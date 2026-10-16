//! Writes a Notecraft section as a OneNote section file (`.one`): the
//! [MS-ONESTORE] revision store of OneNote 2010 and later (file format
//! {109ADD3F-911B-49F5-A5D0-1791EDC8AED8}) holding the [MS-ONE] object model.
//!
//! ```
//! let section = serde_json::json!({
//!     "id": "s1", "name": "Notes", "color": "#4f7cac", "createdAt": "2026-10-01T09:00:00Z",
//!     "pages": [{
//!         "id": "p1", "title": "Hello", "level": 1,
//!         "createdAt": "2026-10-01T09:00:00Z", "modifiedAt": "2026-10-02T10:00:00Z",
//!         "outlines": [{ "id": "o1", "x": 54, "y": 90, "width": 520, "widthSetByUser": true,
//!             "elements": [{ "id": "e1", "kind": "text", "depth": 0, "style": "p",
//!                 "runs": [{ "text": "First line" }] }] }],
//!         "images": []
//!     }]
//! });
//! let bytes = onenote_writer::write_section(&section).unwrap();
//! assert_eq!(&bytes[0x30..0x34], &[0x3f, 0xdd, 0x9a, 0x10]); // guidFileFormat
//! ```
//!
//! The reader in `onenote-re/parser-rs` is the inverse; `docs/file-format.md`
//! describes the format. Modules, bottom up:
//! - [`crc`]: the CRC-32 of crcName, the transaction log and reference counts.
//! - `guid`: GUIDs, ExtendedGUIDs, name-based (deterministic) GUIDs.
//! - `store`: header, transaction log, hashed chunk list, FileNodeList
//!   fragments, FileNodes, FileDataStoreObjects.
//! - `propset`: ObjectSpaceObjectPropSets (OID/OSID streams, PropertySets).
//! - `space`: object spaces, revision manifests, object groups, global id
//!   tables, declarations and reference counts.
//! - `section`, `page`, `text`, `content`, `ink`, `media`: the [MS-ONE]
//!   objects for sections, pages, outlines, rich text, lists, note tags,
//!   tables, pictures, attachments, ink and equations.
//!
//! Each section becomes one object space per page plus the section's, each
//! with a single revision. Not written: page version history, conflict
//! pages, paper color and rule lines, hidden titles, password protection,
//! OneNote's built-up equation objects (equations are their linear text in
//! math-formatted runs), handwriting inside outlines and recordings.
//!
//! Output is deterministic: identities are name-based GUIDs derived from
//! Notecraft ids, and nothing reads a clock, randomness, threads or files,
//! so the crate also builds for `wasm32-unknown-unknown`.

mod content;
pub mod crc;
mod guid;
mod ink;
mod media;
mod model;
mod page;
mod propset;
mod schema;
mod section;
mod space;
mod store;
mod text;
mod time;

use std::fmt;

use serde_json::Value;

use crate::guid::Guid;
use crate::page::{write_page, Ctx};
use crate::store::{fnd, FileNode, FileNodeList, HeaderInfo, Target, Writer};

/// Why a section could not be written.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WriteError {
    /// The input is not a Notecraft section (not a JSON object).
    InvalidInput(String),
    /// The section does not fit the format (over 4 GiB, more than 2^24
    /// objects on a page…).
    TooLarge(String),
    /// A bug in the writer: it produced something it refuses to write.
    Internal(String),
}

impl WriteError {
    pub(crate) fn internal(msg: impl Into<String>) -> WriteError {
        WriteError::Internal(msg.into())
    }
}

impl fmt::Display for WriteError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            WriteError::InvalidInput(m) => write!(f, "invalid section: {m}"),
            WriteError::TooLarge(m) => write!(f, "section too large: {m}"),
            WriteError::Internal(m) => write!(f, "internal error: {m}"),
        }
    }
}

impl std::error::Error for WriteError {}

/// Options for [`write_section_with`].
#[derive(Debug, Clone, Default)]
pub struct WriteOptions {
    /// The name the file will be saved under, e.g. `"Notes.one"`. OneNote
    /// keeps a CRC of it in the header (`crcName`); by default it is
    /// [`suggested_file_name`].
    pub file_name: Option<String>,
}

/// A written section.
#[derive(Debug, Clone)]
pub struct WriteOutput {
    pub bytes: Vec<u8>,
    /// What was left out or approximated (e.g. a picture without data).
    pub warnings: Vec<String>,
}

/// Namespace of every name-based GUID this crate makes.
const NAMESPACE: Guid = Guid::parse("{5E7C1F2A-0B4D-4C8E-9A61-3D2F8B7E4C10}");

/// Write one Notecraft section (`Section` in `notecraft/src/model/types.ts`)
/// as a `.one` file.
pub fn write_section(section: &Value) -> Result<Vec<u8>, WriteError> {
    write_section_with(section, &WriteOptions::default()).map(|o| o.bytes)
}

/// [`write_section`] with options, also returning warnings.
pub fn write_section_with(
    section: &Value,
    options: &WriteOptions,
) -> Result<WriteOutput, WriteError> {
    let model = model::Section::from_json(section)
        .ok_or_else(|| WriteError::InvalidInput("expected a JSON object".into()))?;
    let mut early_warnings = Vec::new();
    if section.get("locked").is_some_and(Value::is_object) {
        early_warnings.push("the section is locked: its sealed pages are not written".to_string());
    }
    let key = if model.id.is_empty() {
        format!("name:{}", model.name)
    } else {
        model.id.clone()
    };
    let ns = Guid::name_based(NAMESPACE, &format!("section:{key}"));
    let mut ctx = Ctx::new(ns, model.created_at);
    ctx.warnings = early_warnings;

    // PageLevel 1–3; the first page of a section starts a series (level 1).
    let mut pages = Vec::with_capacity(model.pages.len());
    for (i, page) in model.pages.iter().enumerate() {
        let level = if i == 0 { 1 } else { page.level.clamp(1, 3) };
        pages.push(write_page(&mut ctx, &model, page, i, level)?);
    }
    let sec = section::write_section(&mut ctx, &model, &pages);

    // Root file node list ([MS-ONESTORE] §2.1.14), in OneNote's order: the
    // section space, the root marker, the page spaces, the file data store.
    let mut root = FileNodeList::default();
    let space_ref = |space: space::Space, rid, group| -> Result<FileNode, WriteError> {
        let gosid = space.gosid;
        Ok(FileNode {
            id: fnd::OBJECT_SPACE_MANIFEST_LIST_REFERENCE,
            target: Target::List(space.into_manifest(rid, group)?),
            data: gosid.bytes().to_vec(),
        })
    };
    let root_gosid = sec.space.gosid;
    root.push(space_ref(sec.space, sec.rid, sec.group)?);
    root.push(FileNode::plain(
        fnd::OBJECT_SPACE_MANIFEST_ROOT,
        root_gosid.bytes().to_vec(),
    ));
    for p in pages {
        root.push(space_ref(p.space, p.rid, p.group)?);
    }
    let files = std::mem::take(&mut ctx.files);
    if !files.files.is_empty() {
        let mut store = FileNodeList::default();
        for (i, g) in files.guids.iter().enumerate() {
            store.push(FileNode {
                id: fnd::FILE_DATA_STORE_OBJECT_REFERENCE,
                target: Target::FileData(i),
                data: g.0.to_vec(),
            });
        }
        root.push(FileNode {
            id: fnd::FILE_DATA_STORE_LIST_REFERENCE,
            target: Target::List(store),
            data: Vec::new(),
        });
    }

    let file_name = options
        .file_name
        .clone()
        .unwrap_or_else(|| suggested_file_name(section));
    let info = HeaderInfo {
        guid_file: Guid::name_based(ns, "file"),
        crc_name: crc::file_name_crc(&file_name),
    };
    let mut w = Writer::new(&files.files);
    let root_chunk = w.list(root)?;
    let bytes = w.finish(root_chunk, &info)?;
    Ok(WriteOutput {
        bytes,
        warnings: ctx.warnings,
    })
}

/// The file name a section is saved under: its name, made safe for a file
/// system, plus `.one`.
pub fn suggested_file_name(section: &Value) -> String {
    let name = section.get("name").and_then(Value::as_str).unwrap_or("");
    let mut safe: String = name
        .chars()
        .map(|c| {
            if c.is_control() || "\\/:*?\"<>|".contains(c) {
                '_'
            } else {
                c
            }
        })
        .collect();
    safe = safe
        .trim()
        .trim_end_matches('.')
        .trim()
        .chars()
        .take(120)
        .collect();
    if safe.is_empty() {
        safe = "Section".into();
    }
    format!("{safe}.one")
}
