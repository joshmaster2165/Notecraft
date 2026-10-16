//! Tables of contents (`.onetoc2`, [MS-ONE] §2.1.15): one in the notebook
//! folder and one in every section group subfolder.
//!
//! ```text
//!   jcidPersistablePropertyContainerForTOC (content root)
//!     TOCEntryIndex_OidIndex → one entry per child, in display order
//!     NotebookColor           (the notebook's TOC only)
//!   jcidPersistablePropertyContainerForTOCSection (each entry)
//!     FileIdentityGuid        the child's Header.guidFile (.one, or the group's .onetoc2)
//!     NotebookElementOrderingID  1, 2, 3…
//!     FolderChildFilename     "Name.one" for a section, "Name" for a group folder
//!     NotebookColor           (sections)
//! ```
//!
//! FolderChildFilename escapes "+" as "^M" and "," as "^J", as both readers
//! in this repository and onenote.rs expect.

use crate::guid::{ExGuid, Guid};
use crate::propset::PropSet;
use crate::schema::{jcid, prop};
use crate::space::{role, Space};
use crate::store::{fnd, FileKind, FileNode, FileNodeList, HeaderInfo, Target, Writer};
use crate::{crc, WriteError};

/// What every table of contents file is called. OneNote's own name for it
/// (its string resources hold "Open Notebook" and ".onetoc2").
pub(crate) const TOC_FILE_NAME: &str = "Open Notebook.onetoc2";

pub(crate) struct TocEntry {
    /// "Name.one" or a folder name, unescaped.
    pub file_name: String,
    /// The child's `Header.guidFile`.
    pub guid: Guid,
    /// COLORREF, or 0xFFFFFFFF for none; `None` leaves NotebookColor out.
    pub color: Option<u32>,
}

pub(crate) struct Toc {
    pub guid_file: Guid,
    /// `guidFile` of the parent folder's table of contents (nil for the
    /// notebook's own).
    pub guid_ancestor: Guid,
    /// The notebook's COLORREF; `None` (no NotebookColor) for a notebook
    /// without a color and for a section group's table of contents.
    pub color: Option<u32>,
    pub entries: Vec<TocEntry>,
}

/// FolderChildFilename's escapes.
pub(crate) fn escape_name(name: &str) -> String {
    name.replace('+', "^M").replace(',', "^J")
}

pub(crate) fn write_toc(toc: &Toc) -> Result<Vec<u8>, WriteError> {
    let ns = toc.guid_file;
    let exguid = |name: &str| ExGuid::new(Guid::name_based(ns, name), 1);
    let mut sp = Space::new(exguid("toc/space"));
    let root = sp.reserve(
        exguid("toc/root"),
        jcid::PERSISTABLE_PROPERTY_CONTAINER_FOR_TOC,
    );
    let mut children = Vec::with_capacity(toc.entries.len());
    for (i, e) in toc.entries.iter().enumerate() {
        let mut p = PropSet::new();
        p.guid(prop::FILE_IDENTITY_GUID, e.guid)
            .u32(prop::NOTEBOOK_ELEMENT_ORDERING_ID, i as u32 + 1)
            .wz(prop::FOLDER_CHILD_FILENAME, &escape_name(&e.file_name));
        if let Some(c) = e.color {
            p.u32(prop::NOTEBOOK_COLOR, c);
        }
        children.push(sp.add(
            exguid(&format!("toc/entry/{i}")),
            jcid::PERSISTABLE_PROPERTY_CONTAINER_FOR_TOC,
            p,
        ));
    }
    let mut p = PropSet::new();
    if !children.is_empty() {
        p.oids(prop::TOC_ENTRY_INDEX_OID_INDEX, children);
    }
    if let Some(c) = toc.color {
        p.u32(prop::NOTEBOOK_COLOR, c);
    }
    sp.fill(root, p);
    sp.set_root(role::CONTENT, root);

    let gosid = sp.gosid;
    let mut list = FileNodeList::default();
    list.push(FileNode {
        id: fnd::OBJECT_SPACE_MANIFEST_LIST_REFERENCE,
        target: Target::List(sp.into_toc_manifest(exguid("toc/revision"))?),
        data: gosid.bytes().to_vec(),
    });
    list.push(FileNode::plain(
        fnd::OBJECT_SPACE_MANIFEST_ROOT,
        gosid.bytes().to_vec(),
    ));
    let files: Vec<Vec<u8>> = Vec::new();
    let mut w = Writer::new(&files);
    let root_chunk = w.list(list)?;
    w.finish(
        root_chunk,
        &HeaderInfo {
            kind: FileKind::Toc,
            guid_file: toc.guid_file,
            guid_ancestor: toc.guid_ancestor,
            crc_name: crc::file_name_crc(TOC_FILE_NAME),
        },
    )
}
