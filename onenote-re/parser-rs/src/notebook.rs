//! Converts a parsed revision store into a JSON tree of notebook blocks:
//! section -> pages -> outlines / images / files -> outline elements ->
//! rich text runs, tables, lists and note tags.
//!
//! Coordinates: OneNote stores layout as float32 half-inch units; this module
//! converts them to points (1 half-inch = 36pt). Font sizes are stored in
//! half-points and converted to points.
//!
//! The output types serialize (serde) to exactly the JSON the TypeScript
//! converter produces: same keys, key order, omitted fields and numbers.

use std::collections::HashSet;
use std::rc::Rc;

use serde::ser::{SerializeMap, SerializeStruct};
use serde::{Serialize, Serializer};

use crate::ink::{
    decode_bounding_box, decode_ink_dimensions, decode_ink_path, point_bounds, stroke_points,
    Bounds, InkBlock, InkStroke, HIMETRIC_PT,
};
use crate::js::{self, round2 as round};
use crate::onestore::{
    root_role, ExtendedGuid, ObjectDeclaration, ObjectSpace, OneStore, Property, PropertySet,
    PropertyValue, Revision,
};
use crate::reader::{hex, latin1_units, utf16le, utf16le_units};
use crate::schema::{jcid, jcid_name, prop, prop_name};

// --- output types ------------------------------------------------------------

fn is_none<T>(v: &Option<T>) -> bool {
    v.is_none()
}

/// Position and size in points. Serializes x, y, width, height, except that an
/// image's PictureWidth added after its LayoutMaxHeight lands after it (key
/// order follows the TypeScript object).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Layout {
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub width: Option<f64>,
    pub height: Option<f64>,
    width_after_height: bool,
}

impl Serialize for Layout {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let len = [self.x, self.y, self.width, self.height]
            .iter()
            .filter(|v| v.is_some())
            .count();
        let mut st = s.serialize_struct("Layout", len)?;
        let field = |st: &mut S::SerializeStruct, k: &'static str, v: Option<f64>| match v {
            Some(v) => st.serialize_field(k, &v),
            None => st.skip_field(k),
        };
        field(&mut st, "x", self.x)?;
        field(&mut st, "y", self.y)?;
        if self.width_after_height {
            field(&mut st, "height", self.height)?;
            field(&mut st, "width", self.width)?;
        } else {
            field(&mut st, "width", self.width)?;
            field(&mut st, "height", self.height)?;
        }
        st.end()
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextStyle {
    #[serde(skip_serializing_if = "is_none")]
    pub font: Option<String>,
    #[serde(skip_serializing_if = "is_none")]
    pub font_size: Option<f64>,
    #[serde(skip_serializing_if = "is_none")]
    pub color: Option<String>,
    #[serde(skip_serializing_if = "is_none")]
    pub highlight: Option<String>,
    #[serde(skip_serializing_if = "is_none")]
    pub bold: Option<bool>,
    #[serde(skip_serializing_if = "is_none")]
    pub italic: Option<bool>,
    #[serde(skip_serializing_if = "is_none")]
    pub underline: Option<bool>,
    #[serde(skip_serializing_if = "is_none")]
    pub strikethrough: Option<bool>,
    #[serde(skip_serializing_if = "is_none")]
    pub superscript: Option<bool>,
    #[serde(skip_serializing_if = "is_none")]
    pub subscript: Option<bool>,
    #[serde(skip_serializing_if = "is_none")]
    pub hidden: Option<bool>,
    #[serde(skip_serializing_if = "is_none")]
    pub math: Option<bool>,
    #[serde(skip_serializing_if = "is_none")]
    pub language_id: Option<u32>,
    #[serde(skip_serializing_if = "is_none")]
    pub style_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TextRun {
    /// UTF-16 code unit offsets into the block's `text` (JavaScript string indices).
    pub start: usize,
    pub end: usize,
    pub text: String,
    pub style: TextStyle,
    #[serde(skip_serializing_if = "is_none")]
    pub href: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Paragraph {
    #[serde(flatten)]
    pub style: TextStyle,
    /// "left", "center" or "right".
    #[serde(skip_serializing_if = "is_none")]
    pub alignment: Option<&'static str>,
    #[serde(skip_serializing_if = "is_none")]
    pub space_before: Option<f64>,
    #[serde(skip_serializing_if = "is_none")]
    pub space_after: Option<f64>,
    #[serde(skip_serializing_if = "is_none")]
    pub line_spacing: Option<f64>,
    #[serde(skip_serializing_if = "is_none")]
    pub rtl: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RichTextBlock {
    /// Always "richText".
    pub r#type: &'static str,
    pub id: String,
    pub text: String,
    pub runs: Vec<TextRun>,
    pub paragraph: Paragraph,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetInfo {
    pub byte_length: usize,
    pub media_type: String,
    #[serde(skip_serializing_if = "is_none")]
    pub extension: Option<String>,
    /// Set when the bytes came from resolve_file_data (e.g. "cache/0000004Q.bin"), not the .one file.
    #[serde(skip_serializing_if = "is_none")]
    pub source: Option<String>,
    /// Whatever the caller's on_asset hook returned (file path, URL, data URI...).
    #[serde(rename = "ref", skip_serializing_if = "is_none")]
    pub reference: Option<String>,
}

/// Where the binary payload lives. "embedded" means the bytes were found, in the
/// .one file or through resolve_file_data (then asset.source says where).
/// "notEmbedded" is the `<invfdo>` marker: the writer (e.g. OneNote for Mac's
/// local backups) declared the object but left the bytes out, and no resolver
/// supplied them. "external" is a `<file>` reference to a sidecar file.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AssetStatus {
    Embedded,
    NotEmbedded,
    External,
    Missing,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageBlock {
    /// Always "image".
    pub r#type: &'static str,
    pub id: String,
    pub layout: Layout,
    #[serde(skip_serializing_if = "is_none")]
    pub alt_text: Option<String>,
    #[serde(skip_serializing_if = "is_none")]
    pub filename: Option<String>,
    #[serde(skip_serializing_if = "is_none")]
    pub hyperlink: Option<String>,
    #[serde(skip_serializing_if = "is_none")]
    pub is_background: Option<bool>,
    /// Text OneNote recognised in the picture (stored on the image node).
    #[serde(skip_serializing_if = "is_none")]
    pub ocr_text: Option<String>,
    /// UnverifiedHash (20 bytes, hex): the key the cache resolver matches against SHA-1 of cached files.
    #[serde(skip_serializing_if = "is_none")]
    pub unverified_hash: Option<String>,
    pub asset_status: AssetStatus,
    pub asset: Option<AssetInfo>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedFileBlock {
    /// Always "embeddedFile".
    pub r#type: &'static str,
    pub id: String,
    pub layout: Layout,
    #[serde(skip_serializing_if = "is_none")]
    pub filename: Option<String>,
    #[serde(skip_serializing_if = "is_none")]
    pub source_path: Option<String>,
    pub asset_status: AssetStatus,
    pub asset: Option<AssetInfo>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TableCell {
    pub id: String,
    #[serde(skip_serializing_if = "is_none")]
    pub shading: Option<String>,
    pub children: Vec<OutlineElementBlock>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TableRow {
    pub id: String,
    pub cells: Vec<TableCell>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableBlock {
    /// Always "table".
    pub r#type: &'static str,
    pub id: String,
    #[serde(skip_serializing_if = "is_none")]
    pub row_count: Option<u32>,
    #[serde(skip_serializing_if = "is_none")]
    pub column_count: Option<u32>,
    pub column_widths: Vec<f64>,
    #[serde(skip_serializing_if = "is_none")]
    pub borders_visible: Option<bool>,
    pub rows: Vec<TableRow>,
}

/// A JSON value with JavaScript object semantics (insertion-ordered keys,
/// re-assignment keeps the position): the generic rendering of property sets.
#[derive(Debug, Clone, PartialEq)]
pub enum Described {
    Null,
    Bool(bool),
    Number(f64),
    String(String),
    Array(Vec<Described>),
    Object(Vec<(String, Described)>),
}

impl Described {
    fn set(entries: &mut Vec<(String, Described)>, key: String, value: Described) {
        match entries.iter_mut().find(|(k, _)| *k == key) {
            Some(slot) => slot.1 = value,
            None => entries.push((key, value)),
        }
    }
}

impl Serialize for Described {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        match self {
            Described::Null => s.serialize_unit(),
            Described::Bool(b) => s.serialize_bool(*b),
            Described::Number(n) => serialize_number(*n, s),
            Described::String(v) => s.serialize_str(v),
            Described::Array(items) => items.serialize(s),
            Described::Object(entries) => {
                let mut m = s.serialize_map(Some(entries.len()))?;
                for (k, v) in entries {
                    m.serialize_entry(k, v)?;
                }
                m.end()
            }
        }
    }
}

/// Integers as integers (so `1` is not printed `1.0` by serializers that keep the type).
fn serialize_number<S: Serializer>(n: f64, s: S) -> Result<S::Ok, S::Error> {
    if n.fract() == 0.0 && n.abs() < 4_294_967_296.0 && !(n == 0.0 && n.is_sign_negative()) {
        if n >= 0.0 {
            s.serialize_u32(n as u32)
        } else {
            s.serialize_i64(n as i64)
        }
    } else {
        s.serialize_f64(n)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnknownBlock {
    /// Always "unknown".
    pub r#type: &'static str,
    pub id: String,
    pub jcid: String,
    pub jcid_name: String,
    pub properties: Described,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(untagged)]
pub enum ContentBlock {
    RichText(RichTextBlock),
    Image(ImageBlock),
    EmbeddedFile(EmbeddedFileBlock),
    Table(TableBlock),
    Ink(InkBlock),
    Unknown(UnknownBlock),
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct BulletList {
    /// Always "bullet".
    pub kind: &'static str,
    /// Bullet glyph (render with `font`, often Symbol/Wingdings).
    pub bullet: String,
    #[serde(skip_serializing_if = "is_none")]
    pub font: Option<String>,
    #[serde(skip_serializing_if = "is_none")]
    pub restart: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct NumberedList {
    /// Always "numbered".
    pub kind: &'static str,
    /// Numbering scheme, e.g. "decimal", "lowerLetter", "upperRoman".
    pub scheme: String,
    #[serde(skip_serializing_if = "is_none")]
    pub prefix: Option<String>,
    #[serde(skip_serializing_if = "is_none")]
    pub suffix: Option<String>,
    #[serde(skip_serializing_if = "is_none")]
    pub restart: Option<u32>,
    #[serde(skip_serializing_if = "is_none")]
    pub font: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(untagged)]
pub enum ListInfo {
    Bullet(BulletList),
    Numbered(NumberedList),
}

// MSONFC numbering schemes used by NumberListFormat.
const NUMBER_SCHEMES: [&str; 8] = [
    "decimal",
    "upperRoman",
    "lowerRoman",
    "upperLetter",
    "lowerLetter",
    "ordinal",
    "cardinalText",
    "ordinalText",
];

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteTag {
    #[serde(skip_serializing_if = "is_none")]
    pub label: Option<String>,
    #[serde(skip_serializing_if = "is_none")]
    pub shape: Option<u32>,
    /// ActionItemType from the tag definition; present on to-do style (checkable) tags.
    #[serde(skip_serializing_if = "is_none")]
    pub action_item_type: Option<u32>,
    #[serde(skip_serializing_if = "is_none")]
    pub highlight_color: Option<String>,
    #[serde(skip_serializing_if = "is_none")]
    pub text_color: Option<String>,
    #[serde(skip_serializing_if = "is_none")]
    pub completed: Option<bool>,
    #[serde(skip_serializing_if = "is_none")]
    pub created_at: Option<String>,
    #[serde(skip_serializing_if = "is_none")]
    pub completed_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutlineElementBlock {
    /// Always "outlineElement".
    pub r#type: &'static str,
    pub id: String,
    #[serde(skip_serializing_if = "is_none")]
    pub level: Option<u32>,
    #[serde(skip_serializing_if = "is_none")]
    pub created_at: Option<String>,
    #[serde(skip_serializing_if = "is_none")]
    pub last_modified: Option<String>,
    pub content: Vec<ContentBlock>,
    pub children: Vec<OutlineElementBlock>,
    #[serde(skip_serializing_if = "is_none")]
    pub list: Option<ListInfo>,
    #[serde(skip_serializing_if = "is_none")]
    pub tags: Option<Vec<NoteTag>>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct OutlineBlock {
    /// Always "outline".
    pub r#type: &'static str,
    pub id: String,
    pub layout: Layout,
    /// "titleText", "titleDate" or "titleTime".
    #[serde(skip_serializing_if = "is_none")]
    pub role: Option<&'static str>,
    pub children: Vec<OutlineElementBlock>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(untagged)]
pub enum PageBlock {
    Outline(OutlineBlock),
    Image(ImageBlock),
    EmbeddedFile(EmbeddedFileBlock),
    Ink(InkBlock),
    Unknown(UnknownBlock),
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct PageSize {
    #[serde(skip_serializing_if = "is_none")]
    pub width: Option<f64>,
    #[serde(skip_serializing_if = "is_none")]
    pub height: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    pub id: String,
    pub title: String,
    #[serde(skip_serializing_if = "is_none")]
    pub level: Option<u32>,
    #[serde(skip_serializing_if = "is_none")]
    pub created_at: Option<String>,
    #[serde(skip_serializing_if = "is_none")]
    pub last_modified: Option<String>,
    #[serde(skip_serializing_if = "is_none")]
    pub author: Option<String>,
    pub size: PageSize,
    pub title_blocks: Vec<OutlineBlock>,
    pub blocks: Vec<PageBlock>,
    /// Earlier versions of this page, newest first (only with ConvertOptions::include_versions).
    #[serde(skip_serializing_if = "is_none")]
    pub versions: Option<Vec<PageVersion>>,
}

/// One entry of OneNote's page version history. The page manifest's
/// VersionHistoryGraphSpaceContextNodes names a context whose root is
/// VersionHistoryContent; its VersionProxy children each name another context
/// whose current revision is the historical page.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageVersion {
    /// The version's context id inside the page object space.
    pub id: String,
    #[serde(skip_serializing_if = "is_none")]
    pub created_at: Option<String>,
    #[serde(skip_serializing_if = "is_none")]
    pub modified_at: Option<String>,
    #[serde(skip_serializing_if = "is_none")]
    pub author: Option<String>,
    pub page: Page,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileFormatVersion {
    pub last_writer: String,
    pub oldest_writer: String,
    pub newest_writer: String,
    pub oldest_reader: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    pub file_kind: &'static str,
    pub guid_file: String,
    pub file_format_version: FileFormatVersion,
    pub byte_length: usize,
    pub object_spaces: usize,
    pub embedded_files: usize,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Section {
    pub id: Option<String>,
    pub name: Option<String>,
    pub entity_guid: Option<String>,
    pub created_at: Option<String>,
    pub color: Option<String>,
    pub pages: Vec<Page>,
    /// The name came from SectionDisplayName with no section_name option, so
    /// the TypeScript object gained the key last.
    name_last: bool,
}

impl Serialize for Section {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let mut st = s.serialize_struct("Section", 6)?;
        let opt = |st: &mut S::SerializeStruct, k: &'static str, v: &Option<String>| match v {
            Some(v) => st.serialize_field(k, v),
            None => st.skip_field(k),
        };
        st.serialize_field("id", &self.id)?;
        st.serialize_field("pages", &self.pages)?;
        if !self.name_last {
            opt(&mut st, "name", &self.name)?;
        }
        opt(&mut st, "entityGuid", &self.entity_guid)?;
        opt(&mut st, "createdAt", &self.created_at)?;
        opt(&mut st, "color", &self.color)?;
        if self.name_last {
            opt(&mut st, "name", &self.name)?;
        }
        st.end()
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct FileDataLookups {
    pub requested: u32,
    pub resolved: u32,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostics {
    pub warnings: Vec<String>,
    pub encrypted_object_spaces: Vec<String>,
    /// Present when resolve_file_data is set: file data objects asked for and found.
    #[serde(skip_serializing_if = "is_none")]
    pub file_data_lookups: Option<FileDataLookups>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct NotebookJson {
    /// Always "onenote-revision-store".
    pub format: &'static str,
    pub source: Source,
    pub section: Section,
    pub diagnostics: Diagnostics,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct FileDataQuery {
    /// The PictureContainer14 / EmbeddedFileContainer declaration.
    pub container_id: String,
    /// The image node's UnverifiedHash as lowercase hex, when it has one.
    pub unverified_hash: Option<String>,
    pub extension: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedFileData {
    pub bytes: Vec<u8>,
    pub source: String,
}

/// An embedded image or attachment handed to [`ConvertOptions::on_asset`].
#[derive(Debug, Clone, Copy)]
pub struct Asset<'b> {
    /// The file data container's id (`{GUID}#n`).
    pub id: &'b str,
    pub bytes: &'b [u8],
    pub extension: Option<&'b str>,
    pub media_type: &'b str,
}

pub type AssetHook<'o> = Box<dyn FnMut(Asset<'_>) -> Option<String> + 'o>;
pub type FileDataResolver<'o> = Box<dyn Fn(&FileDataQuery) -> Option<ResolvedFileData> + 'o>;

#[derive(Default)]
pub struct ConvertOptions<'o> {
    pub section_name: Option<String>,
    /// Also convert each page's version history into Page::versions.
    pub include_versions: bool,
    /// Called once per embedded image / attachment; return a reference to store in the JSON.
    pub on_asset: Option<AssetHook<'o>>,
    /// Supplies bytes the .one file declares but does not carry (`<invfdo>`), e.g.
    /// `OneNoteCache::resolver()`. Not consulted for `<file>` references.
    pub resolve_file_data: Option<FileDataResolver<'o>>,
}

// --- property helpers ----------------------------------------------------------

const HALF_INCH_PT: f64 = 36.0;

/// Property lookup by id; a later property with the same id wins.
struct Props<'p, 'a> {
    owned: Option<Rc<PropertySet<'a>>>,
    borrowed: Option<&'p PropertySet<'a>>,
}

impl<'p, 'a> Props<'p, 'a> {
    fn of(set: &'p PropertySet<'a>) -> Self {
        Props {
            owned: None,
            borrowed: Some(set),
        }
    }

    fn set(&self) -> Option<&PropertySet<'a>> {
        self.borrowed.or(self.owned.as_deref())
    }

    fn get(&self, id: u32) -> Option<&Property<'a>> {
        self.set()?.properties.iter().rev().find(|p| p.id == id)
    }

    fn has(&self, id: u32) -> bool {
        self.get(id).is_some()
    }

    fn bytes(&self, id: u32) -> Option<&'a [u8]> {
        match self.get(id)?.value {
            PropertyValue::Bytes(b) => Some(b),
            _ => None,
        }
    }

    fn bool(&self, id: u32) -> Option<bool> {
        match self.get(id)?.value {
            PropertyValue::Bool(b) => Some(b),
            _ => None,
        }
    }

    fn u32(&self, id: u32) -> Option<u32> {
        let b = self.bytes(id)?;
        match b.len() {
            n if n >= 4 => Some(u32::from_le_bytes([b[0], b[1], b[2], b[3]])),
            2 => Some(u32::from(u16::from_le_bytes([b[0], b[1]]))),
            1 => Some(u32::from(b[0])),
            _ => None,
        }
    }

    fn f32(&self, id: u32) -> Option<f64> {
        let b = self.bytes(id).filter(|b| b.len() >= 4)?;
        Some(f64::from(f32::from_le_bytes([b[0], b[1], b[2], b[3]])))
    }

    fn str(&self, id: u32) -> Option<String> {
        self.bytes(id).map(utf16le)
    }

    fn oids(&self, id: u32) -> Vec<ExtendedGuid> {
        match self.get(id).map(|p| &p.value) {
            Some(PropertyValue::Oids { ids, .. }) => ids.iter().flatten().copied().collect(),
            _ => Vec::new(),
        }
    }

    fn osids(&self, id: u32) -> Vec<ExtendedGuid> {
        match self.get(id).map(|p| &p.value) {
            Some(PropertyValue::Osids { ids, .. }) => ids.iter().flatten().copied().collect(),
            _ => Vec::new(),
        }
    }

    fn context_ids(&self, id: u32) -> Vec<ExtendedGuid> {
        match self.get(id).map(|p| &p.value) {
            Some(PropertyValue::ContextIds { ids, .. }) => ids.iter().flatten().copied().collect(),
            _ => Vec::new(),
        }
    }
}

fn half_inches(v: Option<f64>) -> Option<f64> {
    v.filter(|v| v.is_finite()).map(|v| round(v * HALF_INCH_PT))
}

/// COLORREF 0x00BBGGRR; 0xFFFFFFFF means "automatic".
pub(crate) fn color_ref(v: Option<u32>) -> Option<String> {
    let v = v?;
    if v == 0xffff_ffff || v >> 24 == 0xff {
        return None;
    }
    Some(format!(
        "#{:02x}{:02x}{:02x}",
        v & 0xff,
        (v >> 8) & 0xff,
        (v >> 16) & 0xff
    ))
}

/// Seconds since 1980-01-01T00:00:00Z.
fn time32(v: Option<u32>) -> Option<String> {
    let v = v.filter(|&v| v != 0)?;
    Some(js::iso_string(315_532_800_000 + i64::from(v) * 1000))
}

/// 100ns ticks since 1601-01-01T00:00:00Z.
fn file_time(b: Option<&[u8]>) -> Option<String> {
    let b: [u8; 8] = b?.try_into().ok()?;
    let ticks = u64::from_le_bytes(b);
    if ticks == 0 {
        return None;
    }
    Some(js::iso_string((ticks / 10_000) as i64 - 11_644_473_600_000))
}

/// Media type from the leading bytes, else `application/x-<extension>`.
pub fn sniff_media_type(b: &[u8], extension: Option<&str>) -> String {
    let starts = |sig: &[u8]| b.len() >= sig.len() && &b[..sig.len()] == sig;
    let at = |i: usize| b.get(i).copied();
    let t = if starts(&[0x89, 0x50, 0x4e, 0x47]) {
        "image/png"
    } else if starts(&[0xff, 0xd8, 0xff]) {
        "image/jpeg"
    } else if starts(&[0x47, 0x49, 0x46, 0x38]) {
        "image/gif"
    } else if starts(&[0x42, 0x4d]) {
        "image/bmp"
    } else if starts(&[0x25, 0x50, 0x44, 0x46]) {
        "application/pdf"
    } else if starts(&[0x52, 0x49, 0x46, 0x46]) && at(8) == Some(0x57) && at(9) == Some(0x45) {
        "image/webp"
    } else if starts(&[0x01, 0x00, 0x00, 0x00]) && at(40) == Some(0x20) && at(41) == Some(0x45) {
        "image/emf"
    } else if starts(&[0xd7, 0xcd, 0xc6, 0x9a]) {
        "image/wmf"
    } else if starts(&[0x50, 0x4b, 0x03, 0x04]) {
        "application/zip"
    } else if starts(&[0x49, 0x49, 0x2a, 0x00]) || starts(&[0x4d, 0x4d, 0x00, 0x2a]) {
        "image/tiff"
    } else if let Some(ext) = extension.filter(|e| !e.is_empty()) {
        return format!("application/x-{}", ext.strip_prefix('.').unwrap_or(ext));
    } else {
        "application/octet-stream"
    };
    t.to_string()
}

// --- converter -----------------------------------------------------------------

#[derive(Clone, Copy)]
struct Ctx<'s> {
    space: &'s ObjectSpace,
    rev: &'s Revision,
    depth: u32,
}

impl<'s> Ctx<'s> {
    fn deeper(self) -> Self {
        Ctx {
            depth: self.depth + 1,
            ..self
        }
    }
}

const MAX_DEPTH: u32 = 64;

pub struct NotebookConverter<'s, 'a, 'o> {
    store: &'s OneStore<'a>,
    opts: ConvertOptions<'o>,
    lookups: Option<FileDataLookups>,
}

impl<'s, 'a, 'o> NotebookConverter<'s, 'a, 'o> {
    pub fn new(store: &'s OneStore<'a>, opts: ConvertOptions<'o>) -> Self {
        NotebookConverter {
            store,
            opts,
            lookups: None,
        }
    }

    pub fn convert(mut self) -> NotebookJson {
        let s = self.store;
        let h = &s.header;
        let ffv = |v: u32| format!("0x{v:x}");
        let mut out = NotebookJson {
            format: "onenote-revision-store",
            source: Source {
                file_kind: h.file_kind.as_str(),
                guid_file: h.guid_file.clone(),
                file_format_version: FileFormatVersion {
                    last_writer: ffv(h.ffv_last_code_that_wrote_to_this_file),
                    oldest_writer: ffv(h.ffv_oldest_code_that_has_written_to_this_file),
                    newest_writer: ffv(h.ffv_newest_code_that_has_written_to_this_file),
                    oldest_reader: ffv(h.ffv_oldest_code_that_may_read_this_file),
                },
                byte_length: s.buf.len(),
                object_spaces: s.object_spaces.len(),
                embedded_files: s.file_data.len(),
            },
            section: Section {
                id: s.root_gosid.map(|g| g.key()),
                ..Section::default()
            },
            diagnostics: Diagnostics::default(),
        };
        for sp in s.object_spaces.values() {
            if sp.encrypted {
                out.diagnostics.encrypted_object_spaces.push(sp.gosid.key());
            }
        }
        if self.opts.resolve_file_data.is_some() {
            self.lookups = Some(FileDataLookups::default());
        }
        if let Some(name) = self.opts.section_name.clone().filter(|n| !n.is_empty()) {
            out.section.name = Some(name);
        }
        self.convert_section(&mut out.section);
        out.diagnostics.warnings = s.warnings();
        out.diagnostics.file_data_lookups = self.lookups;
        out
    }

    fn convert_section(&mut self, section: &mut Section) {
        let s = self.store;
        let Some(root) = s.root_gosid.and_then(|g| s.object_spaces.get(&g)) else {
            s.warn("no root object space".into());
            return;
        };
        let rev = s.current_revision(root, root_role::DEFAULT_CONTENT, None);
        let section_node = rev.and_then(|rev| {
            let oid = s.root_object(root, rev, root_role::DEFAULT_CONTENT)?;
            s.find_object(rev, &oid, Some(root))
        });
        let (Some(rev), Some(section_node)) = (rev, section_node) else {
            s.warn("root object space has no current default-content root object".into());
            return;
        };
        if section_node.jcid.raw != jcid::SECTION_NODE {
            s.warn(format!(
                "root object is {}, not SectionNode (is this a .onetoc2?)",
                jcid_name(section_node.jcid.raw)
            ));
            return;
        }
        let ctx = Ctx {
            space: root,
            rev,
            depth: 0,
        };
        let sp = self.props(Some(section_node));
        section.entity_guid = sp.str(prop::NOTEBOOK_MANAGEMENT_ENTITY_GUID);
        section.created_at = file_time(sp.bytes(prop::TOPOLOGY_CREATION_TIME_STAMP));
        section.color = color_ref(sp.u32(prop::NOTEBOOK_COLOR));

        // Section metadata root, when present, carries the display name.
        let meta_rev = s
            .current_revision(root, root_role::METADATA, None)
            .unwrap_or(rev);
        let meta = s
            .root_object(root, meta_rev, root_role::METADATA)
            .and_then(|oid| s.find_object(meta_rev, &oid, Some(root)));
        let display_name = meta.and_then(|m| self.props(Some(m)).str(prop::SECTION_DISPLAY_NAME));
        if let Some(name) = display_name.filter(|n| !n.is_empty()) {
            section.name_last = section.name.is_none();
            section.name = Some(name);
        }

        for series_oid in sp.oids(prop::ELEMENT_CHILD_NODES) {
            let Some(series) = self
                .resolve(ctx, &series_oid)
                .filter(|d| d.jcid.raw == jcid::PAGE_SERIES_NODE)
            else {
                continue;
            };
            let ps = self.props(Some(series));
            let metas: Vec<Option<&ObjectDeclaration>> = ps
                .oids(prop::META_DATA_OBJECTS_ABOVE_GRAPH_SPACE)
                .iter()
                .map(|o| self.resolve(ctx, o))
                .collect();
            for (i, gosid) in ps
                .osids(prop::CHILD_GRAPH_SPACE_ELEMENT_NODES)
                .iter()
                .enumerate()
            {
                if let Some(page) = self.convert_page(gosid, metas.get(i).copied().flatten(), None)
                {
                    section.pages.push(page);
                }
            }
        }
    }

    fn props(&self, decl: Option<&ObjectDeclaration>) -> Props<'a, 'a> {
        Props {
            owned: decl.and_then(|d| self.store.property_set(d)),
            borrowed: None,
        }
    }

    fn resolve(&self, ctx: Ctx<'s>, oid: &ExtendedGuid) -> Option<&'s ObjectDeclaration> {
        if oid.is_nil() {
            return None;
        }
        self.store.find_object(ctx.rev, oid, Some(ctx.space))
    }

    /// First of `oids` that resolves.
    fn resolve_first(&self, ctx: Ctx<'s>, oids: &[ExtendedGuid]) -> Option<&'s ObjectDeclaration> {
        oids.iter().find_map(|o| self.resolve(ctx, o))
    }

    fn author_name(&self, ctx: Ctx<'s>, oids: &[ExtendedGuid]) -> Option<String> {
        let a = self.resolve(ctx, oids.first()?)?;
        self.props(Some(a)).str(prop::AUTHOR)
    }

    /// `at` converts a specific revision (a historical version) instead of the current one.
    fn convert_page(
        &mut self,
        gosid: &ExtendedGuid,
        series_meta: Option<&'s ObjectDeclaration>,
        at: Option<&'s Revision>,
    ) -> Option<Page> {
        let s = self.store;
        let Some(space) = s.object_spaces.get(gosid) else {
            s.warn(format!("page object space {gosid} missing"));
            return None;
        };
        if space.encrypted {
            return None;
        }
        let rev = at.or_else(|| s.current_revision(space, root_role::DEFAULT_CONTENT, None))?;
        let ctx = Ctx {
            space,
            rev,
            depth: 0,
        };

        let meta_rev = at
            .or_else(|| s.current_revision(space, root_role::METADATA, None))
            .unwrap_or(rev);
        let meta_decl = s
            .root_object(space, meta_rev, root_role::METADATA)
            .and_then(|oid| s.find_object(meta_rev, &oid, Some(space)));
        let meta = self.props(meta_decl.or(series_meta));

        let manifest = s
            .root_object(space, rev, root_role::DEFAULT_CONTENT)
            .and_then(|oid| self.resolve(ctx, &oid));
        let page_decl = self
            .props(manifest)
            .oids(prop::CONTENT_CHILD_NODES)
            .iter()
            .filter_map(|o| self.resolve(ctx, o))
            .find(|d| d.jcid.raw == jcid::PAGE_NODE);
        let pp = self.props(page_decl);

        let mut page = Page {
            id: gosid.key(),
            title: meta
                .str(prop::CACHED_TITLE_STRING)
                .or_else(|| pp.str(prop::CACHED_TITLE_STRING))
                .unwrap_or_default(),
            level: meta.u32(prop::PAGE_LEVEL),
            created_at: file_time(meta.bytes(prop::TOPOLOGY_CREATION_TIME_STAMP))
                .or_else(|| time32(pp.u32(prop::CREATION_TIME_STAMP))),
            last_modified: time32(pp.u32(prop::LAST_MODIFIED_TIME))
                .or_else(|| file_time(pp.bytes(prop::LAST_MODIFIED_TIME_STAMP))),
            author: pp
                .str(prop::AUTHOR)
                .or_else(|| self.author_name(ctx, &pp.oids(prop::AUTHOR_ORIGINAL))),
            size: PageSize {
                width: half_inches(pp.f32(prop::PAGE_WIDTH)),
                height: half_inches(pp.f32(prop::PAGE_HEIGHT)),
            },
            title_blocks: Vec::new(),
            blocks: Vec::new(),
            versions: None,
        };

        for title_oid in pp.oids(prop::STRUCTURE_ELEMENT_CHILD_NODES) {
            let Some(title) = self
                .resolve(ctx, &title_oid)
                .filter(|d| d.jcid.raw == jcid::TITLE_NODE)
            else {
                continue;
            };
            for o in self.props(Some(title)).oids(prop::ELEMENT_CHILD_NODES) {
                if let Some(PageBlock::Outline(b)) = self.convert_page_child(ctx, &o) {
                    page.title_blocks.push(b);
                }
            }
        }
        if page.title.is_empty() {
            let parts: Vec<String> = page
                .title_blocks
                .iter()
                .map(|b| plain_text(&b.children))
                .collect();
            page.title = js::trim(&parts.join(" ")).to_string();
        }

        for o in pp.oids(prop::ELEMENT_CHILD_NODES) {
            if let Some(b) = self.convert_page_child(ctx, &o) {
                page.blocks.push(b);
            }
        }
        if self.opts.include_versions && at.is_none() {
            let manifest_props = self.props(manifest);
            let versions = self.page_versions(gosid, space, &manifest_props);
            if !versions.is_empty() {
                page.versions = Some(versions);
            }
        }
        Some(page)
    }

    /// Walk VersionHistoryGraphSpaceContextNodes → VersionHistoryContent → VersionProxy → historical revision.
    fn page_versions(
        &mut self,
        gosid: &ExtendedGuid,
        space: &'s ObjectSpace,
        manifest: &Props,
    ) -> Vec<PageVersion> {
        let s = self.store;
        let mut out: Vec<PageVersion> = Vec::new();
        let mut seen: HashSet<ExtendedGuid> = HashSet::new();
        for history_ctx in manifest.context_ids(prop::VERSION_HISTORY_GRAPH_SPACE_CONTEXT_NODES) {
            let Some(hrev) =
                s.current_revision(space, root_role::DEFAULT_CONTENT, Some(&history_ctx))
            else {
                continue;
            };
            let content = s
                .root_object(space, hrev, root_role::DEFAULT_CONTENT)
                .and_then(|oid| s.find_object(hrev, &oid, Some(space)));
            let Some(content) = content.filter(|c| c.jcid.raw == jcid::VERSION_HISTORY_CONTENT)
            else {
                continue;
            };
            let hctx = Ctx {
                space,
                rev: hrev,
                depth: 0,
            };
            for proxy_oid in self.props(Some(content)).oids(prop::ELEMENT_CHILD_NODES) {
                let Some(proxy) = self
                    .resolve(hctx, &proxy_oid)
                    .filter(|d| d.jcid.raw == jcid::VERSION_PROXY)
                else {
                    continue;
                };
                let pp = self.props(Some(proxy));
                for version_ctx in pp.context_ids(prop::VERSION_HISTORY_GRAPH_SPACE_CONTEXT_NODES) {
                    if !seen.insert(version_ctx) {
                        continue;
                    }
                    let Some(vrev) =
                        s.current_revision(space, root_role::DEFAULT_CONTENT, Some(&version_ctx))
                    else {
                        continue;
                    };
                    let Some(page) = self.convert_page(gosid, None, Some(vrev)) else {
                        continue;
                    };
                    let created_at = time32(pp.u32(prop::CREATION_TIME_STAMP));
                    let modified_at = file_time(pp.bytes(prop::LAST_MODIFIED_TIME_STAMP))
                        .or_else(|| page.last_modified.clone());
                    let author = self.author_name(hctx, &pp.oids(prop::AUTHOR_MOST_RECENT));
                    out.push(PageVersion {
                        id: version_ctx.key(),
                        created_at,
                        modified_at,
                        author,
                        page,
                    });
                }
            }
        }
        // Newest first; a stable sort keeps file order for ties.
        out.sort_by(|a, b| {
            b.modified_at
                .as_deref()
                .unwrap_or("")
                .cmp(a.modified_at.as_deref().unwrap_or(""))
        });
        out
    }

    fn convert_page_child(&mut self, ctx: Ctx<'s>, oid: &ExtendedGuid) -> Option<PageBlock> {
        let decl = self.resolve(ctx, oid)?;
        Some(match decl.jcid.raw {
            jcid::OUTLINE_NODE => PageBlock::Outline(self.convert_outline(ctx, decl)),
            jcid::IMAGE_NODE => PageBlock::Image(self.convert_image(ctx, decl)),
            jcid::EMBEDDED_FILE_NODE => {
                PageBlock::EmbeddedFile(self.convert_embedded_file(ctx, decl))
            }
            _ if self.is_ink(decl) => PageBlock::Ink(self.convert_ink(ctx, decl, false)),
            _ => PageBlock::Unknown(self.unknown(decl)),
        })
    }

    // --- ink (file-format.md §13) ------------------------------------------------

    /// An ink container by JCID, or by shape: it points at ink data or holds ink groups.
    fn is_ink(&self, decl: &ObjectDeclaration) -> bool {
        if decl.jcid.raw == jcid::INK_CONTAINER {
            return true;
        }
        let p = self.props(Some(decl));
        p.has(prop::INK_DATA) || p.has(prop::INK_STROKES)
    }

    fn convert_ink(&self, ctx: Ctx<'s>, decl: &'s ObjectDeclaration, embedded: bool) -> InkBlock {
        let mut strokes: Vec<InkStroke> = Vec::new();
        let mut bbox: Option<[f64; 4]> = None;
        self.ink_walk(ctx, decl, 0.0, 0.0, 0, embedded, &mut strokes, &mut bbox);
        let all: Vec<f64> = strokes
            .iter()
            .flat_map(|s| s.points.iter().copied())
            .collect();
        let mut bounds = point_bounds(&all);
        if embedded {
            // Strokes flow with the text: make them relative to the ink's own box.
            let (ox, oy) = match bbox {
                Some(b) => (
                    js::min(b[0], bounds.map_or(b[0], |p| p.x)),
                    js::min(b[1], bounds.map_or(b[1], |p| p.y)),
                ),
                None => (bounds.map_or(0.0, |p| p.x), bounds.map_or(0.0, |p| p.y)),
            };
            for st in &mut strokes {
                for (i, v) in st.points.iter_mut().enumerate() {
                    *v = round(*v - if i % 2 == 1 { oy } else { ox });
                }
            }
            let all: Vec<f64> = strokes
                .iter()
                .flat_map(|s| s.points.iter().copied())
                .collect();
            bounds = point_bounds(&all).map(|b| Bounds {
                x: 0.0,
                y: 0.0,
                width: round(b.x + b.width),
                height: round(b.y + b.height),
            });
        }
        InkBlock {
            r#type: "ink",
            id: decl.oid.key(),
            embedded: embedded.then_some(true),
            bounds,
            strokes,
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn ink_walk(
        &self,
        ctx: Ctx<'s>,
        d: &'s ObjectDeclaration,
        ox: f64,
        oy: f64,
        depth: u32,
        embedded: bool,
        strokes: &mut Vec<InkStroke>,
        bbox: &mut Option<[f64; 4]>,
    ) {
        if depth > 16 {
            return;
        }
        let p = self.props(Some(d));
        // Page ink is placed by the container's offset; groups nest offsets.
        let x = ox
            + if embedded {
                0.0
            } else {
                half_inches(p.f32(prop::OFFSET_FROM_PARENT_HORIZ)).unwrap_or(0.0)
            };
        let y = oy
            + if embedded {
                0.0
            } else {
                half_inches(p.f32(prop::OFFSET_FROM_PARENT_VERT)).unwrap_or(0.0)
            };
        let sx = p.f32(prop::INK_SCALING_X).unwrap_or(1.0);
        let sy = p.f32(prop::INK_SCALING_Y).unwrap_or(1.0);
        // The container itself may be the data node (InkStrokes directly on it).
        let data = if p.has(prop::INK_STROKES) {
            Some(d)
        } else {
            self.resolve_first(ctx, &p.oids(prop::INK_DATA))
        };
        if let Some(data) = data {
            let dp = self.props(Some(data));
            if let Some(bb) = decode_bounding_box(dp.bytes(prop::INK_BOUNDING_BOX)) {
                if bbox.is_none() {
                    let [x0, y0, x1, y1] = bb.map(f64::from);
                    *bbox = Some([
                        x0 * sx * HIMETRIC_PT + x,
                        y0 * sy * HIMETRIC_PT + y,
                        x1 * sx * HIMETRIC_PT + x,
                        y1 * sy * HIMETRIC_PT + y,
                    ]);
                }
            }
            for so in dp.oids(prop::INK_STROKES) {
                if let Some(stroke) = self
                    .resolve(ctx, &so)
                    .and_then(|sd| self.convert_stroke(ctx, sd, sx, sy, x, y))
                {
                    strokes.push(stroke);
                }
            }
        }
        for co in p.oids(prop::CONTENT_CHILD_NODES) {
            if let Some(cd) = self.resolve(ctx, &co) {
                if self.is_ink(cd) {
                    self.ink_walk(ctx, cd, x, y, depth + 1, embedded, strokes, bbox);
                }
            }
        }
    }

    fn convert_stroke(
        &self,
        ctx: Ctx<'s>,
        decl: &ObjectDeclaration,
        sx: f64,
        sy: f64,
        x: f64,
        y: f64,
    ) -> Option<InkStroke> {
        let p = self.props(Some(decl));
        let path = p.bytes(prop::INK_PATH)?;
        let props_decl = self.resolve_first(ctx, &p.oids(prop::INK_STROKE_PROPERTIES));
        let sp = self.props(props_decl);
        let raw = stroke_points(
            &decode_ink_path(path),
            &decode_ink_dimensions(sp.bytes(prop::INK_DIMENSIONS)),
            sx,
            sy,
        );
        if raw.is_empty() {
            return None;
        }
        let points = raw
            .iter()
            .enumerate()
            .map(|(i, v)| round(v * HIMETRIC_PT + if i % 2 == 1 { y } else { x }))
            .collect();
        let w = sp.f32(prop::INK_WIDTH);
        let h = sp.f32(prop::INK_HEIGHT);
        let transparency = sp.u32(prop::INK_STROKE_TRANSPARENCY);
        let rop = sp.u32(prop::INK_RASTER_OPERATION);
        let bias = p.u32(prop::INK_BIAS);
        Some(InkStroke {
            points,
            color: color_ref(sp.u32(prop::INK_COLOR))
                .or_else(|| sp.has(prop::INK_COLOR).then(|| "#000000".to_string())),
            width: w.filter(|w| w.is_finite()).map(|w| round(w * HIMETRIC_PT)),
            height: h.filter(|h| h.is_finite()).map(|h| round(h * HIMETRIC_PT)),
            transparency: transparency.filter(|&t| t != 0),
            // R2_MASKPEN (9) is how Windows Ink draws highlighters; OneNote's are also translucent.
            highlighter: (rop == Some(9) || transparency.unwrap_or(0) >= 64).then_some(true),
            pen_tip: sp.u32(prop::INK_PEN_TIP_SHAPE).filter(|&t| t != 0),
            bias: match bias {
                Some(0) => Some("handwriting"),
                Some(1) => Some("drawing"),
                Some(2) => Some("both"),
                _ => None,
            },
        })
    }

    fn layout(&self, p: &Props) -> Layout {
        Layout {
            x: half_inches(p.f32(prop::OFFSET_FROM_PARENT_HORIZ)),
            y: half_inches(p.f32(prop::OFFSET_FROM_PARENT_VERT)),
            width: half_inches(p.f32(prop::LAYOUT_MAX_WIDTH)),
            height: half_inches(p.f32(prop::LAYOUT_MAX_HEIGHT)),
            width_after_height: false,
        }
    }

    fn convert_outline(&mut self, ctx: Ctx<'s>, decl: &'s ObjectDeclaration) -> OutlineBlock {
        let p = self.props(Some(decl));
        let role = if p.bool(prop::IS_TITLE_TEXT) == Some(true) {
            Some("titleText")
        } else if p.bool(prop::IS_TITLE_DATE) == Some(true) {
            Some("titleDate")
        } else if p.bool(prop::IS_TITLE_TIME) == Some(true) {
            Some("titleTime")
        } else {
            None
        };
        OutlineBlock {
            r#type: "outline",
            id: decl.oid.key(),
            layout: self.layout(&p),
            role,
            children: self.convert_elements(ctx, &p.oids(prop::ELEMENT_CHILD_NODES)),
        }
    }

    fn convert_elements(
        &mut self,
        ctx: Ctx<'s>,
        oids: &[ExtendedGuid],
    ) -> Vec<OutlineElementBlock> {
        if ctx.depth > MAX_DEPTH {
            return Vec::new();
        }
        let inner = ctx.deeper();
        let mut out = Vec::new();
        for oid in oids {
            let Some(d) = self.resolve(inner, oid) else {
                continue;
            };
            if d.jcid.raw == jcid::OUTLINE_ELEMENT_NODE {
                out.push(self.convert_element(inner, d));
            } else if d.jcid.raw == jcid::OUTLINE_GROUP {
                // Groups only bundle siblings; flatten them into the parent.
                let children = self.props(Some(d)).oids(prop::ELEMENT_CHILD_NODES);
                out.extend(self.convert_elements(inner, &children));
            }
        }
        out
    }

    fn convert_element(
        &mut self,
        ctx: Ctx<'s>,
        decl: &'s ObjectDeclaration,
    ) -> OutlineElementBlock {
        let p = self.props(Some(decl));
        let mut el = OutlineElementBlock {
            r#type: "outlineElement",
            id: decl.oid.key(),
            level: p.u32(prop::OUTLINE_ELEMENT_CHILD_LEVEL),
            created_at: time32(p.u32(prop::CREATION_TIME_STAMP)),
            last_modified: time32(p.u32(prop::LAST_MODIFIED_TIME)),
            content: Vec::new(),
            children: self.convert_elements(ctx, &p.oids(prop::ELEMENT_CHILD_NODES)),
            list: None,
            tags: None,
        };
        if let Some(list_decl) = self.resolve_first(ctx, &p.oids(prop::LIST_NODES)) {
            el.list = Some(self.convert_list(list_decl));
        }
        // NoteTagStates can sit on the outline element or (in OneNote for Mac's
        // files, always) on its RichTextOENode content.
        let mut tags = self.convert_note_tags(ctx, &p);
        for o in p.oids(prop::CONTENT_CHILD_NODES) {
            if let Some(d) = self
                .resolve(ctx, &o)
                .filter(|d| d.jcid.raw == jcid::RICH_TEXT_OE_NODE)
            {
                let dp = self.props(Some(d));
                tags.extend(self.convert_note_tags(ctx, &dp));
            }
            if let Some(c) = self.convert_content(ctx, &o) {
                el.content.push(c);
            }
        }
        if !tags.is_empty() {
            el.tags = Some(tags);
        }
        el
    }

    fn convert_content(&mut self, ctx: Ctx<'s>, oid: &ExtendedGuid) -> Option<ContentBlock> {
        let d = self.resolve(ctx, oid)?;
        Some(match d.jcid.raw {
            jcid::RICH_TEXT_OE_NODE => ContentBlock::RichText(self.convert_rich_text(ctx, d)),
            jcid::IMAGE_NODE => ContentBlock::Image(self.convert_image(ctx, d)),
            jcid::TABLE_NODE => ContentBlock::Table(self.convert_table(ctx, d)),
            jcid::EMBEDDED_FILE_NODE => {
                ContentBlock::EmbeddedFile(self.convert_embedded_file(ctx, d))
            }
            _ if self.is_ink(d) => ContentBlock::Ink(self.convert_ink(ctx, d, true)),
            _ => ContentBlock::Unknown(self.unknown(d)),
        })
    }

    fn convert_list(&self, decl: &ObjectDeclaration) -> ListInfo {
        let p = self.props(Some(decl));
        // NumberListFormat is length-prefixed: [cch][chars...]. Numbered formats put
        // a U+FFFD placeholder followed by the MSONFC scheme code between prefix and suffix.
        let mut chars: Vec<char> = p
            .str(prop::NUMBER_LIST_FORMAT)
            .unwrap_or_default()
            .chars()
            .collect();
        let first_unit = |c: char| u32::from(c.encode_utf16(&mut [0u16; 2])[0]);
        if !chars.is_empty() && first_unit(chars[0]) as usize == chars.len() - 1 {
            chars.remove(0);
        }
        let font = p.str(prop::LIST_FONT).or_else(|| p.str(prop::FONT));
        let restart = p.u32(prop::LIST_RESTART);
        let Some(ph) = chars.iter().position(|&c| c == '\u{fffd}') else {
            return ListInfo::Bullet(BulletList {
                kind: "bullet",
                bullet: chars.iter().collect(),
                font,
                restart,
            });
        };
        let code = chars.get(ph + 1).map_or(0, |&c| first_unit(c));
        let joined = |cs: &[char]| Some(cs.iter().collect::<String>()).filter(|s| !s.is_empty());
        ListInfo::Numbered(NumberedList {
            kind: "numbered",
            scheme: NUMBER_SCHEMES
                .get(code as usize)
                .map_or_else(|| format!("msonfc_{code}"), |s| s.to_string()),
            prefix: joined(&chars[..ph]),
            suffix: joined(chars.get(ph + 2..).unwrap_or(&[])),
            restart,
            font,
        })
    }

    fn convert_note_tags(&self, ctx: Ctx<'s>, p: &Props) -> Vec<NoteTag> {
        let Some(PropertyValue::PropertyValues { sets, .. }) =
            p.get(prop::NOTE_TAG_STATES).map(|p| &p.value)
        else {
            return Vec::new();
        };
        sets.iter()
            .map(|set| {
                let tp = Props::of(set);
                let def_decl = tp
                    .oids(prop::NOTE_TAG_DEFINITION_OID)
                    .first()
                    .and_then(|o| self.resolve(ctx, o));
                let def = self.props(def_decl);
                let status = tp.u32(prop::ACTION_ITEM_STATUS);
                NoteTag {
                    label: def.str(prop::NOTE_TAG_LABEL),
                    shape: def.u32(prop::NOTE_TAG_SHAPE),
                    action_item_type: def.u32(prop::ACTION_ITEM_TYPE),
                    highlight_color: color_ref(def.u32(prop::NOTE_TAG_HIGHLIGHT_COLOR)),
                    text_color: color_ref(def.u32(prop::NOTE_TAG_TEXT_COLOR)),
                    completed: status.map(|s| s & 0x1 == 1),
                    created_at: time32(tp.u32(prop::NOTE_TAG_CREATED)),
                    completed_at: time32(tp.u32(prop::NOTE_TAG_COMPLETED)),
                }
            })
            .collect()
    }

    fn text_style(p: &Props) -> TextStyle {
        let flag = |id: u32| p.bool(id).filter(|&b| b);
        TextStyle {
            font: p.str(prop::FONT),
            font_size: p
                .u32(prop::FONT_SIZE)
                .filter(|&s| s != 0)
                .map(|s| f64::from(s) / 2.0),
            color: color_ref(p.u32(prop::FONT_COLOR)),
            highlight: color_ref(p.u32(prop::HIGHLIGHT)),
            bold: flag(prop::BOLD),
            italic: flag(prop::ITALIC),
            underline: flag(prop::UNDERLINE),
            strikethrough: flag(prop::STRIKETHROUGH),
            superscript: flag(prop::SUPERSCRIPT),
            subscript: flag(prop::SUBSCRIPT),
            hidden: flag(prop::HIDDEN),
            math: flag(prop::MATH_FORMATTING),
            language_id: p.u32(prop::LANGUAGE_ID),
            style_id: p.str(prop::PARAGRAPH_STYLE_ID),
        }
    }

    fn convert_rich_text(&self, ctx: Ctx<'s>, decl: &ObjectDeclaration) -> RichTextBlock {
        let p = self.props(Some(decl));
        let ascii = p.bytes(prop::TEXT_EXTENDED_ASCII);
        // UTF-16 code units: run offsets and lengths are JavaScript string indices.
        let raw: Vec<u16> = match p.bytes(prop::RICH_EDIT_TEXT_UNICODE) {
            Some(b) => utf16le_units(b),
            None => ascii.map(latin1_units).unwrap_or_default(),
        };

        let para_decl = self.resolve_first(ctx, &p.oids(prop::PARAGRAPH_STYLE));
        let para = self.props(para_decl);
        let alignment = p
            .u32(prop::PARAGRAPH_ALIGNMENT)
            .or_else(|| para.u32(prop::PARAGRAPH_ALIGNMENT));
        let either = |id: u32| p.f32(id).or_else(|| para.f32(id));
        let paragraph = Paragraph {
            style: Self::text_style(&para),
            alignment: match alignment {
                Some(1) => Some("center"),
                Some(2) => Some("right"),
                Some(0) => Some("left"),
                _ => None,
            },
            space_before: half_inches(either(prop::PARAGRAPH_SPACE_BEFORE)),
            space_after: half_inches(either(prop::PARAGRAPH_SPACE_AFTER)),
            line_spacing: half_inches(either(prop::PARAGRAPH_LINE_SPACING_EXACT)),
            rtl: p.bool(prop::READING_ORDER_RTL).filter(|&b| b),
        };

        // TextRunIndex holds run end offsets; TextRunFormatting holds one style per run.
        let ends: Vec<u32> = p
            .bytes(prop::TEXT_RUN_INDEX)
            .map(|b| {
                b.as_chunks::<4>()
                    .0
                    .iter()
                    .map(|c| u32::from_le_bytes(*c))
                    .collect()
            })
            .unwrap_or_default();
        let style_props: Vec<Props> = p
            .oids(prop::TEXT_RUN_FORMATTING)
            .iter()
            .map(|o| self.props(self.resolve(ctx, o)))
            .collect();
        let styles: Vec<TextStyle> = style_props.iter().map(Self::text_style).collect();
        let is_link: Vec<bool> = style_props
            .iter()
            .map(|sp| sp.bool(prop::HYPERLINK) == Some(true))
            .collect();
        let mut bounds = vec![0usize];
        bounds.extend(
            ends.iter()
                .map(|&e| e as usize)
                .filter(|&e| e > 0 && e < raw.len()),
        );
        bounds.push(raw.len());

        let mut runs = Vec::new();
        let mut text: Vec<u16> = Vec::new();
        let mut href: Option<String> = None;
        for (i, w) in bounds.windows(2).enumerate() {
            // String.prototype.slice: empty when start >= end.
            let mut piece: Vec<u16> = if w[0] < w[1] {
                raw[w[0]..w[1]].to_vec()
            } else {
                continue;
            };
            let style = styles.get(i).cloned().unwrap_or_default();
            // Hyperlinks are stored inline as a hidden field code: ﷟HYPERLINK "url"
            if let Some((start, end, url)) = find_hyperlink(&piece) {
                href = Some(String::from_utf16_lossy(&url));
                piece.drain(start..end);
            } else if !is_link.get(i).copied().unwrap_or(false) {
                href = None;
            }
            if piece.is_empty() {
                continue;
            }
            let start = text.len();
            text.extend_from_slice(&piece);
            runs.push(TextRun {
                start,
                end: text.len(),
                text: String::from_utf16_lossy(&piece),
                style,
                href: href.clone(),
            });
        }
        RichTextBlock {
            r#type: "richText",
            id: decl.oid.key(),
            text: String::from_utf16_lossy(&text),
            runs,
            paragraph,
        }
    }

    /// Bytes of a file data container: from the .one file's FileDataStore, else
    /// from opts.resolve_file_data (keyed by the owning node's UnverifiedHash).
    fn file_asset(
        &mut self,
        decl: Option<&ObjectDeclaration>,
        unverified_hash: Option<&str>,
    ) -> (AssetStatus, Option<AssetInfo>) {
        let Some(decl) = decl else {
            return (AssetStatus::Missing, None);
        };
        let fd_ref = decl.file_data_reference.as_deref();
        let extension = decl.extension.as_deref().filter(|e| !e.is_empty());
        let mut resolved: Option<ResolvedFileData> = None;
        let mut bytes: Option<&[u8]> = self.store.file_data_for(decl);
        if bytes.is_none() && !fd_ref.is_some_and(|r| r.starts_with("<file>")) {
            if let Some(resolve) = &self.opts.resolve_file_data {
                let lookups = self.lookups.get_or_insert_with(FileDataLookups::default);
                lookups.requested += 1;
                let query = FileDataQuery {
                    container_id: decl.oid.key(),
                    unverified_hash: unverified_hash.map(str::to_string),
                    extension: extension.map(str::to_string),
                };
                resolved = resolve(&query);
                if resolved.is_some() {
                    lookups.resolved += 1;
                }
            }
        }
        if let Some(r) = &resolved {
            bytes = Some(&r.bytes);
        }
        let Some(bytes) = bytes else {
            let status = match fd_ref {
                Some(r) if r.starts_with("<invfdo>") => AssetStatus::NotEmbedded,
                Some(r) if r.starts_with("<file>") => AssetStatus::External,
                _ => AssetStatus::Missing,
            };
            return (status, None);
        };
        let media_type = sniff_media_type(bytes, extension);
        let id = decl.oid.key();
        let reference = match &mut self.opts.on_asset {
            Some(hook) => hook(Asset {
                id: &id,
                bytes,
                extension,
                media_type: &media_type,
            }),
            None => None,
        };
        let info = AssetInfo {
            byte_length: bytes.len(),
            media_type,
            extension: extension.map(str::to_string),
            source: resolved.map(|r| r.source),
            reference,
        };
        (AssetStatus::Embedded, Some(info))
    }

    fn convert_image(&mut self, ctx: Ctx<'s>, decl: &ObjectDeclaration) -> ImageBlock {
        let p = self.props(Some(decl));
        let container = self.resolve_first(ctx, &p.oids(prop::PICTURE_CONTAINER));
        let mut layout = self.layout(&p);
        if let Some(pw) = half_inches(p.f32(prop::PICTURE_WIDTH)) {
            // Assigning a key the object lacks appends it (after height).
            layout.width_after_height = layout.width.is_none() && layout.height.is_some();
            layout.width = Some(pw);
        }
        if let Some(ph) = half_inches(p.f32(prop::PICTURE_HEIGHT)) {
            layout.height = Some(ph);
        }
        let unverified_hash = p
            .bytes(prop::UNVERIFIED_HASH)
            .filter(|b| b.len() == 20)
            .map(hex);
        let alt_text = p.str(prop::IMAGE_ALT_TEXT);
        let filename = p.str(prop::IMAGE_FILENAME);
        let hyperlink = p.str(prop::WZ_HYPERLINK_URL);
        let is_background = p.bool(prop::IS_BACKGROUND).filter(|&b| b);
        let ocr_text = p
            .str(prop::RICH_EDIT_TEXT_UNICODE)
            .filter(|s| !s.is_empty());
        let (asset_status, asset) = self.file_asset(container, unverified_hash.as_deref());
        ImageBlock {
            r#type: "image",
            id: decl.oid.key(),
            layout,
            alt_text,
            filename,
            hyperlink,
            is_background,
            ocr_text,
            unverified_hash,
            asset_status,
            asset,
        }
    }

    fn convert_embedded_file(
        &mut self,
        ctx: Ctx<'s>,
        decl: &ObjectDeclaration,
    ) -> EmbeddedFileBlock {
        let p = self.props(Some(decl));
        let container = self.resolve_first(ctx, &p.oids(prop::EMBEDDED_FILE_CONTAINER));
        let hash = p
            .bytes(prop::UNVERIFIED_HASH)
            .filter(|b| b.len() == 20)
            .map(hex);
        let (asset_status, asset) = self.file_asset(container, hash.as_deref());
        EmbeddedFileBlock {
            r#type: "embeddedFile",
            id: decl.oid.key(),
            layout: self.layout(&p),
            filename: p.str(prop::EMBEDDED_FILE_NAME),
            source_path: p.str(prop::SOURCE_FILEPATH),
            asset_status,
            asset,
        }
    }

    fn convert_table(&mut self, ctx: Ctx<'s>, decl: &ObjectDeclaration) -> TableBlock {
        let p = self.props(Some(decl));
        let mut widths = Vec::new();
        if let Some(wb) = p.bytes(prop::TABLE_COLUMN_WIDTHS).filter(|b| !b.is_empty()) {
            // cColumns (u8) followed by float32 widths.
            let mut i = 0usize;
            while i < usize::from(wb[0]) && 1 + i * 4 + 4 <= wb.len() {
                let at = 1 + i * 4;
                let w = f64::from(f32::from_le_bytes([
                    wb[at],
                    wb[at + 1],
                    wb[at + 2],
                    wb[at + 3],
                ]));
                widths.push(round(w * HALF_INCH_PT));
                i += 1;
            }
        }
        let inner = ctx.deeper();
        let mut rows = Vec::new();
        for ro in p.oids(prop::ELEMENT_CHILD_NODES) {
            let Some(row) = self
                .resolve(inner, &ro)
                .filter(|d| d.jcid.raw == jcid::TABLE_ROW_NODE)
            else {
                continue;
            };
            let mut cells = Vec::new();
            for co in self.props(Some(row)).oids(prop::ELEMENT_CHILD_NODES) {
                let Some(cell) = self
                    .resolve(inner, &co)
                    .filter(|d| d.jcid.raw == jcid::TABLE_CELL_NODE)
                else {
                    continue;
                };
                let cp = self.props(Some(cell));
                let shading = color_ref(cp.u32(prop::CELL_SHADING_COLOR));
                let children = self.convert_elements(inner, &cp.oids(prop::ELEMENT_CHILD_NODES));
                cells.push(TableCell {
                    id: cell.oid.key(),
                    shading,
                    children,
                });
            }
            rows.push(TableRow {
                id: row.oid.key(),
                cells,
            });
        }
        TableBlock {
            r#type: "table",
            id: decl.oid.key(),
            row_count: p.u32(prop::ROW_COUNT),
            column_count: p.u32(prop::COLUMN_COUNT),
            column_widths: widths,
            borders_visible: p.bool(prop::TABLE_BORDERS_VISIBLE),
            rows,
        }
    }

    fn unknown(&self, decl: &ObjectDeclaration) -> UnknownBlock {
        UnknownBlock {
            r#type: "unknown",
            id: decl.oid.key(),
            jcid: format!("0x{:x}", decl.jcid.raw),
            jcid_name: jcid_name(decl.jcid.raw),
            properties: describe_properties(self.store.property_set(decl).as_deref()),
        }
    }
}

/// `/﷟HYPERLINK "([^"]*)"/` on UTF-16: (match start, match end, url).
fn find_hyperlink(s: &[u16]) -> Option<(usize, usize, Vec<u16>)> {
    let prefix: Vec<u16> = "\u{fddf}HYPERLINK \"".encode_utf16().collect();
    let start = s
        .windows(prefix.len())
        .position(|w| w == prefix.as_slice())?;
    let url_start = start + prefix.len();
    // No closing quote after the first prefix means none after a later one either.
    let close = s[url_start..].iter().position(|&c| c == u16::from(b'"'))? + url_start;
    Some((start, close + 1, s[url_start..close].to_vec()))
}

/// Text of every rich text block under `elements`, depth first, joined by spaces.
pub fn plain_text(elements: &[OutlineElementBlock]) -> String {
    fn walk(els: &[OutlineElementBlock], parts: &mut Vec<String>) {
        for e in els {
            for c in &e.content {
                if let ContentBlock::RichText(t) = c {
                    parts.push(t.text.clone());
                }
            }
            walk(&e.children, parts);
        }
    }
    let mut parts = Vec::new();
    walk(elements, &mut parts);
    parts.join(" ")
}

// --- generic property rendering (unknown blocks and raw dumps) -------------------

const STRING_PROPS: [u32; 18] = [
    prop::FONT,
    prop::RICH_EDIT_TEXT_UNICODE,
    prop::NUMBER_LIST_FORMAT,
    prop::LIST_FONT,
    prop::CACHED_TITLE_STRING,
    prop::CACHED_TITLE_STRING_FROM_PAGE,
    prop::AUTHOR,
    prop::EMBEDDED_FILE_NAME,
    prop::SOURCE_FILEPATH,
    prop::CONFLICTING_USER_NAME,
    prop::IMAGE_FILENAME,
    prop::IMAGE_ALT_TEXT,
    prop::PARAGRAPH_STYLE_ID,
    prop::NOTE_TAG_LABEL,
    prop::SECTION_DISPLAY_NAME,
    prop::NEXT_STYLE,
    prop::WZ_HYPERLINK_URL,
    prop::NOTEBOOK_MANAGEMENT_ENTITY_GUID,
];

pub fn describe_properties(set: Option<&PropertySet>) -> Described {
    let mut out = Vec::new();
    for p in set.map(|s| s.properties.as_slice()).unwrap_or(&[]) {
        Described::set(&mut out, prop_name(p.id), describe_value(p));
    }
    Described::Object(out)
}

fn describe_value(p: &Property) -> Described {
    let ids = |ids: &[Option<ExtendedGuid>], single: bool| {
        let keys: Vec<Described> = ids
            .iter()
            .map(|x| x.map_or(Described::Null, |g| Described::String(g.key())))
            .collect();
        if single {
            keys.into_iter().next().unwrap_or(Described::Null)
        } else {
            Described::Array(keys)
        }
    };
    match &p.value {
        PropertyValue::None => Described::Null,
        PropertyValue::Bool(b) => Described::Bool(*b),
        PropertyValue::Bytes(b) => {
            if STRING_PROPS.contains(&p.id) {
                return Described::String(utf16le(b));
            }
            match b.len() {
                1 => Described::Number(f64::from(b[0])),
                2 => Described::Number(f64::from(u16::from_le_bytes([b[0], b[1]]))),
                4 => {
                    let f = f64::from(f32::from_le_bytes([b[0], b[1], b[2], b[3]]));
                    let u = u32::from_le_bytes([b[0], b[1], b[2], b[3]]);
                    // Report plausible floats as floats (layout values), everything else as integers.
                    if f.abs() > 1e-4 && f.abs() < 1e5 && (f64::from(u) / 1e7).fract() != 0.0 {
                        Described::Object(vec![
                            ("u32".into(), Described::Number(f64::from(u))),
                            ("f32".into(), Described::Number(round(f))),
                        ])
                    } else {
                        Described::Number(f64::from(u))
                    }
                }
                8 => Described::String(
                    u64::from_le_bytes(b[..8].try_into().unwrap_or([0; 8])).to_string(),
                ),
                n if n > 64 => Described::Object(vec![
                    ("hex".into(), Described::String(hex(&b[..64]))),
                    ("byteLength".into(), Described::Number(n as f64)),
                ]),
                _ => Described::Object(vec![("hex".into(), Described::String(hex(b)))]),
            }
        }
        PropertyValue::Oids { ids: v, single }
        | PropertyValue::Osids { ids: v, single }
        | PropertyValue::ContextIds { ids: v, single } => ids(v, *single),
        PropertyValue::PropertyValues { sets, .. } => {
            Described::Array(sets.iter().map(|s| describe_properties(Some(s))).collect())
        }
        PropertyValue::PropertySet(s) => describe_properties(Some(s)),
    }
}

// --- raw object graph dump ------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectGraph<'s> {
    pub header: &'s crate::onestore::Header,
    pub root_object_space: Option<String>,
    pub file_data: Vec<&'s crate::onestore::FileData>,
    pub file_node_list_fragments: &'s [crate::onestore::Fragment],
    pub object_spaces: Vec<SpaceDump>,
    pub warnings: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceDump {
    pub gosid: String,
    pub encrypted: bool,
    pub role_assignments: Vec<RoleDump>,
    pub revisions: Vec<RevisionDump>,
}

#[derive(Serialize)]
pub struct RoleDump {
    pub rid: String,
    pub role: u32,
    pub context: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RevisionDump {
    pub rid: String,
    pub rid_dependent: Option<String>,
    pub role: u32,
    pub roots: RootsDump,
    pub objects: Vec<ObjectDump>,
}

/// `Object.fromEntries(roots)`: array-index keys first in numeric order, then the rest.
pub struct RootsDump(Vec<(u32, String)>);

impl Serialize for RootsDump {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let mut entries: Vec<&(u32, String)> =
            self.0.iter().filter(|(k, _)| *k != u32::MAX).collect();
        entries.sort_by_key(|(k, _)| *k);
        entries.extend(self.0.iter().filter(|(k, _)| *k == u32::MAX));
        let mut m = s.serialize_map(Some(entries.len()))?;
        for (k, v) in entries {
            m.serialize_entry(&k.to_string(), v)?;
        }
        m.end()
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectDump {
    pub oid: String,
    pub jcid: String,
    pub r#type: String,
    pub declared_by: &'static str,
    #[serde(rename = "ref", skip_serializing_if = "is_none")]
    pub chunk: Option<crate::onestore::FileChunkReference>,
    #[serde(skip_serializing_if = "is_none")]
    pub file_data_reference: Option<String>,
    pub properties: Described,
}

/// The whole revision-store object graph (`--raw`): header, fragments, object
/// spaces, revisions and every property.
pub fn dump_object_graph<'s>(store: &'s OneStore) -> ObjectGraph<'s> {
    let object_spaces = store
        .object_spaces
        .values()
        .map(|sp| SpaceDump {
            gosid: sp.gosid.key(),
            encrypted: sp.encrypted,
            role_assignments: sp
                .role_assignments
                .iter()
                .map(|a| RoleDump {
                    rid: a.rid.key(),
                    role: a.role,
                    context: a.context.map(|c| c.key()),
                })
                .collect(),
            revisions: sp
                .revisions
                .values()
                .map(|r| RevisionDump {
                    rid: r.rid.key(),
                    rid_dependent: (!r.rid_dependent.is_nil()).then(|| r.rid_dependent.key()),
                    role: r.role,
                    roots: RootsDump(
                        r.roots
                            .iter()
                            .map(|(role, oid)| (*role, oid.key()))
                            .collect(),
                    ),
                    objects: r
                        .objects
                        .values()
                        .map(|o| ObjectDump {
                            oid: o.oid.key(),
                            jcid: format!("0x{:x}", o.jcid.raw),
                            r#type: jcid_name(o.jcid.raw),
                            declared_by: o.declared_by,
                            chunk: o.chunk,
                            file_data_reference: o.file_data_reference.clone(),
                            properties: describe_properties(store.property_set(o).as_deref()),
                        })
                        .collect(),
                })
                .collect(),
        })
        .collect();
    ObjectGraph {
        header: &store.header,
        root_object_space: store.root_gosid.map(|g| g.key()),
        file_data: store.file_data.values().collect(),
        file_node_list_fragments: &store.fragments,
        object_spaces,
        warnings: store.warnings(),
    }
}
