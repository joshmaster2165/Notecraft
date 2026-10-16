//! Tables, pictures, attachments and ink.
//!
//! - TableNode → TableRowNode → TableCellNode → outline elements ([MS-ONE]
//!   §2.2.26–§2.2.28). Columns get `TableColumnWidths` (half-inches, at least
//!   1.0) and are locked (`TableColumnsLocked`) so OneNote keeps the widths.
//! - ImageNode (§2.2.24) → PictureContainer14 file data (§2.2.36). Floating
//!   pictures sit in the PageNode with `OffsetFromParentHoriz/Vert`. A crop
//!   stores the uncropped picture and the kept rectangle as the four
//!   `ImageCropped*Percentage` properties, float32 fractions (0–1) of the
//!   picture; PictureWidth/Height are the cropped frame. File Printout pages
//!   set `IsPrintoutPage` and `OriginalPageNumber` (1-based).
//! - EmbeddedFileNode (§2.2.32) → EmbeddedFileContainer file data (§2.2.33),
//!   with a document icon in its PictureContainer.
//! - Page ink: one InkContainer holding every stroke (see [`crate::ink`]).

use crate::guid::Guid;
use crate::ink::{encode_path, path_values, HIMETRIC_PER_PT};
use crate::media::{self, decode_data_url, file_icon, ICON_H, ICON_W};
use crate::model::{FileAttachment, ImageData, InkStroke, Table, Tag};
use crate::page::{align, half_inches, indent_distance, PageWriter};
use crate::propset::{ObjIdx, PropSet};
use crate::schema::{jcid, prop, INK_DIMENSION_X, INK_DIMENSION_Y, LCID_EN_US};
use crate::text::clean_line;
use crate::WriteError;

/// Default column width for columns Notecraft gives no width (points).
const DEFAULT_COLUMN_PT: f64 = 120.0;

impl PageWriter<'_> {
    // --- tables --------------------------------------------------------------------

    pub(crate) fn table(
        &mut self,
        key: &str,
        t: &Table,
        tags: &[Tag],
    ) -> Result<ObjIdx, WriteError> {
        let idx = self.reserve("table", key, jcid::TABLE_NODE);
        let widest = t.rows.iter().map(|r| r.cells.len()).max().unwrap_or(0);
        let cols = t.columns.len().max(widest).clamp(1, 255);
        if t.columns.len().max(widest) > 255 {
            self.ctx
                .warnings
                .push(format!("table {key}: only the first 255 columns are kept"));
        }
        let mut rows = Vec::with_capacity(t.rows.len().max(1));
        let empty_row = crate::model::TableRow {
            id: String::new(),
            cells: Vec::new(),
        };
        let row_list: Vec<&crate::model::TableRow> = if t.rows.is_empty() {
            vec![&empty_row]
        } else {
            t.rows.iter().collect()
        };
        for row in row_list {
            let r = self.reserve("row", &row.id, jcid::TABLE_ROW_NODE);
            let mut cells = Vec::with_capacity(cols);
            for c in 0..cols {
                let cell = row.cells.get(c);
                let ci = self.reserve(
                    "cell",
                    cell.map_or("", |c| c.id.as_str()),
                    jcid::TABLE_CELL_NODE,
                );
                let mut children = match cell {
                    Some(cell) => self.element_tree(&cell.elements)?,
                    None => Vec::new(),
                };
                if children.is_empty() {
                    children.push(self.empty_oe());
                }
                let mut p = PropSet::new();
                self.stamp(&mut p);
                p.oids(prop::ELEMENT_CHILD_NODES, children)
                    .bytes(prop::RG_OUTLINE_INDENT_DISTANCE, indent_distance())
                    .u8(prop::OUTLINE_ELEMENT_CHILD_LEVEL, 1)
                    .bool(prop::ENFORCE_OUTLINE_STRUCTURE, true);
                if let Some(shade) = cell.and_then(|c| c.shading) {
                    p.u32(prop::CELL_SHADING_COLOR, shade.colorref());
                }
                self.sp.fill(ci, p);
                cells.push(ci);
            }
            let mut p = PropSet::new();
            self.stamp(&mut p);
            p.oids(prop::ELEMENT_CHILD_NODES, cells);
            self.sp.fill(r, p);
            rows.push(r);
        }
        let mut widths = vec![cols as u8];
        for c in 0..cols {
            let w = t
                .columns
                .get(c)
                .copied()
                .filter(|w| w.is_finite() && *w > 0.0)
                .unwrap_or(DEFAULT_COLUMN_PT);
            widths.extend_from_slice(&half_inches(w).max(1.0).to_le_bytes());
        }
        let mut locked = vec![cols as u8];
        locked.extend(std::iter::repeat_n(0xffu8, cols.div_ceil(8)));
        let mut p = PropSet::new();
        self.stamp(&mut p);
        p.u32(prop::ROW_COUNT, rows.len() as u32)
            .u32(prop::COLUMN_COUNT, cols as u32)
            .oids(prop::ELEMENT_CHILD_NODES, rows)
            .bool(prop::TABLE_BORDERS_VISIBLE, t.borders)
            .bytes(prop::TABLE_COLUMN_WIDTHS, widths)
            .bytes(prop::TABLE_COLUMNS_LOCKED, locked);
        if let Some(states) = self.note_tags(tags) {
            p.set(prop::NOTE_TAG_STATES, states);
        }
        self.sp.fill(idx, p);
        Ok(idx)
    }

    // --- file data -------------------------------------------------------------------

    /// A file data object for a `data:` URL, or `<invfdo>` when there are no
    /// bytes to store. Pictures take their extension from their format,
    /// attachments from their name.
    fn file_data(
        &mut self,
        kind: &str,
        key: &str,
        jcid: u32,
        src: Option<&str>,
        name: Option<&str>,
        what: &str,
    ) -> (ObjIdx, Option<String>) {
        let picture = jcid == jcid::PICTURE_CONTAINER14;
        let decoded = src.and_then(decode_data_url);
        if src.is_some() && decoded.is_none() {
            self.ctx.warnings.push(format!(
                "{what} {key}: src is not a data: URL; written without its bytes"
            ));
        }
        let oid = self.oid(kind, key);
        match decoded {
            Some(d) => {
                let sniffed = media::sniff(&d.bytes);
                let media_type = sniffed.map_or(d.media_type.clone(), str::to_string);
                let ext = media::extension(
                    if picture && sniffed.is_some() {
                        None
                    } else {
                        name
                    },
                    &media_type,
                );
                let ns = self.ctx.ns;
                let n = self.ctx.files.add(ns, d.bytes);
                let reference = self.ctx.files.reference(n);
                (
                    self.sp.add_file(oid, jcid, reference, ext),
                    Some(media_type),
                )
            }
            None => {
                let ext = media::extension(name, "");
                (self.sp.add_file(oid, jcid, "<invfdo>".into(), ext), None)
            }
        }
    }

    // --- pictures --------------------------------------------------------------------

    /// ImageNode; `floating` is its position on the page (points).
    pub(crate) fn image(
        &mut self,
        key: &str,
        img: &ImageData,
        floating: Option<(f64, f64)>,
        tags: &[Tag],
    ) -> ObjIdx {
        let idx = self.reserve("image", key, jcid::IMAGE_NODE);
        // With a crop, OneNote stores the whole picture and crops on display.
        let src = match (&img.crop, &img.original_src) {
            (Some(_), Some(orig)) => Some(orig.as_str()),
            (Some(_), None) => {
                self.ctx.warnings.push(format!(
                    "picture {key}: cropped without its original; the stored picture is already cropped"
                ));
                img.src.as_deref()
            }
            _ => img.src.as_deref(),
        };
        let (container, media_type) = self.file_data(
            "picture",
            key,
            jcid::PICTURE_CONTAINER14,
            src,
            img.filename.as_deref(),
            "picture",
        );
        if let Some(t) = media_type
            .as_deref()
            .filter(|t| !media::is_onenote_picture(t))
        {
            self.ctx.warnings.push(format!("picture {key}: {t} is not a format OneNote displays (PNG, JPEG, BMP, TIFF, EMF, WMF)"));
        }
        let (w, h) = (half_inches(img.width), half_inches(img.height));
        let mut p = PropSet::new();
        self.stamp(&mut p);
        p.oid(prop::PICTURE_CONTAINER, container)
            .u32(prop::LANGUAGE_ID, LCID_EN_US)
            .f32(prop::PICTURE_WIDTH, w)
            .f32(prop::PICTURE_HEIGHT, h)
            .f32(prop::LAYOUT_MAX_WIDTH, w)
            .f32(prop::LAYOUT_MAX_HEIGHT, h)
            .bool(prop::IS_LAYOUT_SIZE_SET_BY_USER, true);
        if let Some(f) = &img.filename {
            p.wz(prop::IMAGE_FILENAME, &clean_line(f));
        }
        if let Some(a) = &img.alt {
            p.wz(prop::IMAGE_ALT_TEXT, &clean_line(a));
        }
        if let Some(t) = &img.ocr_text {
            p.wz(prop::RICH_EDIT_TEXT_UNICODE, &t.replace('\0', ""))
                .u16(prop::RICH_EDIT_TEXT_LANG_ID, LCID_EN_US as u16);
        }
        match floating {
            Some((x, y)) => {
                p.f32(prop::OFFSET_FROM_PARENT_HORIZ, half_inches(x))
                    .f32(prop::OFFSET_FROM_PARENT_VERT, half_inches(y))
                    .u32(prop::LAYOUT_ALIGNMENT_SELF, align::MARGIN_LEFT);
            }
            None => {
                p.u32(prop::LAYOUT_ALIGNMENT_IN_PARENT, align::LEFT)
                    .u32(prop::LAYOUT_ALIGNMENT_SELF, align::LEFT);
            }
        }
        if let Some(c) = img.crop {
            // Percent in Notecraft, fractions of the uncropped picture in the file.
            let frac = |v: f64| (v.clamp(0.0, 100.0) / 100.0) as f32;
            p.f32(prop::IMAGE_CROPPED_WIDTH, frac(c.width))
                .f32(prop::IMAGE_CROPPED_HEIGHT, frac(c.height))
                .f32(prop::IMAGE_CROPPED_TOP_LEFT_X, frac(c.x))
                .f32(prop::IMAGE_CROPPED_TOP_LEFT_Y, frac(c.y));
        }
        if let Some(page) = img.printout {
            p.bool(prop::IS_PRINTOUT_PAGE, true)
                .u32(prop::ORIGINAL_PAGE_NUMBER, page);
        }
        if let Some(states) = self.note_tags(tags) {
            p.set(prop::NOTE_TAG_STATES, states);
        }
        self.sp.fill(idx, p);
        idx
    }

    // --- attachments -----------------------------------------------------------------

    pub(crate) fn file(&mut self, key: &str, f: &FileAttachment, tags: &[Tag]) -> ObjIdx {
        let idx = self.reserve("file", key, jcid::EMBEDDED_FILE_NODE);
        let name = clean_line(&f.name);
        let (container, _) = self.file_data(
            "file-data",
            key,
            jcid::EMBEDDED_FILE_CONTAINER,
            f.src.as_deref(),
            Some(&name),
            "attachment",
        );
        let ns = self.ctx.ns;
        let n = self.ctx.files.add(ns, file_icon());
        let reference = self.ctx.files.reference(n);
        let oid = self.oid("file-icon", key);
        let icon = self
            .sp
            .add_file(oid, jcid::PICTURE_CONTAINER14, reference, ".png".into());
        // The icon is shown at 96 dpi.
        let (iw, ih) = (
            half_inches(f64::from(ICON_W) * 0.75),
            half_inches(f64::from(ICON_H) * 0.75),
        );
        let mut p = PropSet::new();
        self.stamp(&mut p);
        p.oid(prop::PICTURE_CONTAINER, icon)
            .f32(prop::LAYOUT_MAX_WIDTH, iw)
            .f32(prop::LAYOUT_MAX_HEIGHT, ih)
            .u32(prop::LANGUAGE_ID, LCID_EN_US)
            .wz(prop::RICH_EDIT_TEXT_UNICODE, &name)
            .u16(prop::RICH_EDIT_TEXT_LANG_ID, LCID_EN_US as u16)
            .u32(prop::LAYOUT_ALIGNMENT_IN_PARENT, align::LEFT)
            .u32(prop::LAYOUT_ALIGNMENT_SELF, align::LEFT)
            .oid(prop::EMBEDDED_FILE_CONTAINER, container)
            .wz(prop::EMBEDDED_FILE_NAME, &name)
            .f32(prop::PICTURE_WIDTH, iw)
            .f32(prop::PICTURE_HEIGHT, ih);
        if let Some(states) = self.note_tags(tags) {
            p.set(prop::NOTE_TAG_STATES, states);
        }
        self.sp.fill(idx, p);
        idx
    }

    // --- ink ---------------------------------------------------------------------------

    /// One InkContainer for the page's strokes; also returns the ink's right
    /// and bottom edges in points.
    pub(crate) fn ink(&mut self, strokes: &[InkStroke]) -> Option<(ObjIdx, f64, f64)> {
        let strokes: Vec<&InkStroke> = strokes.iter().filter(|s| s.points.len() >= 2).collect();
        if strokes.is_empty() {
            return None;
        }
        let (mut l, mut t, mut r, mut b) = (
            f64::INFINITY,
            f64::INFINITY,
            f64::NEG_INFINITY,
            f64::NEG_INFINITY,
        );
        for s in &strokes {
            let pad = s.width / 2.0;
            for p in s.points.as_chunks::<2>().0 {
                l = l.min(p[0] - pad);
                t = t.min(p[1] - pad);
                r = r.max(p[0] + pad);
                b = b.max(p[1] + pad);
            }
        }
        // The container sits at the ink's top-left; strokes are HIMETRIC from there.
        let (ox, oy) = (half_inches(l), half_inches(t));
        let (ox_pt, oy_pt) = (f64::from(ox) * 36.0, f64::from(oy) * 36.0);
        let him = |v: f64| v.round().clamp(f64::from(i32::MIN), f64::from(i32::MAX)) as i64;

        let container = self.reserve("ink", "container", jcid::INK_CONTAINER);
        let data = self.reserve("ink", "data", jcid::INK_DATA_NODE);
        let mut nodes = Vec::with_capacity(strokes.len());
        let mut bbox = [i64::MAX, i64::MAX, i64::MIN, i64::MIN];
        for s in &strokes {
            let pts: Vec<(i64, i64)> = s
                .points
                .as_chunks::<2>()
                .0
                .iter()
                .map(|p| {
                    (
                        him((p[0] - ox_pt) * HIMETRIC_PER_PT),
                        him((p[1] - oy_pt) * HIMETRIC_PER_PT),
                    )
                })
                .collect();
            let half = him(s.width * HIMETRIC_PER_PT / 2.0);
            for &(x, y) in &pts {
                bbox = [
                    bbox[0].min(x - half),
                    bbox[1].min(y - half),
                    bbox[2].max(x + half),
                    bbox[3].max(y + half),
                ];
            }
            let props = self.stroke_properties(s);
            let mut p = PropSet::new();
            p.bytes(prop::INK_PATH, encode_path(&path_values(&pts)))
                .u8(prop::INK_BIAS, if s.highlighter || s.shape { 1 } else { 2 })
                .oid(prop::INK_STROKE_PROPERTIES, props);
            nodes.push(self.add("ink-stroke", &s.id, jcid::INK_STROKE_NODE, p));
        }
        let mut box_bytes = Vec::with_capacity(16);
        for v in bbox {
            box_bytes.extend_from_slice(
                &(v.clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32).to_le_bytes(),
            );
        }
        let mut p = PropSet::new();
        p.oids(prop::INK_STROKES, nodes)
            .bytes(prop::INK_BOUNDING_BOX, box_bytes);
        self.sp.fill(data, p);

        let mut p = PropSet::new();
        self.stamp(&mut p);
        p.f32(prop::OFFSET_FROM_PARENT_HORIZ, ox)
            .f32(prop::OFFSET_FROM_PARENT_VERT, oy)
            .oid(prop::INK_DATA, data);
        self.sp.fill(container, p);
        Some((container, r, b))
    }

    /// StrokePropertiesNode, shared by strokes drawn with the same pen.
    fn stroke_properties(&mut self, s: &InkStroke) -> ObjIdx {
        let mut dims = Vec::with_capacity(64);
        for g in [INK_DIMENSION_X, INK_DIMENSION_Y] {
            dims.extend_from_slice(&Guid::parse(g).0);
            dims.extend_from_slice(&0i32.to_le_bytes()); // lower limit
            dims.extend_from_slice(&i32::MAX.to_le_bytes()); // upper limit
            dims.extend_from_slice(&2u32.to_le_bytes()); // units: centimetres
            dims.extend_from_slice(&1000f32.to_le_bytes()); // resolution: HIMETRIC
        }
        let size = (s.width * HIMETRIC_PER_PT) as f32;
        let mut p = PropSet::new();
        p.bytes(prop::INK_DIMENSIONS, dims)
            .f32(prop::INK_WIDTH, size)
            .f32(prop::INK_HEIGHT, size)
            .u32(prop::INK_COLOR, s.color.map_or(0, |c| c.colorref()));
        if s.highlighter {
            // Windows Ink's highlighter: a mask pen with a rectangular tip.
            p.u8(prop::INK_RASTER_OPERATION, 9)
                .u8(prop::INK_PEN_TIP_SHAPE, 1);
        }
        self.shared(jcid::STROKE_PROPERTIES_NODE, "ink-pen", p)
    }
}
