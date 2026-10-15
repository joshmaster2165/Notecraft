//! Revision store ("onestore") container layer.
//!
//! Layout of a .one / .onetoc2 file:
//!
//! ```text
//!   0x000  Header (1024 bytes): file-type GUID, format GUID, chunk references
//!          to the transaction log, the root FileNodeList and the free list.
//!   ....   Chunks addressed by FileChunkReference {stp: offset, cb: size}:
//!          - Transaction log: per-FileNodeList committed node counts.
//!          - FileNodeList fragments: magic, list id, sequence, packed FileNodes,
//!            next-fragment reference, footer magic.
//!          - ObjectSpaceObjectPropSet blobs: OID/OSID/ContextID streams + PropertySet.
//!          - FileDataStoreObject blobs: embedded images / attachments.
//! ```
//!
//! Graph: root list -> object space manifests -> revision manifest lists ->
//! revisions -> object groups -> object declarations -> property sets.
//!
//! Structural damage (bad magics, cycles, out-of-range references) makes
//! [`OneStore::new`] fail; damage inside one object's property set becomes a
//! warning when that set is read. Every read is bounds-checked.

use std::borrow::Cow;
use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::fmt;
use std::hash::Hash;
use std::rc::Rc;

use serde::Serialize;

use crate::reader::{hex, utf16le, Guid, ParseError, Reader, Result};

// --- constants ---------------------------------------------------------------

pub const GUID_FILE_TYPE_ONE: &str = "{7B5C52E4-D88C-4DA7-AEB1-5378D02996D3}";
pub const GUID_FILE_TYPE_ONETOC2: &str = "{43FF2FA1-EFD9-4C76-9EE2-10EA5722765F}";
pub const GUID_FILE_FORMAT: &str = "{109ADD3F-911B-49F5-A5D0-1791EDC8AED8}";
const GUID_FDSO_HEADER: &str = "{BDE316E7-2665-4511-A4C4-8D4D0B7A9EAC}";
const GUID_FDSO_FOOTER: &str = "{71FBA722-0F79-4A0B-BB13-899256426B24}";

// FileNodeListFragment magics. OneNote's fragment opener (FUN_100d342d0 in the
// macOS 16.114 arm64 build) also accepts a legacy 32-bit variant whose
// next-fragment pointer is a FileChunkReference32 (16-byte trailer, not 20).
const FRAGMENT_HEADER_MAGIC: u64 = 0xa456_7ab1_f5f7_f4c4;
const FRAGMENT_FOOTER_MAGIC: u64 = 0x8bc2_15c3_8233_ba4b;
const FRAGMENT_HEADER_MAGIC_32: u64 = 0x6d81_4fd0_a242_b102;
const FRAGMENT_FOOTER_MAGIC_32: u64 = 0x45a9_ba65_a795_4cc2;
const TRANSACTION_SENTINEL: u32 = 0x0000_0001;

/// FileNode IDs ([MS-ONESTORE] §2.4.3).
pub mod file_node_id {
    pub const OBJECT_SPACE_MANIFEST_ROOT_FND: u32 = 0x004;
    pub const OBJECT_SPACE_MANIFEST_LIST_REFERENCE_FND: u32 = 0x008;
    pub const OBJECT_SPACE_MANIFEST_LIST_START_FND: u32 = 0x00c;
    pub const REVISION_MANIFEST_LIST_REFERENCE_FND: u32 = 0x010;
    pub const REVISION_MANIFEST_LIST_START_FND: u32 = 0x014;
    pub const REVISION_MANIFEST_START4_FND: u32 = 0x01b;
    pub const REVISION_MANIFEST_END_FND: u32 = 0x01c;
    pub const REVISION_MANIFEST_START6_FND: u32 = 0x01e;
    pub const REVISION_MANIFEST_START7_FND: u32 = 0x01f;
    pub const GLOBAL_ID_TABLE_START_FNDX: u32 = 0x021;
    pub const GLOBAL_ID_TABLE_START2_FND: u32 = 0x022;
    pub const GLOBAL_ID_TABLE_ENTRY_FNDX: u32 = 0x024;
    pub const GLOBAL_ID_TABLE_ENTRY2_FNDX: u32 = 0x025;
    pub const GLOBAL_ID_TABLE_ENTRY3_FNDX: u32 = 0x026;
    pub const GLOBAL_ID_TABLE_END_FNDX: u32 = 0x028;
    pub const OBJECT_DECLARATION_WITH_REF_COUNT_FNDX: u32 = 0x02d;
    pub const OBJECT_DECLARATION_WITH_REF_COUNT2_FNDX: u32 = 0x02e;
    pub const OBJECT_REVISION_WITH_REF_COUNT_FNDX: u32 = 0x041;
    pub const OBJECT_REVISION_WITH_REF_COUNT2_FNDX: u32 = 0x042;
    pub const ROOT_OBJECT_REFERENCE2_FNDX: u32 = 0x059;
    pub const ROOT_OBJECT_REFERENCE3_FND: u32 = 0x05a;
    pub const REVISION_ROLE_DECLARATION_FND: u32 = 0x05c;
    pub const REVISION_ROLE_AND_CONTEXT_DECLARATION_FND: u32 = 0x05d;
    pub const OBJECT_DECLARATION_FILE_DATA3_REF_COUNT_FND: u32 = 0x072;
    pub const OBJECT_DECLARATION_FILE_DATA3_LARGE_REF_COUNT_FND: u32 = 0x073;
    pub const OBJECT_DATA_ENCRYPTION_KEY_V2_FNDX: u32 = 0x07c;
    pub const OBJECT_INFO_DEPENDENCY_OVERRIDES_FND: u32 = 0x084;
    pub const DATA_SIGNATURE_GROUP_DEFINITION_FND: u32 = 0x08c;
    pub const FILE_DATA_STORE_LIST_REFERENCE_FND: u32 = 0x090;
    pub const FILE_DATA_STORE_OBJECT_REFERENCE_FND: u32 = 0x094;
    pub const OBJECT_DECLARATION2_REF_COUNT_FND: u32 = 0x0a4;
    pub const OBJECT_DECLARATION2_LARGE_REF_COUNT_FND: u32 = 0x0a5;
    pub const OBJECT_GROUP_LIST_REFERENCE_FND: u32 = 0x0b0;
    pub const OBJECT_GROUP_START_FND: u32 = 0x0b4;
    pub const OBJECT_GROUP_END_FND: u32 = 0x0b8;
    pub const HASHED_CHUNK_DESCRIPTOR2_FND: u32 = 0x0c2;
    pub const READ_ONLY_OBJECT_DECLARATION2_REF_COUNT_FND: u32 = 0x0c4;
    pub const READ_ONLY_OBJECT_DECLARATION2_LARGE_REF_COUNT_FND: u32 = 0x0c5;
    pub const CHUNK_TERMINATOR_FND: u32 = 0x0ff;
}
use file_node_id as F;

/// The [MS-ONESTORE] name of a FileNode ID.
pub fn file_node_name(id: u32) -> Cow<'static, str> {
    let name = match id {
        F::OBJECT_SPACE_MANIFEST_ROOT_FND => "ObjectSpaceManifestRootFND",
        F::OBJECT_SPACE_MANIFEST_LIST_REFERENCE_FND => "ObjectSpaceManifestListReferenceFND",
        F::OBJECT_SPACE_MANIFEST_LIST_START_FND => "ObjectSpaceManifestListStartFND",
        F::REVISION_MANIFEST_LIST_REFERENCE_FND => "RevisionManifestListReferenceFND",
        F::REVISION_MANIFEST_LIST_START_FND => "RevisionManifestListStartFND",
        F::REVISION_MANIFEST_START4_FND => "RevisionManifestStart4FND",
        F::REVISION_MANIFEST_END_FND => "RevisionManifestEndFND",
        F::REVISION_MANIFEST_START6_FND => "RevisionManifestStart6FND",
        F::REVISION_MANIFEST_START7_FND => "RevisionManifestStart7FND",
        F::GLOBAL_ID_TABLE_START_FNDX => "GlobalIdTableStartFNDX",
        F::GLOBAL_ID_TABLE_START2_FND => "GlobalIdTableStart2FND",
        F::GLOBAL_ID_TABLE_ENTRY_FNDX => "GlobalIdTableEntryFNDX",
        F::GLOBAL_ID_TABLE_ENTRY2_FNDX => "GlobalIdTableEntry2FNDX",
        F::GLOBAL_ID_TABLE_ENTRY3_FNDX => "GlobalIdTableEntry3FNDX",
        F::GLOBAL_ID_TABLE_END_FNDX => "GlobalIdTableEndFNDX",
        F::OBJECT_DECLARATION_WITH_REF_COUNT_FNDX => "ObjectDeclarationWithRefCountFNDX",
        F::OBJECT_DECLARATION_WITH_REF_COUNT2_FNDX => "ObjectDeclarationWithRefCount2FNDX",
        F::OBJECT_REVISION_WITH_REF_COUNT_FNDX => "ObjectRevisionWithRefCountFNDX",
        F::OBJECT_REVISION_WITH_REF_COUNT2_FNDX => "ObjectRevisionWithRefCount2FNDX",
        F::ROOT_OBJECT_REFERENCE2_FNDX => "RootObjectReference2FNDX",
        F::ROOT_OBJECT_REFERENCE3_FND => "RootObjectReference3FND",
        F::REVISION_ROLE_DECLARATION_FND => "RevisionRoleDeclarationFND",
        F::REVISION_ROLE_AND_CONTEXT_DECLARATION_FND => "RevisionRoleAndContextDeclarationFND",
        F::OBJECT_DECLARATION_FILE_DATA3_REF_COUNT_FND => "ObjectDeclarationFileData3RefCountFND",
        F::OBJECT_DECLARATION_FILE_DATA3_LARGE_REF_COUNT_FND => {
            "ObjectDeclarationFileData3LargeRefCountFND"
        }
        F::OBJECT_DATA_ENCRYPTION_KEY_V2_FNDX => "ObjectDataEncryptionKeyV2FNDX",
        F::OBJECT_INFO_DEPENDENCY_OVERRIDES_FND => "ObjectInfoDependencyOverridesFND",
        F::DATA_SIGNATURE_GROUP_DEFINITION_FND => "DataSignatureGroupDefinitionFND",
        F::FILE_DATA_STORE_LIST_REFERENCE_FND => "FileDataStoreListReferenceFND",
        F::FILE_DATA_STORE_OBJECT_REFERENCE_FND => "FileDataStoreObjectReferenceFND",
        F::OBJECT_DECLARATION2_REF_COUNT_FND => "ObjectDeclaration2RefCountFND",
        F::OBJECT_DECLARATION2_LARGE_REF_COUNT_FND => "ObjectDeclaration2LargeRefCountFND",
        F::OBJECT_GROUP_LIST_REFERENCE_FND => "ObjectGroupListReferenceFND",
        F::OBJECT_GROUP_START_FND => "ObjectGroupStartFND",
        F::OBJECT_GROUP_END_FND => "ObjectGroupEndFND",
        F::HASHED_CHUNK_DESCRIPTOR2_FND => "HashedChunkDescriptor2FND",
        F::READ_ONLY_OBJECT_DECLARATION2_REF_COUNT_FND => "ReadOnlyObjectDeclaration2RefCountFND",
        F::READ_ONLY_OBJECT_DECLARATION2_LARGE_REF_COUNT_FND => {
            "ReadOnlyObjectDeclaration2LargeRefCountFND"
        }
        F::CHUNK_TERMINATOR_FND => "ChunkTerminatorFND",
        _ => return Cow::Owned(format!("Unknown_0x{id:x}")),
    };
    Cow::Borrowed(name)
}

/// Revision roles ([MS-ONESTORE] §2.1.8).
pub mod root_role {
    pub const DEFAULT_CONTENT: u32 = 1;
    pub const METADATA: u32 = 2;
    pub const ENCRYPTION_KEY: u32 = 4;
    pub const VERSION_METADATA: u32 = 8;
}

/// Thrown by the reference implementation when it dereferences a FileNode
/// that carries no chunk reference.
fn missing_reference() -> ParseError {
    ParseError::plain("Cannot read properties of undefined (reading 'cb')")
}

// --- ordered map (JavaScript Map semantics) ------------------------------------

/// Insertion-ordered map: `insert` on an existing key replaces the value in
/// place, like `Map.prototype.set`. Iteration order is part of the output.
#[derive(Debug, Clone)]
pub struct OrderedMap<K, V> {
    keys: Vec<K>,
    values: Vec<V>,
    index: HashMap<K, usize>,
}

impl<K: Hash + Eq + Clone, V> Default for OrderedMap<K, V> {
    fn default() -> Self {
        OrderedMap {
            keys: Vec::new(),
            values: Vec::new(),
            index: HashMap::new(),
        }
    }
}

impl<K: Hash + Eq + Clone, V> OrderedMap<K, V> {
    /// Insert or replace; returns the entry's position.
    pub fn insert(&mut self, key: K, value: V) -> usize {
        if let Some(&i) = self.index.get(&key) {
            self.values[i] = value;
            return i;
        }
        self.index.insert(key.clone(), self.keys.len());
        self.keys.push(key);
        self.values.push(value);
        self.values.len() - 1
    }

    pub fn get(&self, key: &K) -> Option<&V> {
        self.index.get(key).map(|&i| &self.values[i])
    }

    pub fn position(&self, key: &K) -> Option<usize> {
        self.index.get(key).copied()
    }

    pub fn at(&self, i: usize) -> &V {
        &self.values[i]
    }

    fn at_mut(&mut self, i: usize) -> &mut V {
        &mut self.values[i]
    }

    pub fn values(&self) -> std::slice::Iter<'_, V> {
        self.values.iter()
    }

    pub fn iter(&self) -> impl Iterator<Item = (&K, &V)> {
        self.keys.iter().zip(self.values.iter())
    }

    pub fn len(&self) -> usize {
        self.values.len()
    }

    pub fn is_empty(&self) -> bool {
        self.values.is_empty()
    }
}

// --- primitive structures ----------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
pub struct FileChunkReference {
    pub stp: u64,
    pub cb: u64,
}

impl FileChunkReference {
    /// fcrNil: stp all ones, cb zero. fcrZero: both zero. Either means "nothing here".
    pub fn is_nil(&self) -> bool {
        self.cb == 0
    }

    fn start(&self) -> i64 {
        self.stp as i64
    }

    fn end(&self) -> i64 {
        (self.stp + self.cb) as i64
    }
}

/// ExtendedGUID: a GUID plus a 32-bit sequence number. Displays as the
/// `{GUID}#n` key used for every id in the JSON output.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub struct ExtendedGuid {
    pub guid: Guid,
    pub n: u32,
}

impl ExtendedGuid {
    pub const NIL: ExtendedGuid = ExtendedGuid {
        guid: Guid::NIL,
        n: 0,
    };

    pub fn is_nil(&self) -> bool {
        self.guid.is_nil() && self.n == 0
    }

    /// `{GUID}#n`
    pub fn key(&self) -> String {
        let mut s = String::with_capacity(49);
        s.push_str(std::str::from_utf8(&self.guid.to_ascii()).unwrap_or_default());
        s.push('#');
        let mut digits = [0u8; 10];
        let mut n = self.n;
        let mut i = digits.len();
        loop {
            i -= 1;
            digits[i] = b'0' + (n % 10) as u8;
            n /= 10;
            if n == 0 {
                break;
            }
        }
        s.push_str(std::str::from_utf8(&digits[i..]).unwrap_or_default());
        s
    }
}

impl fmt::Display for ExtendedGuid {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.key())
    }
}

/// CompactID: an index into the current global id table plus the sequence number.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CompactId {
    pub n: u32,
    pub guid_index: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Jcid {
    pub raw: u32,
    pub index: u32,
    pub is_binary: bool,
    pub is_property_set: bool,
    pub is_graph_node: bool,
    pub is_file_data: bool,
    pub is_read_only: bool,
}

pub fn decode_jcid(raw: u32) -> Jcid {
    Jcid {
        raw,
        index: raw & 0xffff,
        is_binary: raw & 0x10000 != 0,
        is_property_set: raw & 0x20000 != 0,
        is_graph_node: raw & 0x40000 != 0,
        is_file_data: raw & 0x80000 != 0,
        is_read_only: raw & 0x100000 != 0,
    }
}

fn read_fcr32(r: &mut Reader) -> Result<FileChunkReference> {
    Ok(FileChunkReference {
        stp: u64::from(r.u32()?),
        cb: u64::from(r.u32()?),
    })
}

fn read_fcr64x32(r: &mut Reader) -> Result<FileChunkReference> {
    let stp = r.u64n()?;
    Ok(FileChunkReference {
        stp,
        cb: u64::from(r.u32()?),
    })
}

fn read_extended_guid(r: &mut Reader) -> Result<ExtendedGuid> {
    let guid = r.guid()?;
    Ok(ExtendedGuid { guid, n: r.u32()? })
}

fn read_compact_id(r: &mut Reader) -> Result<CompactId> {
    let v = r.u32()?;
    Ok(CompactId {
        n: v & 0xff,
        guid_index: v >> 8,
    })
}

fn read_string_in_storage_buffer(r: &mut Reader) -> Result<String> {
    let cch = r.u32()?;
    Ok(utf16le(r.bytes(i64::from(cch) * 2)?))
}

// --- header ------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum FileKind {
    Section,
    Toc,
    Unknown,
}

impl FileKind {
    pub fn as_str(self) -> &'static str {
        match self {
            FileKind::Section => "section",
            FileKind::Toc => "toc",
            FileKind::Unknown => "unknown",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Header {
    pub guid_file_type: String,
    pub file_kind: FileKind,
    pub guid_file: String,
    pub guid_file_format: String,
    pub ffv_last_code_that_wrote_to_this_file: u32,
    pub ffv_oldest_code_that_has_written_to_this_file: u32,
    pub ffv_newest_code_that_has_written_to_this_file: u32,
    pub ffv_oldest_code_that_may_read_this_file: u32,
    pub c_transactions_in_log: u32,
    pub guid_ancestor: String,
    pub crc_name: u32,
    pub fcr_hashed_chunk_list: FileChunkReference,
    pub fcr_transaction_log: FileChunkReference,
    pub fcr_file_node_list_root: FileChunkReference,
    pub fcr_free_chunk_list: FileChunkReference,
    pub cb_expected_file_length: u64,
    pub cb_free_space_in_free_chunk_list: u64,
    pub guid_file_version: String,
    pub n_file_version_generation: u64,
    pub guid_deny_read_file_version: String,
    pub bn_created: u32,
    pub bn_last_wrote_to_this_file: u32,
    pub bn_oldest_written: u32,
    pub bn_newest_written: u32,
}

pub fn parse_header(buf: &[u8]) -> Result<Header> {
    if buf.len() < 1024 {
        return Err(ParseError::at("file shorter than the 1024-byte header", 0));
    }
    let mut r = Reader::new(buf, 0, 1024)?;
    let guid_file_type = r.guid()?.to_string();
    let guid_file = r.guid()?.to_string();
    r.skip(16)?; // guidLegacyFileVersion, must be zero
    let guid_file_format = r.guid()?.to_string();
    if guid_file_format != GUID_FILE_FORMAT {
        return Err(ParseError::at(
            format!("not a revision store file (format GUID {guid_file_format})"),
            0x30,
        ));
    }
    let ffv_last = r.u32()?;
    let ffv_oldest = r.u32()?;
    let ffv_newest = r.u32()?;
    let ffv_oldest_reader = r.u32()?;
    read_fcr32(&mut r)?; // fcrLegacyFreeChunkList
    read_fcr32(&mut r)?; // fcrLegacyTransactionLog
    let c_transactions_in_log = r.u32()?;
    r.u32()?; // cbLegacyExpectedFileLength
    r.skip(8)?; // rgbPlaceholder
    read_fcr32(&mut r)?; // fcrLegacyFileNodeListRoot
    r.u32()?; // cbLegacyFreeSpaceInFreeChunkList
    r.skip(4)?; // fNeedsDefrag, fRepairedFile, fNeedsGarbageCollect, fHasNoEmbeddedFileObjects
    let guid_ancestor = r.guid()?.to_string();
    let crc_name = r.u32()?;
    let fcr_hashed_chunk_list = read_fcr64x32(&mut r)?;
    let fcr_transaction_log = read_fcr64x32(&mut r)?;
    let fcr_file_node_list_root = read_fcr64x32(&mut r)?;
    let fcr_free_chunk_list = read_fcr64x32(&mut r)?;
    let cb_expected_file_length = r.u64n()?;
    let cb_free_space_in_free_chunk_list = r.u64n()?;
    let guid_file_version = r.guid()?.to_string();
    let n_file_version_generation = r.u64n()?;
    let guid_deny_read_file_version = r.guid()?.to_string();
    r.u32()?; // grfDebugLogFlags
    read_fcr64x32(&mut r)?; // fcrDebugLog
    read_fcr64x32(&mut r)?; // fcrAllocVerificationFreeChunkList
    let bn_created = r.u32()?;
    let bn_last_wrote_to_this_file = r.u32()?;
    let bn_oldest_written = r.u32()?;
    let bn_newest_written = r.u32()?;
    let file_kind = match guid_file_type.as_str() {
        GUID_FILE_TYPE_ONE => FileKind::Section,
        GUID_FILE_TYPE_ONETOC2 => FileKind::Toc,
        _ => FileKind::Unknown,
    };
    Ok(Header {
        guid_file_type,
        file_kind,
        guid_file,
        guid_file_format,
        ffv_last_code_that_wrote_to_this_file: ffv_last,
        ffv_oldest_code_that_has_written_to_this_file: ffv_oldest,
        ffv_newest_code_that_has_written_to_this_file: ffv_newest,
        ffv_oldest_code_that_may_read_this_file: ffv_oldest_reader,
        c_transactions_in_log,
        guid_ancestor,
        crc_name,
        fcr_hashed_chunk_list,
        fcr_transaction_log,
        fcr_file_node_list_root,
        fcr_free_chunk_list,
        cb_expected_file_length,
        cb_free_space_in_free_chunk_list,
        guid_file_version,
        n_file_version_generation,
        guid_deny_read_file_version,
        bn_created,
        bn_last_wrote_to_this_file,
        bn_oldest_written,
        bn_newest_written,
    })
}

// --- transaction log ---------------------------------------------------------

/// Committed node count per FileNodeListID. Nodes past this count in a list
/// belong to an uncommitted transaction and must be ignored.
fn parse_transaction_log(buf: &[u8], header: &Header) -> Result<HashMap<u32, u32>> {
    let mut counts = HashMap::new();
    let mut fcr = header.fcr_transaction_log;
    let mut transactions: u64 = 0;
    let wanted = u64::from(header.c_transactions_in_log);
    let mut seen = HashSet::new();
    while !fcr.is_nil() && transactions < wanted {
        if !seen.insert(fcr.stp) {
            return Err(ParseError::at(
                "transaction log fragment cycle",
                fcr.start(),
            ));
        }
        let mut r = Reader::new(buf, fcr.start(), fcr.end())?;
        let entries = (fcr.cb as i64 - 12).div_euclid(8);
        let mut i = 0;
        while i < entries && transactions < wanted {
            let src_id = r.u32()?;
            let value = r.u32()?;
            if src_id == TRANSACTION_SENTINEL {
                transactions += 1;
            } else {
                counts.insert(src_id, value);
            }
            i += 1;
        }
        // nextFragment follows the last whole entry; the chunk can carry trailing padding.
        r.pos = fcr.start() + entries * 8;
        fcr = read_fcr64x32(&mut r)?;
    }
    Ok(counts)
}

// --- file nodes --------------------------------------------------------------

/// Type-specific FileNode fields.
#[derive(Debug, Clone)]
pub enum NodeData {
    None,
    ObjectSpaceManifestRoot {
        gosid_root: ExtendedGuid,
    },
    /// ObjectSpaceManifestListReferenceFND and ObjectSpaceManifestListStartFND.
    ObjectSpaceManifestList {
        gosid: ExtendedGuid,
    },
    RevisionManifestListStart {
        gosid: ExtendedGuid,
        n_instance: u32,
    },
    /// RevisionManifestStart4/6/7FND.
    RevisionManifestStart {
        rid: ExtendedGuid,
        rid_dependent: ExtendedGuid,
        time_creation: Option<u64>,
        revision_role: u32,
        odcs_default: u16,
        gctxid: Option<ExtendedGuid>,
    },
    GlobalIdTableEntry {
        index: u32,
        guid: Guid,
    },
    GlobalIdTableEntry2 {
        i_index_map_from: u32,
        i_index_map_to: u32,
    },
    GlobalIdTableEntry3 {
        i_index_copy_from_start: u32,
        c_entries_to_copy: u32,
        i_index_copy_to_start: u32,
    },
    /// Every object declaration / revision node. `jcid` is None for
    /// ObjectRevisionWithRefCount*, which re-declares an existing object.
    ObjectDeclaration {
        oid: CompactId,
        jcid: Option<u32>,
        odcs: Option<u32>,
        has_oid_references: bool,
        has_osid_references: bool,
        c_ref: u32,
        file_data_reference: Option<String>,
        extension: Option<String>,
        md5: Option<String>,
    },
    RootObjectReference2 {
        oid_root: CompactId,
        root_role: u32,
    },
    RootObjectReference3 {
        oid_root: ExtendedGuid,
        root_role: u32,
    },
    /// RevisionRoleDeclarationFND and RevisionRoleAndContextDeclarationFND.
    RevisionRoleDeclaration {
        rid: ExtendedGuid,
        revision_role: u32,
        gctxid: Option<ExtendedGuid>,
    },
    DataSignatureGroupDefinition {
        data_signature_group: ExtendedGuid,
    },
    FileDataStoreObjectReference {
        guid_reference: String,
    },
    ObjectGroupListReference {
        object_group_id: ExtendedGuid,
    },
    ObjectGroupStart {
        oid: ExtendedGuid,
    },
    HashedChunkDescriptor2 {
        guid_hash: String,
    },
}

#[derive(Debug, Clone)]
pub struct FileNode {
    pub id: u32,
    pub offset: i64,
    pub size: u32,
    /// Present when BaseType is 1 (data) or 2 (child FileNodeList).
    pub chunk: Option<FileChunkReference>,
    pub base_type: u32,
    pub data: NodeData,
}

impl FileNode {
    pub fn name(&self) -> Cow<'static, str> {
        file_node_name(self.id)
    }
}

fn read_chunk_ref(r: &mut Reader, stp_format: u32, cb_format: u32) -> Result<FileChunkReference> {
    let stp = match stp_format {
        0 => r.u64n()?,
        1 => u64::from(r.u32()?),
        2 => u64::from(r.u16()?) * 8,
        _ => u64::from(r.u32()?) * 8,
    };
    let cb = match cb_format {
        0 => u64::from(r.u32()?),
        1 => r.u64n()?,
        2 => u64::from(r.u8()?) * 8,
        _ => u64::from(r.u16()?) * 8,
    };
    Ok(FileChunkReference { stp, cb })
}

fn parse_file_node(r: &mut Reader, offset: i64) -> Result<FileNode> {
    let h = r.u32()?;
    let id = h & 0x3ff;
    let size = (h >> 10) & 0x1fff;
    let stp_format = (h >> 23) & 0x3;
    let cb_format = (h >> 25) & 0x3;
    let base_type = (h >> 27) & 0xf;
    if size < 4 {
        return Err(ParseError::at(
            format!("FileNode 0x{id:x} has size {size}"),
            offset,
        ));
    }
    // The body is bounded by the file, not by the fragment.
    let mut body = r.sub(offset + 4, i64::from(size) - 4)?;
    r.pos = offset + i64::from(size);

    let chunk = if base_type == 1 || base_type == 2 {
        Some(read_chunk_ref(&mut body, stp_format, cb_format)?)
    } else {
        None
    };
    let b = &mut body;
    let data = match id {
        F::OBJECT_SPACE_MANIFEST_ROOT_FND => NodeData::ObjectSpaceManifestRoot {
            gosid_root: read_extended_guid(b)?,
        },
        F::OBJECT_SPACE_MANIFEST_LIST_REFERENCE_FND | F::OBJECT_SPACE_MANIFEST_LIST_START_FND => {
            NodeData::ObjectSpaceManifestList {
                gosid: read_extended_guid(b)?,
            }
        }
        F::REVISION_MANIFEST_LIST_START_FND => {
            let gosid = read_extended_guid(b)?;
            NodeData::RevisionManifestListStart {
                gosid,
                n_instance: b.u32()?,
            }
        }
        F::REVISION_MANIFEST_START4_FND => {
            let rid = read_extended_guid(b)?;
            let rid_dependent = read_extended_guid(b)?;
            let time_creation = Some(b.u64()?);
            let revision_role = b.u32()?;
            let odcs_default = b.u16()?;
            NodeData::RevisionManifestStart {
                rid,
                rid_dependent,
                time_creation,
                revision_role,
                odcs_default,
                gctxid: None,
            }
        }
        F::REVISION_MANIFEST_START6_FND | F::REVISION_MANIFEST_START7_FND => {
            let rid = read_extended_guid(b)?;
            let rid_dependent = read_extended_guid(b)?;
            let revision_role = b.u32()?;
            let odcs_default = b.u16()?;
            let gctxid = if id == F::REVISION_MANIFEST_START7_FND {
                Some(read_extended_guid(b)?)
            } else {
                None
            };
            NodeData::RevisionManifestStart {
                rid,
                rid_dependent,
                time_creation: None,
                revision_role,
                odcs_default,
                gctxid,
            }
        }
        F::GLOBAL_ID_TABLE_ENTRY_FNDX => {
            let index = b.u32()?;
            NodeData::GlobalIdTableEntry {
                index,
                guid: b.guid()?,
            }
        }
        F::GLOBAL_ID_TABLE_ENTRY2_FNDX => {
            let i_index_map_from = b.u32()?;
            NodeData::GlobalIdTableEntry2 {
                i_index_map_from,
                i_index_map_to: b.u32()?,
            }
        }
        F::GLOBAL_ID_TABLE_ENTRY3_FNDX => {
            let i_index_copy_from_start = b.u32()?;
            let c_entries_to_copy = b.u32()?;
            NodeData::GlobalIdTableEntry3 {
                i_index_copy_from_start,
                c_entries_to_copy,
                i_index_copy_to_start: b.u32()?,
            }
        }
        F::OBJECT_DECLARATION_WITH_REF_COUNT_FNDX | F::OBJECT_DECLARATION_WITH_REF_COUNT2_FNDX => {
            // 2007-era declaration: jci is the JCID index with IsPropertySet implied.
            let oid = read_compact_id(b)?;
            let lo = u32::from(b.u16()?);
            let hi = b.u32()?;
            let c_ref = if id == F::OBJECT_DECLARATION_WITH_REF_COUNT_FNDX {
                u32::from(b.u8()?)
            } else {
                b.u32()?
            };
            NodeData::ObjectDeclaration {
                oid,
                jcid: Some(0x0002_0000 | (lo & 0x3ff)),
                odcs: Some((lo >> 10) & 0xf),
                has_oid_references: hi & 0x1 != 0,
                has_osid_references: hi & 0x2 != 0,
                c_ref,
                file_data_reference: None,
                extension: None,
                md5: None,
            }
        }
        F::OBJECT_REVISION_WITH_REF_COUNT_FNDX => {
            let oid = read_compact_id(b)?;
            let v = b.u8()?;
            NodeData::ObjectDeclaration {
                oid,
                jcid: None,
                odcs: None,
                has_oid_references: v & 1 != 0,
                has_osid_references: v & 2 != 0,
                c_ref: u32::from(v >> 2),
                file_data_reference: None,
                extension: None,
                md5: None,
            }
        }
        F::OBJECT_REVISION_WITH_REF_COUNT2_FNDX => {
            let oid = read_compact_id(b)?;
            let v = b.u32()?;
            NodeData::ObjectDeclaration {
                oid,
                jcid: None,
                odcs: None,
                has_oid_references: v & 1 != 0,
                has_osid_references: v & 2 != 0,
                c_ref: b.u32()?,
                file_data_reference: None,
                extension: None,
                md5: None,
            }
        }
        F::ROOT_OBJECT_REFERENCE2_FNDX => {
            let oid_root = read_compact_id(b)?;
            NodeData::RootObjectReference2 {
                oid_root,
                root_role: b.u32()?,
            }
        }
        F::ROOT_OBJECT_REFERENCE3_FND => {
            let oid_root = read_extended_guid(b)?;
            NodeData::RootObjectReference3 {
                oid_root,
                root_role: b.u32()?,
            }
        }
        F::REVISION_ROLE_DECLARATION_FND | F::REVISION_ROLE_AND_CONTEXT_DECLARATION_FND => {
            let rid = read_extended_guid(b)?;
            let revision_role = b.u32()?;
            let gctxid = if id == F::REVISION_ROLE_AND_CONTEXT_DECLARATION_FND {
                Some(read_extended_guid(b)?)
            } else {
                None
            };
            NodeData::RevisionRoleDeclaration {
                rid,
                revision_role,
                gctxid,
            }
        }
        F::OBJECT_DECLARATION_FILE_DATA3_REF_COUNT_FND
        | F::OBJECT_DECLARATION_FILE_DATA3_LARGE_REF_COUNT_FND => {
            let oid = read_compact_id(b)?;
            let jcid = b.u32()?;
            let c_ref = if id == F::OBJECT_DECLARATION_FILE_DATA3_REF_COUNT_FND {
                u32::from(b.u8()?)
            } else {
                b.u32()?
            };
            let file_data_reference = read_string_in_storage_buffer(b)?;
            let extension = read_string_in_storage_buffer(b)?;
            NodeData::ObjectDeclaration {
                oid,
                jcid: Some(jcid),
                odcs: None,
                has_oid_references: false,
                has_osid_references: false,
                c_ref,
                file_data_reference: Some(file_data_reference),
                extension: Some(extension),
                md5: None,
            }
        }
        F::DATA_SIGNATURE_GROUP_DEFINITION_FND => NodeData::DataSignatureGroupDefinition {
            data_signature_group: read_extended_guid(b)?,
        },
        F::FILE_DATA_STORE_OBJECT_REFERENCE_FND => NodeData::FileDataStoreObjectReference {
            guid_reference: b.guid()?.to_string(),
        },
        F::OBJECT_DECLARATION2_REF_COUNT_FND
        | F::OBJECT_DECLARATION2_LARGE_REF_COUNT_FND
        | F::READ_ONLY_OBJECT_DECLARATION2_REF_COUNT_FND
        | F::READ_ONLY_OBJECT_DECLARATION2_LARGE_REF_COUNT_FND => {
            let oid = read_compact_id(b)?;
            let jcid = b.u32()?;
            let v = b.u8()?;
            let large = id == F::OBJECT_DECLARATION2_LARGE_REF_COUNT_FND
                || id == F::READ_ONLY_OBJECT_DECLARATION2_LARGE_REF_COUNT_FND;
            let c_ref = if large { b.u32()? } else { u32::from(b.u8()?) };
            let md5 = if id == F::READ_ONLY_OBJECT_DECLARATION2_REF_COUNT_FND
                || id == F::READ_ONLY_OBJECT_DECLARATION2_LARGE_REF_COUNT_FND
            {
                Some(hex(b.bytes(16)?))
            } else {
                None
            };
            NodeData::ObjectDeclaration {
                oid,
                jcid: Some(jcid),
                odcs: None,
                has_oid_references: v & 1 != 0,
                has_osid_references: v & 2 != 0,
                c_ref,
                file_data_reference: None,
                extension: None,
                md5,
            }
        }
        F::OBJECT_GROUP_LIST_REFERENCE_FND => NodeData::ObjectGroupListReference {
            object_group_id: read_extended_guid(b)?,
        },
        F::OBJECT_GROUP_START_FND => NodeData::ObjectGroupStart {
            oid: read_extended_guid(b)?,
        },
        F::HASHED_CHUNK_DESCRIPTOR2_FND => NodeData::HashedChunkDescriptor2 {
            guid_hash: hex(b.bytes(16)?),
        },
        _ => NodeData::None,
    };
    Ok(FileNode {
        id,
        offset,
        size,
        chunk,
        base_type,
        data,
    })
}

// --- object model ------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub enum PropertyValue<'a> {
    None,
    Bool(bool),
    Bytes(&'a [u8]),
    Oids {
        ids: Vec<Option<ExtendedGuid>>,
        single: bool,
    },
    Osids {
        ids: Vec<Option<ExtendedGuid>>,
        single: bool,
    },
    ContextIds {
        ids: Vec<Option<ExtendedGuid>>,
        single: bool,
    },
    PropertyValues {
        prid: u32,
        sets: Vec<PropertySet<'a>>,
    },
    PropertySet(PropertySet<'a>),
}

#[derive(Debug, Clone, PartialEq)]
pub struct Property<'a> {
    pub prid: u32,
    /// Lower 26 bits of the PropertyID.
    pub id: u32,
    pub ty: u32,
    pub value: PropertyValue<'a>,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct PropertySet<'a> {
    pub properties: Vec<Property<'a>>,
}

/// Index of a global id table (CompactID guid index → GUID) in the store.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GidTableId(usize);

type GidTable = HashMap<u64, Guid>;

#[derive(Debug, Clone)]
pub struct ObjectDeclaration {
    pub oid: ExtendedGuid,
    pub jcid: Jcid,
    /// The ObjectSpaceObjectPropSet (or file data) chunk; `ref` in TypeScript.
    pub chunk: Option<FileChunkReference>,
    pub has_oid_references: bool,
    pub has_osid_references: bool,
    /// Global id table used to resolve CompactIDs inside this object's prop set.
    pub gid_table: GidTableId,
    pub file_data_reference: Option<String>,
    pub extension: Option<String>,
    pub declared_by: &'static str,
}

#[derive(Debug, Clone)]
pub struct Revision {
    pub rid: ExtendedGuid,
    pub rid_dependent: ExtendedGuid,
    pub role: u32,
    pub context: Option<ExtendedGuid>,
    pub objects: OrderedMap<ExtendedGuid, ObjectDeclaration>,
    /// Root objects by root role, in declaration order.
    pub roots: Vec<(u32, ExtendedGuid)>,
    pub gid_table: GidTableId,
}

impl Revision {
    pub fn root(&self, role: u32) -> Option<ExtendedGuid> {
        self.roots
            .iter()
            .find(|(r, _)| *r == role)
            .map(|(_, oid)| *oid)
    }

    fn set_root(&mut self, role: u32, oid: ExtendedGuid) {
        match self.roots.iter_mut().find(|(r, _)| *r == role) {
            Some(slot) => slot.1 = oid,
            None => self.roots.push((role, oid)),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RoleAssignment {
    pub rid: ExtendedGuid,
    pub role: u32,
    pub context: Option<ExtendedGuid>,
}

#[derive(Debug, Clone)]
pub struct ObjectSpace {
    pub gosid: ExtendedGuid,
    pub revisions: OrderedMap<ExtendedGuid, Revision>,
    /// Ordered (rid, role, context) assignments; the last one for a role/context wins.
    pub role_assignments: Vec<RoleAssignment>,
    pub encrypted: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct FileData {
    pub guid: String,
    pub offset: u64,
    pub length: u64,
}

/// Every FileNodeList fragment read, for format diagnostics.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Fragment {
    pub list_id: u32,
    pub seq: u32,
    pub offset: u64,
    pub size: u64,
    pub nodes: usize,
}

/// A parsed revision store. Property sets are parsed lazily (and cached) by
/// [`OneStore::property_set`]; their failures are appended to the warnings.
pub struct OneStore<'a> {
    pub buf: &'a [u8],
    pub header: Header,
    pub root_gosid: Option<ExtendedGuid>,
    pub object_spaces: OrderedMap<ExtendedGuid, ObjectSpace>,
    pub file_data: OrderedMap<String, FileData>,
    pub fragments: Vec<Fragment>,
    warnings: RefCell<Vec<String>>,
    gid_tables: Vec<GidTable>,
    prop_cache: RefCell<HashMap<(u64, u64), Rc<PropertySet<'a>>>>,
}

/// Construction state: the store before its object graph is complete.
struct Builder<'a> {
    buf: &'a [u8],
    tx_counts: HashMap<u32, u32>,
    warnings: Vec<String>,
    fragments: Vec<Fragment>,
    gid_tables: Vec<GidTable>,
    object_spaces: OrderedMap<ExtendedGuid, ObjectSpace>,
    file_data: OrderedMap<String, FileData>,
}

/// Object as seen from a revision: its own declarations, then its dependency chain.
fn find_in<'s>(
    space: Option<&'s ObjectSpace>,
    rev: &'s Revision,
    oid: &ExtendedGuid,
) -> Option<&'s ObjectDeclaration> {
    let mut r = Some(rev);
    let mut guard = 0;
    while let Some(cur) = r {
        if guard >= 10_000 {
            break;
        }
        if let Some(o) = cur.objects.get(oid) {
            return Some(o);
        }
        r = match space {
            Some(s) if !cur.rid_dependent.is_nil() => s.revisions.get(&cur.rid_dependent),
            _ => None,
        };
        guard += 1;
    }
    None
}

fn resolve_compact_id(c: CompactId, table: &GidTable) -> Option<ExtendedGuid> {
    if c.n == 0 && c.guid_index == 0 {
        return Some(ExtendedGuid::NIL);
    }
    table
        .get(&u64::from(c.guid_index))
        .map(|&guid| ExtendedGuid { guid, n: c.n })
}

impl<'a> Builder<'a> {
    fn new_gid_table(&mut self) -> GidTableId {
        self.gid_tables.push(GidTable::new());
        GidTableId(self.gid_tables.len() - 1)
    }

    // FileNodeList: a chain of fragments. Stops at the committed node count from
    // the transaction log, a ChunkTerminatorFND, or the end of the fragment.
    fn read_file_node_list(&mut self, first: FileChunkReference) -> Result<Vec<FileNode>> {
        let buf = self.buf;
        let mut nodes: Vec<FileNode> = Vec::new();
        let mut fcr = first;
        let mut limit = usize::MAX;
        let mut list_id: Option<u32> = None;
        let mut expected_seq: u64 = 0;
        let mut seen = HashSet::new();
        while !fcr.is_nil() {
            if !seen.insert(fcr.stp) {
                return Err(ParseError::at("FileNodeList fragment cycle", fcr.start()));
            }
            if fcr.cb < 0x24 {
                return Err(ParseError::at(
                    format!("FileNodeListFragment of {} bytes", fcr.cb),
                    fcr.start(),
                ));
            }
            let mut r = Reader::new(buf, fcr.start(), fcr.end())?;
            let magic = r.u64()?;
            let wide = magic == FRAGMENT_HEADER_MAGIC;
            if !wide && magic != FRAGMENT_HEADER_MAGIC_32 {
                return Err(ParseError::at(
                    "bad FileNodeListFragment header magic",
                    fcr.start(),
                ));
            }
            let id = r.u32()?;
            let seq = r.u32()?;
            match list_id {
                None => {
                    list_id = Some(id);
                    limit = self.tx_counts.get(&id).map_or(usize::MAX, |&c| c as usize);
                }
                Some(expected) if expected != id => {
                    self.warnings.push(format!(
                        "fragment at 0x{:x} belongs to list {id}, expected {expected}",
                        fcr.stp
                    ));
                }
                _ => {}
            }
            if u64::from(seq) != expected_seq {
                self.warnings.push(format!(
                    "list {id}: fragment sequence {seq}, expected {expected_seq}"
                ));
            }
            expected_seq = u64::from(seq) + 1;

            let nodes_end = fcr.end() - if wide { 20 } else { 16 };
            let before = nodes.len();
            while nodes.len() < limit && r.pos + 4 <= nodes_end {
                let h = r.peek_u32()?;
                if h == 0 {
                    break; // padding
                }
                if h & 0x3ff == F::CHUNK_TERMINATOR_FND {
                    break;
                }
                let mut node_reader = Reader::new(buf, r.pos, nodes_end)?;
                nodes.push(parse_file_node(&mut node_reader, r.pos)?);
                r.pos += i64::from((h >> 10) & 0x1fff);
            }
            self.fragments.push(Fragment {
                list_id: id,
                seq,
                offset: fcr.stp,
                size: fcr.cb,
                nodes: nodes.len() - before,
            });

            r.pos = nodes_end;
            let next = if wide {
                read_fcr64x32(&mut r)?
            } else {
                read_fcr32(&mut r)?
            };
            if r.u64()?
                != if wide {
                    FRAGMENT_FOOTER_MAGIC
                } else {
                    FRAGMENT_FOOTER_MAGIC_32
                }
            {
                return Err(ParseError::at(
                    "bad FileNodeListFragment footer magic",
                    r.pos - 8,
                ));
            }
            if nodes.len() >= limit {
                break;
            }
            fcr = next;
        }
        Ok(nodes)
    }

    fn read_file_data_store_list(&mut self, fcr: Option<FileChunkReference>) -> Result<()> {
        let fcr = fcr.ok_or_else(missing_reference)?;
        for node in self.read_file_node_list(fcr)? {
            let (F::FILE_DATA_STORE_OBJECT_REFERENCE_FND, Some(chunk)) = (node.id, node.chunk)
            else {
                continue;
            };
            let mut r = Reader::new(self.buf, chunk.start(), chunk.end())?;
            let guid_header = r.guid()?.to_string();
            if guid_header != GUID_FDSO_HEADER {
                self.warnings.push(format!(
                    "FileDataStoreObject at 0x{:x} has header {guid_header}",
                    chunk.stp
                ));
                continue;
            }
            let length = r.u64n()?;
            r.skip(4 + 8)?; // unused, reserved
            let offset = r.pos as u64;
            r.pos = chunk.end() - 16;
            let footer = r.guid()?.to_string();
            if footer != GUID_FDSO_FOOTER {
                self.warnings.push(format!(
                    "FileDataStoreObject at 0x{:x} has footer {footer}",
                    chunk.stp
                ));
            }
            let NodeData::FileDataStoreObjectReference {
                guid_reference: guid,
            } = node.data
            else {
                continue;
            };
            self.file_data.insert(
                guid.clone(),
                FileData {
                    guid,
                    offset,
                    length,
                },
            );
        }
        Ok(())
    }

    fn revision(&self, space: usize, rev: usize) -> &Revision {
        self.object_spaces.at(space).revisions.at(rev)
    }

    fn revision_mut(&mut self, space: usize, rev: usize) -> &mut Revision {
        self.object_spaces.at_mut(space).revisions.at_mut(rev)
    }

    fn read_object_space(&mut self, node: &FileNode) -> Result<()> {
        let NodeData::ObjectSpaceManifestList { gosid } = node.data else {
            return Ok(());
        };
        let space = ObjectSpace {
            gosid,
            revisions: OrderedMap::default(),
            role_assignments: Vec::new(),
            encrypted: false,
        };
        let si = self.object_spaces.insert(gosid, space);

        // The object space manifest list may contain several revision manifest
        // list references; only the last one is current.
        let mut rev_list_ref: Option<FileChunkReference> = None;
        for n in self.read_file_node_list(node.chunk.ok_or_else(missing_reference)?)? {
            if n.id == F::REVISION_MANIFEST_LIST_REFERENCE_FND {
                rev_list_ref = n.chunk;
            }
        }
        let Some(rev_list_ref) = rev_list_ref else {
            self.warnings.push(format!(
                "object space {gosid} has no revision manifest list"
            ));
            return Ok(());
        };

        let mut current: Option<usize> = None;
        let mut gid_table: Option<GidTableId> = None;
        for n in self.read_file_node_list(rev_list_ref)? {
            match n.id {
                F::REVISION_MANIFEST_START4_FND
                | F::REVISION_MANIFEST_START6_FND
                | F::REVISION_MANIFEST_START7_FND => {
                    let NodeData::RevisionManifestStart {
                        rid,
                        rid_dependent,
                        revision_role,
                        gctxid,
                        ..
                    } = n.data
                    else {
                        continue;
                    };
                    let table = self.new_gid_table();
                    let rev = Revision {
                        rid,
                        rid_dependent,
                        role: revision_role,
                        context: gctxid,
                        objects: OrderedMap::default(),
                        roots: Vec::new(),
                        gid_table: table,
                    };
                    let space = self.object_spaces.at_mut(si);
                    current = Some(space.revisions.insert(rid, rev));
                    space.role_assignments.push(RoleAssignment {
                        rid,
                        role: revision_role,
                        context: gctxid,
                    });
                }
                F::REVISION_MANIFEST_END_FND => current = None,
                F::REVISION_ROLE_DECLARATION_FND | F::REVISION_ROLE_AND_CONTEXT_DECLARATION_FND => {
                    if let NodeData::RevisionRoleDeclaration {
                        rid,
                        revision_role,
                        gctxid,
                    } = n.data
                    {
                        self.object_spaces
                            .at_mut(si)
                            .role_assignments
                            .push(RoleAssignment {
                                rid,
                                role: revision_role,
                                context: gctxid,
                            });
                    }
                }
                F::OBJECT_DATA_ENCRYPTION_KEY_V2_FNDX => {
                    self.object_spaces.at_mut(si).encrypted = true
                }
                F::GLOBAL_ID_TABLE_START_FNDX | F::GLOBAL_ID_TABLE_START2_FND => {
                    gid_table = Some(self.new_gid_table())
                }
                F::GLOBAL_ID_TABLE_ENTRY_FNDX
                | F::GLOBAL_ID_TABLE_ENTRY2_FNDX
                | F::GLOBAL_ID_TABLE_ENTRY3_FNDX => {
                    if let (Some(table), Some(ci)) = (gid_table, current) {
                        let dependency = self.dependency_table(si, ci);
                        self.apply_gid_entry(table, &n, dependency);
                    }
                }
                F::GLOBAL_ID_TABLE_END_FNDX => {
                    if let (Some(ci), Some(table)) = (current, gid_table) {
                        self.revision_mut(si, ci).gid_table = table;
                    }
                    gid_table = None;
                }
                F::OBJECT_GROUP_LIST_REFERENCE_FND => {
                    if let Some(ci) = current {
                        self.read_object_group(n.chunk.ok_or_else(missing_reference)?, si, ci)?;
                    }
                }
                F::ROOT_OBJECT_REFERENCE3_FND => {
                    if let (
                        Some(ci),
                        NodeData::RootObjectReference3 {
                            oid_root,
                            root_role,
                        },
                    ) = (current, &n.data)
                    {
                        self.revision_mut(si, ci).set_root(*root_role, *oid_root);
                    }
                }
                F::ROOT_OBJECT_REFERENCE2_FNDX => {
                    if let (
                        Some(ci),
                        NodeData::RootObjectReference2 {
                            oid_root,
                            root_role,
                        },
                    ) = (current, &n.data)
                    {
                        let table = self.revision(si, ci).gid_table;
                        if let Some(oid) = resolve_compact_id(*oid_root, &self.gid_tables[table.0])
                        {
                            self.revision_mut(si, ci).set_root(*root_role, oid);
                        }
                    }
                }
                _ => {
                    // 2007-format declarations live directly in the revision manifest.
                    if let Some(ci) = current {
                        let table = self.revision(si, ci).gid_table;
                        self.declare_object(&n, si, ci, table);
                    }
                }
            }
        }
        Ok(())
    }

    fn dependency_table(&self, si: usize, ci: usize) -> Option<GidTableId> {
        let rev = self.revision(si, ci);
        if rev.rid_dependent.is_nil() {
            return None;
        }
        self.object_spaces
            .at(si)
            .revisions
            .get(&rev.rid_dependent)
            .map(|r| r.gid_table)
    }

    fn apply_gid_entry(
        &mut self,
        table: GidTableId,
        node: &FileNode,
        dependency: Option<GidTableId>,
    ) {
        let dep = dependency.map(|d| &self.gid_tables[d.0]);
        let updates: Vec<(u64, Guid)> = match node.data {
            NodeData::GlobalIdTableEntry { index, guid } => vec![(u64::from(index), guid)],
            NodeData::GlobalIdTableEntry2 {
                i_index_map_from,
                i_index_map_to,
            } => dep
                .and_then(|d| d.get(&u64::from(i_index_map_from)))
                .map(|&g| vec![(u64::from(i_index_map_to), g)])
                .unwrap_or_default(),
            NodeData::GlobalIdTableEntry3 {
                i_index_copy_from_start,
                c_entries_to_copy,
                i_index_copy_to_start,
            } => {
                let (from, count, to) = (
                    u64::from(i_index_copy_from_start),
                    u64::from(c_entries_to_copy),
                    u64::from(i_index_copy_to_start),
                );
                match dep {
                    // Same result as copying index by index, without looping over a
                    // corrupt 32-bit count.
                    Some(d) if count as usize > d.len() => d
                        .iter()
                        .filter(|(&k, _)| k >= from && k < from + count)
                        .map(|(&k, &g)| (to + (k - from), g))
                        .collect(),
                    Some(d) => (0..count)
                        .filter_map(|i| d.get(&(from + i)).map(|&g| (to + i, g)))
                        .collect(),
                    None => Vec::new(),
                }
            }
            _ => Vec::new(),
        };
        self.gid_tables[table.0].extend(updates);
    }

    fn read_object_group(&mut self, fcr: FileChunkReference, si: usize, ci: usize) -> Result<()> {
        let mut table = self.new_gid_table();
        for n in self.read_file_node_list(fcr)? {
            match n.id {
                F::GLOBAL_ID_TABLE_START_FNDX | F::GLOBAL_ID_TABLE_START2_FND => {
                    table = self.new_gid_table()
                }
                F::GLOBAL_ID_TABLE_ENTRY_FNDX
                | F::GLOBAL_ID_TABLE_ENTRY2_FNDX
                | F::GLOBAL_ID_TABLE_ENTRY3_FNDX => {
                    let dependency = self.revision(si, ci).gid_table;
                    self.apply_gid_entry(table, &n, Some(dependency));
                }
                F::OBJECT_GROUP_START_FND
                | F::OBJECT_GROUP_END_FND
                | F::GLOBAL_ID_TABLE_END_FNDX => {}
                _ => self.declare_object(&n, si, ci, table),
            }
        }
        Ok(())
    }

    fn declare_object(&mut self, node: &FileNode, si: usize, ci: usize, table: GidTableId) {
        let NodeData::ObjectDeclaration {
            oid,
            jcid,
            has_oid_references,
            has_osid_references,
            ref file_data_reference,
            ref extension,
            ..
        } = node.data
        else {
            return;
        };
        let Some(oid) = resolve_compact_id(oid, &self.gid_tables[table.0]) else {
            self.warnings.push(format!(
                "{} at 0x{:x}: unresolved CompactID",
                node.name(),
                node.offset
            ));
            return;
        };
        let jcid_raw = match jcid {
            Some(j) => j,
            // ObjectRevisionWithRefCount re-declares an existing object with new data.
            None => {
                let space = self.object_spaces.at(si);
                find_in(Some(space), space.revisions.at(ci), &oid).map_or(0, |o| o.jcid.raw)
            }
        };
        let declared_by = match node.name() {
            Cow::Borrowed(name) => name,
            Cow::Owned(_) => "Unknown",
        };
        let decl = ObjectDeclaration {
            oid,
            jcid: decode_jcid(jcid_raw),
            chunk: node.chunk,
            has_oid_references,
            has_osid_references,
            gid_table: table,
            file_data_reference: file_data_reference.clone(),
            extension: extension.clone(),
            declared_by,
        };
        self.revision_mut(si, ci).objects.insert(oid, decl);
    }
}

/// PropertySets nest (type 0x11 and arrays of them); the reference
/// implementation recurses until the JS stack runs out. Bound it instead and
/// report the same message.
const MAX_PROPERTY_SET_DEPTH: u32 = 1024;
/// Arrays of zero-width elements (no data bytes per element) are only bounded
/// by their 32-bit count; refuse absurd ones instead of allocating billions.
const MAX_ZERO_WIDTH_ARRAY: u32 = 1 << 20;

/// Reader for one ObjectSpaceObjectPropSet: three CompactID streams, then the
/// PropertySet whose object/space/context references consume those streams.
struct PropSetParser<'a, 't> {
    r: Reader<'a>,
    table: &'t GidTable,
    streams: [Vec<Option<ExtendedGuid>>; 3],
    cursors: [u64; 3],
    depth: u32,
}

const OIDS: usize = 0;
const OSIDS: usize = 1;
const CTX: usize = 2;

impl<'a> PropSetParser<'a, '_> {
    fn read_stream(&mut self) -> Result<(Vec<Option<ExtendedGuid>>, bool, bool)> {
        let h = self.r.u32()?;
        let count = h & 0x00ff_ffff;
        let mut ids = Vec::new();
        for _ in 0..count {
            let c = read_compact_id(&mut self.r)?;
            ids.push(resolve_compact_id(c, self.table));
        }
        Ok((ids, (h >> 30) & 1 == 1, (h >> 31) & 1 == 1))
    }

    fn take(&mut self, which: usize, n: u64) -> Vec<Option<ExtendedGuid>> {
        let arr = &self.streams[which];
        let start = self.cursors[which].min(arr.len() as u64) as usize;
        let end = self.cursors[which].saturating_add(n).min(arr.len() as u64) as usize;
        self.cursors[which] = self.cursors[which].saturating_add(n);
        arr[start..end.max(start)].to_vec()
    }

    // Mirrors OneNote's per-type loader (FUN_10008f0b4): values are read in prid
    // order; object/space/context references consume their side streams.
    fn read_value(&mut self, prid: u32, ty: u32) -> Result<PropertyValue<'a>> {
        Ok(match ty {
            0x1 => PropertyValue::None,
            0x2 => PropertyValue::Bool(prid >> 31 == 1),
            0x3 => PropertyValue::Bytes(self.r.bytes(1)?),
            0x4 => PropertyValue::Bytes(self.r.bytes(2)?),
            0x5 => PropertyValue::Bytes(self.r.bytes(4)?),
            0x6 => PropertyValue::Bytes(self.r.bytes(8)?),
            0x7 => {
                let n = self.r.u32()?;
                PropertyValue::Bytes(self.r.bytes(i64::from(n))?)
            }
            0x8 => PropertyValue::Oids {
                ids: self.take(OIDS, 1),
                single: true,
            },
            0x9 => {
                let n = self.r.u32()?;
                PropertyValue::Oids {
                    ids: self.take(OIDS, u64::from(n)),
                    single: false,
                }
            }
            0xa => PropertyValue::Osids {
                ids: self.take(OSIDS, 1),
                single: true,
            },
            0xb => {
                let n = self.r.u32()?;
                PropertyValue::Osids {
                    ids: self.take(OSIDS, u64::from(n)),
                    single: false,
                }
            }
            0xc => PropertyValue::ContextIds {
                ids: self.take(CTX, 1),
                single: true,
            },
            0xd => {
                let n = self.r.u32()?;
                PropertyValue::ContextIds {
                    ids: self.take(CTX, u64::from(n)),
                    single: false,
                }
            }
            0x10 => {
                // Element type comes from the inner prid. In practice it is 0x11
                // (PropertySet); booleans are stored as one byte per element.
                self.enter()?;
                let n = self.r.u32()?;
                let inner = if n > 0 { self.r.u32()? } else { 0 };
                let inner_type = (inner >> 26) & 0x1f;
                if matches!(inner_type, 0x1 | 0x8 | 0xa | 0xc) && n > MAX_ZERO_WIDTH_ARRAY {
                    return Err(ParseError::at(
                        format!("array of {n} zero-width values"),
                        self.r.pos,
                    ));
                }
                let mut sets = Vec::new();
                for _ in 0..n {
                    if inner_type == 0x11 {
                        sets.push(self.read_property_set()?);
                    } else {
                        let v = if inner_type == 0x2 {
                            PropertyValue::Bool(self.r.u8()? != 0)
                        } else {
                            self.read_value(inner, inner_type)?
                        };
                        sets.push(PropertySet {
                            properties: vec![Property {
                                prid: inner,
                                id: inner & 0x03ff_ffff,
                                ty: inner_type,
                                value: v,
                            }],
                        });
                    }
                }
                self.depth -= 1;
                PropertyValue::PropertyValues { prid: inner, sets }
            }
            0x11 => PropertyValue::PropertySet(self.read_property_set()?),
            _ => {
                return Err(ParseError::at(
                    format!("unknown property type 0x{ty:x} in prid 0x{prid:x}"),
                    self.r.pos,
                ));
            }
        })
    }

    fn enter(&mut self) -> Result<()> {
        if self.depth >= MAX_PROPERTY_SET_DEPTH {
            return Err(ParseError::plain("Maximum call stack size exceeded"));
        }
        self.depth += 1;
        Ok(())
    }

    fn read_property_set(&mut self) -> Result<PropertySet<'a>> {
        self.enter()?;
        let count = self.r.u16()?;
        let mut prids = Vec::with_capacity(usize::from(count));
        for _ in 0..count {
            prids.push(self.r.u32()?);
        }
        let mut properties = Vec::with_capacity(prids.len());
        for prid in prids {
            let ty = (prid >> 26) & 0x1f;
            properties.push(Property {
                prid,
                id: prid & 0x03ff_ffff,
                ty,
                value: self.read_value(prid, ty)?,
            });
        }
        self.depth -= 1;
        Ok(PropertySet { properties })
    }
}

impl<'a> OneStore<'a> {
    pub fn new(buf: &'a [u8]) -> Result<OneStore<'a>> {
        let header = parse_header(buf)?;
        let tx_counts = parse_transaction_log(buf, &header)?;
        let mut b = Builder {
            buf,
            tx_counts,
            warnings: Vec::new(),
            fragments: Vec::new(),
            gid_tables: Vec::new(),
            object_spaces: OrderedMap::default(),
            file_data: OrderedMap::default(),
        };
        let mut root_gosid = None;
        for node in b.read_file_node_list(header.fcr_file_node_list_root)? {
            match node.id {
                F::OBJECT_SPACE_MANIFEST_ROOT_FND => {
                    if let NodeData::ObjectSpaceManifestRoot { gosid_root } = node.data {
                        root_gosid = Some(gosid_root);
                    }
                }
                F::OBJECT_SPACE_MANIFEST_LIST_REFERENCE_FND => b.read_object_space(&node)?,
                F::FILE_DATA_STORE_LIST_REFERENCE_FND => b.read_file_data_store_list(node.chunk)?,
                _ => {}
            }
        }
        Ok(OneStore {
            buf,
            header,
            root_gosid,
            object_spaces: b.object_spaces,
            file_data: b.file_data,
            fragments: b.fragments,
            warnings: RefCell::new(b.warnings),
            gid_tables: b.gid_tables,
            prop_cache: RefCell::new(HashMap::new()),
        })
    }

    /// Warnings so far (construction plus every failed property set read).
    pub fn warnings(&self) -> Vec<String> {
        self.warnings.borrow().clone()
    }

    pub fn warn(&self, message: String) {
        self.warnings.borrow_mut().push(message);
    }

    pub fn resolve_compact_id(&self, c: CompactId, table: GidTableId) -> Option<ExtendedGuid> {
        resolve_compact_id(c, &self.gid_tables[table.0])
    }

    // --- queries ---------------------------------------------------------------

    /// The revision currently holding (role, context) in an object space.
    pub fn current_revision<'s>(
        &self,
        space: &'s ObjectSpace,
        role: u32,
        context: Option<&ExtendedGuid>,
    ) -> Option<&'s Revision> {
        let ctx = context.filter(|c| !c.is_nil());
        for a in space.role_assignments.iter().rev() {
            let a_ctx = a.context.as_ref().filter(|c| !c.is_nil());
            if a.role == role && a_ctx == ctx {
                if let Some(rev) = space.revisions.get(&a.rid) {
                    return Some(rev);
                }
            }
        }
        None
    }

    /// Root object of a revision for a root role, inherited along ridDependent.
    pub fn root_object(
        &self,
        space: &ObjectSpace,
        rev: &Revision,
        root_role: u32,
    ) -> Option<ExtendedGuid> {
        let mut r = Some(rev);
        let mut guard = 0;
        while let Some(cur) = r {
            if guard >= 10_000 {
                break;
            }
            if let Some(root) = cur.root(root_role) {
                return Some(root);
            }
            r = if cur.rid_dependent.is_nil() {
                None
            } else {
                space.revisions.get(&cur.rid_dependent)
            };
            guard += 1;
        }
        None
    }

    /// Object as seen from a revision: its own declarations, then its dependency chain.
    pub fn find_object<'s>(
        &self,
        rev: &'s Revision,
        oid: &ExtendedGuid,
        space: Option<&'s ObjectSpace>,
    ) -> Option<&'s ObjectDeclaration> {
        find_in(space, rev, oid)
    }

    /// Bytes of an `<ifndf>{GUID}` file data reference; None for `<file>`
    /// (external file) and `<invfdo>` (declared but not stored).
    pub fn file_data_for(&self, decl: &ObjectDeclaration) -> Option<&'a [u8]> {
        let reference = decl
            .file_data_reference
            .as_deref()
            .filter(|r| !r.is_empty())?;
        let g = reference.strip_prefix("<ifndf>")?;
        let inner = g.strip_prefix('{')?.strip_suffix('}')?;
        if inner.is_empty() || !inner.chars().all(|c| c.is_ascii_hexdigit() || c == '-') {
            return None;
        }
        let fd = self.file_data.get(&g.to_ascii_uppercase())?;
        let len = self.buf.len() as u64;
        let start = fd.offset.min(len);
        let end = fd.offset.saturating_add(fd.length).min(len).max(start);
        Some(&self.buf[start as usize..end as usize])
    }

    /// Parse the ObjectSpaceObjectPropSet behind a declaration (cached). A
    /// malformed blob becomes a warning and None.
    pub fn property_set(&self, decl: &ObjectDeclaration) -> Option<Rc<PropertySet<'a>>> {
        let chunk = decl
            .chunk
            .filter(|c| c.cb != 0 && decl.jcid.is_property_set)?;
        let key = (chunk.stp, chunk.cb);
        if let Some(cached) = self.prop_cache.borrow().get(&key) {
            return Some(Rc::clone(cached));
        }
        match self.parse_property_set(decl, chunk) {
            Ok(set) => {
                let set = Rc::new(set);
                self.prop_cache.borrow_mut().insert(key, Rc::clone(&set));
                Some(set)
            }
            Err(e) => {
                self.warn(format!(
                    "property set of {} (jcid 0x{:x}): {e}",
                    decl.oid, decl.jcid.raw
                ));
                None
            }
        }
    }

    fn parse_property_set(
        &self,
        decl: &ObjectDeclaration,
        chunk: FileChunkReference,
    ) -> Result<PropertySet<'a>> {
        let r = Reader::new(self.buf, chunk.start(), chunk.end())?;
        let mut p = PropSetParser {
            r,
            table: &self.gid_tables[decl.gid_table.0],
            streams: [Vec::new(), Vec::new(), Vec::new()],
            cursors: [0; 3],
            depth: 0,
        };
        let (oids, _, osid_absent) = p.read_stream()?;
        p.streams[OIDS] = oids;
        if !osid_absent {
            let (osids, extended, _) = p.read_stream()?;
            p.streams[OSIDS] = osids;
            if extended {
                p.streams[CTX] = p.read_stream()?.0;
            }
        }
        p.read_property_set()
    }
}
