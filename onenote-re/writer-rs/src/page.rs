//! Page object spaces ([MS-ONE] §2.1.10): one revision whose roots are the
//! PageManifestNode (content), PageMetaData (metadata) and RevisionMetaData
//! (version metadata), with the page tree below the manifest:
//!
//! ```text
//!   PageManifestNode ─ContentChildNodes→ PageNode
//!     PageNode ─StructureElementChildNodes→ TitleNode ─→ title OutlineNode, date/time OutlineNode
//!              ─ElementChildNodes→ OutlineNode… · floating ImageNode… · InkContainer
//!     OutlineNode ─ElementChildNodes→ OutlineElementNode ─ContentChildNodes→ one content node
//!                                                        ─ElementChildNodes→ indented children
//!                                                        ─ListNodes→ NumberListNode
//! ```
//!
//! Property choices mirror OneNote's own pages ([MS-ONE] §3.1 and the
//! OneNote for Mac files in `docs/file-format.md`): the title and date
//! outlines, page margins, RgOutlineIndentDistance {0.5, 0, 0.75, 0.75},
//! LayoutAlignmentSelf 9 for body outlines and 12 for the title. Layout is in
//! half-inches; Notecraft's points are divided by 36.

use std::collections::{HashMap, HashSet};

use crate::guid::{ExGuid, Guid};
use crate::media::FileStore;
use crate::model::{Element, ElementKind, Outline, Page, Section};
use crate::propset::{ObjIdx, PropSet};
use crate::schema::{jcid, prop, SCHEMA_REVISION};
use crate::space::{role, Space};
use crate::time::Timestamp;
use crate::WriteError;

/// Points per half-inch, the layout unit.
pub(crate) const PT_PER_HALF_INCH: f64 = 36.0;

pub(crate) fn half_inches(pt: f64) -> f32 {
    (pt / PT_PER_HALF_INCH) as f32
}

/// When a section or page has no usable timestamp: 2020-01-01T00:00:00Z.
const FALLBACK_TIME: Timestamp = Timestamp(1_577_836_800_000);

/// `RgOutlineIndentDistance` as OneNote writes it: four levels.
pub(crate) fn indent_distance() -> Vec<u8> {
    let mut b = vec![4, 0, 0, 0];
    for v in [0.5f32, 0.0, 0.75, 0.75] {
        b.extend_from_slice(&v.to_le_bytes());
    }
    b
}

/// LayoutAlignment ([MS-ONE] §2.3.2) values OneNote uses.
pub(crate) mod align {
    pub const LEFT: u32 = 1;
    pub const CENTER: u32 = 2;
    pub const RIGHT: u32 = 3;
    /// Left, relative to the page margin: body outlines and floating pictures.
    pub const MARGIN_LEFT: u32 = 9;
    /// Left (or right on right-to-left pages), relative to the margin: the title.
    pub const TITLE: u32 = 12;
    /// The TitleNode's alignment in the page: also top, against the top margin.
    pub const TITLE_IN_PAGE: u32 = 0x0009_000c;
}

/// Shared state for one file: identities, file data and warnings.
pub(crate) struct Ctx {
    pub ns: Guid,
    pub files: FileStore,
    pub warnings: Vec<String>,
    used: HashSet<Guid>,
    pub section_created: Timestamp,
}

impl Ctx {
    pub fn new(ns: Guid, section_created: Option<Timestamp>) -> Ctx {
        Ctx {
            ns,
            files: FileStore::default(),
            warnings: Vec::new(),
            used: HashSet::new(),
            section_created: section_created.unwrap_or(FALLBACK_TIME),
        }
    }

    /// A GUID named `name` in this file, unique even if Notecraft ids repeat.
    pub fn guid(&mut self, name: &str) -> Guid {
        let mut g = Guid::name_based(self.ns, name);
        let mut k = 1;
        while g.is_nil() || !self.used.insert(g) {
            k += 1;
            g = Guid::name_based(self.ns, &format!("{name}~{k}"));
        }
        g
    }

    pub fn exguid(&mut self, name: &str) -> ExGuid {
        ExGuid::new(self.guid(name), 1)
    }
}

/// A written page: its object space plus what the section needs to know.
pub(crate) struct PageOut {
    pub space: Space,
    pub rid: ExGuid,
    pub group: ExGuid,
    pub level: u32,
    /// PageMetaData, also copied into the section ([MS-ONE] §2.2.81).
    pub metadata: PropSet,
}

pub(crate) struct PageWriter<'c> {
    pub ctx: &'c mut Ctx,
    pub sp: Space,
    key: String,
    counter: usize,
    pub modified: u32,
    pub created: u32,
    pub created_ts: Timestamp,
    pub author: ObjIdx,
    /// Read-only objects without references, by content.
    shared: HashMap<(u32, Vec<u8>), ObjIdx>,
}

impl<'c> PageWriter<'c> {
    /// A fresh object id for `kind` (`key` is a Notecraft id when there is one).
    pub fn oid(&mut self, kind: &str, key: &str) -> ExGuid {
        let key = if key.is_empty() {
            self.counter += 1;
            format!("#{}", self.counter)
        } else {
            key.to_string()
        };
        let name = format!("{}/{kind}/{key}", self.key);
        self.ctx.exguid(&name)
    }

    /// Declare an object now, fill it later (parents before children).
    pub fn reserve(&mut self, kind: &str, key: &str, jcid: u32) -> ObjIdx {
        let oid = self.oid(kind, key);
        self.sp.reserve(oid, jcid)
    }

    pub fn add(&mut self, kind: &str, key: &str, jcid: u32, props: PropSet) -> ObjIdx {
        let oid = self.oid(kind, key);
        self.sp.add(oid, jcid, props)
    }

    /// A read-only object (style, tag definition, stroke properties), shared
    /// by everything on the page that needs the same one.
    pub fn shared(&mut self, jcid: u32, kind: &str, props: PropSet) -> ObjIdx {
        let key = (jcid, props.content_key());
        if let Some(&i) = self.shared.get(&key) {
            return i;
        }
        let oid = self.oid(kind, "");
        let i = self.sp.add(oid, jcid, props);
        self.shared.insert(key, i);
        i
    }

    /// LastModifiedTime: every node carries the page's modification time.
    pub fn stamp(&self, p: &mut PropSet) {
        p.u32(prop::LAST_MODIFIED_TIME, self.modified);
    }

    // --- outline elements --------------------------------------------------------

    /// Notecraft's flat element list (with `depth`) as a tree of
    /// OutlineElementNodes; returns the top-level ones. A depth more than one
    /// below the previous element is pulled up.
    pub fn element_tree(&mut self, elements: &[Element]) -> Result<Vec<ObjIdx>, WriteError> {
        let mut oes: Vec<ObjIdx> = Vec::with_capacity(elements.len());
        let mut contents: Vec<(ObjIdx, Option<ObjIdx>)> = Vec::with_capacity(elements.len());
        let mut children: Vec<Vec<ObjIdx>> = Vec::with_capacity(elements.len());
        let mut top = Vec::new();
        let mut stack: Vec<(usize, usize)> = Vec::new();
        let mut prev: Option<usize> = None;
        for e in elements {
            let depth = e.depth.min(prev.map_or(0, |d| d + 1));
            while stack.last().is_some_and(|&(d, _)| d >= depth) {
                stack.pop();
            }
            let i = oes.len();
            let oe = self.reserve("oe", &e.id, jcid::OUTLINE_ELEMENT_NODE);
            oes.push(oe);
            children.push(Vec::new());
            match stack.last() {
                Some(&(_, parent)) => children[parent].push(oe),
                None => top.push(oe),
            }
            stack.push((depth, i));
            prev = Some(depth);
            contents.push(self.content(e)?);
        }
        for (i, &(content, list)) in contents.iter().enumerate() {
            let p = self.oe_props(content, list, std::mem::take(&mut children[i]));
            self.sp.fill(oes[i], p);
        }
        Ok(top)
    }

    pub fn oe_props(
        &self,
        content: ObjIdx,
        list: Option<ObjIdx>,
        children: Vec<ObjIdx>,
    ) -> PropSet {
        let mut p = PropSet::new();
        self.stamp(&mut p);
        p.oid(prop::AUTHOR_MOST_RECENT, self.author)
            .oid(prop::AUTHOR_ORIGINAL, self.author)
            .u32(prop::CREATION_TIME_STAMP, self.created)
            .u8(prop::OUTLINE_ELEMENT_CHILD_LEVEL, 1)
            .oids(prop::CONTENT_CHILD_NODES, vec![content]);
        if let Some(l) = list {
            p.oids(prop::LIST_NODES, vec![l]);
        }
        if !children.is_empty() {
            p.oids(prop::ELEMENT_CHILD_NODES, children);
        }
        p
    }

    /// The content node of an element, and its NumberListNode.
    fn content(&mut self, e: &Element) -> Result<(ObjIdx, Option<ObjIdx>), WriteError> {
        let content = match &e.kind {
            ElementKind::Text(para) => self.rich_text(&e.id, para, &e.tags),
            ElementKind::Math(linear) => self.math(&e.id, linear, &e.tags),
            ElementKind::Table(t) => self.table(&e.id, t, &e.tags)?,
            ElementKind::Image(img) => self.image(&e.id, img, None, &e.tags),
            ElementKind::File(f) => self.file(&e.id, f, &e.tags),
        };
        let list = e.list.as_ref().map(|l| self.list_node(&e.id, l));
        Ok((content, list))
    }

    /// An outline element holding one empty paragraph.
    pub fn empty_oe(&mut self) -> ObjIdx {
        let oe = self.reserve("oe", "", jcid::OUTLINE_ELEMENT_NODE);
        let text = self.rich_text("", &crate::model::Paragraph::empty(), &[]);
        let p = self.oe_props(text, None, Vec::new());
        self.sp.fill(oe, p);
        oe
    }

    // --- outlines ------------------------------------------------------------------

    fn outline(&mut self, o: &Outline) -> Result<ObjIdx, WriteError> {
        let idx = self.reserve("outline", &o.id, jcid::OUTLINE_NODE);
        let mut children = self.element_tree(&o.elements)?;
        if children.is_empty() {
            // An outline holds at least one outline element ([MS-ONE] §2.2.51).
            children.push(self.empty_oe());
        }
        let mut p = PropSet::new();
        self.stamp(&mut p);
        p.oids(prop::ELEMENT_CHILD_NODES, children)
            .bytes(prop::RG_OUTLINE_INDENT_DISTANCE, indent_distance())
            .u8(prop::OUTLINE_ELEMENT_CHILD_LEVEL, 1)
            .f32(
                prop::LAYOUT_MAX_HEIGHT,
                estimate_height(&o.elements).max(0.2),
            )
            .f32(prop::LAYOUT_MAX_WIDTH, half_inches(o.width).max(1.0))
            .u32(prop::LAYOUT_ALIGNMENT_SELF, align::MARGIN_LEFT)
            .f32(prop::OFFSET_FROM_PARENT_HORIZ, half_inches(o.x))
            .f32(prop::OFFSET_FROM_PARENT_VERT, half_inches(o.y));
        if o.width_set_by_user {
            p.bool(prop::IS_LAYOUT_SIZE_SET_BY_USER, true);
        }
        self.sp.fill(idx, p);
        Ok(idx)
    }

    // --- title ---------------------------------------------------------------------

    /// TitleNode ([MS-ONE] §2.1.16): the title outline and the date/time outline.
    fn title(&mut self, title: &str) -> ObjIdx {
        let node = self.reserve("title", "node", jcid::TITLE_NODE);

        // Title text.
        let outline = self.reserve("title", "outline", jcid::OUTLINE_NODE);
        let oe = self.reserve("title", "oe", jcid::OUTLINE_ELEMENT_NODE);
        let text = self.boiler_text(title, "PageTitle", TitleText::Title);
        let mut p = self.oe_props(text, None, Vec::new());
        p.bool(prop::CANNOT_BE_SELECTED, true)
            .bool(prop::IS_TITLE_TEXT, true);
        self.sp.fill(oe, p);
        let mut p = PropSet::new();
        self.stamp(&mut p);
        p.oids(prop::ELEMENT_CHILD_NODES, vec![oe])
            .bool(prop::ENFORCE_OUTLINE_STRUCTURE, true)
            .u8(prop::OUTLINE_ELEMENT_CHILD_LEVEL, 1)
            .f32(prop::LAYOUT_MAX_HEIGHT, 0.6)
            .bytes(prop::RG_OUTLINE_INDENT_DISTANCE, indent_distance())
            .u32(prop::LAYOUT_ALIGNMENT_SELF, align::TITLE)
            .bool(prop::CANNOT_BE_SELECTED, true)
            .bool(prop::IS_TITLE_TEXT, true)
            .bool(prop::DESCENDANTS_CANNOT_BE_MOVED, true)
            .f32(prop::LAYOUT_MINIMUM_OUTLINE_WIDTH, 4.5)
            .bool(prop::LAYOUT_TIGHT_ALIGNMENT, true);
        self.sp.fill(outline, p);

        // Date and time, read-only boilerplate.
        let dates = self.reserve("title", "date-outline", jcid::OUTLINE_NODE);
        let mut lines = Vec::new();
        for (kind, text, which) in [
            ("date", self.created_ts.title_date(), TitleText::Date),
            ("time", self.created_ts.title_time(), TitleText::Time),
        ] {
            let oe = self.reserve("title", kind, jcid::OUTLINE_ELEMENT_NODE);
            let rt = self.boiler_text(&text, "PageDateTime", which);
            let mut p = self.oe_props(rt, None, Vec::new());
            p.bool(prop::DELETABLE, true)
                .bool(prop::CANNOT_BE_SELECTED, true);
            self.sp.fill(oe, p);
            lines.push(oe);
        }
        let mut p = PropSet::new();
        self.stamp(&mut p);
        p.oids(prop::ELEMENT_CHILD_NODES, lines)
            .u8(prop::OUTLINE_ELEMENT_CHILD_LEVEL, 1)
            .f32(prop::LAYOUT_MAX_HEIGHT, 0.6)
            .bytes(prop::RG_OUTLINE_INDENT_DISTANCE, indent_distance())
            .u32(prop::LAYOUT_ALIGNMENT_SELF, align::TITLE)
            .bool(prop::DELETABLE, true)
            .bool(prop::LAYOUT_TIGHT_LAYOUT, true)
            .bool(prop::IS_TITLE_DATE, true)
            .bool(prop::CANNOT_BE_SELECTED, true)
            .bool(prop::IS_READ_ONLY, true);
        self.sp.fill(dates, p);

        let mut p = PropSet::new();
        self.stamp(&mut p);
        p.oids(prop::ELEMENT_CHILD_NODES, vec![outline, dates])
            .f32(prop::OFFSET_FROM_PARENT_HORIZ, 0.0)
            .f32(prop::OFFSET_FROM_PARENT_VERT, 0.0)
            .u32(prop::LAYOUT_ALIGNMENT_IN_PARENT, align::TITLE_IN_PAGE)
            .u32(prop::LAYOUT_COLLISION_PRIORITY, 0);
        self.sp.fill(node, p);
        node
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum TitleText {
    Title,
    Date,
    Time,
}

/// Rough height of an outline's content in half-inches (OneNote lays the
/// page out again; this is only its starting suggestion).
fn estimate_height(elements: &[Element]) -> f32 {
    let line = 0.42f32;
    elements
        .iter()
        .map(|e| match &e.kind {
            ElementKind::Text(p) => {
                let chars: usize = p.runs.iter().map(|r| r.text.chars().count()).sum();
                line * (1 + chars / 90) as f32
            }
            ElementKind::Math(_) => line,
            ElementKind::Image(i) => half_inches(i.height),
            ElementKind::File(_) => 1.0,
            ElementKind::Table(t) => line * t.rows.len().max(1) as f32,
        })
        .sum()
}

/// Build one page's object space.
pub(crate) fn write_page(
    ctx: &mut Ctx,
    section: &Section,
    page: &Page,
    index: usize,
    level: u32,
) -> Result<PageOut, WriteError> {
    let key = format!(
        "page/{}",
        if page.id.is_empty() {
            format!("#{index}")
        } else {
            page.id.clone()
        }
    );
    let gosid = ctx.exguid(&format!("{key}/space"));
    let rid = ctx.exguid(&format!("{key}/revision"));
    let group = ctx.exguid(&format!("{key}/object-group"));
    let entity = ctx.guid(&format!("{key}/entity"));
    let created_ts = page
        .created_at
        .or(section.created_at)
        .unwrap_or(ctx.section_created);
    let modified_ts = page.modified_at.unwrap_or(created_ts).max(created_ts);

    let sp = Space::new(gosid);
    let mut w = PageWriter {
        ctx,
        sp,
        key,
        counter: 0,
        modified: modified_ts.time32(),
        created: created_ts.time32(),
        created_ts,
        author: 0,
        shared: HashMap::new(),
    };

    // Roots first, then the page tree in document order.
    let manifest = w.reserve("manifest", "", jcid::PAGE_MANIFEST_NODE);
    let meta_oid = w.oid("metadata", "");
    let author_name = page.author.clone().unwrap_or_else(|| "Notecraft".into());
    let mut a = PropSet::new();
    a.wz(prop::AUTHOR, &author_name);
    w.author = w.shared(jcid::AUTHOR, "author", a);
    let mut rm = PropSet::new();
    rm.u64(prop::LAST_MODIFIED_TIME_STAMP, modified_ts.filetime())
        .oid(prop::AUTHOR_MOST_RECENT, w.author);
    let revision_meta = w.add("revision-metadata", "", jcid::REVISION_META_DATA, rm);

    let page_node = w.reserve("page", "", jcid::PAGE_NODE);
    let title = w.title(&page.title);
    let mut blocks = Vec::new();
    let mut right = 0f64;
    let mut bottom = 0f64;
    for o in &page.outlines {
        blocks.push(w.outline(o)?);
        right = right.max(o.x + o.width);
        bottom = bottom.max(o.y + f64::from(estimate_height(&o.elements)) * PT_PER_HALF_INCH);
    }
    for img in &page.images {
        blocks.push(w.image(&img.id, &img.image, Some((img.x, img.y)), &[]));
        right = right.max(img.x + img.image.width);
        bottom = bottom.max(img.y + img.image.height);
    }
    if let Some(ink) = w.ink(&page.ink) {
        blocks.push(ink.0);
        right = right.max(ink.1);
        bottom = bottom.max(ink.2);
    }

    let mut p = PropSet::new();
    w.stamp(&mut p);
    p.oids(prop::STRUCTURE_ELEMENT_CHILD_NODES, vec![title]);
    if !blocks.is_empty() {
        p.oids(prop::ELEMENT_CHILD_NODES, blocks);
    }
    // OneNote's default page, grown to the content (at most 22 in).
    let width = (half_inches(right) + 2.0).clamp(20.94, 44.0);
    let height = (half_inches(bottom) + 1.0).clamp(21.75, 44.0);
    p.bool(prop::LAYOUT_RESOLVE_CHILD_COLLISIONS, true)
        .bool(prop::PORTRAIT_PAGE, true)
        .f32(prop::PAGE_WIDTH, width)
        .f32(prop::PAGE_HEIGHT, height)
        .f32(prop::PAGE_MARGIN_TOP, 1.0)
        .f32(prop::PAGE_MARGIN_BOTTOM, 1.0)
        .f32(prop::PAGE_MARGIN_LEFT, 2.0)
        .f32(prop::PAGE_MARGIN_RIGHT, 2.0)
        .f32(prop::PAGE_MARGIN_ORIGIN_X, 1.0)
        .f32(prop::PAGE_MARGIN_ORIGIN_Y, 0.4)
        .wz(prop::AUTHOR, &author_name)
        .bool(prop::EDIT_ROOT_RTL, false);
    w.sp.fill(page_node, p);

    let mut p = PropSet::new();
    p.oids(prop::CONTENT_CHILD_NODES, vec![page_node]);
    w.sp.fill(manifest, p);

    let mut meta = PropSet::new();
    meta.guid(prop::NOTEBOOK_MANAGEMENT_ENTITY_GUID, entity)
        .wz(
            prop::CACHED_TITLE_STRING,
            &crate::text::clean_line(&page.title),
        )
        .u32(prop::PAGE_LEVEL, level)
        .u32(prop::SCHEMA_REVISION_IN_ORDER_TO_READ, SCHEMA_REVISION)
        .u32(prop::SCHEMA_REVISION_IN_ORDER_TO_WRITE, SCHEMA_REVISION)
        .u64(prop::TOPOLOGY_CREATION_TIME_STAMP, created_ts.filetime());
    let metadata = w.sp.add(meta_oid, jcid::PAGE_META_DATA, meta.clone());

    w.sp.set_root(role::CONTENT, manifest);
    w.sp.set_root(role::METADATA, metadata);
    w.sp.set_root(role::VERSION_METADATA, revision_meta);
    Ok(PageOut {
        space: w.sp,
        rid,
        group,
        level,
        metadata: meta,
    })
}
