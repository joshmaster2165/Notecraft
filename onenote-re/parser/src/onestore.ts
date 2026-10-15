// Revision store ("onestore") container layer.
//
// Layout of a .one / .onetoc2 file:
//
//   0x000  Header (1024 bytes): file-type GUID, format GUID, chunk references
//          to the transaction log, the root FileNodeList and the free list.
//   ....   Chunks addressed by FileChunkReference {stp: offset, cb: size}:
//          - Transaction log: per-FileNodeList committed node counts.
//          - FileNodeList fragments: magic, list id, sequence, packed FileNodes,
//            next-fragment reference, footer magic.
//          - ObjectSpaceObjectPropSet blobs: OID/OSID/ContextID streams + PropertySet.
//          - FileDataStoreObject blobs: embedded images / attachments.
//
// Graph: root list -> object space manifests -> revision manifest lists ->
// revisions -> object groups -> object declarations -> property sets.

import { Reader, ParseError, formatGuid, utf16le, hex, NIL_GUID } from "./reader.ts";

// --- constants ---------------------------------------------------------------

export const GUID_FILE_TYPE_ONE = "{7B5C52E4-D88C-4DA7-AEB1-5378D02996D3}";
export const GUID_FILE_TYPE_ONETOC2 = "{43FF2FA1-EFD9-4C76-9EE2-10EA5722765F}";
export const GUID_FILE_FORMAT = "{109ADD3F-911B-49F5-A5D0-1791EDC8AED8}";
const GUID_FDSO_HEADER = "{BDE316E7-2665-4511-A4C4-8D4D0B7A9EAC}";
const GUID_FDSO_FOOTER = "{71FBA722-0F79-4A0B-BB13-899256426B24}";

// FileNodeListFragment magics. OneNote's fragment opener (FUN_100d342d0 in the
// macOS 16.114 arm64 build) also accepts a legacy 32-bit variant whose
// next-fragment pointer is a FileChunkReference32 (16-byte trailer, not 20).
const FRAGMENT_HEADER_MAGIC = 0xa4567ab1f5f7f4c4n;
const FRAGMENT_FOOTER_MAGIC = 0x8bc215c38233ba4bn;
const FRAGMENT_HEADER_MAGIC_32 = 0x6d814fd0a242b102n;
const FRAGMENT_FOOTER_MAGIC_32 = 0x45a9ba65a7954cc2n;
const TRANSACTION_SENTINEL = 0x00000001;

export const FileNodeId = {
  ObjectSpaceManifestRootFND: 0x004,
  ObjectSpaceManifestListReferenceFND: 0x008,
  ObjectSpaceManifestListStartFND: 0x00c,
  RevisionManifestListReferenceFND: 0x010,
  RevisionManifestListStartFND: 0x014,
  RevisionManifestStart4FND: 0x01b,
  RevisionManifestEndFND: 0x01c,
  RevisionManifestStart6FND: 0x01e,
  RevisionManifestStart7FND: 0x01f,
  GlobalIdTableStartFNDX: 0x021,
  GlobalIdTableStart2FND: 0x022,
  GlobalIdTableEntryFNDX: 0x024,
  GlobalIdTableEntry2FNDX: 0x025,
  GlobalIdTableEntry3FNDX: 0x026,
  GlobalIdTableEndFNDX: 0x028,
  ObjectDeclarationWithRefCountFNDX: 0x02d,
  ObjectDeclarationWithRefCount2FNDX: 0x02e,
  ObjectRevisionWithRefCountFNDX: 0x041,
  ObjectRevisionWithRefCount2FNDX: 0x042,
  RootObjectReference2FNDX: 0x059,
  RootObjectReference3FND: 0x05a,
  RevisionRoleDeclarationFND: 0x05c,
  RevisionRoleAndContextDeclarationFND: 0x05d,
  ObjectDeclarationFileData3RefCountFND: 0x072,
  ObjectDeclarationFileData3LargeRefCountFND: 0x073,
  ObjectDataEncryptionKeyV2FNDX: 0x07c,
  ObjectInfoDependencyOverridesFND: 0x084,
  DataSignatureGroupDefinitionFND: 0x08c,
  FileDataStoreListReferenceFND: 0x090,
  FileDataStoreObjectReferenceFND: 0x094,
  ObjectDeclaration2RefCountFND: 0x0a4,
  ObjectDeclaration2LargeRefCountFND: 0x0a5,
  ObjectGroupListReferenceFND: 0x0b0,
  ObjectGroupStartFND: 0x0b4,
  ObjectGroupEndFND: 0x0b8,
  HashedChunkDescriptor2FND: 0x0c2,
  ReadOnlyObjectDeclaration2RefCountFND: 0x0c4,
  ReadOnlyObjectDeclaration2LargeRefCountFND: 0x0c5,
  ChunkTerminatorFND: 0x0ff,
} as const;

const FILE_NODE_NAMES = new Map<number, string>(
  Object.entries(FileNodeId).map(([k, v]) => [v, k]),
);

export const RootRole = { DefaultContent: 1, Metadata: 2, EncryptionKey: 4, VersionMetadata: 8 } as const;

// --- primitive structures ----------------------------------------------------

export interface FileChunkReference {
  stp: number;
  cb: number;
}

export interface ExtendedGuid {
  guid: string;
  n: number;
}

export interface CompactId {
  n: number;
  guidIndex: number;
}

export interface Jcid {
  raw: number;
  index: number;
  isBinary: boolean;
  isPropertySet: boolean;
  isGraphNode: boolean;
  isFileData: boolean;
  isReadOnly: boolean;
}

export function egKey(e: ExtendedGuid): string {
  return `${e.guid}#${e.n}`;
}

export function isNilEg(e: ExtendedGuid): boolean {
  return e.guid === NIL_GUID && e.n === 0;
}

function isNilRef(r: FileChunkReference): boolean {
  // fcrNil: stp all ones, cb zero. fcrZero: both zero. Either means "nothing here".
  return r.cb === 0;
}

function readFcr32(r: Reader): FileChunkReference {
  return { stp: r.u32(), cb: r.u32() };
}

function readFcr64x32(r: Reader): FileChunkReference {
  return { stp: r.u64n(), cb: r.u32() };
}

function readExtendedGuid(r: Reader): ExtendedGuid {
  return { guid: r.guid(), n: r.u32() };
}

function readCompactId(r: Reader): CompactId {
  const v = r.u32();
  return { n: v & 0xff, guidIndex: v >>> 8 };
}

export function decodeJcid(raw: number): Jcid {
  return {
    raw,
    index: raw & 0xffff,
    isBinary: (raw & 0x10000) !== 0,
    isPropertySet: (raw & 0x20000) !== 0,
    isGraphNode: (raw & 0x40000) !== 0,
    isFileData: (raw & 0x80000) !== 0,
    isReadOnly: (raw & 0x100000) !== 0,
  };
}

function readStringInStorageBuffer(r: Reader): string {
  const cch = r.u32();
  return utf16le(r.bytes(cch * 2));
}

// --- header ------------------------------------------------------------------

export interface Header {
  guidFileType: string;
  fileKind: "section" | "toc" | "unknown";
  guidFile: string;
  guidFileFormat: string;
  ffvLastCodeThatWroteToThisFile: number;
  ffvOldestCodeThatHasWrittenToThisFile: number;
  ffvNewestCodeThatHasWrittenToThisFile: number;
  ffvOldestCodeThatMayReadThisFile: number;
  cTransactionsInLog: number;
  guidAncestor: string;
  crcName: number;
  fcrHashedChunkList: FileChunkReference;
  fcrTransactionLog: FileChunkReference;
  fcrFileNodeListRoot: FileChunkReference;
  fcrFreeChunkList: FileChunkReference;
  cbExpectedFileLength: number;
  cbFreeSpaceInFreeChunkList: number;
  guidFileVersion: string;
  nFileVersionGeneration: number;
  guidDenyReadFileVersion: string;
  bnCreated: number;
  bnLastWroteToThisFile: number;
  bnOldestWritten: number;
  bnNewestWritten: number;
}

export function parseHeader(buf: Uint8Array): Header {
  if (buf.length < 1024) throw new ParseError("file shorter than the 1024-byte header", 0);
  const r = new Reader(buf, 0, 1024);
  const guidFileType = r.guid();
  const guidFile = r.guid();
  r.skip(16); // guidLegacyFileVersion, must be zero
  const guidFileFormat = r.guid();
  if (guidFileFormat !== GUID_FILE_FORMAT) {
    throw new ParseError(`not a revision store file (format GUID ${guidFileFormat})`, 0x30);
  }
  const ffvLast = r.u32();
  const ffvOldest = r.u32();
  const ffvNewest = r.u32();
  const ffvOldestReader = r.u32();
  readFcr32(r); // fcrLegacyFreeChunkList
  readFcr32(r); // fcrLegacyTransactionLog
  const cTransactionsInLog = r.u32();
  r.u32(); // cbLegacyExpectedFileLength
  r.skip(8); // rgbPlaceholder
  readFcr32(r); // fcrLegacyFileNodeListRoot
  r.u32(); // cbLegacyFreeSpaceInFreeChunkList
  r.skip(4); // fNeedsDefrag, fRepairedFile, fNeedsGarbageCollect, fHasNoEmbeddedFileObjects
  const guidAncestor = r.guid();
  const crcName = r.u32();
  const fcrHashedChunkList = readFcr64x32(r);
  const fcrTransactionLog = readFcr64x32(r);
  const fcrFileNodeListRoot = readFcr64x32(r);
  const fcrFreeChunkList = readFcr64x32(r);
  const cbExpectedFileLength = r.u64n();
  const cbFreeSpaceInFreeChunkList = r.u64n();
  const guidFileVersion = r.guid();
  const nFileVersionGeneration = r.u64n();
  const guidDenyReadFileVersion = r.guid();
  r.u32(); // grfDebugLogFlags
  readFcr64x32(r); // fcrDebugLog
  readFcr64x32(r); // fcrAllocVerificationFreeChunkList
  const bnCreated = r.u32();
  const bnLastWroteToThisFile = r.u32();
  const bnOldestWritten = r.u32();
  const bnNewestWritten = r.u32();
  return {
    guidFileType,
    fileKind:
      guidFileType === GUID_FILE_TYPE_ONE ? "section" : guidFileType === GUID_FILE_TYPE_ONETOC2 ? "toc" : "unknown",
    guidFile,
    guidFileFormat,
    ffvLastCodeThatWroteToThisFile: ffvLast,
    ffvOldestCodeThatHasWrittenToThisFile: ffvOldest,
    ffvNewestCodeThatHasWrittenToThisFile: ffvNewest,
    ffvOldestCodeThatMayReadThisFile: ffvOldestReader,
    cTransactionsInLog,
    guidAncestor,
    crcName,
    fcrHashedChunkList,
    fcrTransactionLog,
    fcrFileNodeListRoot,
    fcrFreeChunkList,
    cbExpectedFileLength,
    cbFreeSpaceInFreeChunkList,
    guidFileVersion,
    nFileVersionGeneration,
    guidDenyReadFileVersion,
    bnCreated,
    bnLastWroteToThisFile,
    bnOldestWritten,
    bnNewestWritten,
  };
}

// --- transaction log ---------------------------------------------------------

/**
 * Committed node count per FileNodeListID. Nodes past this count in a list
 * belong to an uncommitted transaction and must be ignored.
 */
function parseTransactionLog(buf: Uint8Array, header: Header): Map<number, number> {
  const counts = new Map<number, number>();
  let ref = header.fcrTransactionLog;
  let transactions = 0;
  const seen = new Set<number>();
  while (!isNilRef(ref) && transactions < header.cTransactionsInLog) {
    if (seen.has(ref.stp)) throw new ParseError("transaction log fragment cycle", ref.stp);
    seen.add(ref.stp);
    const r = new Reader(buf, ref.stp, ref.stp + ref.cb);
    const entries = Math.floor((ref.cb - 12) / 8);
    for (let i = 0; i < entries && transactions < header.cTransactionsInLog; i++) {
      const srcId = r.u32();
      const value = r.u32();
      if (srcId === TRANSACTION_SENTINEL) transactions++;
      else counts.set(srcId, value);
    }
    // nextFragment follows the last whole entry; the chunk can carry trailing padding.
    r.pos = ref.stp + entries * 8;
    ref = readFcr64x32(r);
  }
  return counts;
}

// --- file nodes --------------------------------------------------------------

export interface FileNode {
  id: number;
  name: string;
  offset: number;
  size: number;
  /** Present when BaseType is 1 (data) or 2 (child FileNodeList). */
  ref?: FileChunkReference;
  baseType: number;
  /** Type-specific fields. */
  data: Record<string, unknown>;
}

function readChunkRef(r: Reader, stpFormat: number, cbFormat: number): FileChunkReference {
  let stp: number;
  switch (stpFormat) {
    case 0: stp = r.u64n(); break;
    case 1: stp = r.u32(); break;
    case 2: stp = r.u16() * 8; break;
    default: stp = r.u32() * 8; break;
  }
  let cb: number;
  switch (cbFormat) {
    case 0: cb = r.u32(); break;
    case 1: cb = r.u64n(); break;
    case 2: cb = r.u8() * 8; break;
    default: cb = r.u16() * 8; break;
  }
  return { stp, cb };
}

function parseFileNode(r: Reader, offset: number): FileNode {
  const h = r.u32();
  const id = h & 0x3ff;
  const size = (h >>> 10) & 0x1fff;
  const stpFormat = (h >>> 23) & 0x3;
  const cbFormat = (h >>> 25) & 0x3;
  const baseType = (h >>> 27) & 0xf;
  if (size < 4) throw new ParseError(`FileNode 0x${id.toString(16)} has size ${size}`, offset);
  const body = r.sub(offset + 4, size - 4);
  r.pos = offset + size;

  const node: FileNode = { id, name: FILE_NODE_NAMES.get(id) ?? `Unknown_0x${id.toString(16)}`, offset, size, baseType, data: {} };
  if (baseType === 1 || baseType === 2) node.ref = readChunkRef(body, stpFormat, cbFormat);
  const d = node.data;
  const F = FileNodeId;
  switch (id) {
    case F.ObjectSpaceManifestRootFND:
      d.gosidRoot = readExtendedGuid(body);
      break;
    case F.ObjectSpaceManifestListReferenceFND:
    case F.ObjectSpaceManifestListStartFND:
      d.gosid = readExtendedGuid(body);
      break;
    case F.RevisionManifestListStartFND:
      d.gosid = readExtendedGuid(body);
      d.nInstance = body.u32();
      break;
    case F.RevisionManifestStart4FND:
      d.rid = readExtendedGuid(body);
      d.ridDependent = readExtendedGuid(body);
      d.timeCreation = body.u64().toString();
      d.revisionRole = body.u32();
      d.odcsDefault = body.u16();
      break;
    case F.RevisionManifestStart6FND:
    case F.RevisionManifestStart7FND:
      d.rid = readExtendedGuid(body);
      d.ridDependent = readExtendedGuid(body);
      d.revisionRole = body.u32();
      d.odcsDefault = body.u16();
      if (id === F.RevisionManifestStart7FND) d.gctxid = readExtendedGuid(body);
      break;
    case F.GlobalIdTableEntryFNDX:
      d.index = body.u32();
      d.guid = body.guid();
      break;
    case F.GlobalIdTableEntry2FNDX:
      d.iIndexMapFrom = body.u32();
      d.iIndexMapTo = body.u32();
      break;
    case F.GlobalIdTableEntry3FNDX:
      d.iIndexCopyFromStart = body.u32();
      d.cEntriesToCopy = body.u32();
      d.iIndexCopyToStart = body.u32();
      break;
    case F.ObjectDeclarationWithRefCountFNDX:
    case F.ObjectDeclarationWithRefCount2FNDX: {
      // 2007-era declaration: jci is the JCID index with IsPropertySet implied.
      d.oid = readCompactId(body);
      const lo = body.u16();
      const hi = body.u32();
      d.jcid = 0x00020000 | (lo & 0x3ff);
      d.odcs = (lo >>> 10) & 0xf;
      d.hasOidReferences = (hi & 0x1) !== 0;
      d.hasOsidReferences = (hi & 0x2) !== 0;
      d.cRef = id === F.ObjectDeclarationWithRefCountFNDX ? body.u8() : body.u32();
      break;
    }
    case F.ObjectRevisionWithRefCountFNDX: {
      d.oid = readCompactId(body);
      const b = body.u8();
      d.hasOidReferences = (b & 1) !== 0;
      d.hasOsidReferences = (b & 2) !== 0;
      d.cRef = b >>> 2;
      break;
    }
    case F.ObjectRevisionWithRefCount2FNDX: {
      d.oid = readCompactId(body);
      const b = body.u32();
      d.hasOidReferences = (b & 1) !== 0;
      d.hasOsidReferences = (b & 2) !== 0;
      d.cRef = body.u32();
      break;
    }
    case F.RootObjectReference2FNDX:
      d.oidRoot = readCompactId(body);
      d.rootRole = body.u32();
      break;
    case F.RootObjectReference3FND:
      d.oidRoot = readExtendedGuid(body);
      d.rootRole = body.u32();
      break;
    case F.RevisionRoleDeclarationFND:
    case F.RevisionRoleAndContextDeclarationFND:
      d.rid = readExtendedGuid(body);
      d.revisionRole = body.u32();
      if (id === F.RevisionRoleAndContextDeclarationFND) d.gctxid = readExtendedGuid(body);
      break;
    case F.ObjectDeclarationFileData3RefCountFND:
    case F.ObjectDeclarationFileData3LargeRefCountFND:
      d.oid = readCompactId(body);
      d.jcid = body.u32();
      d.cRef = id === F.ObjectDeclarationFileData3RefCountFND ? body.u8() : body.u32();
      d.fileDataReference = readStringInStorageBuffer(body);
      d.extension = readStringInStorageBuffer(body);
      break;
    case F.DataSignatureGroupDefinitionFND:
      d.dataSignatureGroup = readExtendedGuid(body);
      break;
    case F.FileDataStoreObjectReferenceFND:
      d.guidReference = body.guid();
      break;
    case F.ObjectDeclaration2RefCountFND:
    case F.ObjectDeclaration2LargeRefCountFND:
    case F.ReadOnlyObjectDeclaration2RefCountFND:
    case F.ReadOnlyObjectDeclaration2LargeRefCountFND: {
      d.oid = readCompactId(body);
      d.jcid = body.u32();
      const b = body.u8();
      d.hasOidReferences = (b & 1) !== 0;
      d.hasOsidReferences = (b & 2) !== 0;
      const large = id === F.ObjectDeclaration2LargeRefCountFND || id === F.ReadOnlyObjectDeclaration2LargeRefCountFND;
      d.cRef = large ? body.u32() : body.u8();
      if (id === F.ReadOnlyObjectDeclaration2RefCountFND || id === F.ReadOnlyObjectDeclaration2LargeRefCountFND) {
        d.md5 = hex(body.bytes(16));
      }
      break;
    }
    case F.ObjectGroupListReferenceFND:
      d.objectGroupId = readExtendedGuid(body);
      break;
    case F.ObjectGroupStartFND:
      d.oid = readExtendedGuid(body);
      break;
    case F.HashedChunkDescriptor2FND:
      d.guidHash = hex(body.bytes(16));
      break;
    default:
      break;
  }
  return node;
}

// --- object model ------------------------------------------------------------

export type PropertyValue =
  | { kind: "none" }
  | { kind: "bool"; value: boolean }
  | { kind: "bytes"; value: Uint8Array }
  | { kind: "oids"; value: (ExtendedGuid | null)[]; single: boolean }
  | { kind: "osids"; value: (ExtendedGuid | null)[]; single: boolean }
  | { kind: "contextIds"; value: (ExtendedGuid | null)[]; single: boolean }
  | { kind: "propertyValues"; prid: number; value: PropertySet[] }
  | { kind: "propertySet"; value: PropertySet };

export interface Property {
  prid: number;
  /** Lower 26 bits of the PropertyID. */
  id: number;
  type: number;
  value: PropertyValue;
}

export interface PropertySet {
  properties: Property[];
}

export interface ObjectDeclaration {
  oid: ExtendedGuid;
  jcid: Jcid;
  ref?: FileChunkReference;
  hasOidReferences: boolean;
  hasOsidReferences: boolean;
  /** Global id table used to resolve CompactIDs inside this object's prop set. */
  gidTable: Map<number, string>;
  fileDataReference?: string;
  extension?: string;
  declaredBy: string;
}

export interface Revision {
  rid: ExtendedGuid;
  ridDependent: ExtendedGuid;
  role: number;
  context: ExtendedGuid | null;
  objects: Map<string, ObjectDeclaration>;
  roots: Map<number, ExtendedGuid>;
  gidTable: Map<number, string>;
}

export interface ObjectSpace {
  gosid: ExtendedGuid;
  revisions: Map<string, Revision>;
  /** Ordered (rid, role, context) assignments; the last one for a role/context wins. */
  roleAssignments: { rid: ExtendedGuid; role: number; context: ExtendedGuid | null }[];
  encrypted: boolean;
}

export interface FileData {
  guid: string;
  offset: number;
  length: number;
}

export class OneStore {
  readonly buf: Uint8Array;
  readonly header: Header;
  readonly rootGosid: ExtendedGuid | null;
  readonly objectSpaces = new Map<string, ObjectSpace>();
  readonly fileData = new Map<string, FileData>();
  readonly warnings: string[] = [];
  private readonly txCounts: Map<number, number>;
  private readonly propCache = new Map<string, PropertySet>();
  /** Every FileNodeList fragment read, for format diagnostics. */
  readonly fragments: { listId: number; seq: number; offset: number; size: number; nodes: number }[] = [];

  constructor(buf: Uint8Array) {
    this.buf = buf;
    this.header = parseHeader(buf);
    this.txCounts = parseTransactionLog(buf, this.header);

    let rootGosid: ExtendedGuid | null = null;
    for (const node of this.readFileNodeList(this.header.fcrFileNodeListRoot)) {
      switch (node.id) {
        case FileNodeId.ObjectSpaceManifestRootFND:
          rootGosid = node.data.gosidRoot as ExtendedGuid;
          break;
        case FileNodeId.ObjectSpaceManifestListReferenceFND:
          this.readObjectSpace(node);
          break;
        case FileNodeId.FileDataStoreListReferenceFND:
          this.readFileDataStoreList(node.ref!);
          break;
      }
    }
    this.rootGosid = rootGosid;
  }

  // FileNodeList: a chain of fragments. Stops at the committed node count from
  // the transaction log, a ChunkTerminatorFND, or the end of the fragment.
  readFileNodeList(first: FileChunkReference): FileNode[] {
    const nodes: FileNode[] = [];
    let ref = first;
    let limit = Infinity;
    let listId: number | null = null;
    let expectedSeq = 0;
    const seen = new Set<number>();
    while (!isNilRef(ref)) {
      if (seen.has(ref.stp)) throw new ParseError("FileNodeList fragment cycle", ref.stp);
      seen.add(ref.stp);
      if (ref.cb < 0x24) throw new ParseError(`FileNodeListFragment of ${ref.cb} bytes`, ref.stp);
      const r = new Reader(this.buf, ref.stp, ref.stp + ref.cb);
      const magic = r.u64();
      const wide = magic === FRAGMENT_HEADER_MAGIC;
      if (!wide && magic !== FRAGMENT_HEADER_MAGIC_32) throw new ParseError("bad FileNodeListFragment header magic", ref.stp);
      const id = r.u32();
      const seq = r.u32();
      if (listId === null) {
        listId = id;
        limit = this.txCounts.get(id) ?? Infinity;
      } else if (id !== listId) {
        this.warnings.push(`fragment at 0x${ref.stp.toString(16)} belongs to list ${id}, expected ${listId}`);
      }
      if (seq !== expectedSeq) this.warnings.push(`list ${id}: fragment sequence ${seq}, expected ${expectedSeq}`);
      expectedSeq = seq + 1;

      const nodesEnd = ref.stp + ref.cb - (wide ? 20 : 16);
      const before = nodes.length;
      while (nodes.length < limit && r.pos + 4 <= nodesEnd) {
        const h = r.peekU32();
        if (h === 0) break; // padding
        if ((h & 0x3ff) === FileNodeId.ChunkTerminatorFND) break;
        nodes.push(parseFileNode(new Reader(this.buf, r.pos, nodesEnd), r.pos));
        r.pos += (h >>> 10) & 0x1fff;
      }
      this.fragments.push({ listId: id, seq, offset: ref.stp, size: ref.cb, nodes: nodes.length - before });

      r.pos = nodesEnd;
      const next = wide ? readFcr64x32(r) : readFcr32(r);
      if (r.u64() !== (wide ? FRAGMENT_FOOTER_MAGIC : FRAGMENT_FOOTER_MAGIC_32)) {
        throw new ParseError("bad FileNodeListFragment footer magic", r.pos - 8);
      }
      if (nodes.length >= limit) break;
      ref = next;
    }
    return nodes;
  }

  private readFileDataStoreList(ref: FileChunkReference): void {
    for (const node of this.readFileNodeList(ref)) {
      if (node.id !== FileNodeId.FileDataStoreObjectReferenceFND || !node.ref) continue;
      const r = new Reader(this.buf, node.ref.stp, node.ref.stp + node.ref.cb);
      const guidHeader = r.guid();
      if (guidHeader !== GUID_FDSO_HEADER) {
        this.warnings.push(`FileDataStoreObject at 0x${node.ref.stp.toString(16)} has header ${guidHeader}`);
        continue;
      }
      const length = r.u64n();
      r.skip(4 + 8); // unused, reserved
      const offset = r.pos;
      r.pos = node.ref.stp + node.ref.cb - 16;
      const footer = r.guid();
      if (footer !== GUID_FDSO_FOOTER) this.warnings.push(`FileDataStoreObject at 0x${node.ref.stp.toString(16)} has footer ${footer}`);
      const guid = node.data.guidReference as string;
      this.fileData.set(guid, { guid, offset, length });
    }
  }

  private readObjectSpace(ref: FileNode): void {
    const gosid = ref.data.gosid as ExtendedGuid;
    const space: ObjectSpace = { gosid, revisions: new Map(), roleAssignments: [], encrypted: false };
    this.objectSpaces.set(egKey(gosid), space);

    // The object space manifest list may contain several revision manifest
    // list references; only the last one is current.
    let revListRef: FileChunkReference | undefined;
    for (const node of this.readFileNodeList(ref.ref!)) {
      if (node.id === FileNodeId.RevisionManifestListReferenceFND) revListRef = node.ref;
    }
    if (!revListRef) {
      this.warnings.push(`object space ${egKey(gosid)} has no revision manifest list`);
      return;
    }

    let current: Revision | null = null;
    let gidTable: Map<number, string> | null = null;
    for (const node of this.readFileNodeList(revListRef)) {
      const d = node.data;
      switch (node.id) {
        case FileNodeId.RevisionManifestStart4FND:
        case FileNodeId.RevisionManifestStart6FND:
        case FileNodeId.RevisionManifestStart7FND: {
          const rid = d.rid as ExtendedGuid;
          const context = (d.gctxid as ExtendedGuid | undefined) ?? null;
          current = {
            rid,
            ridDependent: d.ridDependent as ExtendedGuid,
            role: d.revisionRole as number,
            context,
            objects: new Map(),
            roots: new Map(),
            gidTable: new Map(),
          };
          space.revisions.set(egKey(rid), current);
          space.roleAssignments.push({ rid, role: current.role, context });
          break;
        }
        case FileNodeId.RevisionManifestEndFND:
          current = null;
          break;
        case FileNodeId.RevisionRoleDeclarationFND:
        case FileNodeId.RevisionRoleAndContextDeclarationFND:
          space.roleAssignments.push({
            rid: d.rid as ExtendedGuid,
            role: d.revisionRole as number,
            context: (d.gctxid as ExtendedGuid | undefined) ?? null,
          });
          break;
        case FileNodeId.ObjectDataEncryptionKeyV2FNDX:
          space.encrypted = true;
          break;
        case FileNodeId.GlobalIdTableStartFNDX:
        case FileNodeId.GlobalIdTableStart2FND:
          gidTable = new Map();
          break;
        case FileNodeId.GlobalIdTableEntryFNDX:
        case FileNodeId.GlobalIdTableEntry2FNDX:
        case FileNodeId.GlobalIdTableEntry3FNDX:
          if (gidTable && current) this.applyGidEntry(gidTable, node, this.dependencyTable(space, current));
          break;
        case FileNodeId.GlobalIdTableEndFNDX:
          if (current && gidTable) current.gidTable = gidTable;
          gidTable = null;
          break;
        case FileNodeId.ObjectGroupListReferenceFND:
          if (current) this.readObjectGroup(node.ref!, current);
          break;
        case FileNodeId.RootObjectReference3FND:
          current?.roots.set(d.rootRole as number, d.oidRoot as ExtendedGuid);
          break;
        case FileNodeId.RootObjectReference2FNDX:
          if (current) {
            const oid = this.resolveCompactId(d.oidRoot as CompactId, current.gidTable);
            if (oid) current.roots.set(d.rootRole as number, oid);
          }
          break;
        default:
          // 2007-format declarations live directly in the revision manifest.
          if (current) this.declareObject(node, current, current.gidTable);
          break;
      }
    }
  }

  private dependencyTable(space: ObjectSpace, rev: Revision): Map<number, string> {
    if (isNilEg(rev.ridDependent)) return new Map();
    return space.revisions.get(egKey(rev.ridDependent))?.gidTable ?? new Map();
  }

  private applyGidEntry(table: Map<number, string>, node: FileNode, dependency: Map<number, string>): void {
    const d = node.data;
    if (node.id === FileNodeId.GlobalIdTableEntryFNDX) {
      table.set(d.index as number, d.guid as string);
    } else if (node.id === FileNodeId.GlobalIdTableEntry2FNDX) {
      const g = dependency.get(d.iIndexMapFrom as number);
      if (g) table.set(d.iIndexMapTo as number, g);
    } else {
      const from = d.iIndexCopyFromStart as number;
      const to = d.iIndexCopyToStart as number;
      for (let i = 0; i < (d.cEntriesToCopy as number); i++) {
        const g = dependency.get(from + i);
        if (g) table.set(to + i, g);
      }
    }
  }

  private readObjectGroup(ref: FileChunkReference, rev: Revision): void {
    let gidTable = new Map<number, string>();
    for (const node of this.readFileNodeList(ref)) {
      switch (node.id) {
        case FileNodeId.GlobalIdTableStartFNDX:
        case FileNodeId.GlobalIdTableStart2FND:
          gidTable = new Map();
          break;
        case FileNodeId.GlobalIdTableEntryFNDX:
        case FileNodeId.GlobalIdTableEntry2FNDX:
        case FileNodeId.GlobalIdTableEntry3FNDX:
          this.applyGidEntry(gidTable, node, rev.gidTable);
          break;
        case FileNodeId.ObjectGroupStartFND:
        case FileNodeId.ObjectGroupEndFND:
        case FileNodeId.GlobalIdTableEndFNDX:
          break;
        default:
          this.declareObject(node, rev, gidTable);
      }
    }
  }

  private declareObject(node: FileNode, rev: Revision, gidTable: Map<number, string>): void {
    const F = FileNodeId;
    const d = node.data;
    switch (node.id) {
      case F.ObjectDeclarationWithRefCountFNDX:
      case F.ObjectDeclarationWithRefCount2FNDX:
      case F.ObjectDeclaration2RefCountFND:
      case F.ObjectDeclaration2LargeRefCountFND:
      case F.ReadOnlyObjectDeclaration2RefCountFND:
      case F.ReadOnlyObjectDeclaration2LargeRefCountFND:
      case F.ObjectDeclarationFileData3RefCountFND:
      case F.ObjectDeclarationFileData3LargeRefCountFND:
      case F.ObjectRevisionWithRefCountFNDX:
      case F.ObjectRevisionWithRefCount2FNDX:
        break;
      default:
        return;
    }
    const oid = this.resolveCompactId(d.oid as CompactId, gidTable);
    if (!oid) {
      this.warnings.push(`${node.name} at 0x${node.offset.toString(16)}: unresolved CompactID`);
      return;
    }
    let jcidRaw = d.jcid as number | undefined;
    if (jcidRaw === undefined) {
      // ObjectRevisionWithRefCount re-declares an existing object with new data.
      jcidRaw = this.findObject(rev, oid, this.spaceOf(rev))?.jcid.raw ?? 0;
    }
    const decl: ObjectDeclaration = {
      oid,
      jcid: decodeJcid(jcidRaw),
      hasOidReferences: Boolean(d.hasOidReferences),
      hasOsidReferences: Boolean(d.hasOsidReferences),
      gidTable,
      declaredBy: node.name,
    };
    if (node.ref) decl.ref = node.ref;
    if (d.fileDataReference !== undefined) {
      decl.fileDataReference = d.fileDataReference as string;
      decl.extension = d.extension as string;
    }
    rev.objects.set(egKey(oid), decl);
  }

  private spaceOf(rev: Revision): ObjectSpace | undefined {
    for (const s of this.objectSpaces.values()) if (s.revisions.get(egKey(rev.rid)) === rev) return s;
    return undefined;
  }

  resolveCompactId(c: CompactId, table: Map<number, string>): ExtendedGuid | null {
    if (c.n === 0 && c.guidIndex === 0) return { guid: NIL_GUID, n: 0 };
    const guid = table.get(c.guidIndex);
    return guid ? { guid, n: c.n } : null;
  }

  // --- queries ---------------------------------------------------------------

  /** The revision currently holding (role, context) in an object space. */
  currentRevision(space: ObjectSpace, role: number = RootRole.DefaultContent, context: ExtendedGuid | null = null): Revision | undefined {
    const ctxKey = context && !isNilEg(context) ? egKey(context) : null;
    for (let i = space.roleAssignments.length - 1; i >= 0; i--) {
      const a = space.roleAssignments[i]!;
      const aCtx = a.context && !isNilEg(a.context) ? egKey(a.context) : null;
      if (a.role === role && aCtx === ctxKey) {
        const rev = space.revisions.get(egKey(a.rid));
        if (rev) return rev;
      }
    }
    return undefined;
  }

  /** Root object of a revision for a root role, inherited along ridDependent. */
  rootObject(space: ObjectSpace, rev: Revision, rootRole: number): ExtendedGuid | undefined {
    for (let r: Revision | undefined = rev, guard = 0; r && guard < 10000; guard++) {
      const root = r.roots.get(rootRole);
      if (root) return root;
      r = isNilEg(r.ridDependent) ? undefined : space.revisions.get(egKey(r.ridDependent));
    }
    return undefined;
  }

  /** Object as seen from a revision: its own declarations, then its dependency chain. */
  findObject(rev: Revision, oid: ExtendedGuid, space: ObjectSpace | undefined): ObjectDeclaration | undefined {
    const key = egKey(oid);
    for (let r: Revision | undefined = rev, guard = 0; r && guard < 10000; guard++) {
      const o = r.objects.get(key);
      if (o) return o;
      r = space && !isNilEg(r.ridDependent) ? space.revisions.get(egKey(r.ridDependent)) : undefined;
    }
    return undefined;
  }

  fileDataFor(decl: ObjectDeclaration): Uint8Array | null {
    const ref = decl.fileDataReference;
    if (!ref) return null;
    const m = /^<ifndf>(\{[0-9A-Fa-f-]+\})$/.exec(ref);
    if (!m) return null; // "<file>" (external file) or "<invfdo>" (invalid)
    const fd = this.fileData.get(m[1]!.toUpperCase());
    return fd ? this.buf.subarray(fd.offset, fd.offset + fd.length) : null;
  }

  /** Parse the ObjectSpaceObjectPropSet behind a declaration (cached). */
  propertySet(decl: ObjectDeclaration): PropertySet | null {
    if (!decl.ref || decl.ref.cb === 0 || !decl.jcid.isPropertySet) return null;
    const key = `${decl.ref.stp}:${decl.ref.cb}`;
    const cached = this.propCache.get(key);
    if (cached) return cached;
    const r = new Reader(this.buf, decl.ref.stp, decl.ref.stp + decl.ref.cb);
    const resolve = (c: CompactId) => this.resolveCompactId(c, decl.gidTable);

    const readStream = (): { ids: (ExtendedGuid | null)[]; extended: boolean; osidAbsent: boolean } => {
      const h = r.u32();
      const count = h & 0xffffff;
      const ids: (ExtendedGuid | null)[] = [];
      for (let i = 0; i < count; i++) ids.push(resolve(readCompactId(r)));
      return { ids, extended: ((h >>> 30) & 1) === 1, osidAbsent: ((h >>> 31) & 1) === 1 };
    };
    const oids = readStream();
    let osids: (ExtendedGuid | null)[] = [];
    let ctxIds: (ExtendedGuid | null)[] = [];
    if (!oids.osidAbsent) {
      const s = readStream();
      osids = s.ids;
      if (s.extended) ctxIds = readStream().ids;
    }
    const cursors = { oid: 0, osid: 0, ctx: 0 };
    const take = (arr: (ExtendedGuid | null)[], which: "oid" | "osid" | "ctx", n: number) => {
      const out = arr.slice(cursors[which], cursors[which] + n);
      cursors[which] += n;
      return out;
    };

    // Mirrors OneNote's per-type loader (FUN_10008f0b4): values are read in prid
    // order; object/space/context references consume their side streams.
    const readValue = (prid: number, type: number): PropertyValue => {
        let value: PropertyValue;
        switch (type) {
          case 0x1: value = { kind: "none" }; break;
          case 0x2: value = { kind: "bool", value: (prid >>> 31) === 1 }; break;
          case 0x3: value = { kind: "bytes", value: r.bytes(1) }; break;
          case 0x4: value = { kind: "bytes", value: r.bytes(2) }; break;
          case 0x5: value = { kind: "bytes", value: r.bytes(4) }; break;
          case 0x6: value = { kind: "bytes", value: r.bytes(8) }; break;
          case 0x7: value = { kind: "bytes", value: r.bytes(r.u32()) }; break;
          case 0x8: value = { kind: "oids", value: take(oids.ids, "oid", 1), single: true }; break;
          case 0x9: value = { kind: "oids", value: take(oids.ids, "oid", r.u32()), single: false }; break;
          case 0xa: value = { kind: "osids", value: take(osids, "osid", 1), single: true }; break;
          case 0xb: value = { kind: "osids", value: take(osids, "osid", r.u32()), single: false }; break;
          case 0xc: value = { kind: "contextIds", value: take(ctxIds, "ctx", 1), single: true }; break;
          case 0xd: value = { kind: "contextIds", value: take(ctxIds, "ctx", r.u32()), single: false }; break;
          case 0x10: {
            // Element type comes from the inner prid. In practice it is 0x11
            // (PropertySet); booleans are stored as one byte per element.
            const n = r.u32();
            const inner = n > 0 ? r.u32() : 0;
            const innerType = (inner >>> 26) & 0x1f;
            const sets: PropertySet[] = [];
            for (let i = 0; i < n; i++) {
              if (innerType === 0x11) sets.push(readPropertySet());
              else {
                const v = innerType === 0x2 ? ({ kind: "bool", value: r.u8() !== 0 } as const) : readValue(inner, innerType);
                sets.push({ properties: [{ prid: inner, id: inner & 0x3ffffff, type: innerType, value: v }] });
              }
            }
            value = { kind: "propertyValues", prid: inner, value: sets };
            break;
          }
          case 0x11: value = { kind: "propertySet", value: readPropertySet() }; break;
          default:
            throw new ParseError(`unknown property type 0x${type.toString(16)} in prid 0x${prid.toString(16)}`, r.pos);
        }
        return value;
    };

    const readPropertySet = (): PropertySet => {
      const count = r.u16();
      const prids: number[] = [];
      for (let i = 0; i < count; i++) prids.push(r.u32());
      const properties: Property[] = [];
      for (const prid of prids) {
        const type = (prid >>> 26) & 0x1f;
        properties.push({ prid, id: prid & 0x3ffffff, type, value: readValue(prid, type) });
      }
      return { properties };
    };

    try {
      const set = readPropertySet();
      this.propCache.set(key, set);
      return set;
    } catch (e) {
      this.warnings.push(`property set of ${egKey(decl.oid)} (jcid 0x${decl.jcid.raw.toString(16)}): ${(e as Error).message}`);
      return null;
    }
  }
}

export { formatGuid };
