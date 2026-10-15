//! The notebook table of contents (.onetoc2, [MS-ONE] §2.1.15, §2.2.93–96).
//! A notebook folder holds one .onetoc2 plus its .one sections; each section
//! group is a subfolder with its own .onetoc2. The TOC gives the order of the
//! entries and the notebook's color; it does not say whether an entry is a
//! section or a group — that is decided on disk (file vs folder).

use std::collections::HashMap;

use serde::Serialize;

use crate::onestore::{
    root_role, ExtendedGuid, FileKind, ObjectDeclaration, OneStore, PropertyValue,
};
use crate::reader::{format_guid, utf16le, MAX_SAFE_INTEGER};
use crate::schema::{jcid, jcid_name, prop};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TocEntry {
    /// File or folder name, unescaped. A section is `"<name>.one"`; a group is a folder name.
    pub name: String,
    /// NotebookElementOrderingID: smaller comes first.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub order: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    /// FileIdentityGuid: the section file's Header.guidFile.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub guid_file: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotebookToc {
    /// Always "onenote-toc".
    pub format: &'static str,
    pub guid_file: String,
    /// In display order.
    pub entries: Vec<TocEntry>,
    pub warnings: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
}

/// NotebookColor: COLORREF with an inverted alpha in the top byte; 0xFFFFFFFF means none.
fn toc_color(v: Option<u32>) -> Option<String> {
    crate::notebook::color_ref(v)
}

/// FolderChildFilename escapes "+" as "^M" and "," as "^J".
pub fn unescape_toc_name(s: &str) -> String {
    s.replace("^M", "+").replace("^J", ",")
}

/// A TOC entry plus its position in the file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawTocEntry {
    pub index: usize,
    pub entry: TocEntry,
}

/// Later references to a name are authoritative (onenote.rs); then sort by
/// ordering id, keeping file order for ties.
pub fn order_toc_entries(raw: Vec<RawTocEntry>) -> Vec<TocEntry> {
    let mut by_name: HashMap<String, RawTocEntry> = HashMap::new();
    for e in raw {
        by_name.insert(e.entry.name.to_lowercase(), e);
    }
    let mut entries: Vec<RawTocEntry> = by_name.into_values().collect();
    entries.sort_by_key(|e| (e.entry.order.map_or(MAX_SAFE_INTEGER, u64::from), e.index));
    entries.into_iter().map(|e| e.entry).collect()
}

/// Parse a .onetoc2 file. Fails only when the revision store itself is unreadable.
pub fn parse_notebook_toc(buf: &[u8]) -> crate::reader::Result<NotebookToc> {
    Ok(notebook_toc(&OneStore::new(buf)?))
}

pub fn notebook_toc(store: &OneStore) -> NotebookToc {
    let mut out = NotebookToc {
        format: "onenote-toc",
        guid_file: store.header.guid_file.clone(),
        entries: Vec::new(),
        warnings: Vec::new(),
        color: None,
    };
    walk_toc(store, &mut out);
    out.warnings = store.warnings();
    out
}

struct TocProps<'a> {
    set: Option<std::rc::Rc<crate::onestore::PropertySet<'a>>>,
}

impl<'a> TocProps<'a> {
    fn new(store: &OneStore<'a>, d: &ObjectDeclaration) -> Self {
        TocProps {
            set: store.property_set(d),
        }
    }

    fn value(&self, id: u32) -> Option<&PropertyValue<'a>> {
        self.set
            .as_ref()?
            .properties
            .iter()
            .rev()
            .find(|p| p.id == id)
            .map(|p| &p.value)
    }

    fn bytes(&self, id: u32) -> Option<&'a [u8]> {
        match self.value(id)? {
            PropertyValue::Bytes(b) => Some(b),
            _ => None,
        }
    }

    fn u32(&self, id: u32) -> Option<u32> {
        let b = self.bytes(id).filter(|b| b.len() >= 4)?;
        Some(u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
    }

    fn oids(&self, id: u32) -> Vec<ExtendedGuid> {
        match self.value(id) {
            Some(PropertyValue::Oids { ids, .. }) => ids.iter().flatten().copied().collect(),
            _ => Vec::new(),
        }
    }
}

fn walk_toc(store: &OneStore, out: &mut NotebookToc) {
    if store.header.file_kind != FileKind::Toc {
        store.warn(format!(
            "file kind is {}, not a .onetoc2",
            store.header.file_kind.as_str()
        ));
    }
    let space = store.root_gosid.and_then(|g| store.object_spaces.get(&g));
    let found = space.and_then(|space| {
        let rev = store.current_revision(space, root_role::DEFAULT_CONTENT, None)?;
        let root_oid = store.root_object(space, rev, root_role::DEFAULT_CONTENT)?;
        Some((space, rev, store.find_object(rev, &root_oid, Some(space))?))
    });
    let Some((space, rev, root)) = found else {
        store.warn("no root table-of-contents object".into());
        return;
    };
    if root.jcid.raw != jcid::PERSISTABLE_PROPERTY_CONTAINER_FOR_TOC {
        store.warn(format!("root object is {}", jcid_name(root.jcid.raw)));
    }

    out.color = toc_color(TocProps::new(store, root).u32(prop::NOTEBOOK_COLOR));
    let mut raw: Vec<RawTocEntry> = Vec::new();
    fn walk(
        store: &OneStore,
        space: &crate::onestore::ObjectSpace,
        rev: &crate::onestore::Revision,
        d: &ObjectDeclaration,
        depth: u32,
        raw: &mut Vec<RawTocEntry>,
    ) {
        if depth > 32 {
            return;
        }
        let p = TocProps::new(store, d);
        if let Some(name) = p.bytes(prop::FOLDER_CHILD_FILENAME) {
            let guid = p.bytes(prop::FILE_IDENTITY_GUID);
            raw.push(RawTocEntry {
                index: raw.len(),
                entry: TocEntry {
                    name: unescape_toc_name(&utf16le(name)),
                    order: p.u32(prop::NOTEBOOK_ELEMENT_ORDERING_ID),
                    color: toc_color(p.u32(prop::NOTEBOOK_COLOR)),
                    guid_file: guid.filter(|g| g.len() == 16).map(format_guid),
                },
            });
            return;
        }
        for o in p.oids(prop::TOC_ENTRY_INDEX_OID_INDEX) {
            if let Some(child) = store.find_object(rev, &o, Some(space)) {
                walk(store, space, rev, child, depth + 1, raw);
            }
        }
    }
    walk(store, space, rev, root, 0, &mut raw);
    out.entries = order_toc_entries(raw);
}
