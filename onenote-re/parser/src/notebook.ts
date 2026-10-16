// Converts a parsed revision store into a JSON tree of notebook blocks:
// section -> pages -> outlines / images / files -> outline elements ->
// rich text runs, tables, lists and note tags.
//
// Coordinates: OneNote stores layout as float32 half-inch units; this module
// converts them to points (1 half-inch = 36pt). Font sizes are stored in
// half-points and converted to points.

import {
  OneStore,
  RootRole,
  egKey,
  isNilEg,
  type ExtendedGuid,
  type ObjectDeclaration,
  type ObjectSpace,
  type Property,
  type PropertySet,
  type Revision,
} from "./onestore.ts";
import { Jcid, Prop, jcidName, propName } from "./schema.ts";
import { utf16le, latin1, hex } from "./reader.ts";
import {
  HIMETRIC_PT,
  decodeBoundingBox,
  decodeInkDimensions,
  decodeInkPath,
  pointBounds,
  strokePoints,
  type InkBlock,
  type InkShapeInfo,
  type InkStroke,
} from "./ink.ts";

export type { InkBlock, InkShapeInfo, InkStroke } from "./ink.ts";

// --- output types ------------------------------------------------------------

export interface Layout {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

export interface TextStyle {
  font?: string;
  fontSize?: number;
  color?: string;
  highlight?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  superscript?: boolean;
  subscript?: boolean;
  hidden?: boolean;
  /** MathFormatting: the run is part of an equation (RichEdit's CFE_MATH). */
  math?: boolean;
  /** MathOrdinary / MathNoBuildup: RichEdit's CFE_MATHORDINARY / CFE_MATHNOBUILDUP. */
  mathOrdinary?: boolean;
  mathNoBuildup?: boolean;
  /** The math object this run's U+FDD0 starts (MathData_*; file-format.md §15.4). */
  mathObject?: MathObject;
  languageId?: number;
  styleId?: string;
}

/**
 * One math object (fraction, radical, n-ary, script, brackets…) in equation
 * text. Its text is U+FDD0, the arguments separated by U+FDEE, then U+FDEF;
 * the MathData_* properties sit on the U+FDD0 run's formatting. The field
 * names follow ITextRange2::GetInlineObject, whose parameters they match.
 */
export interface MathObject {
  /** MathData_Type: RichEdit's inline object type (tom.h OBJECTTYPE: 16 fraction, 21 n-ary, 25 radical, 29 subscript…). */
  type: number;
  /** MathData_cArg: number of arguments. */
  args?: number;
  /** MathData_Char / Char1 / Char2: UTF-16 code units (n-ary operator or accent, brackets, separator). */
  char?: number;
  char1?: number;
  char2?: number;
  /** MathData_Align. */
  align?: number;
  /** MathData_cCol: matrix columns. */
  columns?: number;
  /** MathData_TeXStyle. */
  texStyle?: number;
  /** MathData_FontAlign. */
  fontAlign?: number;
}

export interface TextRun {
  start: number;
  end: number;
  text: string;
  style: TextStyle;
  href?: string;
}

export interface RichTextBlock {
  type: "richText";
  id: string;
  text: string;
  runs: TextRun[];
  paragraph: TextStyle & {
    alignment?: "left" | "center" | "right";
    spaceBefore?: number;
    spaceAfter?: number;
    lineSpacing?: number;
    rtl?: boolean;
  };
}

export interface AssetInfo {
  byteLength: number;
  mediaType: string;
  extension?: string;
  /** Set when the bytes came from resolveFileData (e.g. "cache/0000004Q.bin"), not the .one file. */
  source?: string;
  /** Whatever the caller's onAsset hook returned (file path, URL, data URI...). */
  ref?: string;
}

/**
 * Where the binary payload lives. "embedded" means the bytes were found, in the
 * .one file or through resolveFileData (then asset.source says where).
 * "notEmbedded" is the <invfdo> marker: the writer (e.g. OneNote for Mac's
 * local backups) declared the object but left the bytes out, and no resolver
 * supplied them. "external" is a <file> reference to a sidecar file.
 */
export type AssetStatus = "embedded" | "notEmbedded" | "external" | "missing";

export interface ImageBlock {
  type: "image";
  id: string;
  layout: Layout;
  altText?: string;
  filename?: string;
  hyperlink?: string;
  isBackground?: boolean;
  /** Text OneNote recognised in the picture (stored on the image node). */
  ocrText?: string;
  /** UnverifiedHash (20 bytes, hex): the key cache.ts matches against SHA-1 of cached files. */
  unverifiedHash?: string;
  /** Picture › Crop (file-format.md §15.1). */
  crop?: ImageCrop;
  /** One page of a File Printout (file-format.md §15.2). */
  printout?: PrintoutInfo;
  /** Embedded web content (IFrame*: an online video, for example). */
  embed?: EmbedInfo;
  assetStatus: AssetStatus;
  asset: AssetInfo | null;
}

/**
 * The kept rectangle as percentages (0–100) of the original picture. OneNote
 * stores fractions (0–1) as float32; the converter multiplies by 100.
 */
export interface ImageCrop {
  topLeftXPercentage: number;
  topLeftYPercentage: number;
  widthPercentage: number;
  heightPercentage: number;
}

export interface PrintoutInfo {
  /** OriginalPageNumber (else DisplayedPageNumber): the 1-based page of the printed file. */
  page?: number;
  /** IsPartOfSplitPrintout: a long printout continued on another OneNote page. */
  splitPart?: boolean;
  /** PrintoutOutOfDate: the attachment changed after this picture was made. */
  outOfDate?: boolean;
}

export interface EmbedInfo {
  url?: string;
  /** IFrameMediaType (not decoded). */
  mediaType?: number;
  title?: string;
}

export interface EmbeddedFileBlock {
  type: "embeddedFile";
  id: string;
  layout: Layout;
  filename?: string;
  sourcePath?: string;
  /** A recording made in OneNote (Insert › Audio / Video). */
  recording?: { media?: number; duration?: number };
  /** PrintoutOutOfDate: the file changed after its printout pictures were made. */
  printoutOutOfDate?: boolean;
  assetStatus: AssetStatus;
  asset: AssetInfo | null;
}

export interface TableBlock {
  type: "table";
  id: string;
  rowCount?: number;
  columnCount?: number;
  columnWidths: number[];
  bordersVisible?: boolean;
  rows: { id: string; cells: { id: string; shading?: string; children: OutlineElementBlock[] }[] }[];
}

export interface UnknownBlock {
  type: "unknown";
  id: string;
  jcid: string;
  jcidName: string;
  properties: Record<string, unknown>;
}

export type ContentBlock = RichTextBlock | ImageBlock | EmbeddedFileBlock | TableBlock | InkBlock | UnknownBlock;

export interface ListInfo {
  kind: "bullet" | "numbered";
  /** Bullet glyph (render with `font`, often Symbol/Wingdings). */
  bullet?: string;
  /** Numbering scheme, e.g. "decimal", "lowerLetter", "upperRoman". */
  scheme?: string;
  prefix?: string;
  suffix?: string;
  restart?: number;
  font?: string;
}

// MSONFC numbering schemes used by NumberListFormat.
const NUMBER_SCHEMES = ["decimal", "upperRoman", "lowerRoman", "upperLetter", "lowerLetter", "ordinal", "cardinalText", "ordinalText"];

export interface NoteTag {
  label?: string;
  shape?: number;
  /** ActionItemType from the tag definition; present on to-do style (checkable) tags. */
  actionItemType?: number;
  highlightColor?: string;
  textColor?: string;
  completed?: boolean;
  createdAt?: string;
  completedAt?: string;
}

export interface OutlineElementBlock {
  type: "outlineElement";
  id: string;
  level?: number;
  list?: ListInfo;
  tags?: NoteTag[];
  createdAt?: string;
  lastModified?: string;
  content: ContentBlock[];
  children: OutlineElementBlock[];
}

export interface OutlineBlock {
  type: "outline";
  id: string;
  layout: Layout;
  role?: "titleText" | "titleDate" | "titleTime";
  children: OutlineElementBlock[];
}

export type PageBlock = OutlineBlock | ImageBlock | EmbeddedFileBlock | InkBlock | UnknownBlock;

export interface Page {
  id: string;
  title: string;
  level?: number;
  createdAt?: string;
  lastModified?: string;
  author?: string;
  size: { width?: number; height?: number };
  titleBlocks: OutlineBlock[];
  blocks: PageBlock[];
  /** Earlier versions of this page, newest first (only with ConvertOptions.includeVersions). */
  versions?: PageVersion[];
}

/**
 * One entry of OneNote's page version history. The page manifest's
 * VersionHistoryGraphSpaceContextNodes names a context whose root is
 * VersionHistoryContent; its VersionProxy children each name another context
 * whose current revision is the historical page.
 */
export interface PageVersion {
  /** The version's context id inside the page object space. */
  id: string;
  createdAt?: string;
  modifiedAt?: string;
  author?: string;
  page: Page;
}

export interface NotebookJson {
  format: "onenote-revision-store";
  source: {
    fileKind: string;
    guidFile: string;
    fileFormatVersion: { lastWriter: string; oldestWriter: string; newestWriter: string; oldestReader: string };
    byteLength: number;
    objectSpaces: number;
    embeddedFiles: number;
  };
  section: {
    id: string | null;
    /**
     * Password protected in OneNote: encrypted object spaces
     * (ObjectDataEncryptionKeyV2FNDX) or IsEncrypted on the section. Their
     * pages are not decrypted or converted (file-format.md §15.5).
     */
    encrypted?: boolean;
    name?: string;
    entityGuid?: string;
    createdAt?: string;
    color?: string;
    pages: Page[];
  };
  diagnostics: {
    warnings: string[];
    encryptedObjectSpaces: string[];
    /** Present when resolveFileData is set: file data objects asked for and found. */
    fileDataLookups?: { requested: number; resolved: number };
  };
}

export interface FileDataQuery {
  /** The PictureContainer14 / EmbeddedFileContainer declaration. */
  containerId: string;
  /** The image node's UnverifiedHash as lowercase hex, when it has one. */
  unverifiedHash?: string;
  extension?: string;
}

export type FileDataResolver = (query: FileDataQuery) => { bytes: Uint8Array; source: string } | undefined;

export interface ConvertOptions {
  /** Called once per embedded image / attachment; return a reference to store in the JSON. */
  onAsset?: (asset: { id: string; bytes: Uint8Array; extension?: string; mediaType: string }) => string | undefined;
  /**
   * Supplies bytes the .one file declares but does not carry (<invfdo>), e.g.
   * OneNoteCache.resolver() from cache.ts. Not consulted for <file> references.
   */
  resolveFileData?: FileDataResolver;
  sectionName?: string;
  /** Also convert each page's version history into Page.versions. */
  includeVersions?: boolean;
}

// --- property helpers ----------------------------------------------------------

const HALF_INCH_PT = 36;

class Props {
  private readonly byId = new Map<number, Property>();
  constructor(set: PropertySet | null) {
    for (const p of set?.properties ?? []) this.byId.set(p.id, p);
  }
  has(id: number): boolean {
    return this.byId.has(id);
  }
  get(id: number): Property | undefined {
    return this.byId.get(id);
  }
  bytes(id: number): Uint8Array | undefined {
    const v = this.byId.get(id)?.value;
    return v?.kind === "bytes" ? v.value : undefined;
  }
  bool(id: number): boolean | undefined {
    const v = this.byId.get(id)?.value;
    return v?.kind === "bool" ? v.value : undefined;
  }
  u32(id: number): number | undefined {
    const b = this.bytes(id);
    if (!b) return undefined;
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    if (b.length >= 4) return dv.getUint32(0, true);
    if (b.length === 2) return dv.getUint16(0, true);
    if (b.length === 1) return b[0];
    return undefined;
  }
  f32(id: number): number | undefined {
    const b = this.bytes(id);
    if (!b || b.length < 4) return undefined;
    return new DataView(b.buffer, b.byteOffset, 4).getFloat32(0, true);
  }
  str(id: number): string | undefined {
    const b = this.bytes(id);
    return b ? utf16le(b) : undefined;
  }
  oids(id: number): ExtendedGuid[] {
    const v = this.byId.get(id)?.value;
    return v?.kind === "oids" ? v.value.filter((x): x is ExtendedGuid => x !== null) : [];
  }
  osids(id: number): ExtendedGuid[] {
    const v = this.byId.get(id)?.value;
    return v?.kind === "osids" ? v.value.filter((x): x is ExtendedGuid => x !== null) : [];
  }
  all(): Property[] {
    return [...this.byId.values()];
  }
}

const round = (n: number) => Math.round(n * 100) / 100;
const halfInches = (v: number | undefined) => (v === undefined || !Number.isFinite(v) ? undefined : round(v * HALF_INCH_PT));

function colorRef(v: number | undefined): string | undefined {
  // COLORREF 0x00BBGGRR; 0xFFFFFFFF means "automatic".
  if (v === undefined || v === 0xffffffff || (v >>> 24) === 0xff) return undefined;
  const r = v & 0xff, g = (v >>> 8) & 0xff, b = (v >>> 16) & 0xff;
  return `#${[r, g, b].map((x) => x.toString(16).padStart(2, "0")).join("")}`;
}

function time32(v: number | undefined): string | undefined {
  // Seconds since 1980-01-01T00:00:00Z.
  if (!v) return undefined;
  return new Date(Date.UTC(1980, 0, 1) + v * 1000).toISOString();
}

function fileTime(b: Uint8Array | undefined): string | undefined {
  // 100ns ticks since 1601-01-01T00:00:00Z.
  if (!b || b.length !== 8) return undefined;
  const ticks = new DataView(b.buffer, b.byteOffset, 8).getBigUint64(0, true);
  if (ticks === 0n) return undefined;
  const ms = Number(ticks / 10000n) - 11644473600000;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

export function sniffMediaType(b: Uint8Array, extension?: string): string {
  const starts = (...sig: number[]) => sig.every((x, i) => b[i] === x);
  if (starts(0x89, 0x50, 0x4e, 0x47)) return "image/png";
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (starts(0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (starts(0x42, 0x4d)) return "image/bmp";
  if (starts(0x25, 0x50, 0x44, 0x46)) return "application/pdf";
  if (starts(0x52, 0x49, 0x46, 0x46) && b[8] === 0x57 && b[9] === 0x45) return "image/webp";
  if (starts(0x01, 0x00, 0x00, 0x00) && b[40] === 0x20 && b[41] === 0x45) return "image/emf";
  if (starts(0xd7, 0xcd, 0xc6, 0x9a)) return "image/wmf";
  if (starts(0x50, 0x4b, 0x03, 0x04)) return "application/zip";
  if (starts(0x49, 0x49, 0x2a, 0x00) || starts(0x4d, 0x4d, 0x00, 0x2a)) return "image/tiff";
  // Audio and video: recordings and attached media (file-format.md §15.6).
  const tag = (at: number, s: string) => [...s].every((c, i) => b[at + i] === c.charCodeAt(0));
  if (tag(4, "ftyp")) {
    if (tag(8, "M4A ") || tag(8, "M4B ")) return "audio/mp4";
    if (tag(8, "qt  ")) return "video/quicktime";
    if (tag(8, "3gp") || tag(8, "3g2")) return "video/3gpp";
    return "video/mp4";
  }
  if (starts(0x52, 0x49, 0x46, 0x46) && tag(8, "WAVE")) return "audio/wav";
  if (starts(0x52, 0x49, 0x46, 0x46) && tag(8, "AVI ")) return "video/x-msvideo";
  if (tag(0, "ID3")) return "audio/mpeg";
  if (tag(0, "OggS")) return "audio/ogg";
  if (tag(0, "fLaC")) return "audio/flac";
  if (tag(0, "caff")) return "audio/x-caf";
  if (tag(0, "#!AMR")) return "audio/amr";
  if (starts(0x1a, 0x45, 0xdf, 0xa3)) return "video/webm";
  if (starts(0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11)) {
    const ext = extension?.replace(/^\./, "").toLowerCase();
    return ext === "wma" ? "audio/x-ms-wma" : ext === "wmv" ? "video/x-ms-wmv" : "video/x-ms-asf";
  }
  if (b[0] === 0xff && ((b[1] ?? 0) & 0xf6) === 0xf0) return "audio/aac";
  if (b[0] === 0xff && ((b[1] ?? 0) & 0xe0) === 0xe0) return "audio/mpeg";
  if (extension) return `application/x-${extension.replace(/^\./, "")}`;
  return "application/octet-stream";
}

/** Strip undefined fields so the JSON stays compact. */
function compact<T extends object>(o: T): T {
  for (const k of Object.keys(o) as (keyof T)[]) if (o[k] === undefined) delete o[k];
  return o;
}

// --- crop, printouts, Ink to Shape, equations, embeds (file-format.md §15) -------

// [X, Y, width, height]. The 0x12xx family is the one OneNote for Mac reads and
// writes; the Deprecated_ family is read when the current one is absent.
const CROP_CURRENT = ["ImageCroppedTopLeftXPercentage", "ImageCroppedTopLeftYPercentage", "ImageCroppedWidthPercentage", "ImageCroppedHeightPercentage"].map((n) => Prop[n]!);
const CROP_DEPRECATED = ["Deprecated_ImageCroppedTopLeftXPercentage", "Deprecated_ImageCroppedTopLeftYPercentage", "Deprecated_ImageCroppedWidthPercentage", "Deprecated_ImageCroppedHeightPercentage"].map((n) => Prop[n]!);
const clamp100 = (v: number) => Math.min(100, Math.max(0, v));

/**
 * The crop rectangle in percent of the original picture. OneNote stores
 * float32 fractions with an uncropped default of {0, 0, 1, 1}; a rectangle
 * with any value above 1 is taken as already in percent. No crop → undefined.
 */
function imageCrop(p: Props): ImageCrop | undefined {
  const ids = [CROP_CURRENT, CROP_DEPRECATED].find((set) => set.some((id) => p.has(id)));
  if (!ids) return undefined;
  const v = ids.map((id) => p.f32(id));
  const given = v.filter((n) => n !== undefined);
  if (!given.every(Number.isFinite)) return undefined;
  const scale = given.some((n) => n > 1.001) ? 1 : 100;
  // A missing value keeps the uncropped default: left/top 0, width/height the whole picture.
  const pct = (n: number | undefined, full: number) => (n === undefined ? full : clamp100(n * scale));
  const x = round(pct(v[0], 0));
  const y = round(pct(v[1], 0));
  const width = round(Math.min(pct(v[2], 100), 100 - x));
  const height = round(Math.min(pct(v[3], 100), 100 - y));
  if (!(width > 0 && height > 0) || (x === 0 && y === 0 && width >= 100 && height >= 100)) return undefined;
  return { topLeftXPercentage: x, topLeftYPercentage: y, widthPercentage: width, heightPercentage: height };
}

function printoutInfo(p: Props): PrintoutInfo | undefined {
  const isPage = p.bool(Prop.IsPrintoutPage!) === true;
  const split = p.bool(Prop.IsPartOfSplitPrintout!) === true;
  if (!isPage && !split) return undefined;
  return compact({
    page: p.u32(Prop.OriginalPageNumber!) || p.u32(Prop.DisplayedPageNumber!) || undefined,
    splitPart: split || undefined,
    outOfDate: p.bool(Prop.PrintoutOutOfDate!) || undefined,
  });
}

function embedInfo(p: Props): EmbedInfo | undefined {
  const url = p.str(Prop.IFrameOriginUrl!);
  const mediaType = p.u32(Prop.IFrameMediaType!);
  const title = p.str(Prop.IFrameContentTitle!);
  if (url === undefined && mediaType === undefined && title === undefined) return undefined;
  return compact({ url, mediaType, title });
}

const INK_SHAPES = [
  ["shape2d", "InkShape2DInfo", "InkShape2DInfoModifiedProxy"],
  ["line", "InkLineShapeInfo", "InkLineShapeInfoModifiedProxy"],
] as const;

/** InkShape2DInfo / InkLineShapeInfo on an ink object, undecoded. */
function inkShape(p: Props): InkShapeInfo | undefined {
  for (const [source, info, proxy] of INK_SHAPES) {
    const b = p.bytes(Prop[info]!);
    if (b) return compact({ source, byteLength: b.length, data: hex(b.subarray(0, 256)), modifiedProxy: p.u32(Prop[proxy]!) });
  }
  return undefined;
}

/** MathData_* on a run's formatting: present when MathData_Type is. */
function mathObject(p: Props): MathObject | undefined {
  const type = p.u32(Prop.MathData_Type!);
  if (type === undefined) return undefined;
  return compact({
    type,
    args: p.u32(Prop.MathData_cArg!),
    char: p.u32(Prop.MathData_Char!),
    char1: p.u32(Prop.MathData_Char1!),
    char2: p.u32(Prop.MathData_Char2!),
    align: p.u32(Prop.MathData_Align!),
    columns: p.u32(Prop.MathData_cCol!),
    texStyle: p.u32(Prop.MathData_TeXStyle!),
    fontAlign: p.u32(Prop.MathData_FontAlign!),
  });
}

// --- converter -----------------------------------------------------------------

interface Ctx {
  space: ObjectSpace;
  rev: Revision;
  depth: number;
}

const MAX_DEPTH = 64;

export class NotebookConverter {
  private readonly store: OneStore;
  private readonly opts: ConvertOptions;
  private lookups = { requested: 0, resolved: 0 };

  constructor(store: OneStore, opts: ConvertOptions = {}) {
    this.store = store;
    this.opts = opts;
  }

  convert(): NotebookJson {
    const s = this.store;
    const h = s.header;
    const ffv = (v: number) => `0x${v.toString(16)}`;
    const out: NotebookJson = {
      format: "onenote-revision-store",
      source: {
        fileKind: h.fileKind,
        guidFile: h.guidFile,
        fileFormatVersion: {
          lastWriter: ffv(h.ffvLastCodeThatWroteToThisFile),
          oldestWriter: ffv(h.ffvOldestCodeThatHasWrittenToThisFile),
          newestWriter: ffv(h.ffvNewestCodeThatHasWrittenToThisFile),
          oldestReader: ffv(h.ffvOldestCodeThatMayReadThisFile),
        },
        byteLength: s.buf.length,
        objectSpaces: s.objectSpaces.size,
        embeddedFiles: s.fileData.size,
      },
      // `encrypted` is declared here so that it serializes after `id` whenever it is set.
      section: { id: s.rootGosid ? egKey(s.rootGosid) : null, encrypted: undefined, pages: [] },
      diagnostics: { warnings: s.warnings, encryptedObjectSpaces: [] },
    };
    // Password-protected sections (file-format.md §15.5): detected, never decrypted.
    for (const sp of s.objectSpaces.values()) if (sp.encrypted) out.diagnostics.encryptedObjectSpaces.push(egKey(sp.gosid));
    const nEncrypted = out.diagnostics.encryptedObjectSpaces.length;
    if (nEncrypted) {
      out.section.encrypted = true;
      s.warnings.push(`password-protected section: ${nEncrypted} of ${s.objectSpaces.size} object spaces are encrypted (ObjectDataEncryptionKeyV2FNDX) and were not converted`);
    }
    if (this.opts.resolveFileData) out.diagnostics.fileDataLookups = this.lookups = { requested: 0, resolved: 0 };
    if (this.opts.sectionName) out.section.name = this.opts.sectionName;

    const root = s.rootGosid ? s.objectSpaces.get(egKey(s.rootGosid)) : undefined;
    if (!root) {
      s.warnings.push("no root object space");
      return out;
    }
    // The section node itself is encrypted: nothing below it can be read.
    if (root.encrypted) return out;
    const rev = s.currentRevision(root, RootRole.DefaultContent);
    const rootOid = rev && s.rootObject(root, rev, RootRole.DefaultContent);
    const sectionNode = rev && rootOid ? s.findObject(rev, rootOid, root) : undefined;
    if (!rev || !sectionNode) {
      s.warnings.push("root object space has no current default-content root object");
      return out;
    }
    if (sectionNode.jcid.raw !== Jcid.SectionNode) {
      s.warnings.push(`root object is ${jcidName(sectionNode.jcid.raw)}, not SectionNode (is this a .onetoc2?)`);
      return out;
    }
    const ctx: Ctx = { space: root, rev, depth: 0 };
    const sp = this.props(sectionNode);
    // Section metadata root, when present, carries the display name and the color.
    const metaRev = s.currentRevision(root, RootRole.Metadata) ?? rev;
    const metaOid = s.rootObject(root, metaRev, RootRole.Metadata);
    const meta = metaOid ? s.findObject(metaRev, metaOid, root) : undefined;
    const mp = this.props(meta);

    out.section.entityGuid = sp.str(Prop.NotebookManagementEntityGuid!);
    out.section.createdAt = fileTime(sp.bytes(Prop.TopologyCreationTimeStamp!));
    // NotebookColor is on SectionMetaData in OneNote's files ([MS-ONE]); the
    // section node and the deprecated property are fallbacks.
    out.section.color =
      colorRef(mp.u32(Prop.NotebookColor!)) ??
      colorRef(sp.u32(Prop.NotebookColor!)) ??
      colorRef(mp.u32(Prop.Deprecated_SectionColor!)) ??
      colorRef(sp.u32(Prop.Deprecated_SectionColor!));

    const displayName = meta ? mp.str(Prop.SectionDisplayName!) : undefined;
    if (displayName) out.section.name = displayName;
    // OneNote's own flags for protected content, on the section or its metadata.
    const flag = (id: number) => sp.bool(id) === true || mp.bool(id) === true;
    if (flag(Prop.IsEncrypted!) || flag(Prop.IsSomeEncryptedContentUnavailable!)) {
      out.section.encrypted = true;
      s.warnings.push(`password-protected section: the section is marked ${flag(Prop.IsEncrypted!) ? "IsEncrypted" : "IsSomeEncryptedContentUnavailable"}`);
    }

    for (const seriesOid of sp.oids(Prop.ElementChildNodes!)) {
      const series = this.resolve(ctx, seriesOid);
      if (!series || series.jcid.raw !== Jcid.PageSeriesNode) continue;
      const ps = this.props(series);
      const metas = ps.oids(Prop.MetaDataObjectsAboveGraphSpace!).map((o) => this.resolve(ctx, o));
      ps.osids(Prop.ChildGraphSpaceElementNodes!).forEach((gosid, i) => {
        const page = this.convertPage(gosid, metas[i]);
        if (page) out.section.pages.push(page);
      });
    }
    compact(out.section);
    return out;
  }

  private props(decl: ObjectDeclaration | undefined): Props {
    return new Props(decl ? this.store.propertySet(decl) : null);
  }

  private resolve(ctx: Ctx, oid: ExtendedGuid): ObjectDeclaration | undefined {
    if (isNilEg(oid)) return undefined;
    return this.store.findObject(ctx.rev, oid, ctx.space);
  }

  private authorName(ctx: Ctx, oids: ExtendedGuid[]): string | undefined {
    const a = oids[0] && this.resolve(ctx, oids[0]);
    return a ? this.props(a).str(Prop.Author!) : undefined;
  }

  /** `at` converts a specific revision (a historical version) instead of the current one. */
  private convertPage(gosid: ExtendedGuid, seriesMeta: ObjectDeclaration | undefined, at?: Revision): Page | null {
    const s = this.store;
    const space = s.objectSpaces.get(egKey(gosid));
    if (!space) {
      s.warnings.push(`page object space ${egKey(gosid)} missing`);
      return null;
    }
    if (space.encrypted) return null;
    const rev = at ?? s.currentRevision(space, RootRole.DefaultContent);
    if (!rev) return null;
    const ctx: Ctx = { space, rev, depth: 0 };

    const metaRev = at ?? s.currentRevision(space, RootRole.Metadata) ?? rev;
    const metaOid = s.rootObject(space, metaRev, RootRole.Metadata);
    const metaDecl = metaOid ? s.findObject(metaRev, metaOid, space) : undefined;
    const meta = this.props(metaDecl ?? seriesMeta);

    const manifestOid = s.rootObject(space, rev, RootRole.DefaultContent);
    const manifest = manifestOid ? this.resolve(ctx, manifestOid) : undefined;
    const pageDecl = this.props(manifest)
      .oids(Prop.ContentChildNodes!)
      .map((o) => this.resolve(ctx, o))
      .find((d) => d?.jcid.raw === Jcid.PageNode);
    const pp = this.props(pageDecl);

    const page: Page = {
      id: egKey(gosid),
      title: meta.str(Prop.CachedTitleString!) ?? pp.str(Prop.CachedTitleString!) ?? "",
      level: meta.u32(Prop.PageLevel!),
      createdAt: fileTime(meta.bytes(Prop.TopologyCreationTimeStamp!)) ?? time32(pp.u32(Prop.CreationTimeStamp!)),
      lastModified: time32(pp.u32(Prop.LastModifiedTime!)) ?? fileTime(pp.bytes(Prop.LastModifiedTimeStamp!)),
      author: pp.str(Prop.Author!) ?? this.authorName(ctx, pp.oids(Prop.AuthorOriginal!)),
      size: compact({ width: halfInches(pp.f32(Prop.PageWidth!)), height: halfInches(pp.f32(Prop.PageHeight!)) }),
      titleBlocks: [],
      blocks: [],
    };

    for (const titleOid of pp.oids(Prop.StructureElementChildNodes!)) {
      const title = this.resolve(ctx, titleOid);
      if (title?.jcid.raw !== Jcid.TitleNode) continue;
      for (const o of this.props(title).oids(Prop.ElementChildNodes!)) {
        const b = this.convertPageChild(ctx, o);
        if (b?.type === "outline") page.titleBlocks.push(b);
      }
    }
    // No cached title: the title outline's text, never OneNote's date/time line under it.
    if (!page.title) {
      page.title = page.titleBlocks
        .filter((b) => b.role !== "titleDate" && b.role !== "titleTime")
        .map((b) => plainText(b.children))
        .join(" ")
        .trim();
    }

    for (const o of pp.oids(Prop.ElementChildNodes!)) {
      const b = this.convertPageChild(ctx, o);
      if (b) page.blocks.push(b);
    }
    if (this.opts.includeVersions && !at) {
      const versions = this.pageVersions(gosid, space, this.props(manifest));
      if (versions.length) page.versions = versions;
    }
    return compact(page);
  }

  /** Walk VersionHistoryGraphSpaceContextNodes → VersionHistoryContent → VersionProxy → historical revision. */
  private pageVersions(gosid: ExtendedGuid, space: ObjectSpace, manifest: Props): PageVersion[] {
    const s = this.store;
    const contexts = (p: Props) => {
      const v = p.get(Prop.VersionHistoryGraphSpaceContextNodes!)?.value;
      return v?.kind === "contextIds" ? v.value.filter((x): x is ExtendedGuid => x !== null) : [];
    };
    const out: PageVersion[] = [];
    const seen = new Set<string>();
    for (const historyCtx of contexts(manifest)) {
      const hrev = s.currentRevision(space, RootRole.DefaultContent, historyCtx);
      const hroot = hrev && s.rootObject(space, hrev, RootRole.DefaultContent);
      const content = hrev && hroot ? s.findObject(hrev, hroot, space) : undefined;
      if (!hrev || content?.jcid.raw !== Jcid.VersionHistoryContent) continue;
      const hctx: Ctx = { space, rev: hrev, depth: 0 };
      for (const proxyOid of this.props(content).oids(Prop.ElementChildNodes!)) {
        const proxy = this.resolve(hctx, proxyOid);
        if (proxy?.jcid.raw !== Jcid.VersionProxy) continue;
        const pp = this.props(proxy);
        for (const versionCtx of contexts(pp)) {
          const key = egKey(versionCtx);
          if (seen.has(key)) continue;
          seen.add(key);
          const vrev = s.currentRevision(space, RootRole.DefaultContent, versionCtx);
          const page = vrev && this.convertPage(gosid, undefined, vrev);
          if (!page) continue;
          out.push(
            compact({
              id: key,
              createdAt: time32(pp.u32(Prop.CreationTimeStamp!)),
              modifiedAt: fileTime(pp.bytes(Prop.LastModifiedTimeStamp!)) ?? page.lastModified,
              author: this.authorName(hctx, pp.oids(Prop.AuthorMostRecent!)),
              page,
            }),
          );
        }
      }
    }
    return out.sort((a, b) => (b.modifiedAt ?? "").localeCompare(a.modifiedAt ?? ""));
  }

  private convertPageChild(ctx: Ctx, oid: ExtendedGuid): PageBlock | null {
    const decl = this.resolve(ctx, oid);
    if (!decl) return null;
    switch (decl.jcid.raw) {
      case Jcid.OutlineNode: return this.convertOutline(ctx, decl);
      case Jcid.ImageNode: return this.convertImage(ctx, decl);
      case Jcid.EmbeddedFileNode: return this.convertEmbeddedFile(ctx, decl);
      default: return this.isInk(decl) ? this.convertInk(ctx, decl, false) : this.unknown(decl);
    }
  }

  // --- ink (file-format.md §13) ------------------------------------------------

  /** An ink container by JCID, or by shape: it points at ink data or holds ink groups. */
  private isInk(decl: ObjectDeclaration): boolean {
    if (decl.jcid.raw === Jcid.InkContainer) return true;
    const p = this.props(decl);
    return p.has(Prop.InkData!) || p.has(Prop.InkStrokes!);
  }

  private convertInk(ctx: Ctx, decl: ObjectDeclaration, embedded: boolean): InkBlock {
    const strokes: InkStroke[] = [];
    let box: [number, number, number, number] | undefined;
    const walk = (d: ObjectDeclaration, ox: number, oy: number, depth: number) => {
      if (depth > 16) return;
      const p = this.props(d);
      // Page ink is placed by the container's offset; groups nest offsets.
      const x = ox + (embedded ? 0 : (halfInches(p.f32(Prop.OffsetFromParentHoriz!)) ?? 0));
      const y = oy + (embedded ? 0 : (halfInches(p.f32(Prop.OffsetFromParentVert!)) ?? 0));
      const sx = p.f32(Prop.InkScalingX!) ?? 1;
      const sy = p.f32(Prop.InkScalingY!) ?? 1;
      // The container itself may be the data node (InkStrokes directly on it).
      const data = p.has(Prop.InkStrokes!) ? d : p.oids(Prop.InkData!).map((o) => this.resolve(ctx, o)).find(Boolean);
      if (data) {
        const dp = this.props(data);
        const bb = decodeBoundingBox(dp.bytes(Prop.InkBoundingBox!));
        if (bb && !box) box = [bb[0] * sx * HIMETRIC_PT + x, bb[1] * sy * HIMETRIC_PT + y, bb[2] * sx * HIMETRIC_PT + x, bb[3] * sy * HIMETRIC_PT + y];
        // Ink to Shape info on the stroke wins; else the data node's or container's applies.
        const shape = inkShape(dp) ?? inkShape(p);
        for (const so of dp.oids(Prop.InkStrokes!)) {
          const sd = this.resolve(ctx, so);
          const stroke = sd && this.convertStroke(ctx, sd, sx, sy, x, y, shape);
          if (stroke) strokes.push(stroke);
        }
      }
      for (const co of p.oids(Prop.ContentChildNodes!)) {
        const cd = this.resolve(ctx, co);
        if (cd && this.isInk(cd)) walk(cd, x, y, depth + 1);
      }
    };
    walk(decl, 0, 0, 0);
    const all = strokes.flatMap((s) => s.points);
    let bounds = pointBounds(all);
    if (embedded) {
      // Strokes flow with the text: make them relative to the ink's own box.
      const ox = box ? Math.min(box[0], bounds?.x ?? box[0]) : (bounds?.x ?? 0);
      const oy = box ? Math.min(box[1], bounds?.y ?? box[1]) : (bounds?.y ?? 0);
      for (const st of strokes) st.points = st.points.map((v, i) => round(v - (i % 2 ? oy : ox)));
      bounds = pointBounds(strokes.flatMap((st) => st.points));
      if (bounds) bounds = { x: 0, y: 0, width: round(bounds.x + bounds.width), height: round(bounds.y + bounds.height) };
    }
    return compact({ type: "ink" as const, id: egKey(decl.oid), embedded: embedded || undefined, bounds, strokes });
  }

  private convertStroke(ctx: Ctx, decl: ObjectDeclaration, sx: number, sy: number, x: number, y: number, shape?: InkShapeInfo): InkStroke | null {
    const p = this.props(decl);
    const path = p.bytes(Prop.InkPath!);
    if (!path) return null;
    const propsDecl = p.oids(Prop.InkStrokeProperties!).map((o) => this.resolve(ctx, o)).find(Boolean);
    const sp = this.props(propsDecl);
    const raw = strokePoints(decodeInkPath(path), decodeInkDimensions(sp.bytes(Prop.InkDimensions!)), sx, sy);
    if (!raw.length) return null;
    const points = raw.map((v, i) => round(v * HIMETRIC_PT + (i % 2 ? y : x)));
    const w = sp.f32(Prop.InkWidth!);
    const h = sp.f32(Prop.InkHeight!);
    const transparency = sp.u32(Prop.InkStrokeTransparency!);
    const rop = sp.u32(Prop.InkRasterOperation!);
    const bias = p.u32(Prop.InkBias!);
    return compact({
      points,
      color: colorRef(sp.u32(Prop.InkColor!)) ?? (sp.has(Prop.InkColor!) ? "#000000" : undefined),
      width: w !== undefined && Number.isFinite(w) ? round(w * HIMETRIC_PT) : undefined,
      height: h !== undefined && Number.isFinite(h) ? round(h * HIMETRIC_PT) : undefined,
      transparency: transparency || undefined,
      // R2_MASKPEN (9) is how Windows Ink draws highlighters; OneNote's are also translucent.
      highlighter: rop === 9 || (transparency ?? 0) >= 64 || undefined,
      penTip: sp.u32(Prop.InkPenTipShape!) || undefined,
      bias: bias === 0 ? "handwriting" : bias === 1 ? "drawing" : bias === 2 ? "both" : undefined,
      shape: inkShape(p) ?? shape,
    } satisfies InkStroke);
  }

  private layout(p: Props): Layout {
    return compact({
      x: halfInches(p.f32(Prop.OffsetFromParentHoriz!)),
      y: halfInches(p.f32(Prop.OffsetFromParentVert!)),
      width: halfInches(p.f32(Prop.LayoutMaxWidth!)),
      height: halfInches(p.f32(Prop.LayoutMaxHeight!)),
    });
  }

  private convertOutline(ctx: Ctx, decl: ObjectDeclaration): OutlineBlock {
    const p = this.props(decl);
    const out: OutlineBlock = {
      type: "outline",
      id: egKey(decl.oid),
      layout: this.layout(p),
      role: p.bool(Prop.IsTitleText!) ? "titleText" : p.bool(Prop.IsTitleDate!) ? "titleDate" : p.bool(Prop.IsTitleTime!) ? "titleTime" : undefined,
      children: this.convertElements(ctx, p.oids(Prop.ElementChildNodes!)),
    };
    return compact(out);
  }

  private convertElements(ctx: Ctx, oids: ExtendedGuid[]): OutlineElementBlock[] {
    if (ctx.depth > MAX_DEPTH) return [];
    const inner: Ctx = { ...ctx, depth: ctx.depth + 1 };
    const out: OutlineElementBlock[] = [];
    for (const oid of oids) {
      const d = this.resolve(inner, oid);
      if (!d) continue;
      if (d.jcid.raw === Jcid.OutlineElementNode) out.push(this.convertElement(inner, d));
      else if (d.jcid.raw === Jcid.OutlineGroup) {
        // Groups only bundle siblings; flatten them into the parent.
        out.push(...this.convertElements(inner, this.props(d).oids(Prop.ElementChildNodes!)));
      }
    }
    return out;
  }

  private convertElement(ctx: Ctx, decl: ObjectDeclaration): OutlineElementBlock {
    const p = this.props(decl);
    const el: OutlineElementBlock = {
      type: "outlineElement",
      id: egKey(decl.oid),
      level: p.u32(Prop.OutlineElementChildLevel!),
      createdAt: time32(p.u32(Prop.CreationTimeStamp!)),
      lastModified: time32(p.u32(Prop.LastModifiedTime!)),
      content: [],
      children: this.convertElements(ctx, p.oids(Prop.ElementChildNodes!)),
    };
    const listDecl = p.oids(Prop.ListNodes!).map((o) => this.resolve(ctx, o)).find(Boolean);
    if (listDecl) el.list = this.convertList(listDecl);
    // NoteTagStates can sit on the outline element or (in OneNote for Mac's
    // files, always) on its RichTextOENode content.
    const tags = this.convertNoteTags(ctx, p);
    for (const o of p.oids(Prop.ContentChildNodes!)) {
      const d = this.resolve(ctx, o);
      if (d?.jcid.raw === Jcid.RichTextOENode) tags.push(...this.convertNoteTags(ctx, this.props(d)));
      const c = this.convertContent(ctx, o);
      if (c) el.content.push(c);
    }
    if (tags.length) el.tags = tags;
    return compact(el);
  }

  private convertContent(ctx: Ctx, oid: ExtendedGuid): ContentBlock | null {
    const d = this.resolve(ctx, oid);
    if (!d) return null;
    switch (d.jcid.raw) {
      case Jcid.RichTextOENode: return this.convertRichText(ctx, d);
      case Jcid.ImageNode: return this.convertImage(ctx, d);
      case Jcid.TableNode: return this.convertTable(ctx, d);
      case Jcid.EmbeddedFileNode: return this.convertEmbeddedFile(ctx, d);
      default: return this.isInk(d) ? this.convertInk(ctx, d, true) : this.unknown(d);
    }
  }

  private convertList(decl: ObjectDeclaration): ListInfo {
    const p = this.props(decl);
    // NumberListFormat is length-prefixed: [cch][chars...]. Numbered formats put
    // a U+FFFD placeholder followed by the MSONFC scheme code between prefix and suffix.
    let chars = [...(p.str(Prop.NumberListFormat!) ?? "")];
    if (chars.length && chars[0]!.charCodeAt(0) === chars.length - 1) chars = chars.slice(1);
    const font = p.str(Prop.ListFont!) ?? p.str(Prop.Font!);
    const restart = p.u32(Prop.ListRestart!);
    const ph = chars.indexOf("\ufffd");
    if (ph === -1) return compact({ kind: "bullet", bullet: chars.join(""), font, restart } as ListInfo);
    const code = chars[ph + 1]?.charCodeAt(0) ?? 0;
    return compact({
      kind: "numbered",
      scheme: NUMBER_SCHEMES[code] ?? `msonfc_${code}`,
      prefix: chars.slice(0, ph).join("") || undefined,
      suffix: chars.slice(ph + 2).join("") || undefined,
      restart,
      font,
    } as ListInfo);
  }

  private convertNoteTags(ctx: Ctx, p: Props): NoteTag[] {
    const v = p.get(Prop.NoteTagStates!)?.value;
    if (v?.kind !== "propertyValues") return [];
    return v.value.map((set) => {
      const tp = new Props(set);
      const defOid = tp.oids(Prop.NoteTagDefinitionOid!)[0];
      const def = this.props(defOid ? this.resolve(ctx, defOid) : undefined);
      const status = tp.u32(Prop.ActionItemStatus!);
      return compact({
        label: def.str(Prop.NoteTagLabel!),
        shape: def.u32(Prop.NoteTagShape!),
        actionItemType: def.u32(Prop.ActionItemType!),
        highlightColor: colorRef(def.u32(Prop.NoteTagHighlightColor!)),
        textColor: colorRef(def.u32(Prop.NoteTagTextColor!)),
        completed: status === undefined ? undefined : (status & 0x1) === 1,
        createdAt: time32(tp.u32(Prop.NoteTagCreated!)),
        completedAt: time32(tp.u32(Prop.NoteTagCompleted!)),
      } as NoteTag);
    });
  }

  private textStyle(p: Props): TextStyle {
    const size = p.u32(Prop.FontSize!);
    return compact({
      font: p.str(Prop.Font!),
      fontSize: size ? size / 2 : undefined,
      color: colorRef(p.u32(Prop.FontColor!)),
      highlight: colorRef(p.u32(Prop.Highlight!)),
      bold: p.bool(Prop.Bold!) || undefined,
      italic: p.bool(Prop.Italic!) || undefined,
      underline: p.bool(Prop.Underline!) || undefined,
      strikethrough: p.bool(Prop.Strikethrough!) || undefined,
      superscript: p.bool(Prop.Superscript!) || undefined,
      subscript: p.bool(Prop.Subscript!) || undefined,
      hidden: p.bool(Prop.Hidden!) || undefined,
      math: p.bool(Prop.MathFormatting!) || undefined,
      mathOrdinary: p.bool(Prop.MathOrdinary!) || undefined,
      mathNoBuildup: p.bool(Prop.MathNoBuildup!) || undefined,
      mathObject: mathObject(p),
      languageId: p.u32(Prop.LanguageID!),
      styleId: p.str(Prop.ParagraphStyleId!),
    });
  }

  private convertRichText(ctx: Ctx, decl: ObjectDeclaration): RichTextBlock {
    const p = this.props(decl);
    const ascii = p.bytes(Prop.TextExtendedAscii!);
    const raw = p.str(Prop.RichEditTextUnicode!) ?? (ascii ? latin1(ascii) : "");

    const paraDecl = p.oids(Prop.ParagraphStyle!).map((o) => this.resolve(ctx, o)).find(Boolean);
    const paraProps = this.props(paraDecl);
    const alignment = p.u32(Prop.ParagraphAlignment!) ?? paraProps.u32(Prop.ParagraphAlignment!);
    const paragraph: RichTextBlock["paragraph"] = compact({
      ...this.textStyle(paraProps),
      alignment: alignment === 1 ? "center" : alignment === 2 ? "right" : alignment === 0 ? "left" : undefined,
      spaceBefore: halfInches(p.f32(Prop.ParagraphSpaceBefore!) ?? paraProps.f32(Prop.ParagraphSpaceBefore!)),
      spaceAfter: halfInches(p.f32(Prop.ParagraphSpaceAfter!) ?? paraProps.f32(Prop.ParagraphSpaceAfter!)),
      lineSpacing: halfInches(p.f32(Prop.ParagraphLineSpacingExact!) ?? paraProps.f32(Prop.ParagraphLineSpacingExact!)),
      rtl: p.bool(Prop.ReadingOrderRTL!) || undefined,
    });

    // TextRunIndex holds run end offsets; TextRunFormatting holds one style per run.
    const idxBytes = p.bytes(Prop.TextRunIndex!);
    const ends: number[] = [];
    if (idxBytes) {
      const dv = new DataView(idxBytes.buffer, idxBytes.byteOffset, idxBytes.byteLength);
      for (let i = 0; i + 4 <= idxBytes.length; i += 4) ends.push(dv.getUint32(i, true));
    }
    const styleProps = p.oids(Prop.TextRunFormatting!).map((o) => this.props(this.resolve(ctx, o)));
    const styles = styleProps.map((sp) => this.textStyle(sp));
    const isLink = styleProps.map((sp) => sp.bool(Prop.Hyperlink!) === true);
    const bounds = [0, ...ends.filter((e) => e > 0 && e < raw.length), raw.length];
    const runs: TextRun[] = [];
    let text = "";
    let href: string | undefined;
    for (let i = 0; i + 1 < bounds.length; i++) {
      let piece = raw.slice(bounds[i], bounds[i + 1]);
      if (!piece) continue;
      const style = styles[i] ?? {};
      // Hyperlinks are stored inline as a hidden field code: ﷟HYPERLINK "url"
      const m = /﷟HYPERLINK "([^"]*)"/.exec(piece);
      if (m) {
        href = m[1];
        piece = piece.replace(m[0], "");
      } else if (!isLink[i]) {
        href = undefined;
      }
      if (!piece) continue;
      const start = text.length;
      text += piece;
      runs.push(compact({ start, end: text.length, text: piece, style, href }));
    }
    return { type: "richText", id: egKey(decl.oid), text, runs, paragraph };
  }

  /**
   * Bytes of a file data container: from the .one file's FileDataStore, else
   * from opts.resolveFileData (keyed by the owning node's UnverifiedHash).
   */
  private fileAsset(decl: ObjectDeclaration | undefined, unverifiedHash: string | undefined): Pick<ImageBlock, "assetStatus" | "asset"> {
    if (!decl) return { assetStatus: "missing", asset: null };
    const fdRef = decl.fileDataReference;
    const extension = decl.extension || undefined;
    let bytes = this.store.fileDataFor(decl) ?? undefined;
    let source: string | undefined;
    const resolve = this.opts.resolveFileData;
    if (!bytes && resolve && !fdRef?.startsWith("<file>")) {
      this.lookups.requested++;
      const hit = resolve({ containerId: egKey(decl.oid), unverifiedHash, extension });
      if (hit) {
        this.lookups.resolved++;
        ({ bytes, source } = hit);
      }
    }
    if (!bytes) {
      const assetStatus = fdRef?.startsWith("<invfdo>") ? "notEmbedded" : fdRef?.startsWith("<file>") ? "external" : "missing";
      return { assetStatus, asset: null };
    }
    const mediaType = sniffMediaType(bytes, extension);
    const ref = this.opts.onAsset?.({ id: egKey(decl.oid), bytes, extension, mediaType });
    return { assetStatus: "embedded", asset: compact({ byteLength: bytes.length, mediaType, extension, source, ref }) };
  }

  private convertImage(ctx: Ctx, decl: ObjectDeclaration): ImageBlock {
    const p = this.props(decl);
    const container = p.oids(Prop.PictureContainer!).map((o) => this.resolve(ctx, o)).find(Boolean);
    const layout = this.layout(p);
    const pw = halfInches(p.f32(Prop.PictureWidth!));
    const ph = halfInches(p.f32(Prop.PictureHeight!));
    if (pw !== undefined) layout.width = pw;
    if (ph !== undefined) layout.height = ph;
    const hashBytes = p.bytes(Prop.UnverifiedHash!);
    const unverifiedHash = hashBytes?.length === 20 ? hex(hashBytes) : undefined;
    return compact({
      type: "image",
      id: egKey(decl.oid),
      layout,
      altText: p.str(Prop.ImageAltText!),
      filename: p.str(Prop.ImageFilename!),
      hyperlink: p.str(Prop.WzHyperlinkUrl!),
      isBackground: p.bool(Prop.IsBackground!) || undefined,
      ocrText: p.str(Prop.RichEditTextUnicode!) || undefined,
      unverifiedHash,
      crop: imageCrop(p),
      printout: printoutInfo(p),
      embed: embedInfo(p),
      ...this.fileAsset(container, unverifiedHash),
    } as ImageBlock);
  }

  private convertEmbeddedFile(ctx: Ctx, decl: ObjectDeclaration): EmbeddedFileBlock {
    const p = this.props(decl);
    const container = p.oids(Prop.EmbeddedFileContainer!).map((o) => this.resolve(ctx, o)).find(Boolean);
    const hashBytes = p.bytes(Prop.UnverifiedHash!);
    return compact({
      type: "embeddedFile",
      id: egKey(decl.oid),
      layout: this.layout(p),
      filename: p.str(Prop.EmbeddedFileName!),
      sourcePath: p.str(Prop.SourceFilepath!),
      recording: p.has(Prop.IRecordMedia!) || p.has(Prop.AudioRecordingDuration!)
        ? compact({ media: p.u32(Prop.IRecordMedia!), duration: p.u32(Prop.AudioRecordingDuration!) })
        : undefined,
      printoutOutOfDate: p.bool(Prop.PrintoutOutOfDate!) || undefined,
      ...this.fileAsset(container, hashBytes?.length === 20 ? hex(hashBytes) : undefined),
    } as EmbeddedFileBlock);
  }

  private convertTable(ctx: Ctx, decl: ObjectDeclaration): TableBlock {
    const p = this.props(decl);
    const widths: number[] = [];
    const wb = p.bytes(Prop.TableColumnWidths!);
    if (wb && wb.length >= 1) {
      // cColumns (u8) followed by float32 widths.
      const dv = new DataView(wb.buffer, wb.byteOffset, wb.byteLength);
      for (let i = 0; i < wb[0]! && 1 + i * 4 + 4 <= wb.length; i++) widths.push(round(dv.getFloat32(1 + i * 4, true) * HALF_INCH_PT));
    }
    const inner: Ctx = { ...ctx, depth: ctx.depth + 1 };
    const rows: TableBlock["rows"] = [];
    for (const ro of p.oids(Prop.ElementChildNodes!)) {
      const row = this.resolve(inner, ro);
      if (row?.jcid.raw !== Jcid.TableRowNode) continue;
      const cells: TableBlock["rows"][number]["cells"] = [];
      for (const co of this.props(row).oids(Prop.ElementChildNodes!)) {
        const cell = this.resolve(inner, co);
        if (cell?.jcid.raw !== Jcid.TableCellNode) continue;
        const cp = this.props(cell);
        cells.push(compact({ id: egKey(cell.oid), shading: colorRef(cp.u32(Prop.CellShadingColor!)), children: this.convertElements(inner, cp.oids(Prop.ElementChildNodes!)) }));
      }
      rows.push({ id: egKey(row.oid), cells });
    }
    return compact({
      type: "table",
      id: egKey(decl.oid),
      rowCount: p.u32(Prop.RowCount!),
      columnCount: p.u32(Prop.ColumnCount!),
      columnWidths: widths,
      bordersVisible: p.bool(Prop.TableBordersVisible!),
      rows,
    } as TableBlock);
  }

  private unknown(decl: ObjectDeclaration): UnknownBlock {
    return {
      type: "unknown",
      id: egKey(decl.oid),
      jcid: `0x${decl.jcid.raw.toString(16)}`,
      jcidName: jcidName(decl.jcid.raw),
      properties: describeProperties(this.store.propertySet(decl)),
    };
  }
}

export function plainText(elements: OutlineElementBlock[]): string {
  const parts: string[] = [];
  const walk = (els: OutlineElementBlock[]) => {
    for (const e of els) {
      for (const c of e.content) if (c.type === "richText") parts.push(c.text);
      walk(e.children);
    }
  };
  walk(elements);
  return parts.join(" ");
}

// --- generic property rendering (unknown blocks and raw dumps) -------------------

const STRING_PROPS = new Set(
  ["Font", "RichEditTextUnicode", "NumberListFormat", "ListFont", "CachedTitleString", "CachedTitleStringFromPage", "Author",
    "EmbeddedFileName", "SourceFilepath", "ConflictingUserName", "ImageFilename", "ImageAltText", "ParagraphStyleId",
    "NoteTagLabel", "SectionDisplayName", "NextStyle", "WzHyperlinkUrl", "NotebookManagementEntityGuid",
    "IFrameOriginUrl", "IFrameContentTitle", "AudioRecordingFilename"].map((n) => Prop[n]!),
);

export function describeProperties(set: PropertySet | null): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of set?.properties ?? []) out[propName(p.id)] = describeValue(p);
  return out;
}

function describeValue(p: Property): unknown {
  const v = p.value;
  switch (v.kind) {
    case "none": return null;
    case "bool": return v.value;
    case "bytes": {
      const b = v.value;
      if (STRING_PROPS.has(p.id)) return utf16le(b);
      const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
      if (b.length === 1) return b[0];
      if (b.length === 2) return dv.getUint16(0, true);
      if (b.length === 4) {
        const f = dv.getFloat32(0, true);
        const u = dv.getUint32(0, true);
        // Report plausible floats as floats (layout values), everything else as integers.
        return Math.abs(f) > 1e-4 && Math.abs(f) < 1e5 && !Number.isInteger(u / 1e7) ? { u32: u, f32: round(f) } : u;
      }
      if (b.length === 8) return dv.getBigUint64(0, true).toString();
      return b.length > 64 ? { hex: hex(b.subarray(0, 64)), byteLength: b.length } : { hex: hex(b) };
    }
    case "oids":
    case "osids":
    case "contextIds": {
      const ids = v.value.map((x) => (x ? egKey(x) : null));
      return v.single ? ids[0] ?? null : ids;
    }
    case "propertyValues": return v.value.map((s) => describeProperties(s));
    case "propertySet": return describeProperties(v.value);
  }
}

// --- raw object graph dump ------------------------------------------------------

export function dumpObjectGraph(store: OneStore) {
  return {
    header: store.header,
    rootObjectSpace: store.rootGosid ? egKey(store.rootGosid) : null,
    fileData: [...store.fileData.values()],
    fileNodeListFragments: store.fragments,
    objectSpaces: [...store.objectSpaces.values()].map((sp) => ({
      gosid: egKey(sp.gosid),
      encrypted: sp.encrypted,
      roleAssignments: sp.roleAssignments.map((a) => ({ rid: egKey(a.rid), role: a.role, context: a.context ? egKey(a.context) : null })),
      revisions: [...sp.revisions.values()].map((r) => ({
        rid: egKey(r.rid),
        ridDependent: isNilEg(r.ridDependent) ? null : egKey(r.ridDependent),
        role: r.role,
        roots: Object.fromEntries([...r.roots].map(([role, oid]) => [role, egKey(oid)])),
        objects: [...r.objects.values()].map((o) => ({
          oid: egKey(o.oid),
          jcid: `0x${o.jcid.raw.toString(16)}`,
          type: jcidName(o.jcid.raw),
          declaredBy: o.declaredBy,
          ref: o.ref,
          fileDataReference: o.fileDataReference,
          properties: describeProperties(store.propertySet(o)),
        })),
      })),
    })),
    warnings: store.warnings,
  };
}

export function parseOneNote(buf: Uint8Array, opts: ConvertOptions = {}): NotebookJson {
  return new NotebookConverter(new OneStore(buf), opts).convert();
}
