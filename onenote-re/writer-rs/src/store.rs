//! The revision store container ([MS-ONESTORE] §2.3–§2.5): header,
//! transaction log, hashed chunk list, FileNodeList fragments, FileNodes and
//! FileDataStoreObjects.
//!
//! ```text
//!   0x000  Header (1024 bytes)
//!   ....   chunks, 8-byte aligned, children before the lists that point at them:
//!          FileDataStoreObjects, ObjectSpaceObjectPropSets, FileNodeList
//!          fragments (object groups → revision manifest lists → object space
//!          manifest lists → root list), the hashed chunk list, then the
//!          transaction log.
//! ```
//!
//! Choices follow OneNote's own files (checked against the OneNote for Mac
//! backups that `docs/file-format.md` describes):
//! - FileNode headers set the reserved bit 31. Nodes without a reference use
//!   StpFormat 1 / CbFormat 0; references use an uncompressed 32-bit stp and
//!   the narrowest cb format, compressed (×8) when the size allows.
//! - A list is one fragment unless it outgrows [`FRAGMENT_LIMIT`]; earlier
//!   fragments then end with a ChunkTerminatorFND, as OneNote's do.
//! - FileNodeList IDs are handed out top-down from 0x10 (root list first).
//! - One transaction commits every list; its sentinel holds the CRC-32 of the
//!   entries before it ([`crate::crc`]).

use crate::crc;
use crate::guid::Guid;
use crate::WriteError;

pub(crate) const GUID_FILE_TYPE_ONE: Guid = Guid::parse("{7B5C52E4-D88C-4DA7-AEB1-5378D02996D3}");
pub(crate) const GUID_FILE_FORMAT: Guid = Guid::parse("{109ADD3F-911B-49F5-A5D0-1791EDC8AED8}");
const GUID_FDSO_HEADER: Guid = Guid::parse("{BDE316E7-2665-4511-A4C4-8D4D0B7A9EAC}");
const GUID_FDSO_FOOTER: Guid = Guid::parse("{71FBA722-0F79-4A0B-BB13-899256426B24}");

const FRAGMENT_HEADER_MAGIC: u64 = 0xa456_7ab1_f5f7_f4c4;
const FRAGMENT_FOOTER_MAGIC: u64 = 0x8bc2_15c3_8233_ba4b;
/// File format version of OneNote 2010 and later ([MS-ONESTORE] §2.3.1).
const FFV_ONE: u32 = 0x2a;
/// Build number written to the four `bn*` header fields: OneNote 2010
/// 14.0.4763.1000, the value in [MS-ONESTORE] §3.1. Readers ignore it.
const BUILD_NUMBER: u32 = 0x0fa1_29b4;
/// Fragments are cut before they grow past this size (OneNote's largest are
/// about 42 KB).
pub(crate) const FRAGMENT_LIMIT: usize = 32 * 1024;
/// Header, next-fragment reference, footer and up to 7 bytes of padding.
const FRAGMENT_OVERHEAD: usize = 16 + 20 + 7;

/// FileNode IDs ([MS-ONESTORE] §2.4.3).
pub(crate) mod fnd {
    pub const OBJECT_SPACE_MANIFEST_ROOT: u16 = 0x004;
    pub const OBJECT_SPACE_MANIFEST_LIST_REFERENCE: u16 = 0x008;
    pub const OBJECT_SPACE_MANIFEST_LIST_START: u16 = 0x00c;
    pub const REVISION_MANIFEST_LIST_REFERENCE: u16 = 0x010;
    pub const REVISION_MANIFEST_LIST_START: u16 = 0x014;
    pub const REVISION_MANIFEST_END: u16 = 0x01c;
    pub const REVISION_MANIFEST_START6: u16 = 0x01e;
    pub const GLOBAL_ID_TABLE_START2: u16 = 0x022;
    pub const GLOBAL_ID_TABLE_ENTRY: u16 = 0x024;
    pub const GLOBAL_ID_TABLE_END: u16 = 0x028;
    pub const ROOT_OBJECT_REFERENCE3: u16 = 0x05a;
    pub const OBJECT_DECLARATION_FILE_DATA3_REF_COUNT: u16 = 0x072;
    pub const OBJECT_DECLARATION_FILE_DATA3_LARGE_REF_COUNT: u16 = 0x073;
    pub const OBJECT_INFO_DEPENDENCY_OVERRIDES: u16 = 0x084;
    pub const FILE_DATA_STORE_LIST_REFERENCE: u16 = 0x090;
    pub const FILE_DATA_STORE_OBJECT_REFERENCE: u16 = 0x094;
    pub const HASHED_CHUNK_DESCRIPTOR2: u16 = 0x0c2;
    pub const OBJECT_DECLARATION2_REF_COUNT: u16 = 0x0a4;
    pub const OBJECT_DECLARATION2_LARGE_REF_COUNT: u16 = 0x0a5;
    pub const OBJECT_GROUP_LIST_REFERENCE: u16 = 0x0b0;
    pub const OBJECT_GROUP_START: u16 = 0x0b4;
    pub const OBJECT_GROUP_END: u16 = 0x0b8;
    pub const READ_ONLY_OBJECT_DECLARATION2_REF_COUNT: u16 = 0x0c4;
    pub const READ_ONLY_OBJECT_DECLARATION2_LARGE_REF_COUNT: u16 = 0x0c5;
    pub const CHUNK_TERMINATOR: u16 = 0x0ff;
}

/// What a FileNode's FileNodeChunkReference points at.
pub(crate) enum Target {
    None,
    /// Bytes written as their own chunk (an ObjectSpaceObjectPropSet).
    Blob(Vec<u8>),
    /// A read-only object's property set and its MD5, also listed in the
    /// hashed chunk list ([MS-ONESTORE] §2.3.4).
    HashedBlob(Vec<u8>, [u8; 16]),
    /// A chunk written earlier.
    Existing(Chunk),
    /// A FileDataStoreObject wrapping file data `n` of the store.
    FileData(usize),
    /// A child file node list.
    List(FileNodeList),
    /// `fcrNil`, followed by the data inline (ObjectInfoDependencyOverridesFND).
    Nil,
}

pub(crate) struct FileNode {
    pub id: u16,
    pub target: Target,
    /// The `fnd` fields after the chunk reference.
    pub data: Vec<u8>,
}

impl FileNode {
    pub fn plain(id: u16, data: Vec<u8>) -> FileNode {
        FileNode {
            id,
            target: Target::None,
            data,
        }
    }
}

#[derive(Default)]
pub(crate) struct FileNodeList {
    pub nodes: Vec<FileNode>,
}

impl FileNodeList {
    pub fn push(&mut self, node: FileNode) {
        self.nodes.push(node);
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Chunk {
    pub stp: u64,
    pub cb: u64,
}

/// Inputs of the header besides the chunk references.
pub(crate) struct HeaderInfo {
    pub guid_file: Guid,
    pub crc_name: u32,
}

pub(crate) struct Writer<'f> {
    out: Vec<u8>,
    files: &'f [Vec<u8>],
    next_list_id: u32,
    /// (FileNodeListID, committed node count) for the transaction.
    tx: Vec<(u32, u32)>,
    /// Read-only property sets for the hashed chunk list.
    hashed: Vec<(Chunk, [u8; 16])>,
}

fn too_large(what: &str) -> WriteError {
    WriteError::TooLarge(format!(
        "{what} does not fit the .one format's 32-bit offsets"
    ))
}

impl<'f> Writer<'f> {
    pub fn new(files: &'f [Vec<u8>]) -> Writer<'f> {
        Writer {
            out: vec![0; 1024],
            files,
            next_list_id: 0x10,
            tx: Vec::new(),
            hashed: Vec::new(),
        }
    }

    fn align(&mut self) {
        while !self.out.len().is_multiple_of(8) {
            self.out.push(0);
        }
    }

    fn alloc(&mut self, bytes: &[u8]) -> Chunk {
        self.align();
        let stp = self.out.len() as u64;
        self.out.extend_from_slice(bytes);
        Chunk {
            stp,
            cb: bytes.len() as u64,
        }
    }

    /// FileDataStoreObject ([MS-ONESTORE] §2.6.13): a 36-byte header, the
    /// data padded so the footer starts on an 8-byte boundary, a GUID footer.
    fn file_data(&mut self, n: usize) -> Chunk {
        let data = &self.files[n];
        self.align();
        let stp = self.out.len() as u64;
        self.out.extend_from_slice(&GUID_FDSO_HEADER.0);
        self.out
            .extend_from_slice(&(data.len() as u64).to_le_bytes());
        self.out.extend_from_slice(&[0; 4 + 8]);
        self.out.extend_from_slice(data);
        self.align();
        self.out.extend_from_slice(&GUID_FDSO_FOOTER.0);
        Chunk {
            stp,
            cb: self.out.len() as u64 - stp,
        }
    }

    /// Write a list and everything it references; returns the first fragment.
    pub fn list(&mut self, list: FileNodeList) -> Result<Chunk, WriteError> {
        let id = self.next_list_id;
        self.next_list_id += 1;
        let count = list.nodes.len() as u32;
        // Children first: they need offsets before this list's nodes can
        // point at them. IDs are still taken in pre-order.
        let mut encoded: Vec<Vec<u8>> = Vec::with_capacity(list.nodes.len());
        for node in list.nodes {
            let reference = match node.target {
                Target::None => None,
                Target::Blob(b) => Some((self.alloc(&b), 1)),
                Target::HashedBlob(b, md5) => {
                    let chunk = self.alloc(&b);
                    self.hashed.push((chunk, md5));
                    Some((chunk, 1))
                }
                Target::Existing(chunk) => Some((chunk, 1)),
                Target::FileData(n) => Some((self.file_data(n), 1)),
                Target::List(child) => Some((self.list(child)?, 2)),
                Target::Nil => {
                    encoded.push(encode_node(node.id, NodeRef::Nil, &node.data)?);
                    continue;
                }
            };
            let r = match reference {
                Some((chunk, base_type)) => NodeRef::Chunk(chunk, base_type),
                None => NodeRef::None,
            };
            encoded.push(encode_node(node.id, r, &node.data)?);
        }
        self.tx.push((id, count));
        self.fragments(id, &encoded)
    }

    /// Lay out a list's nodes in fragments, last fragment first so each one
    /// can point at its successor.
    fn fragments(&mut self, id: u32, nodes: &[Vec<u8>]) -> Result<Chunk, WriteError> {
        let terminator = encode_node(fnd::CHUNK_TERMINATOR, NodeRef::None, &[])?;
        let mut groups: Vec<&[Vec<u8>]> = Vec::new();
        let mut start = 0;
        let mut size = FRAGMENT_OVERHEAD + terminator.len();
        for (i, n) in nodes.iter().enumerate() {
            if i > start && size + n.len() > FRAGMENT_LIMIT {
                groups.push(&nodes[start..i]);
                start = i;
                size = FRAGMENT_OVERHEAD + terminator.len();
            }
            size += n.len();
        }
        groups.push(&nodes[start..]);

        let mut next: Option<Chunk> = None;
        for (seq, group) in groups.iter().enumerate().rev() {
            let mut f = Vec::new();
            f.extend_from_slice(&FRAGMENT_HEADER_MAGIC.to_le_bytes());
            f.extend_from_slice(&id.to_le_bytes());
            f.extend_from_slice(&(seq as u32).to_le_bytes());
            for n in group.iter() {
                f.extend_from_slice(n);
            }
            if next.is_some() {
                f.extend_from_slice(&terminator);
            }
            while !(f.len() + 20).is_multiple_of(8) {
                f.push(0);
            }
            match next {
                Some(c) => {
                    f.extend_from_slice(&c.stp.to_le_bytes());
                    f.extend_from_slice(
                        &(u32::try_from(c.cb).map_err(|_| too_large("a fragment"))?).to_le_bytes(),
                    );
                }
                None => {
                    // fcrNil: stp all ones, cb zero.
                    f.extend_from_slice(&u64::MAX.to_le_bytes());
                    f.extend_from_slice(&0u32.to_le_bytes());
                }
            }
            f.extend_from_slice(&FRAGMENT_FOOTER_MAGIC.to_le_bytes());
            next = Some(self.alloc(&f));
        }
        next.ok_or_else(|| WriteError::internal("list without fragments"))
    }

    /// Write the hashed chunk list, the transaction log and the header;
    /// returns the file.
    pub fn finish(mut self, root: Chunk, info: &HeaderInfo) -> Result<Vec<u8>, WriteError> {
        // Hashed chunk list: HashedChunkDescriptor2FND {BlobRef, MD5} for the
        // read-only property sets, as OneNote keeps it.
        let hashed = if self.hashed.is_empty() {
            None
        } else {
            let mut list = FileNodeList::default();
            for (chunk, md5) in std::mem::take(&mut self.hashed) {
                list.push(FileNode {
                    id: fnd::HASHED_CHUNK_DESCRIPTOR2,
                    target: Target::Existing(chunk),
                    data: md5.to_vec(),
                });
            }
            Some(self.list(list)?)
        };

        // Transaction log: one transaction that commits every list, then the
        // sentinel (srcID 1) with the running CRC of the log, then fcrNil and
        // 4 bytes of padding, like OneNote's fragments.
        self.tx.sort_by_key(|&(id, _)| id);
        let mut log = Vec::with_capacity(self.tx.len() * 8 + 24);
        for &(id, count) in &self.tx {
            log.extend_from_slice(&id.to_le_bytes());
            log.extend_from_slice(&count.to_le_bytes());
        }
        let crc = crc::crc32(&log);
        log.extend_from_slice(&1u32.to_le_bytes());
        log.extend_from_slice(&crc.to_le_bytes());
        log.extend_from_slice(&u64::MAX.to_le_bytes());
        log.extend_from_slice(&0u32.to_le_bytes());
        log.extend_from_slice(&[0; 4]);
        let tx_log = self.alloc(&log);

        let len = self.out.len() as u64;
        if len > u64::from(u32::MAX) {
            return Err(too_large("the section"));
        }
        // File version GUIDs are named after the content, so they change
        // when it does and stay put when it doesn't.
        let digest_name = format!("{:08x}{:016x}", crc::crc32(&self.out[1024..]), len);
        let ns = info.guid_file;
        let guid_file_version = Guid::name_based(ns, &format!("file-version:{digest_name}"));
        let guid_deny_read = Guid::name_based(ns, &format!("deny-read:{digest_name}"));

        let mut h = Vec::with_capacity(1024);
        h.extend_from_slice(&GUID_FILE_TYPE_ONE.0); // guidFileType
        h.extend_from_slice(&info.guid_file.0); // guidFile
        h.extend_from_slice(&[0; 16]); // guidLegacyFileVersion
        h.extend_from_slice(&GUID_FILE_FORMAT.0); // guidFileFormat
        for _ in 0..4 {
            h.extend_from_slice(&FFV_ONE.to_le_bytes()); // ffv* (4×)
        }
        h.extend_from_slice(&[0; 8]); // fcrLegacyFreeChunkList: fcrZero
        h.extend_from_slice(&u32::MAX.to_le_bytes()); // fcrLegacyTransactionLog: fcrNil
        h.extend_from_slice(&0u32.to_le_bytes());
        h.extend_from_slice(&1u32.to_le_bytes()); // cTransactionsInLog
        h.extend_from_slice(&0u32.to_le_bytes()); // cbLegacyExpectedFileLength
        h.extend_from_slice(&0u64.to_le_bytes()); // rgbPlaceholder
        h.extend_from_slice(&u32::MAX.to_le_bytes()); // fcrLegacyFileNodeListRoot: fcrNil
        h.extend_from_slice(&0u32.to_le_bytes());
        h.extend_from_slice(&0u32.to_le_bytes()); // cbLegacyFreeSpaceInFreeChunkList
        h.extend_from_slice(&[0; 4]); // fNeedsDefrag, fRepairedFile, fNeedsGarbageCollect, fHasNoEmbeddedFileObjects
        h.extend_from_slice(&[0; 16]); // guidAncestor: no table of contents yet
        h.extend_from_slice(&info.crc_name.to_le_bytes()); // crcName
        match hashed {
            Some(c) => push_fcr64x32(&mut h, c)?, // fcrHashedChunkList
            None => push_fcr64x32_nil(&mut h),
        }
        push_fcr64x32(&mut h, tx_log)?; // fcrTransactionLog
        push_fcr64x32(&mut h, root)?; // fcrFileNodeListRoot
        push_fcr64x32_nil(&mut h); // fcrFreeChunkList
        h.extend_from_slice(&len.to_le_bytes()); // cbExpectedFileLength
        h.extend_from_slice(&0u64.to_le_bytes()); // cbFreeSpaceInFreeChunkList
        h.extend_from_slice(&guid_file_version.0); // guidFileVersion
        h.extend_from_slice(&1u64.to_le_bytes()); // nFileVersionGeneration
        h.extend_from_slice(&guid_deny_read.0); // guidDenyReadFileVersion
        h.extend_from_slice(&0u32.to_le_bytes()); // grfDebugLogFlags
        h.extend_from_slice(&[0; 12]); // fcrDebugLog: fcrZero
        h.extend_from_slice(&[0; 12]); // fcrAllocVerificationFreeChunkList: fcrZero
        for _ in 0..4 {
            h.extend_from_slice(&BUILD_NUMBER.to_le_bytes()); // bn* (4×)
        }
        debug_assert_eq!(h.len(), 0x128);
        h.resize(1024, 0); // rgbReserved
        self.out[..1024].copy_from_slice(&h);
        Ok(self.out)
    }
}

fn push_fcr64x32(h: &mut Vec<u8>, c: Chunk) -> Result<(), WriteError> {
    h.extend_from_slice(&c.stp.to_le_bytes());
    h.extend_from_slice(
        &u32::try_from(c.cb)
            .map_err(|_| too_large("a chunk"))?
            .to_le_bytes(),
    );
    Ok(())
}

fn push_fcr64x32_nil(h: &mut Vec<u8>) {
    h.extend_from_slice(&u64::MAX.to_le_bytes());
    h.extend_from_slice(&0u32.to_le_bytes());
}

enum NodeRef {
    None,
    Chunk(Chunk, u32),
    Nil,
}

/// FileNode ([MS-ONESTORE] §2.4.3): `FileNodeID:10 | Size:13 | StpFormat:2 |
/// CbFormat:2 | BaseType:4 | Reserved:1 (= 1)`, then the chunk reference and
/// the data.
fn encode_node(id: u16, r: NodeRef, data: &[u8]) -> Result<Vec<u8>, WriteError> {
    let mut reference = Vec::new();
    let (stp_format, cb_format, base_type) = match r {
        NodeRef::None => (1, 0, 0),
        NodeRef::Nil => {
            // As OneNote writes it: 8-byte stp of all ones, 1-byte cb of 0.
            reference.extend_from_slice(&u64::MAX.to_le_bytes());
            reference.push(0);
            (0, 2, 1)
        }
        NodeRef::Chunk(c, base_type) => {
            let stp = u32::try_from(c.stp).map_err(|_| too_large("the section"))?;
            reference.extend_from_slice(&stp.to_le_bytes());
            let cb_format = if c.cb.is_multiple_of(8) && c.cb / 8 <= 0xff {
                reference.push((c.cb / 8) as u8);
                2
            } else if c.cb.is_multiple_of(8) && c.cb / 8 <= 0xffff {
                reference.extend_from_slice(&((c.cb / 8) as u16).to_le_bytes());
                3
            } else if let Ok(cb) = u32::try_from(c.cb) {
                reference.extend_from_slice(&cb.to_le_bytes());
                0
            } else {
                reference.extend_from_slice(&c.cb.to_le_bytes());
                1
            };
            (1, cb_format, base_type)
        }
    };
    let size = 4 + reference.len() + data.len();
    if size >= 1 << 13 {
        return Err(WriteError::internal(format!(
            "FileNode 0x{id:x} of {size} bytes"
        )));
    }
    let header = u32::from(id) & 0x3ff
        | (size as u32) << 10
        | stp_format << 23
        | cb_format << 25
        | base_type << 27
        | 1 << 31;
    let mut out = Vec::with_capacity(size);
    out.extend_from_slice(&header.to_le_bytes());
    out.extend_from_slice(&reference);
    out.extend_from_slice(data);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn node_header_matches_the_spec_example() {
        // [MS-ONESTORE] §3.3: RevisionManifestEndFND is 0x8080101C.
        let n = encode_node(fnd::REVISION_MANIFEST_END, NodeRef::None, &[]).unwrap();
        assert_eq!(n, 0x8080_101cu32.to_le_bytes());
        // ObjectDeclaration2RefCountFND with a u16 stp would be 0x8D0044A4;
        // ours uses a 32-bit stp: StpFormat 1.
        let n = encode_node(
            fnd::OBJECT_DECLARATION2_REF_COUNT,
            NodeRef::Chunk(
                Chunk {
                    stp: 0xf28,
                    cb: 0x20,
                },
                1,
            ),
            &[0; 10],
        )
        .unwrap();
        let h = u32::from_le_bytes([n[0], n[1], n[2], n[3]]);
        assert_eq!(h & 0x3ff, 0xa4);
        assert_eq!((h >> 10) & 0x1fff, 4 + 5 + 10);
        assert_eq!((h >> 23) & 3, 1);
        assert_eq!((h >> 25) & 3, 2);
        assert_eq!((h >> 27) & 0xf, 1);
        assert_eq!(n[8], 4);
    }

    #[test]
    fn long_lists_are_split_with_terminators() {
        let files: Vec<Vec<u8>> = Vec::new();
        let mut w = Writer::new(&files);
        let mut list = FileNodeList::default();
        for _ in 0..4000 {
            list.push(FileNode::plain(fnd::GLOBAL_ID_TABLE_ENTRY, vec![0; 20]));
        }
        let first = w.list(list).unwrap();
        let out = &w.out;
        let mut stp = first.stp as usize;
        let mut cb = first.cb as usize;
        let mut nodes = 0;
        let mut seq = 0;
        loop {
            assert!(cb <= FRAGMENT_LIMIT);
            assert_eq!(
                u32::from_le_bytes(out[stp + 12..stp + 16].try_into().unwrap()),
                seq
            );
            let end = stp + cb - 20;
            let mut p = stp + 16;
            while p + 4 <= end {
                let h = u32::from_le_bytes(out[p..p + 4].try_into().unwrap());
                if h == 0 || h & 0x3ff == 0xff {
                    break;
                }
                nodes += 1;
                p += ((h >> 10) & 0x1fff) as usize;
            }
            let next = u64::from_le_bytes(out[end..end + 8].try_into().unwrap());
            if next == u64::MAX {
                break;
            }
            cb = u32::from_le_bytes(out[end + 8..end + 12].try_into().unwrap()) as usize;
            stp = next as usize;
            seq += 1;
        }
        assert_eq!(nodes, 4000);
        assert!(seq > 0);
    }
}
