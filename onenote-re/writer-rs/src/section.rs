//! The section object space ([MS-ONE] §2.1.14), the root of the file:
//!
//! ```text
//!   SectionNode (content root) ─ElementChildNodes→ PageSeriesNode…
//!     PageSeriesNode ─ChildGraphSpaceElementNodes→ page object spaces
//!                    ─MetaDataObjectsAboveGraphSpace→ PageMetaData copies
//!   SectionMetaData (metadata root): schema revision, NotebookColor, SectionDisplayName
//! ```
//!
//! A page series is a top-level page and the subpages after it (§1.3.2); its
//! first page has PageLevel 1. Each page's PageMetaData is copied into the
//! section under the page's object space id XORed with the metadata salt
//! (§2.2.81), so OneNote can list pages without opening them.

use crate::guid::{ExGuid, Guid};
use crate::model::Section;
use crate::page::{Ctx, PageOut};
use crate::propset::PropSet;
use crate::schema::{jcid, prop, METADATA_SALT, SCHEMA_REVISION};
use crate::space::{role, Space};
use crate::text::clean_line;

pub(crate) struct SectionOut {
    pub space: Space,
    pub rid: ExGuid,
    pub group: ExGuid,
}

pub(crate) fn write_section(ctx: &mut Ctx, section: &Section, pages: &[PageOut]) -> SectionOut {
    let key = "section";
    let gosid = ctx.exguid(&format!("{key}/space"));
    let rid = ctx.exguid(&format!("{key}/revision"));
    let group = ctx.exguid(&format!("{key}/object-group"));
    let created = ctx.section_created.filetime();
    let salt = Guid::parse(METADATA_SALT);

    let mut sp = Space::new(gosid);
    let node = sp.reserve(ctx.exguid(&format!("{key}/node")), jcid::SECTION_NODE);

    // Series: a new one at every top-level page.
    let mut series: Vec<Vec<&PageOut>> = Vec::new();
    for p in pages {
        match series.last_mut() {
            Some(s) if p.level > 1 => s.push(p),
            _ => series.push(vec![p]),
        }
    }
    let mut series_nodes = Vec::new();
    for (i, s) in series.iter().enumerate() {
        let idx = sp.reserve(
            ctx.exguid(&format!("{key}/series/{i}")),
            jcid::PAGE_SERIES_NODE,
        );
        let mut metas = Vec::new();
        for p in s {
            let oid = ExGuid::new(p.space.gosid.guid.xor(salt), p.space.gosid.n);
            metas.push(sp.add(oid, jcid::PAGE_META_DATA, p.metadata.clone()));
        }
        let mut props = PropSet::new();
        props
            .osids(
                prop::CHILD_GRAPH_SPACE_ELEMENT_NODES,
                s.iter().map(|p| p.space.gosid).collect(),
            )
            .guid(
                prop::NOTEBOOK_MANAGEMENT_ENTITY_GUID,
                ctx.guid(&format!("{key}/series/{i}/entity")),
            )
            .u64(prop::TOPOLOGY_CREATION_TIME_STAMP, created)
            .oids(prop::META_DATA_OBJECTS_ABOVE_GRAPH_SPACE, metas);
        sp.fill(idx, props);
        series_nodes.push(idx);
    }

    let mut props = PropSet::new();
    props.guid(
        prop::NOTEBOOK_MANAGEMENT_ENTITY_GUID,
        ctx.guid(&format!("{key}/entity")),
    );
    props.u64(prop::TOPOLOGY_CREATION_TIME_STAMP, created);
    if !series_nodes.is_empty() {
        props.oids(prop::ELEMENT_CHILD_NODES, series_nodes);
    }
    sp.fill(node, props);

    // NotebookColor is a COLORREF whose top byte is inverted alpha; no color
    // is 0xFFFFFFFF.
    let mut meta = PropSet::new();
    meta.u32(prop::SCHEMA_REVISION_IN_ORDER_TO_READ, SCHEMA_REVISION)
        .u32(prop::SCHEMA_REVISION_IN_ORDER_TO_WRITE, SCHEMA_REVISION)
        .u32(
            prop::NOTEBOOK_COLOR,
            section.color.map_or(u32::MAX, |c| c.colorref()),
        );
    let name = clean_line(&section.name);
    if !name.is_empty() {
        meta.wz(prop::SECTION_DISPLAY_NAME, &name);
    }
    let metadata = sp.add(
        ctx.exguid(&format!("{key}/metadata")),
        jcid::SECTION_META_DATA,
        meta,
    );

    sp.set_root(role::CONTENT, node);
    sp.set_root(role::METADATA, metadata);
    SectionOut {
        space: sp,
        rid,
        group,
    }
}
