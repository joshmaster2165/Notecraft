# The `.one` file format, as OneNote for Mac reads it

**Target:** Microsoft OneNote for Mac 16.114 (build 26101123, Mac App Store), the
arm64 slice of `Contents/MacOS/Microsoft OneNote`
(sha256 `f30d5efa105cf235475ea7c3467c8e043da062a397d80a9fe5a521ede262c514`).
The revision-store code is statically linked into the main executable; no
framework carries it. The binary is stripped, so function names below are Ghidra
`FUN_` addresses, located through format constants. Evidence IDs refer to two
REA evidence bundles, `evidence/rea-onenote-16.114-arm64.json` (98 records) and,
for the cache store in §11, `evidence/rea-onenote-16.114-arm64-cache.json`
(91 records). They hold decompiler output of Microsoft's binary, so they stay on
the analysis machine and aren't published here.

**Validation corpus:** the 14 `.one` section backups that OneNote writes to
`~/Library/Containers/com.microsoft.onenote.mac/Data/Library/Application Support/Microsoft User Data/OneNote/15.0/Backup/`
(23 MB in total: 221 object spaces, 1,366 FileNodeList fragments, 94,711 FileNodes).
All of them parse with zero warnings.

Each fact below is labelled:
- **[binary]**: observed in decompiled or disassembled OneNote code.
- **[files]**: observed in the real files.
- **[spec]**: Microsoft's public [MS-ONESTORE]/[MS-ONE] documentation, used for names
  and for anything the first two sources did not exercise.

---

## 1. Physical layout

```
offset 0x000 ┌──────────────────────────────────────────────┐
             │ Header (0x400 bytes)                          │──┐ fcrTransactionLog
             ├──────────────────────────────────────────────┤  │ fcrFileNodeListRoot
             │ chunks, addressed by FileChunkReference       │◄─┘ fcrFreeChunkList …
             │  • Transaction log fragments                  │
             │  • FileNodeList fragments (lists of FileNodes)│
             │  • ObjectSpaceObjectPropSet blobs             │
             │  • FileDataStoreObject blobs (images, files)  │
             │  • free space                                 │
             └──────────────────────────────────────────────┘
```

A `FileChunkReference` is `{stp: offset, cb: size}`. The header uses the
64x32 form (u64 offset, u32 size). Inside FileNodes the widths are compressed
(§4). A size of 0 means "nil".

## 2. Header (`FUN_100d29130`, header load/validate)

| Off | Size | Field | Notes |
|---|---|---|---|
| 0x00 | 16 | guidFileType | `.one` `{7B5C52E4-D88C-4DA7-AEB1-5378D02996D3}`, `.onetoc2` `{43FF2FA1-EFD9-4C76-9EE2-10EA5722765F}`. All-equal bytes → `FNFZeroHeaderFile` **[binary]** |
| 0x10 | 16 | guidFile | unique per file |
| 0x20 | 16 | guidLegacyFileVersion | zero |
| 0x30 | 16 | guidFileFormat | must be `{109ADD3F-911B-49F5-A5D0-1791EDC8AED8}` **[binary]** |
| 0x40 | 4 | ffvLastCodeThatWroteToThisFile | `< 0x1C` takes a legacy code path; 0x2A in all sample files **[binary][files]** |
| 0x44 / 0x48 | 4+4 | ffvOldest/NewestCodeThatHasWritten | |
| 0x4C | 4 | ffvOldestCodeThatMayReadThisFile | compared against the reader's version → `FNFInconsistentFileVersions` **[binary]** |
| 0x50–0x7B | | legacy 32-bit references, `cTransactionsInLog` @0x60 | |
| 0x7C | 1 | fNeedsDefrag | copied into the in-memory file object **[binary]** |
| 0x7E | 1 | fNeedsGarbageCollect | copied likewise **[binary]** |
| 0x80 | 16 | guidAncestor | |
| 0x94 | 12 | fcrHashedChunkList | |
| 0xA0 | 12 | fcrTransactionLog | |
| 0xAC | 12 | fcrFileNodeListRoot | |
| 0xB8 | 12 | fcrFreeChunkList | |
| 0xC4 | 8 | cbExpectedFileLength | |
| 0xD4–0x127 | | file version GUIDs, debug log, build numbers | |

The loader keeps two 0x400-byte copies of the header, one committed and one
working **[binary]**. `FUN_100052f28` is a static initializer that builds the
table of supported (file-type GUID, FFV) pairs: 0x2A for `.one`, 0x1B for
`.onetoc2` **[binary]**.

## 3. Transaction log

The log is a chain of fragments, each holding `TransactionEntry {u32 srcID, u32 value}`
records followed by a 12-byte next-fragment reference. `srcID == 1` is a
sentinel that ends one transaction. Any other `srcID` is a FileNodeList ID,
and `value` is that list's committed node count. Only the first
`cTransactionsInLog` transactions count. Nodes beyond a list's committed count
are uncommitted and must be ignored.

**Pitfall [files]:** the next-fragment reference sits right after the **last
whole entry**, `8·⌊(cb−12)/8⌋`, and not at `cb−12`. The fragment can carry
4 bytes of trailing padding. Reading at `cb−12` silently truncates every
large notebook. In the sample files that lost 105 of 117 pages.

## 4. FileNodeList fragments and FileNodes

### Fragment (`FUN_100d342d0` open/validate, `FUN_100d32b74` create, `FUN_100d32d8c` finalize)

```
u64 magic  0xA4567AB1F5F7F4C4          ── FNFFileNodeListChunkHeaderCorrupt if wrong
u32 FileNodeListID
u32 nFragmentSequence
FileNode[]  … until committed count, ChunkTerminatorFND (0x0FF), or < 4 bytes left
padding
FileChunkReference64x32 nextFragment    (fcrNil on the last fragment)
u64 footer 0x8BC215C38233BA4B          ── FNFFileNodeListChunkFooterCorrupt64Bit
```

- The minimum fragment size is 0x24 bytes. New fragments default to 0x1000
  bytes, and the writer zero-fills them **[binary]**.
- **Undocumented legacy variant [binary]:** header magic `0x6D814FD0A242B102`
  and footer `0x45A9BA65A7954CC2`, with a 32-bit next-fragment reference
  (16-byte trailer instead of 20). The parser accepts it.

### FileNode header (`FUN_100d35468`)

```
bits  0–9   FileNodeID
bits 10–22  Size (whole node incl. header; must be > 3 → FNFCorruptFileNodeHeaderSize)
bits 23–24  StpFormat  0: u64   1: u32   2: u16×8   3: u32×8
bits 25–26  CbFormat   0: u32   1: u64   2: u8×8    3: u16×8
bits 27–30  BaseType   0: no ref   1: ref → data   2: ref → child FileNodeList
```

This function decodes every field exactly as above **[binary]**. The encodings
observed in the sample files are `stp1/cb2` (66k nodes), `stp2/cb2` (11k) and
`stp0/cb2` (630) **[files]**.

### FileNode types seen in the sample files [files]

| ID | Name | Count |
|---|---|---|
| 0x0A4 | ObjectDeclaration2RefCountFND | 74,045 |
| 0x0C4 | ReadOnlyObjectDeclaration2RefCountFND | 5,007 |
| 0x08C | DataSignatureGroupDefinitionFND | 3,406 |
| 0x024 | GlobalIdTableEntryFNDX | 2,846 |
| 0x05A | RootObjectReference3FND | 1,669 |
| 0x072 | ObjectDeclarationFileData3RefCountFND | 1,414 |
| 0x0B0/0x0B4/0x0B8 | ObjectGroupListReference / Start / End | 630 each |
| 0x022/0x028 | GlobalIdTableStart2 / End | 630 each |
| 0x084 | ObjectInfoDependencyOverridesFND | 630 |
| 0x01E/0x01F/0x01C | RevisionManifestStart6 / Start7 / End | 422 / 208 / 630 |
| 0x008/0x00C | ObjectSpaceManifestListReference / Start | 221 each |
| 0x010/0x014 | RevisionManifestListReference / Start | 221 each |
| 0x05D/0x05C | RevisionRole(AndContext)DeclarationFND | 201 / 104 |
| 0x0C5 | ReadOnlyObjectDeclaration2LargeRefCountFND | 82 |
| 0x004 | ObjectSpaceManifestRootFND | 13 |

`onestore.ts` also handles the rest of the [spec] set, including the 2007-era
`…FNDX` declarations and GlobalIdTable entry types 2 and 3.

## 5. Logical structure

```
root FileNodeList
├─ ObjectSpaceManifestRootFND          → gosid of the root object space (the section)
├─ ObjectSpaceManifestListReferenceFND → one per object space (section + one per page)
│   └─ RevisionManifestListReferenceFND (last one wins)
│       ├─ RevisionManifestStart6/7FND  rid, ridDependent, role [, context]
│       │   ├─ ObjectGroupListReferenceFND → object group list:
│       │   │     GlobalIdTableStart2 · Entry(index → GUID)… · End
│       │   │     ObjectDeclaration2RefCountFND {CompactID oid, JCID, ref → prop set}…
│       │   ├─ ObjectInfoDependencyOverridesFND
│       │   ├─ RootObjectReference3FND {ExtendedGUID oid, RootRole}
│       │   └─ RevisionManifestEndFND
│       └─ RevisionRole(AndContext)DeclarationFND  (re-points a role at a revision)
└─ FileDataStoreListReferenceFND       → FileDataStoreObjectReferenceFND {ref, guid}…
```

- **CompactID** is `u8 n | u24 guidIndex`. It is resolved through the global ID
  table of the object group that declared the object, giving
  `ExtendedGUID {guid, n}`.
- **Current revision:** the last revision assigned to (role 1 = content,
  default context). A revision inherits objects and roots from `ridDependent`.
- **Root roles:** 1 = content root, 2 = metadata root.

## 6. Property sets (`FUN_10008df60` PropertySet, `FUN_10008f0b4` per-property loader)

```
ObjectSpaceObjectPropSet:
  u32 header {count:24, reserved:6, ExtendedStreamsPresent:1, OsidStreamNotPresent:1}
  CompactID[count]  OIDs
  [OSIDs stream, same header]          if !OsidStreamNotPresent
  [ContextIDs stream]                  if OSIDs.ExtendedStreamsPresent
  PropertySet

PropertySet:
  u16 cProperties                       (remaining ≥ 4·count is checked) [binary]
  u32 prid[cProperties]                 {id:26, type:5, boolValue:1}
  values, in prid order
```

| type | value | how it is read **[binary]** |
|---|---|---|
| 0x1 | none | |
| 0x2 | bool | the value is bit 31 of the prid |
| 0x3–0x6 | 1, 2, 4, 8 bytes | |
| 0x7 | u32 length + bytes | length must not exceed the remaining bytes |
| 0x8 / 0x9 | ObjectID / array | consume the OIDs stream (`CountOfObjectIDsRemaining`) |
| 0xA / 0xB | ObjectSpaceID / array | consume the OSIDs stream |
| 0xC / 0xD | ContextID / array | consume the ContextIDs stream |
| 0x10 | ArrayOfPropertyValues | `u32 n`, then if n > 0 an inner prid and n values **of the inner prid's type**; booleans take 1 byte each |
| 0x11 | nested PropertySet | recursive |

The 0x10 rule is more general than the public spec, which assumes the
elements are PropertySets. The parser follows the binary.

Property names in `schema.ts` come from [MS-ONE] and from a name table that
the binary ships (§11.6). All 135 [MS-ONE] names match that table. The
numeric IDs and type bits are confirmed against the files.

## 7. File data (`FUN_100d1be84`, FileDataStoreObject writer)

```
GUID   {BDE316E7-2665-4511-A4C4-8D4D0B7A9EAC}   ┐
u64    cbLength                                  │ 0x24-byte header
u32    unused, u64 reserved                      ┘
bytes  FileData[cbLength]
GUID   {71FBA722-0F79-4A0B-BB13-899256426B24}   at chunk end − 0x10
```

The writer allocates `cbLength + 0x34` **[binary]**. Images and attachments
point here through `ObjectDeclarationFileData3RefCountFND.FileDataReference = "<ifndf>{guid}"`.

**[files]:** the Mac backups declare every picture as `"<invfdo>"` (an invalid
file data object) and include no file data store. The image bytes are not in
the backup, only the layout, filename and OCR text. The parser extracts bytes
whenever a file does embed them (use `--assets <dir>`). Otherwise it looks for
them in OneNote's cache folder (§11) and reports `assetStatus: "notEmbedded"`
when they are not there either.

## 8. Page model ([MS-ONE] semantics used by `notebook.ts`)

```
SectionNode 0x60007 ─ElementChildNodes→ PageSeriesNode 0x60008
  PageSeriesNode ─ChildGraphSpaceElementNodes→ page object spaces (one per page, in order)
page space: content root PageManifestNode 0x60037 ─ContentChildNodes→ PageNode 0x6000B
                metadata root PageMetaData 0x20030 (CachedTitleString, PageLevel, created time)
PageNode ─StructureElementChildNodes→ TitleNode 0x6002C ─→ OutlineNode(s)
         ─ElementChildNodes→ OutlineNode 0x6000C | ImageNode 0x60011 | EmbeddedFileNode 0x60035
OutlineNode ─ElementChildNodes→ OutlineElementNode 0x6000D (| OutlineGroup 0x60019)
OutlineElementNode ─ContentChildNodes→ RichTextOENode 0x6000E | ImageNode | TableNode 0x60022
                   ─ElementChildNodes→ nested OutlineElementNodes   ─ListNodes→ NumberListNode 0x60012
TableNode → TableRowNode 0x60023 → TableCellNode 0x60024 → OutlineElementNodes
RichTextOENode: RichEditTextUnicode (UTF-16) + TextRunIndex (u32 run ends) + TextRunFormatting (style objects 0x12004D)
```

Details worth knowing **[files]**:
- **Units.** Layout floats are half-inches, so the parser multiplies by 36 to
  get points. Font sizes are half-points. Times are Time32 (seconds since
  1980) or FILETIME.
- **Hyperlinks** are stored inline in the text as a hidden field code
  `U+FDDF HYPERLINK "url"` before the link text. The parser strips it and sets
  `href` on the runs.
- **List formats** are length-prefixed UTF-16 strings. A bullet is `[1, '•']`.
  A numbered format is `[3, U+FFFD, scheme, '.']`, where the scheme is the
  MSONFC code (0 = decimal, 4 = lower letter, …).
- **Image nodes** carry `RichEditTextUnicode`, which holds the text OneNote
  recognized in the picture. It is exposed as `ocrText`.

## 9. Function map

| Address | Role | Evidence |
|---|---|---|
| `FUN_100d29130` | header load + validation | `ev_3ee63608ef460e11…` |
| `FUN_100052f28` | supported file-type/FFV table (static init) | `ev_bf216501252ce856…` |
| `FUN_100d342d0` | open FileNodeList fragment, check header/footer magic | `ev_47cc6dd3426e8b15…` |
| `FUN_100d32b74` | create fragment (header, default 0x1000 bytes) | `ev_c5820cd0e5063699…` |
| `FUN_100d32d8c` | finalize fragment (nil next pointer + footer) | `ev_4bcb8664592e37ba…` |
| `FUN_100d35468` | decode FileNode header / rewrite its chunk reference | `ev_61e373e65c7d7ea5…` |
| `FUN_10008df60` | read PropertySet | `ev_6d57a5a85ddc9539…` |
| `FUN_10008f0b4` | read one property value (type switch) | `ev_54c7568d8f0e033d…` |
| `FUN_100d1be84` | write FileDataStoreObject | `ev_e073d407b792a47c…` |

## 10. Open questions and limits

- **Transaction-log reader not located.** The next-pointer placement in §3 is
  observed in the files, not in code.
- **Writer code, not reader code.** The FileDataStoreObject routine found
  through its GUID constants is the writer; the reader compares those GUIDs by
  another path that was not traced.
- **No `.onetoc2` or ink sample.** The Mac backups contain neither. §13 and
  §14 follow onenote.rs and [MS-ONE]; they are covered by unit tests on
  synthetic data, not yet by real files. `--raw` dumps any file's object graph.
- **Not decoded:**
  - Password-protected sections (`ObjectDataEncryptionKeyV2FNDX`). These are
    detected and reported.
  - Handwriting embedded in text runs (`TextRunDataObject` → InkDataNode) and
    OneNote's handwriting recognition (`RecognizedText*`, 0x20054–57).
  - Several image properties: `TextContentMetadata` (0x1D61), `EncryptedHash`
    (0x1DFB, a Windows DPAPI blob) and `OriginalPageNumber` (0x1DF9). Only
    `UnverifiedHash` (0x1DFC) is used (§11.5). Names come from §11.6; the values
    are not interpreted.
- **Note tags sit on the text node in Mac files.** [MS-ONE] puts
  `NoteTagStates` (0x40003489) on the `OutlineElementNode`; the Mac backups put
  it on the paragraph's `RichTextOENode` (0x6000E) instead **[files]**. The
  parser reads both. Each state points at a `NoteTagSharedDefinitionContainer`
  (0x120043) with the label, shape and colors; a present `ActionItemType`
  makes the tag checkable, and bit 0 of `ActionItemStatus` means done.

---

## 11. The local cache store (`15.0/cache`)

OneNote for Mac syncs notebooks into a cache folder next to `Backup/`:
`~/Library/Containers/com.microsoft.onenote.mac/Data/Library/Application Support/Microsoft User Data/OneNote/15.0/cache/`.
The cache is not a revision-store file. It is OneNote's own transactional
object store (`Jot::Cache::CStore<OneNoteData>`), split over many files. The
parser reads it only to find file data that a backup leaves out
([`parser/src/cache.ts`](../parser/src/cache.ts)).

**Validation corpus:** the cache on the same machine as the backups: `header`
plus 231 `.bin` files (18 MB), with OneNote running.

### 11.1 Folder layout

```
cache/
├─ header           72 bytes (§11.2)
├─ 00000000.bin     one file per FileID (here 00000000 … 00000076, no gaps)
├─ …
├─ <FileID>.enc     the same, when the cache-encryption feature gate is on
└─ tmp/             new files are created here, then moved into place
```

- **FileID.** A 40-bit counter. `FUN_10006ffd0` throws for a value with bits
  above bit 39 **[binary]**.
- **File name.** `FUN_1000716ec` takes 5 bits at a time, least significant
  first, from `"0123456789ABCDEFGHIJKLMNOPQRSTUV"`, emits 8 digits and reverses
  them. `FUN_100071664` appends `.bin` (mode 0) or `.enc` (mode 1) **[binary]**.
  FileID 230 is therefore `00000076.bin`.
- **Paths.** `FUN_1000715d0` builds `<cache>/<name>` for committed files.
  `FUN_100c50d24` builds `<cache>/tmp/<name>` for files being created.
  `FUN_10005d048` joins components with `/` **[binary]**. `FUN_100c51998` opens
  or creates a file by FileID, as a memory mapping or a standard-I/O file, and
  picks `.enc` when the feature gate at `DAT_101787a90` is on **[binary]**. All
  231 files here are `.bin`, and `tmp/` is empty **[files]**.

### 11.2 `header`

`FUN_10006eb90` opens `<cache>/header`. For a new store it fills a 0x48-byte
struct with `FUN_100cad7bc` and writes it **[binary]**. `FUN_10006e69c`, the
store open routine, reads it back.

| Off | Size | Initial value | Field | This machine |
|---|---|---|---|---|
| 0x00 | 4 | 0, 4 or 5 | format mode; `FUN_10006e69c` branches on `> 4` | 0 |
| 0x04 | 4 | set once | creation tag | (per store) |
| 0x08 | 8 | 0 | | 0 |
| 0x10 | 4 + 4 | 0, −1 | not decoded | 0x13A1, 0x1B0 |
| 0x18 | 4 + 4 | 0, −1 | not decoded | 0xD, −1 |
| 0x20 | 4 | −1 | not decoded | −1 |
| 0x24 | 8 | 0 | **last FileID handed out** | 230 |
| 0x2C / 0x34 / 0x3C | 8 each | −1 | three reference fields, not decoded | (0xBBE, −1), (0x7A, 0x40002B9E), (0x90, −1) |
| 0x44 | 4 | 0 | | 0 |

The initial values come from `FUN_100cad7bc` **[binary]**. The 0x24 field is
**[files]**: it equals the highest FileID on disk. It is consistent with
`FUN_10006e69c` loading a header field into the store's FileID counter
(`store+0xB18`), which `FUN_100cee324` and `FUN_100c5ad08` pre-increment before
each new file **[binary]**.

### 11.3 Allocator files and file data objects

The FileID namespace holds two kinds of file.

- **Allocator files** are memory-mapped and sized in 4 KB steps
  (`Cache::CAllocatorFiles`, `MemAccessToFileOnMemoryMappedFile`; RTTI names
  **[binary]**). They hold the object store: `CRevisionInCache`,
  `CObjectGroupInCache`, `CFileDataStoreInCache`, dictionaries and transaction
  logs. Their first words are offsets into the same file with a 2-bit tag in
  bits 30–31 **[files]**. Property sets inside them use the PropertySet encoding
  of §6. For example, all 699 occurrences in the cache of the backups'
  `UnverifiedHash` values are preceded by their u32 length, 20 **[files]**.
  **Not decoded.**
- **File data objects (FDOs)** are images and attachments, one standard-I/O
  file each. `CFileDataStoreInCache::CreateFileDataObject` (`FUN_100cee324`)
  takes the next FileID and calls `CAllocatorMappings::CreateStandardIoFile`
  (`FUN_100c527e4` → `FUN_100c51998`). The file lives in `tmp/` until its
  transaction commits, and `…CreateFileDataObjectDeleteUncommitted` removes it
  otherwise **[binary]**. `CFileDataStoreInCache::MoveFileIntoStore`
  (`FUN_100c5ad08`) does the same with a file that already exists, such as a
  finished download **[binary]**.
- **FDO index.** The store keys FDOs through two dictionaries, given by the
  template arguments of `Cache::CCommittedFileDataObjectInCacheWithTxn`:
  `FdoIDAndIdentityID → array<u8,20>` and
  `FileHashAndIdentityID → FdoIDAndFileID`. It logs `FdoHashCollision` when two
  FDOs share a hash **[binary]**.
- **Inference, not observed:** a committed FDO file holds the image or
  attachment bytes unchanged. It is created with standard I/O rather than
  through the allocator, and the move path takes an existing file. This cache
  has no FDO to check against.

### 11.4 Why the pictures are missing: on-demand download

**[files]**
- None of the 231 files is an FDO. No 4 KB page has entropy above 7.9
  bits/byte, and there is no PNG, JPEG, GIF, PDF or ZIP signature. No file in
  the whole OneNote container, or in the Office group container outside
  `SolutionPackages`, has entropy above 7.5. Compressed images would be close
  to 8.
- The cache does hold the notebook graph. All 223 page object-space GUIDs and
  all 120 picture-container GUIDs from the backups appear in it, and so does
  every `UnverifiedHash` and `EncryptedHash` value.
- `00000002.bin` contains `MayHaveFdosPendingDownload = true` 180 times and
  `MayHaveChildrenWithFdosPendingDownload = true` 201 times (prids `0x88003614`
  and `0x88003615`, with the bool bit set). These are OneNote's flags for
  objects whose file data has not been downloaded yet. The objects they belong
  to were not identified.

**[binary]**
- `FUN_100d86b48` logs `CellStorageGetRevisionBatchQueryExcludesODBs` when a
  revision-batch query leaves out object data BLOBs. Syncing a page does not
  have to bring its file data with it.
- `Realtime::CObjectSpaceNativeReplicator::DownloadFileDataObject`,
  `DownloadMissingFdosInAllContexts`, `Realtime::ForEachDeferredFdo` and
  `FdoDownloadQueue` (RTTI) fetch FDOs later. `FUN_100b69340` stores a
  downloaded FDO in the cache (telemetry `DownloadFdo_StoredInCache`, keyed by
  `FdoId`).
- `FUN_100d03a50` turns an FDO's property set into attributes:
  `FileDataObject_Extension`, `FileDataObject_FileChecksum`,
  `FileDataObject_InvalidData` (the `<invfdo>` case) and `FileDataObject_GUID`
  (the FdoID). It then looks the FdoID up in the local file data store.

**Conclusion:** OneNote for Mac downloads a picture's bytes only when it needs
them. On this machine none of the 618 current image blocks has been
downloaded, so their bytes are not on disk.

### 11.5 How the parser links cached file data

`OneNoteCache` (`cache.ts`) indexes the folder. It sorts files into
`fileData` (a known media signature at offset 0), `encrypted` (`.enc`) and
`store`, and hashes every readable file with SHA-1. For a container with no
bytes in the `.one` file, the converter passes the image node's
`UnverifiedHash` to `ConvertOptions.resolveFileData`. On a SHA-1 match it fills
`asset`, with `source: "cache/<name>"`, and sets `assetStatus: "embedded"`.
`--assets <dir>` then writes the file.

- `UnverifiedHash` (0x1C001DFC) is 20 bytes. It is on 601 of the 618 current
  image blocks, with 569 distinct values. The parser now emits it as
  `unverifiedHash` **[files]**.
- `EncryptedHash` (0x1C001DFB) is a 246-byte Windows DPAPI blob. Every value
  starts `01000000 D08C9DDF-0115-D111-8C7A-00C04FC297EB`, so OneNote for
  Windows inserted these pictures **[files]**.
- **Unconfirmed:** that `UnverifiedHash` is the SHA-1 of the file bytes. The
  Mac binary only lists the property (`FUN_100be6040`) and never computes it. A
  match is conclusive, but a miss may only mean a different hash. The other
  route, from container to FdoID to FileID, needs the allocator format (§11.3).
  It would also cover the 17 blocks that have no `UnverifiedHash`.
- The CLI and the smoke test use the `cache` sibling of a `…/15.0/Backup` tree.
  `--cache <dir>` and `--no-cache` override that.

**Result on this machine:** 0 of 618 image blocks resolve. The cache holds no
FDO files.

### 11.6 The property-name table

Contrary to the first version of §6, the binary does ship property names.
`__DATA_CONST` 0x101649EA8–0x10165AF60 holds 1,803 entries of 32 bytes:

```
u32 prid · u32 flags · u64 0 · wchar16 *name · wchar16 *name (same pointer)
```

For example, 0x10164DE28 is `{0x1C001DFC, 0x07070007, 0, L"UnverifiedHash"}`.
The table was found from the string `Unused_FileDataObject_FileHash` and walked
with a Mach-O reader. The three `read_bytes` records in the function map below
anchor it. All 135 names already in `schema.ts` match the table. These names
were added from it: `TextContentMetadata`, `IsScreenClipping`, `NeedsOCR`,
`OriginalPageNumber`, `EncryptedHash`, `UnverifiedHash`, `OcrEngineVersion`,
`OcrAccuracyIndex`, `FileDataObject_*`, `MayHaveFdosPendingDownload`,
`MayHaveChildrenWithFdosPendingDownload` and `DeferFDODownloadOnNotebook`.

### 11.7 Function map (cache)

| Address | Role | Evidence |
|---|---|---|
| `FUN_1000716ec` | FileID → 8 base-32 digits | `ev_d7cbd4bdf934e5374705…` |
| `FUN_100071664` | append `.bin` / `.enc` | `ev_882ee7cb0d0b465ae7d2…` |
| `FUN_1000715d0` | `<cache>/<name>` | `ev_ef99c682b179e13dbeb2…` |
| `FUN_100c50d24` | `<cache>/tmp/<name>` (new files) | `ev_6d5b5c1a6f9daf3004e9…`, `ev_eeccf7e05470f8149f05…` |
| `FUN_10005d048` | path join with `/` | `ev_4aaac9dc0c8238e41268…` |
| `FUN_10006ffd0` | FileID must fit in 40 bits | `ev_6e9cd593682803209c51…` |
| `FUN_10006eb90` | open or initialise `header` (0x48 bytes) | `ev_827490be7a3558882e7f…` |
| `FUN_100cad7bc` | header initial values | `ev_d89fab4d06228598e61a…` |
| `FUN_10006e69c` | store open: header → store fields | `ev_d631335e68cba7ce8d69…` |
| `FUN_100c51998` | open/create file by FileID (mmap or stdio, `.enc` gate) | `ev_0c9799465775a4b2473c…` |
| `FUN_100c527e4` | `CAllocatorMappings::CreateStandardIoFile` | `ev_4cfd701535a220867108…` |
| `FUN_100cee324` | `CFileDataStoreInCache::CreateFileDataObject` | `ev_b0df3cc749dce59da257…` |
| `FUN_100c5ad08` | `CFileDataStoreInCache::MoveFileIntoStore` | `ev_9df102ab224778ded217…` |
| `FUN_100c53218` | `.bin` → `.enc` conversion through `tmp/` | `ev_c7d6241ae7ea9c9ee6f1…` |
| `FUN_100d03a50` | FDO property set → attributes (Extension, FileChecksum, InvalidData, GUID) | `ev_24acd2f222f896c62027…` |
| `FUN_100b69340` | store a downloaded FDO in the cache | `ev_08b3fa5c5048f0fbcb11…` |
| `FUN_100d86b48` | revision-batch query that excludes object data BLOBs | `ev_7146247d157603edc308…` |
| `FUN_100be6040` | property list that includes `UnverifiedHash`/`EncryptedHash` (only code reference) | `ev_3ca31f118cf3a07ea477…`, `ev_be7e95d8b20535f74341…` |
| table @ 0x101649EA8 | property-name table | `ev_38b4eb064aebed4f3818…`, `ev_3b9124069be0d0399b6b…`, `ev_4f64434e52e37581cc9b…` |
| strings | `FileDataStoreInCache`, `FdoHashCollision`, `MissingFdos`, `DownloadFdo_StoredInCache`, `ExcludesODBs` | `ev_76ab1abdfe12f5867497…`, `ev_a67eed17aa41ae106ec6…`, `ev_05b9d3f153858319f350…`, `ev_7c0542a93c2d6c80c250…`, `ev_1e009f1b214d17d533a3…` |

### 11.8 Open questions

- **Allocator file format.** Pages, tagged offsets, transactions and
  dictionaries are not decoded. The parser therefore cannot read the
  FdoID → FileID index, or tell which objects carry the pending-download flags.
- **`UnverifiedHash` algorithm.** Unconfirmed (§11.5).
- **`.enc` files.** Listed but not readable; format and key are unknown.
- **Getting the bytes.** Expected but not tested: once OneNote for Mac has
  downloaded the pictures (for example, after their pages are opened), `cache/`
  gains FDO files, and `npm run smoke` reports how many resolve.

---

## 12. Page version history

OneNote keeps earlier states of a page inside that page's own object space.
The parser exposes them with `ConvertOptions.includeVersions`, which fills
`Page.versions`. Everything below is **[files]**: it was read from the
14 sample sections, which hold 201 versions across 104 of 208 pages. None of
it was traced in the binary.

```
page object space
├─ revision R_cur  role 1, default context          ← current page (PageManifestNode root)
│     PageManifestNode.VersionHistoryGraphSpaceContextNodes (0x3400347B) = [C_hist]
├─ revision R_hist role 1, context C_hist
│     root 1: VersionHistoryContent (0x6003C)
│               ElementChildNodes → VersionProxy (0x6003D)…
│     root 2: VersionHistoryMetaData (0x20046)  SchemaRevisionInOrderToRead
└─ revision R_v    role 1, context C_v          ← one historical page (full PageManifestNode tree)
      root 4: RevisionMetaData (0x20044)  AuthorMostRecent, LastModifiedTimeStamp

VersionProxy
  CreationTimeStamp (Time32)
  LastModifiedTimeStamp (FILETIME)           when this version was current
  AuthorMostRecent → ReadOnlyPersistablePropertyContainerForAuthor.Author
  VersionHistoryGraphSpaceContextNodes = [C_v]
```

- **Context assignments.** Historical revisions are reached only through
  `RevisionRoleAndContextDeclarationFND` (role 1 + context). The role in their
  `RevisionManifestStart` can be 4, and so can the current revision's (in
  other pages it is 1), so the manifest role alone cannot tell them apart.
- **Full trees.** Each historical revision holds a complete page tree, not a
  delta, and converts with the same page converter (`convertPage(…, at)`).
- **Timestamps.** `VersionProxy.LastModifiedTimeStamp` can be later than the
  current page's `LastModifiedTime` (Time32, coarser). The parser sorts
  versions by the proxy timestamp, newest first.

Notecraft (`../notecraft`) imports these as read-only "OneNote" versions next
to its own snapshots.

---

## 13. Ink

[MS-ONE] does not document ink. The object graph, property IDs and point
encoding below follow onenote.rs (msiemens), whose author validated them
against real files; this repository has no ink sample yet (§10). The parser
implements them in `parser/src/ink.ts`.

```
PageNode.ElementChildNodes ─→ InkContainer (0x60014)            page ink
OutlineElementNode.ContentChildNodes ─→ InkContainer             ink inside an outline
InkContainer
  InkData (0x20003415) → InkDataNode (0x2003B)
  │   InkStrokes (0x24003416) → InkStrokeNode (0x20047)…
  │   InkBoundingBox (0x1C003418)  4 × i32 [xMin, yMin, xMax, yMax], HIMETRIC
  ├ ContentChildNodes → nested InkContainers (groups; offsets add up)
  ├ InkScalingX/Y (0x14001C46/47)  f32, multiplies coordinates
  └ OffsetFromParentHoriz/Vert     f32 half-inches (page ink only)
InkStrokeNode
  InkPath (0x1C00340B)             point data, see below
  InkBias (0x0C00341C)             0 handwriting · 1 drawing · 2 both
  InkStrokeProperties (0x20003409) → StrokePropertiesNode (0x120048)
StrokePropertiesNode
  InkDimensions (0x1C00340A)       32-byte entries: GUID, i32 min, i32 max, 8 bytes
  InkWidth / InkHeight (0x1400340D / 0x1400340C)   f32 HIMETRIC
  InkColor (0x1400340F)            COLORREF 0x00BBGGRR
  InkTransparency (0x0C003414)     u8, 0 = opaque
  InkRasterOperation (0x0C003413)  9 (mask pen) marks a highlighter in Windows Ink
  InkPenTip (0x0C003412)           0 = round
```

**InkPath** is an [MS-ISF] multi-byte sequence: unsigned integers of 7 bits
per byte, low group first, high bit = more. The first integer is the value
count ×2; every value keeps its sign in the low bit (`v >> 1`, negated when
bit 0 is set). Values are grouped by dimension, not interleaved: all X, then
all Y, then any others (pressure), in `InkDimensions` order (X =
`{598A6A8F-52C0-4BA0-93AF-AF357411A561}`, Y =
`{B53F9F75-04E0-4498-A7EE-C30DBB5A9011}`). The first value of each dimension
is absolute and the rest are deltas.

**Units.** Coordinates × InkScaling are HIMETRIC (0.01 mm); points =
HIMETRIC × 72 / 2540. Page ink adds the container offset (half-inches × 36).
Ink inside an outline flows with the text, so the parser makes it relative to
its bounding box and marks the block `embedded`.

Notecraft turns page ink into its own editable strokes and embedded ink into
an inline drawing.

## 14. Notebook table of contents (`.onetoc2`)

A notebook folder holds one `.onetoc2` and its `.one` sections; each section
group is a subfolder with its own `.onetoc2` ([MS-ONE] §2.1.15). The root
object is `jcidPersistablePropertyContainerForTOC` (0x20001); its entries use
the same JCID. `parser/src/toc.ts` reads it.

| Property | ID | Meaning |
|---|---|---|
| TOCEntryIndex_OidIndex | 0x24001CF6 | child entries (root) |
| FolderChildFilename | 0x1C001D6B | entry name; `^M` = `+`, `^J` = `,` |
| NotebookElementOrderingID | 0x14001CB9 | display order |
| NotebookColor | 0x14001CBE | COLORREF; top byte inverted alpha; 0xFFFFFFFF = none |
| FileIdentityGuid | 0x1C001D94 | the section file's `guidFile` |

Nothing marks an entry as a section or a group; that is decided on disk
(`X.one` file vs `X` folder), and the file system name wins over
`FolderChildFilename`. Later entries with the same name override earlier
ones; entries are then sorted by ordering id. The root's color is the
notebook's; a section's own `.one` color wins over its TOC entry's.
