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
  math?: boolean;
  languageId?: number;
  styleId?: string;
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
  assetStatus: AssetStatus;
  asset: AssetInfo | null;
}

export interface EmbeddedFileBlock {
  type: "embeddedFile";
  id: string;
  layout: Layout;
  filename?: string;
  sourcePath?: string;
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

export type ContentBlock = RichTextBlock | ImageBlock | EmbeddedFileBlock | TableBlock | UnknownBlock;

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

export type PageBlock = OutlineBlock | ImageBlock | EmbeddedFileBlock | UnknownBlock;

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
  if (extension) return `application/x-${extension.replace(/^\./, "")}`;
  return "application/octet-stream";
}

/** Strip undefined fields so the JSON stays compact. */
function compact<T extends object>(o: T): T {
  for (const k of Object.keys(o) as (keyof T)[]) if (o[k] === undefined) delete o[k];
  return o;
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
      section: { id: s.rootGosid ? egKey(s.rootGosid) : null, pages: [] },
      diagnostics: { warnings: s.warnings, encryptedObjectSpaces: [] },
    };
    for (const sp of s.objectSpaces.values()) if (sp.encrypted) out.diagnostics.encryptedObjectSpaces.push(egKey(sp.gosid));
    if (this.opts.resolveFileData) out.diagnostics.fileDataLookups = this.lookups = { requested: 0, resolved: 0 };
    if (this.opts.sectionName) out.section.name = this.opts.sectionName;

    const root = s.rootGosid ? s.objectSpaces.get(egKey(s.rootGosid)) : undefined;
    if (!root) {
      s.warnings.push("no root object space");
      return out;
    }
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
    out.section.entityGuid = sp.str(Prop.NotebookManagementEntityGuid!);
    out.section.createdAt = fileTime(sp.bytes(Prop.TopologyCreationTimeStamp!));
    out.section.color = colorRef(sp.u32(Prop.NotebookColor!));

    // Section metadata root, when present, carries the display name.
    const metaRev = s.currentRevision(root, RootRole.Metadata) ?? rev;
    const metaOid = s.rootObject(root, metaRev, RootRole.Metadata);
    const meta = metaOid ? s.findObject(metaRev, metaOid, root) : undefined;
    const displayName = meta ? this.props(meta).str(Prop.SectionDisplayName!) : undefined;
    if (displayName) out.section.name = displayName;

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
    if (!page.title) page.title = page.titleBlocks.map((b) => plainText(b.children)).join(" ").trim();

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
      default: return this.unknown(decl);
    }
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
      default: return this.unknown(d);
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
    "NoteTagLabel", "SectionDisplayName", "NextStyle", "WzHyperlinkUrl", "NotebookManagementEntityGuid"].map((n) => Prop[n]!),
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
