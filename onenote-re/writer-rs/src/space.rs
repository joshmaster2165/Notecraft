//! Object spaces ([MS-ONESTORE] §2.1.4–§2.1.13): one per section and one
//! per page, each written as a single revision.
//!
//! ```text
//!   object space manifest list   ObjectSpaceManifestListStartFND · RevisionManifestListReferenceFND
//!   revision manifest list       RevisionManifestListStartFND
//!                                RevisionManifestStart6FND  (role 1, default context, no dependency)
//!                                ObjectGroupListReferenceFND → object group list
//!                                ObjectInfoDependencyOverridesFND  (no overrides; CRC of the reference counts)
//!                                RootObjectReference3FND…  (1 content, 2 metadata, 4 version metadata)
//!                                RevisionManifestEndFND
//!   object group list            ObjectGroupStartFND · GlobalIdTableStart2FND · GlobalIdTableEntryFNDX…
//!                                GlobalIdTableEndFNDX · declarations… · ObjectGroupEndFND
//! ```
//!
//! Declarations follow the JCID: read-only types (paragraph styles, authors,
//! note tag definitions, ink stroke properties) use
//! ReadOnlyObjectDeclaration2RefCountFND with the MD5 of their property set,
//! file data uses ObjectDeclarationFileData3RefCountFND, the rest
//! ObjectDeclaration2RefCountFND. The `Large` variants take over above a
//! reference count of 255. A reference count is the number of references to
//! the object within the revision, plus one for a root (§2.1.5); OneNote's
//! files count repeated references from one object separately, and so do we.

use std::collections::HashMap;

use md5::{Digest, Md5};

use crate::crc;
use crate::guid::{ExGuid, Guid};
use crate::propset::{self, ObjIdx, PropSet};
use crate::schema::jcid;
use crate::store::{fnd, FileNode, FileNodeList, Target};
use crate::WriteError;

/// Root roles ([MS-ONE] §2.1.8).
pub(crate) mod role {
    pub const CONTENT: u32 = 1;
    pub const METADATA: u32 = 2;
    pub const VERSION_METADATA: u32 = 4;
}

pub(crate) enum ObjData {
    /// Reserved by [`Space::reserve`], filled in by [`Space::fill`].
    Pending,
    Props(PropSet),
    /// A file data object: `<ifndf>{GUID}` or `<invfdo>`, and an extension.
    File {
        reference: String,
        extension: String,
    },
}

pub(crate) struct Obj {
    pub oid: ExGuid,
    pub jcid: u32,
    pub data: ObjData,
}

pub(crate) struct Space {
    pub gosid: ExGuid,
    pub objects: Vec<Obj>,
    roots: Vec<(u32, ObjIdx)>,
}

impl Space {
    pub fn new(gosid: ExGuid) -> Space {
        Space {
            gosid,
            objects: Vec::new(),
            roots: Vec::new(),
        }
    }

    pub fn add(&mut self, oid: ExGuid, jcid: u32, props: PropSet) -> ObjIdx {
        self.objects.push(Obj {
            oid,
            jcid,
            data: ObjData::Props(props),
        });
        self.objects.len() - 1
    }

    /// Declare an object now (so it is declared before its children) and
    /// give it its properties later.
    pub fn reserve(&mut self, oid: ExGuid, jcid: u32) -> ObjIdx {
        self.objects.push(Obj {
            oid,
            jcid,
            data: ObjData::Pending,
        });
        self.objects.len() - 1
    }

    pub fn fill(&mut self, idx: ObjIdx, props: PropSet) {
        self.objects[idx].data = ObjData::Props(props);
    }

    pub fn add_file(
        &mut self,
        oid: ExGuid,
        jcid: u32,
        reference: String,
        extension: String,
    ) -> ObjIdx {
        self.objects.push(Obj {
            oid,
            jcid,
            data: ObjData::File {
                reference,
                extension,
            },
        });
        self.objects.len() - 1
    }

    pub fn set_root(&mut self, role: u32, idx: ObjIdx) {
        self.roots.retain(|(r, _)| *r != role);
        self.roots.push((role, idx));
        self.roots.sort_by_key(|(r, _)| *r);
    }

    /// Reference counts, roots included.
    fn ref_counts(&self) -> Result<Vec<u32>, WriteError> {
        let mut counts = vec![0u32; self.objects.len()];
        let mut refs = Vec::new();
        for o in &self.objects {
            match &o.data {
                ObjData::Props(p) => {
                    refs.clear();
                    p.oid_refs(&mut refs);
                    for &r in &refs {
                        let c = counts.get_mut(r).ok_or_else(|| {
                            WriteError::internal("reference to an unknown object")
                        })?;
                        *c += 1;
                    }
                }
                ObjData::File { .. } => {}
                ObjData::Pending => return Err(WriteError::internal("object never filled in")),
            }
        }
        for &(_, r) in &self.roots {
            counts[r] += 1;
        }
        if let Some(i) = counts.iter().position(|&c| c == 0) {
            return Err(WriteError::internal(format!(
                "object 0x{:x} is unreachable",
                self.objects[i].jcid
            )));
        }
        Ok(counts)
    }

    /// The object space manifest list, with everything under it.
    pub fn into_manifest(self, rid: ExGuid, group: ExGuid) -> Result<FileNodeList, WriteError> {
        let counts = self.ref_counts()?;

        // Global identification table: object GUIDs in declaration order,
        // then the object spaces referenced.
        let mut table: Vec<Guid> = Vec::new();
        let mut index: HashMap<Guid, u32> = HashMap::new();
        let mut add = |g: Guid, table: &mut Vec<Guid>| {
            index.entry(g).or_insert_with(|| {
                table.push(g);
                (table.len() - 1) as u32
            });
        };
        for o in &self.objects {
            add(o.oid.guid, &mut table);
        }
        let mut osids = Vec::new();
        for o in &self.objects {
            if let ObjData::Props(p) = &o.data {
                p.osid_refs(&mut osids);
            }
        }
        for s in osids {
            add(s.guid, &mut table);
        }
        if table.len() > 0x00ff_ffff {
            return Err(WriteError::TooLarge(
                "more than 2^24 identities in one page".into(),
            ));
        }
        let index_of = |g: Guid| index[&g];
        let oid_of = |i: ObjIdx| self.objects[i].oid;
        let compact = |id: ExGuid| -> Result<u32, WriteError> {
            if id.n > 0xff {
                return Err(WriteError::internal("ExtendedGUID.n above 255"));
            }
            Ok(id.n | index_of(id.guid) << 8)
        };

        let mut g = FileNodeList::default();
        g.push(FileNode::plain(
            fnd::OBJECT_GROUP_START,
            group.bytes().to_vec(),
        ));
        g.push(FileNode::plain(fnd::GLOBAL_ID_TABLE_START2, Vec::new()));
        for (i, guid) in table.iter().enumerate() {
            let mut d = (i as u32).to_le_bytes().to_vec();
            d.extend_from_slice(&guid.0);
            g.push(FileNode::plain(fnd::GLOBAL_ID_TABLE_ENTRY, d));
        }
        g.push(FileNode::plain(fnd::GLOBAL_ID_TABLE_END, Vec::new()));

        let mut ref_crc = 0u32;
        for (o, &count) in self.objects.iter().zip(&counts) {
            ref_crc = crc::update(ref_crc, &count.to_le_bytes());
            let large = count > 0xff;
            let mut d = compact(o.oid)?.to_le_bytes().to_vec();
            d.extend_from_slice(&o.jcid.to_le_bytes());
            match &o.data {
                ObjData::Props(p) => {
                    let e = propset::encode(p, &oid_of, &index_of)?;
                    d.push(e.has_oid_refs as u8 | (e.has_osid_refs as u8) << 1);
                    if large {
                        d.extend_from_slice(&count.to_le_bytes());
                    } else {
                        d.push(count as u8);
                    }
                    let read_only = o.jcid & jcid::IS_READ_ONLY != 0;
                    let md5: [u8; 16] = Md5::digest(&e.bytes).into();
                    if read_only {
                        d.extend_from_slice(&md5);
                    }
                    let id = match (read_only, large) {
                        (false, false) => fnd::OBJECT_DECLARATION2_REF_COUNT,
                        (false, true) => fnd::OBJECT_DECLARATION2_LARGE_REF_COUNT,
                        (true, false) => fnd::READ_ONLY_OBJECT_DECLARATION2_REF_COUNT,
                        (true, true) => fnd::READ_ONLY_OBJECT_DECLARATION2_LARGE_REF_COUNT,
                    };
                    // Read-only property sets are also indexed by MD5 in the
                    // hashed chunk list, as in OneNote's files.
                    let target = if read_only {
                        Target::HashedBlob(e.bytes, md5)
                    } else {
                        Target::Blob(e.bytes)
                    };
                    g.push(FileNode {
                        id,
                        target,
                        data: d,
                    });
                }
                ObjData::File {
                    reference,
                    extension,
                } => {
                    if large {
                        d.extend_from_slice(&count.to_le_bytes());
                    } else {
                        d.push(count as u8);
                    }
                    push_storage_string(&mut d, reference);
                    push_storage_string(&mut d, extension);
                    let id = if large {
                        fnd::OBJECT_DECLARATION_FILE_DATA3_LARGE_REF_COUNT
                    } else {
                        fnd::OBJECT_DECLARATION_FILE_DATA3_REF_COUNT
                    };
                    g.push(FileNode::plain(id, d));
                }
                ObjData::Pending => return Err(WriteError::internal("object never filled in")),
            }
        }
        g.push(FileNode::plain(fnd::OBJECT_GROUP_END, Vec::new()));

        let mut rev = FileNodeList::default();
        let mut start = self.gosid.bytes().to_vec();
        start.extend_from_slice(&0u32.to_le_bytes()); // nInstance
        rev.push(FileNode::plain(fnd::REVISION_MANIFEST_LIST_START, start));
        let mut manifest = rid.bytes().to_vec();
        manifest.extend_from_slice(&ExGuid::NIL.bytes()); // ridDependent
        manifest.extend_from_slice(&role::CONTENT.to_le_bytes()); // RevisionRole
        manifest.extend_from_slice(&0u16.to_le_bytes()); // odcsDefault: not encrypted
        rev.push(FileNode::plain(fnd::REVISION_MANIFEST_START6, manifest));
        rev.push(FileNode {
            id: fnd::OBJECT_GROUP_LIST_REFERENCE,
            target: Target::List(g),
            data: group.bytes().to_vec(),
        });
        // ObjectInfoDependencyOverrideData: no overrides, and the CRC of the
        // reference counts declared in the object group ([MS-ONESTORE] §2.6.10).
        let mut overrides = Vec::with_capacity(12);
        overrides.extend_from_slice(&0u32.to_le_bytes());
        overrides.extend_from_slice(&0u32.to_le_bytes());
        overrides.extend_from_slice(&ref_crc.to_le_bytes());
        rev.push(FileNode {
            id: fnd::OBJECT_INFO_DEPENDENCY_OVERRIDES,
            target: Target::Nil,
            data: overrides,
        });
        for &(r, idx) in &self.roots {
            let mut d = self.objects[idx].oid.bytes().to_vec();
            d.extend_from_slice(&r.to_le_bytes());
            rev.push(FileNode::plain(fnd::ROOT_OBJECT_REFERENCE3, d));
        }
        rev.push(FileNode::plain(fnd::REVISION_MANIFEST_END, Vec::new()));

        let mut osl = FileNodeList::default();
        osl.push(FileNode::plain(
            fnd::OBJECT_SPACE_MANIFEST_LIST_START,
            self.gosid.bytes().to_vec(),
        ));
        osl.push(FileNode {
            id: fnd::REVISION_MANIFEST_LIST_REFERENCE,
            target: Target::List(rev),
            data: Vec::new(),
        });
        Ok(osl)
    }
}

/// StringInStorageBuffer ([MS-ONESTORE] §2.2.3): u32 character count, UTF-16.
fn push_storage_string(d: &mut Vec<u8>, s: &str) {
    let units: Vec<u16> = s.encode_utf16().collect();
    d.extend_from_slice(&(units.len() as u32).to_le_bytes());
    for u in units {
        d.extend_from_slice(&u.to_le_bytes());
    }
}
