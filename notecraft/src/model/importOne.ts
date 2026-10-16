// .one import: run the reverse-engineered revision-store parser in the browser
// and map its NotebookJson onto Notecraft's model.
//
// Features from onenote-re/docs/file-format.md §15:
//   ImageCropped* (crop rectangle)          ImageData.crop / original, cropped pixels in src (finishImport)
//   IsPrintoutPage, IsPartOfSplitPrintout   ImageData.printout, linked to the attachment it shows
//   MathFormatting + MathData_* runs         MathEl (UnicodeMath linear form), or inline linear text
//   InkShape2DInfo / InkLineShapeInfo        InkStroke.shape + shapeKind
//   encrypted (password-protected) section   "<name> (locked)" with a page saying how to get it in
//   audio/video attachments and recordings   FileEl with a playable data: URL and a matching extension
import { parseSection } from "./parser.ts";
import { inkToSvg } from "@re/parser/src/ink.ts";
import type {
  ContentBlock,
  EmbeddedFileBlock,
  ImageBlock,
  InkBlock,
  InkShapeInfo,
  ListInfo,
  MathObject,
  NoteTag as OneNoteTag,
  NotebookJson,
  OutlineBlock,
  OutlineElementBlock,
  Page as OnePage,
  PrintoutInfo,
  TextRun,
  UnknownBlock,
} from "@re/parser/src/notebook.ts";
import type { CropRect, CustomTagDef, Element, FileEl, FloatingImage, ImageData, InkStroke, ListStyle, NoteTag, NumberScheme, Outline, Page, PageLevel, PageVersion, ParagraphEl, ParagraphStyle, Run, Section } from "./types.ts";
import { LAYOUT } from "./types.ts";
import { newId, nowIso } from "../lib/id.ts";
import { normalizeRuns } from "../lib/richtext.ts";
import { paragraph, SECTION_COLORS } from "./ops.ts";
import { tagFromOneNote } from "./tags.ts";
import { cropImage } from "../engine.ts";

export interface ImportStats {
  pages: number;
  outlines: number;
  paragraphs: number;
  tables: number;
  images: number;
  imagesWithoutData: number;
  inkStrokes: number;
  warnings: number;
  /** Pictures shown cropped (counted by finishImport). */
  croppedImages: number;
  /** File Printout pages. */
  printouts: number;
  /** Equations; `equationsUndecoded` of them kept their visible text only. */
  equations: number;
  equationsUndecoded: number;
  /** Ink to Shape strokes. */
  inkShapes: number;
  /** Audio and video attachments (recordings included). */
  media: number;
}

/** A picture OneNote showed cropped. importNotebookJson leaves it whole; finishImport crops it. */
export interface PendingCrop {
  image: ImageData;
  crop: CropRect;
  /** The picture's size on the OneNote page (PictureWidth/Height), when the file has it. */
  frame?: { width: number; height: number };
  /** Counts in stats (false for page history). */
  counted: boolean;
}

export interface ImportResult {
  section: Section;
  stats: ImportStats;
  /** OneNote's page history (VersionHistoryContent → VersionProxy), mapped onto the imported pages. */
  versions: Omit<PageVersion, "id">[];
  /** Custom tags (not in the default catalog) used by the imported notes. */
  customTags: CustomTagDef[];
  /** The section file stored its own color (a notebook TOC's color applies otherwise). */
  colorFromFile: boolean;
  /** OneNote had this section password protected: its notes were not imported (file-format.md §15.5). */
  passwordProtected: boolean;
  /** Crops still to apply; finishImport does it and empties the list. */
  pendingCrops: PendingCrop[];
}

const PARAGRAPH_STYLES = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "quote", "code", "cite"]);
/** OneNote's built-in ParagraphStyleIds that Notecraft names differently. */
const STYLE_ALIASES: Record<string, ParagraphStyle> = { blockquote: "quote" };

/**
 * NoteTagShape values drawn with a check box ([MS-ONE] §2.3.86; the same set
 * onenote-re/writer-rs writes). Every tag definition OneNote writes has an
 * ActionItemType, checkable or not, so the shape decides.
 */
const CHECKBOX_SHAPES = (shape: number) => (shape >= 1 && shape <= 12) || [28, 30, 32, 48, 50, 52, 69, 71, 73].includes(shape) || (shape >= 89 && shape <= 99);
const checkable = (t: OneNoteTag) => (t.shape !== undefined ? CHECKBOX_SHAPES(t.shape) : t.actionItemType !== undefined);

/** What an imported password-protected section's one page says. */
export const LOCKED_SECTION_MESSAGE = "This section is password protected in OneNote. Unlock it in OneNote and import it again.";

/** Parse a .one file in this process (Rust/WebAssembly parser when built) and import it. */
export async function importOneFile(bytes: Uint8Array, fileName: string): Promise<ImportResult> {
  const { json, assets } = await parseSection(bytes, fileName);
  return finishImport(importNotebookJson(json, fileName, assets));
}

/** importNotebookJson, then finishImport. */
export async function importNotebookJsonAsync(json: NotebookJson, fileName: string, assets: Map<string, string>): Promise<ImportResult> {
  return finishImport(importNotebookJson(json, fileName, assets));
}

export type Cropper = (src: string, rect: CropRect) => Promise<{ src: string; width: number; height: number }>;

/**
 * The asynchronous part of an import: crop the pictures OneNote showed cropped
 * (the Rust engine, natively or as WebAssembly). A picture that can't be
 * cropped stays whole, without a crop, rather than failing the import.
 */
export async function finishImport(r: ImportResult, crop: Cropper = cropImage): Promise<ImportResult> {
  const jobs = r.pendingCrops.splice(0);
  // Page history repeats its page's pictures: crop each picture/rectangle once.
  const done = new Map<string, Promise<{ src: string; width: number; height: number }>>();
  for (const job of jobs) {
    const src = job.image.src;
    if (!src) continue;
    const c = job.crop;
    const key = `${c.topLeftXPercentage},${c.topLeftYPercentage},${c.widthPercentage},${c.heightPercentage}|${src}`;
    let pending = done.get(key);
    if (!pending) done.set(key, (pending = crop(src, c)));
    try {
      const out = await pending;
      if (!out?.src || !(out.width > 0) || !(out.height > 0)) throw new Error("empty crop");
      const size = croppedSize(job, out);
      Object.assign(job.image, {
        src: out.src,
        width: size.width,
        height: size.height,
        crop: { ...c },
        original: { src, width: size.fullWidth, height: size.fullHeight },
      } satisfies Partial<ImageData>);
      if (job.counted) r.stats.croppedImages++;
    } catch (e) {
      console.warn("Notecraft: could not crop an imported picture; keeping it whole", e);
    }
  }
  return r;
}

/**
 * Display size of a cropped picture. OneNote's PictureWidth/Height is taken
 * as the visible (cropped) frame; when its shape matches the whole picture
 * better than the cropped part, it is read as the whole picture instead.
 */
function croppedSize(job: PendingCrop, px: { width: number; height: number }) {
  const fx = job.crop.widthPercentage / 100;
  const fy = job.crop.heightPercentage / 100;
  let w: number, h: number;
  if (job.frame) {
    const ratio = job.frame.width / job.frame.height;
    const off = (r: number) => Math.abs(Math.log(ratio / r));
    const whole = off(px.width / fx / (px.height / fy)) < off(px.width / px.height);
    [w, h] = whole ? [job.frame.width * fx, job.frame.height * fy] : [job.frame.width, job.frame.height];
  } else {
    // No size in the file: the cropped pixels at 1px = 1pt, at most 640 wide.
    const s = Math.min(1, 640 / px.width);
    [w, h] = [px.width * s, px.height * s];
  }
  const width = Math.max(1, Math.round(w));
  const height = Math.max(1, Math.round(h));
  return { width, height, fullWidth: Math.round(width / fx), fullHeight: Math.round(height / fy) };
}

/**
 * Import already-parsed parser output. `assets` maps the ids the parser's
 * onAsset hook returned to data URLs (the desktop app parses in its main
 * process, where OneNote's cache can fill in missing pictures). Cropped
 * pictures come in whole and are listed in `pendingCrops`: finishImport (or
 * importNotebookJsonAsync) applies the crop.
 */
export function importNotebookJson(json: NotebookJson, fileName: string, assets: Map<string, string>): ImportResult {
  const stats: ImportStats = {
    pages: 0,
    outlines: 0,
    paragraphs: 0,
    tables: 0,
    images: 0,
    imagesWithoutData: 0,
    inkStrokes: 0,
    warnings: json.diagnostics.warnings.length,
    croppedImages: 0,
    printouts: 0,
    equations: 0,
    equationsUndecoded: 0,
    inkShapes: 0,
    media: 0,
  };
  const pendingCrops: PendingCrop[] = [];
  // Converting page history (its pictures are cropped too, but not counted).
  let inHistory = false;

  const runOf = (r: TextRun): Run => {
    const out: Run = { text: r.text };
    const s = r.style;
    if (s.bold) out.b = true;
    if (s.italic) out.i = true;
    if (s.underline) out.u = true;
    if (s.strikethrough) out.s = true;
    if (s.superscript) out.sup = true;
    if (s.subscript) out.sub = true;
    if (s.highlight) out.highlight = s.highlight;
    if (s.color) out.color = s.color;
    // Keep fonts and sizes only where they differ from OneNote's default (Calibri 11).
    if (s.font && s.font !== "Calibri") out.font = s.font;
    if (s.fontSize && s.fontSize !== 11) out.size = s.fontSize;
    if (r.href) out.href = r.href;
    return out;
  };

  const listOf = (l: ListInfo | undefined): ListStyle | undefined => {
    if (!l) return undefined;
    if (l.kind === "bullet") return { kind: "bullet", glyph: l.bullet || "•" };
    const known: NumberScheme[] = ["decimal", "upperRoman", "lowerRoman", "upperLetter", "lowerLetter"];
    const scheme = known.includes(l.scheme as NumberScheme) ? (l.scheme as NumberScheme) : "decimal";
    return { kind: "numbered", scheme, suffix: l.suffix ?? "", ...(l.prefix ? { prefix: l.prefix } : {}), ...(l.restart ? { start: l.restart } : {}) };
  };

  // NoteTagStates → catalog tags (matched by NoteTagLabel) or custom tag definitions.
  const customTags = new Map<string, CustomTagDef>();
  const tagsOf = (tags: OneNoteTag[] | undefined): NoteTag[] | undefined => {
    if (!tags?.length) return undefined;
    const out: NoteTag[] = [];
    for (const t of tags) {
      // tagFromOneNote makes a custom tag checkable when it has an ActionItemType.
      const { tag, def } = tagFromOneNote({ ...t, actionItemType: checkable(t) ? (t.actionItemType ?? 0) : undefined });
      if (def) customTags.set(def.id, def);
      if (!out.some((x) => x.kind === tag.kind)) out.push(tag);
    }
    return out;
  };

  // --- pictures, crops and printouts ----------------------------------------------

  // Attachments and printout pictures of the page being converted, in document order.
  let events: PageEvent[] = [];

  /** The picture's size on the page (PictureWidth/Height), when the file has a usable one. */
  const frameOf = (b: ImageBlock) => {
    const { width, height } = b.layout;
    return width && height && width > 0 && height > 0 ? { width, height } : undefined;
  };

  const imageOf = (b: ImageBlock): ImageData => {
    stats.images++;
    const src = b.asset?.ref ? assets.get(b.asset.ref) : undefined;
    if (!src) stats.imagesWithoutData++;
    let width = b.layout.width ?? 160;
    let height = b.layout.height ?? 120;
    // Until finishImport crops it, a cropped picture shows whole, at the size its frame implies.
    if (src && b.crop && frameOf(b)) {
      width /= b.crop.widthPercentage / 100;
      height /= b.crop.heightPercentage / 100;
    }
    return {
      ...(src ? { src } : {}),
      width: Math.max(1, Math.round(width)),
      height: Math.max(1, Math.round(height)),
      ...(b.altText ? { alt: b.altText } : {}),
      ...(b.filename ? { filename: b.filename } : {}),
      ...(b.ocrText ? { ocrText: b.ocrText } : {}),
    };
  };

  /** Register the picture as stored in the section (crop to apply, printout to link). */
  const track = <T extends ImageData>(image: T, b: ImageBlock): T => {
    if (image.src && b.crop) {
      const frame = frameOf(b);
      pendingCrops.push({ image, crop: { ...b.crop }, ...(frame ? { frame } : {}), counted: !inHistory });
    }
    if (b.printout) {
      stats.printouts++;
      events.push({ kind: "printout", image, info: b.printout });
    }
    return image;
  };

  // --- attachments, recordings and media ------------------------------------------

  const fileOf = (c: EmbeddedFileBlock, depth: number, extra: Partial<FileEl> = {}): FileEl => {
    const mediaType = c.asset?.mediaType;
    const isMedia = !!mediaType && /^(audio|video)\//.test(mediaType);
    if (isMedia) stats.media++;
    const fallback = c.recording ? (mediaType?.startsWith("video/") ? "Video recording" : "Audio recording") : "attachment";
    const name = withExtension(c.filename || fallback, isMedia ? mediaType : undefined);
    const raw = c.asset?.ref ? assets.get(c.asset.ref) : undefined;
    const src = raw && mediaType ? withMediaType(raw, mediaType, name) : raw;
    const el: FileEl = { id: newId("e"), kind: "file", depth, ...extra, name, ...(c.asset ? { size: c.asset.byteLength } : {}), ...(src ? { src } : {}) };
    events.push({ kind: "file", name, outOfDate: !!c.printoutOutOfDate });
    return el;
  };

  // Online videos and other embeds (IFrame*): Notecraft has no web embed, so a link.
  const embedUrl = (b: ImageBlock | UnknownBlock): { url: string; title?: string } | undefined => {
    if (b.type === "image") return b.embed?.url ? { url: b.embed.url, ...(b.embed.title ? { title: b.embed.title } : {}) } : undefined;
    const url = b.properties.IFrameOriginUrl;
    const title = b.properties.IFrameContentTitle;
    return typeof url === "string" && url ? { url, ...(typeof title === "string" && title ? { title } : {}) } : undefined;
  };
  const linkParagraph = (e: { url: string; title?: string }, extra: Partial<ParagraphEl> = {}) => paragraph([{ text: e.title ?? e.url, href: e.url }], extra);

  // --- ink ------------------------------------------------------------------------

  // Page ink becomes Notecraft ink: same page points, editable with the Draw tools.
  const strokesOf = (b: InkBlock): InkStroke[] =>
    b.strokes
      .filter((st) => st.points.length >= 2)
      .map((st) => {
        stats.inkStrokes++;
        const hl = !!st.highlighter;
        const size = Math.max(st.width ?? 0, st.height ?? 0);
        const out: InkStroke = {
          id: newId("k"),
          tool: hl ? "highlighter" : "pen",
          color: st.color ?? (hl ? "#ffe14d" : "#1d1f23"),
          width: Math.round((size || (hl ? 14 : 2)) * 10) / 10,
          points: st.points,
        };
        // Ink to Shape: OneNote's recognized geometry is not decoded, but the
        // stroke it keeps is the clean shape; name it from that outline.
        if (st.shape) {
          stats.inkShapes++;
          out.shape = true;
          const kind = shapeKindOf(st.points, st.shape);
          if (kind) out.shapeKind = kind;
        }
        return out;
      });

  // Handwriting inside an outline flows with the text, so it comes in as a drawing.
  const inkImageOf = (b: InkBlock) => {
    stats.inkStrokes += b.strokes.length;
    const svg = inkToSvg(b.strokes);
    const w = Number(/width="([\d.]+)"/.exec(svg)?.[1] ?? 40);
    const h = Number(/height="([\d.]+)"/.exec(svg)?.[1] ?? 20);
    return { src: `data:image/svg+xml;base64,${btoa(svg)}`, width: Math.max(8, Math.round(w)), height: Math.max(8, Math.round(h)), alt: "Handwriting", filename: "ink.svg" };
  };

  // --- outlines -------------------------------------------------------------------

  // OneNote nests children (ElementChildNodes); Notecraft flattens to depth.
  const flatten = (els: OutlineElementBlock[], depth: number, out: Element[]) => {
    for (const oe of els) {
      const list = listOf(oe.list);
      const tags = tagsOf(oe.tags);
      const contents: ContentBlock[] = oe.content.length ? oe.content : [];
      let first = true;
      const common = () => {
        const c = { depth, ...(first && list ? { list } : {}), ...(first && tags ? { tags } : {}) };
        first = false;
        return c;
      };
      if (!contents.length) out.push(paragraph([], common()));
      for (const c of contents) {
        if (c.type === "richText") {
          const styleId = c.paragraph.styleId?.toLowerCase();
          const style: ParagraphStyle = (styleId && (STYLE_ALIASES[styleId] ?? (PARAGRAPH_STYLES.has(styleId) ? (styleId as ParagraphStyle) : undefined))) || "p";
          const pp = c.paragraph;
          const extra = {
            ...(pp.alignment && pp.alignment !== "left" ? { align: pp.alignment } : {}),
            ...(pp.spaceBefore ? { spaceBefore: pp.spaceBefore } : {}),
            ...(pp.spaceAfter ? { spaceAfter: pp.spaceAfter } : {}),
            ...(pp.lineSpacing ? { lineSpacing: pp.lineSpacing } : {}),
          };
          const math = mathOf(c.runs);
          if (math) {
            stats.equations += math.zones;
            stats.equationsUndecoded += math.undecoded;
          }
          if (math?.only && math.linear) {
            // A paragraph that is all equation: an equation element.
            out.push({ id: newId("e"), kind: "math", ...common(), linear: math.linear });
          } else {
            // Text with inline equations keeps flowing: each equation becomes its linear form.
            stats.paragraphs++;
            out.push(paragraph(normalizeRuns(math ? math.runs(runOf) : c.runs.map(runOf)), { ...common(), style, ...extra }));
          }
        } else if (c.type === "table") {
          stats.tables++;
          out.push({
            id: newId("t"),
            kind: "table",
            ...common(),
            borders: c.bordersVisible !== false,
            columns: c.columnWidths.length ? c.columnWidths.map((w) => Math.round(w)) : Array(c.rows[0]?.cells.length ?? 1).fill(120),
            rows: c.rows.map((r) => ({
              id: newId("r"),
              cells: r.cells.map((cell) => {
                const inner: Element[] = [];
                flatten(cell.children, 0, inner);
                return { id: newId("c"), ...(cell.shading ? { shading: cell.shading } : {}), elements: inner.length ? inner : [paragraph()] };
              }),
            })),
          });
        } else if (c.type === "image") {
          const image = track(imageOf(c), c);
          out.push({ id: newId("e"), kind: "image", ...common(), image });
          const embed = embedUrl(c);
          if (embed) out.push(linkParagraph(embed, { depth }));
        } else if (c.type === "ink") {
          if (c.strokes.length) out.push({ id: newId("e"), kind: "image", ...common(), image: inkImageOf(c) });
        } else if (c.type === "embeddedFile") {
          out.push(fileOf(c, depth, common()));
        } else if (c.type === "unknown") {
          const embed = embedUrl(c);
          if (embed) out.push(linkParagraph(embed, common()));
        }
      }
      flatten(oe.children, depth + 1, out);
    }
  };

  const outlineOf = (b: OutlineBlock): Outline => {
    stats.outlines++;
    const elements: Element[] = [];
    flatten(b.children, 0, elements);
    return {
      id: newId("o"),
      x: Math.round(b.layout.x ?? LAYOUT.bodyX),
      y: Math.round(b.layout.y ?? LAYOUT.bodyY),
      width: Math.round(b.layout.width ?? LAYOUT.outlineWidth),
      widthSetByUser: true,
      elements: elements.length ? elements : [paragraph()],
    };
  };

  /** A block Notecraft only has as outline content, placed where OneNote had it on the page. */
  const outlineAt = (layout: { x?: number; y?: number; width?: number }, elements: Element[]): Outline => ({
    id: newId("o"),
    x: Math.round(layout.x ?? LAYOUT.bodyX),
    y: Math.round(layout.y ?? LAYOUT.bodyY),
    width: Math.round(Math.max(layout.width ?? 0, 240)),
    widthSetByUser: false,
    elements,
  });

  const pageOf = (p: OnePage): { page: Page; events: PageEvent[] } => {
    stats.pages++;
    events = [];
    const outlines: Outline[] = [];
    const images: FloatingImage[] = [];
    const ink: InkStroke[] = [];
    for (const b of p.blocks) {
      if (b.type === "outline") outlines.push(outlineOf(b));
      else if (b.type === "image") {
        const img = track({ id: newId("i"), x: Math.round(b.layout.x ?? LAYOUT.bodyX), y: Math.round(b.layout.y ?? LAYOUT.bodyY), ...imageOf(b) }, b);
        images.push(img);
        const embed = embedUrl(b);
        if (embed) outlines.push(outlineAt({ x: img.x, y: img.y + img.height + 6 }, [linkParagraph(embed, { depth: 0 })]));
      } else if (b.type === "ink") ink.push(...strokesOf(b));
      // Attachments placed directly on the page (recordings, files): Notecraft keeps files in outlines.
      else if (b.type === "embeddedFile") outlines.push(outlineAt(b.layout, [fileOf(b, 0)]));
      else if (b.type === "unknown") {
        const embed = embedUrl(b);
        if (embed) outlines.push(outlineAt({}, [linkParagraph(embed, { depth: 0 })]));
      }
    }
    const created = p.createdAt ?? p.lastModified ?? nowIso();
    const page: Page = {
      id: newId("p"),
      title: p.title,
      level: Math.min(3, Math.max(1, p.level ?? 1)) as PageLevel,
      createdAt: created,
      modifiedAt: p.lastModified ?? created,
      ...(p.author ? { author: p.author } : {}),
      outlines,
      images,
      ...(ink.length ? { ink } : {}),
    };
    return { page, events };
  };

  // Backups are named "Section (On 2026-10-14).one".
  const baseName = (json.section.name ?? fileName).replace(/\.one$/i, "").replace(/\s*\(On \d{4}-\d{2}-\d{2}\)$/, "");
  const passwordProtected = json.section.encrypted === true;
  const name = passwordProtected ? `${baseName} (locked)` : baseName;
  const converted = json.section.pages.map(pageOf);
  linkPrintouts(converted.map((c) => c.events));
  const section: Section = {
    id: newId("s"),
    name,
    color: json.section.color ?? SECTION_COLORS[Math.abs(hash(baseName)) % SECTION_COLORS.length]!,
    createdAt: json.section.createdAt ?? nowIso(),
    pages: converted.map((c) => c.page),
    source: { file: fileName, guidFile: json.source.guidFile, importedAt: nowIso() },
  };

  // Historical versions are converted the same way but don't count in the import stats.
  const counted = { ...stats };
  inHistory = true;
  const versions: Omit<PageVersion, "id">[] = [];
  json.section.pages.forEach((p, i) => {
    const target = section.pages[i]!;
    for (const v of p.versions ?? []) {
      const { page, events: ev } = pageOf(v.page);
      linkPrintouts([ev]);
      versions.push({
        pageId: target.id,
        at: v.modifiedAt ?? v.createdAt ?? v.page.lastModified ?? target.modifiedAt,
        ...(v.author ? { author: v.author } : {}),
        source: "onenote",
        reason: "import",
        page: { ...page, id: target.id, level: target.level, createdAt: target.createdAt },
      });
    }
  });
  Object.assign(stats, counted);
  inHistory = false;

  // A password-protected section: OneNote's encryption is not opened (by design).
  // Its notes stay in OneNote; a page says so (any pages that were readable follow).
  if (passwordProtected) section.pages.unshift(lockedPage(section.createdAt));
  if (!section.pages.length) section.pages.push(pageOf({ id: "", title: "", size: {}, titleBlocks: [], blocks: [] }).page);
  return { section, stats, versions, customTags: [...customTags.values()], colorFromFile: !!json.section.color, passwordProtected, pendingCrops };
}

function lockedPage(createdAt: string): Page {
  return {
    id: newId("p"),
    title: "Password protected in OneNote",
    level: 1,
    createdAt,
    modifiedAt: createdAt,
    outlines: [
      {
        id: newId("o"),
        x: LAYOUT.bodyX,
        y: LAYOUT.bodyY,
        width: LAYOUT.outlineWidth,
        widthSetByUser: false,
        elements: [paragraph([{ text: LOCKED_SECTION_MESSAGE }])],
      },
    ],
    images: [],
  };
}

function hash(s: string): number {
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return h;
}

// --- printouts ---------------------------------------------------------------------

type PageEvent = { kind: "file"; name: string; outOfDate: boolean } | { kind: "printout"; image: ImageData; info: PrintoutInfo };

/**
 * Link File Printout pictures to the attachment they show: the nearest
 * attachment before them on the same page. A printout split over several
 * OneNote pages (IsPartOfSplitPrintout) has its attachment on the first page
 * only, so a picture with none before it on its page continues the previous
 * printout. `pages` is the printout's page count as far as the file shows it.
 */
function linkPrintouts(pages: PageEvent[][]) {
  type Group = { file: string; outOfDate: boolean; pictures: { image: ImageData; info: PrintoutInfo }[] };
  const groups: Group[] = [];
  let current: Group | undefined;
  let lastFile: { name: string; outOfDate: boolean } | undefined;
  for (const events of pages) {
    let onPage: Group | undefined;
    let fileOnPage: { name: string; outOfDate: boolean } | undefined;
    for (const ev of events) {
      if (ev.kind === "file") {
        fileOnPage = lastFile = ev;
        onPage = undefined;
        continue;
      }
      if (!onPage) {
        const continues = current && (ev.info.splitPart || !fileOnPage);
        if (continues) onPage = current;
        else {
          const f = fileOnPage ?? lastFile;
          onPage = { file: f?.name ?? ev.image.filename ?? "File printout", outOfDate: f?.outOfDate ?? false, pictures: [] };
          groups.push(onPage);
        }
        current = onPage;
      }
      onPage!.pictures.push(ev);
    }
  }
  for (const g of groups) {
    const numbered = g.pictures.map((p, i) => p.info.page ?? i + 1);
    const pages = Math.max(g.pictures.length, ...numbered);
    g.pictures.forEach(({ image, info }, i) => {
      const page = numbered[i]!;
      image.printout = { file: g.file, page, pages };
      // Pictures made before the attachment last changed (PrintoutOutOfDate) are kept as OneNote showed them, labelled.
      const stale = info.outOfDate || g.outOfDate;
      const label = `${g.file}, page ${page} of ${pages}${stale ? " (out of date)" : ""}`;
      if (!image.alt) image.alt = label;
      if (!image.filename) image.filename = label;
    });
  }
}

// --- media -------------------------------------------------------------------------

const MEDIA_EXTENSIONS: Record<string, string[]> = {
  "audio/mp4": ["m4a", "m4b", "mp4", "aac"],
  "audio/mpeg": ["mp3", "mpga"],
  "audio/wav": ["wav"],
  "audio/ogg": ["ogg", "oga", "opus"],
  "audio/aac": ["aac", "adts"],
  "audio/flac": ["flac"],
  "audio/x-ms-wma": ["wma"],
  "audio/amr": ["amr"],
  "audio/x-caf": ["caf"],
  "video/mp4": ["mp4", "m4v"],
  "video/quicktime": ["mov", "qt"],
  "video/webm": ["webm"],
  "video/3gpp": ["3gp", "3g2"],
  "video/x-msvideo": ["avi"],
  "video/x-ms-wmv": ["wmv"],
  "video/x-ms-asf": ["asf", "wmv", "wma"],
};

/** Give audio/video a file extension that matches its media type, so the app plays it. */
function withExtension(name: string, mediaType: string | undefined): string {
  const exts = mediaType ? MEDIA_EXTENSIONS[mediaType] : undefined;
  if (!exts) return name;
  const ext = /\.([A-Za-z0-9]{1,5})$/.exec(name)?.[1]?.toLowerCase();
  return ext && exts.includes(ext) ? name : `${name}.${exts[0]}`;
}

/** A data: URL whose media type is generic gets the sniffed (or extension's) one. */
function withMediaType(src: string, mediaType: string, name: string): string {
  const m = /^data:([^;,]*)([;,])/.exec(src);
  if (!m) return src;
  const current = m[1] ?? "";
  const generic = !current || current === "application/octet-stream" || current.startsWith("application/x-");
  let better = mediaType.startsWith("application/") ? undefined : mediaType;
  if (!better) {
    const ext = /\.([A-Za-z0-9]{1,5})$/.exec(name)?.[1]?.toLowerCase();
    better = Object.entries(MEDIA_EXTENSIONS).find(([, exts]) => ext && exts[0] === ext)?.[0];
  }
  return generic && better && better !== current ? `data:${better}${src.slice(m[0].length - 1)}` : src;
}

// --- equations ---------------------------------------------------------------------

const MATH_START = "﷐";
const MATH_SEPARATOR = "﷮";
const MATH_END = "﷯";
const STRUCTURE = /[﷐﷮﷯]/g;

interface MathParagraph {
  /** Every non-equation run is blank: the paragraph is one equation element. */
  only: boolean;
  /** UnicodeMath of the equations, joined by spaces. */
  linear: string;
  zones: number;
  undecoded: number;
  /** The paragraph's runs with each equation as one run of linear text. */
  runs: (runOf: (r: TextRun) => Run) => Run[];
}

/**
 * Equations in a paragraph: runs with MathFormatting. Built-up math objects
 * are U+FDD0 … U+FDEE … U+FDEF in the text with MathData_* on the U+FDD0
 * run (file-format.md §15.4); they are written back in UnicodeMath linear
 * format. An object whose MathData_Type is missing or unknown keeps its
 * visible text.
 */
function mathOf(runs: TextRun[]): MathParagraph | undefined {
  if (!runs.some((r) => r.style.math)) return undefined;
  type Zone = { linear: string; decoded: boolean; first: TextRun };
  const parts: (TextRun | Zone)[] = [];
  let zone: TextRun[] = [];
  const close = () => {
    if (!zone.length) return;
    const text = zone.map((r) => r.text).join("");
    const objects = new Map<number, MathObject>();
    let at = 0;
    for (const r of zone) {
      for (let i = r.text.indexOf(MATH_START); i !== -1; i = r.text.indexOf(MATH_START, i + 1)) if (r.style.mathObject) objects.set(at + i, r.style.mathObject);
      at += r.text.length;
    }
    const { linear, decoded } = buildDown(text, (i) => objects.get(i));
    parts.push({ linear, decoded, first: zone[0]! });
    zone = [];
  };
  for (const r of runs) {
    if (r.style.math) zone.push(r);
    else {
      close();
      parts.push(r);
    }
  }
  close();
  const zones = parts.filter((p): p is Zone => "linear" in p);
  const only = parts.every((p) => "linear" in p || !p.text.trim());
  return {
    only,
    linear: zones.map((z) => z.linear).filter(Boolean).join(" "),
    zones: zones.length,
    undecoded: zones.filter((z) => !z.decoded).length,
    runs: (runOf) =>
      parts.map((p) => {
        if (!("linear" in p)) return runOf(p);
        const run = runOf({ ...p.first, text: p.linear });
        if (!run.font) run.font = "Cambria Math";
        return run;
      }),
  };
}

/**
 * RichEdit's built-up math → UnicodeMath. `objectAt(i)` is the MathData of the
 * U+FDD0 at text index i. `decoded` is false when any object had to fall back
 * to its visible text.
 */
export function buildDown(text: string, objectAt: (i: number) => MathObject | undefined): { linear: string; decoded: boolean } {
  let i = 0;
  let decoded = true;
  const seq = (): string => {
    let out = "";
    while (i < text.length) {
      const c = text[i]!;
      if (c === MATH_SEPARATOR || c === MATH_END) return out;
      if (c !== MATH_START) {
        out += c;
        i++;
        continue;
      }
      const obj = objectAt(i);
      i++;
      const args: string[] = [];
      for (;;) {
        args.push(seq());
        if (text[i] === MATH_SEPARATOR) {
          i++;
          continue;
        }
        if (text[i] === MATH_END) i++;
        break;
      }
      const built = obj ? mathObjectLinear(obj, args) : undefined;
      if (built === undefined) decoded = false;
      out += built ?? args.map((a) => a.replace(STRUCTURE, "")).filter((a) => a.trim()).join(" ");
    }
    return out;
  };
  let linear = "";
  while (i < text.length) {
    linear += seq();
    if (i < text.length) i++; // a separator or end outside any object
  }
  return { linear: linear.replace(STRUCTURE, "").trim(), decoded };
}

/** Function names the equation engine (crates/engine/src/math.rs) sets upright and applies. */
const FUNCTION_NAMES = new Set(["sin", "cos", "tan", "cot", "sec", "csc", "log", "ln", "exp", "lim", "max", "min", "det", "sinh", "cosh", "tanh", "arg", "gcd", "Pr"]);

/** One argument as an operand: single symbols, numbers and function names bare, anything else in parentheses. */
function operand(s: string): string {
  const t = s.trim();
  if (!t || [...t].length === 1 || /^\d+(\.\d+)?$/.test(t) || FUNCTION_NAMES.has(t)) return t;
  if (t.startsWith("(") && t.endsWith(")")) {
    let depth = 0;
    let closesAtEnd = true;
    for (let k = 0; k < t.length; k++) {
      if (t[k] === "(") depth++;
      else if (t[k] === ")" && --depth === 0 && k < t.length - 1) closesAtEnd = false;
    }
    if (closesAtEnd && depth === 0) return t;
  }
  return `(${t})`;
}

/**
 * What a function or n-ary operator applies to: bare when it is one element
 * (`x`, `a_n`, `x^2`, `(a+b)`), in parentheses when it has an operator or a
 * space outside brackets.
 */
function element(s: string): string {
  const t = s.trim();
  let depth = 0;
  for (const ch of t) {
    if ("([{⟨".includes(ch)) depth++;
    else if (")]}⟩".includes(ch)) depth--;
    else if (depth === 0 && (/\s/.test(ch) || "+-−=±∓<>≤≥≠,/".includes(ch))) return operand(t);
  }
  return t;
}

const chr = (code: number | undefined, fallback: string) => (code ? String.fromCharCode(code) : fallback);

/**
 * One math object in UnicodeMath, by MathData_Type (tom.h OBJECTTYPE values,
 * in the order of RichEdit's own per-type operator table; file-format.md
 * §15.4). Argument order follows OMML. Undefined for types not handled.
 */
function mathObjectLinear(o: MathObject, a: string[]): string | undefined {
  const [a0 = "", a1 = "", a2 = ""] = a;
  const scripts = (sub: string, sup: string) => `${sub.trim() ? `_${operand(sub)}` : ""}${sup.trim() ? `^${operand(sup)}` : ""}`;
  switch (o.type) {
    case 10: // tomAccent: the accent (a combining mark) follows its base
      return `${operand(a0)}${chr(o.char, "̂")}`;
    case 11: // tomBox
      return `□${operand(a0)}`;
    case 12: // tomBoxedFormula
      return `▭(${a0.trim()})`;
    case 13: // tomBrackets
      return `${chr(o.char, "(")}${a0.trim()}${chr(o.char1, ")")}`;
    case 14: // tomBracketsWithSeps
      return `${chr(o.char, "(")}${a.map((x) => x.trim()).join(chr(o.char2, "│"))}${chr(o.char1, ")")}`;
    case 15: // tomEquationArray
      return `█(${a.map((x) => x.trim()).join("@")})`;
    case 16: {
      // tomFraction; a skewed (⁄), linear (∕) or no-bar (¦) fraction keeps its operator
      const op = o.char && "⁄∕¦".includes(String.fromCharCode(o.char)) ? String.fromCharCode(o.char) : "/";
      return `${operand(a0)}${op}${operand(a1)}`;
    }
    case 17: {
      // tomFunctionApply: name, U+2061, argument. The engine skips U+2061 in a
      // row but would read it into a limit (lim┬(n→∞)), so a space follows those.
      const name = a0.trim();
      return `${name}${/[┬┴]/.test(name) ? " " : "\u2061"}${element(a1)}`;
    }
    case 18: // tomLeftSubSup: sub, sup, base
      return `(${scripts(a0, a1)})${operand(a2)}`;
    case 19: // tomLowerLimit
      return `${operand(a0)}┬${operand(a1)}`;
    case 20: {
      // tomMatrix: cells row by row, MathData_cCol columns
      const cols = o.columns && o.columns > 0 ? o.columns : a.length || 1;
      const rows: string[] = [];
      for (let k = 0; k < a.length; k += cols) rows.push(a.slice(k, k + cols).map((x) => x.trim()).join("&"));
      return `■(${rows.join("@")})`;
    }
    case 21: {
      // tomNary: lower limit, upper limit, operand
      const body = a2.trim();
      return `${chr(o.char, "∫")}${scripts(a0, a1)}${body ? ` ${element(body)}` : ""}`;
    }
    case 22: // tomOpChar
      return `${chr(o.char, "")}${a.join("")}`;
    case 23: // tomOverbar
      return `¯${operand(a0)}`;
    case 24: // tomPhantom
      return `⟡${operand(a0)}`;
    case 25: {
      // tomRadical: degree, radicand (or the radicand alone)
      if (a.length < 2) return `√${operand(a0)}`;
      const degree = a0.trim();
      if (!degree) return `√${operand(a1)}`;
      if (degree === "3") return `∛${operand(a1)}`;
      if (degree === "4") return `∜${operand(a1)}`;
      return `√(${degree}&${a1.trim()})`;
    }
    case 26: // tomSlashedFraction
      return `${operand(a0)}⁄${operand(a1)}`;
    case 27: // tomStack
      return `${operand(a0)}¦${operand(a1)}`;
    case 28: // tomStretchStack (over/under brace and similar)
      return `${chr(o.char, "⏟")}${operand(a0)}`;
    case 29: // tomSubscript
      return `${operand(a0)}${scripts(a1, "")}`;
    case 30: // tomSubSup
      return `${operand(a0)}${scripts(a1, a2)}`;
    case 31: // tomSuperscript
      return `${operand(a0)}${scripts("", a1)}`;
    case 32: // tomUnderbar
      return `▁${operand(a0)}`;
    case 33: // tomUpperLimit
      return `${operand(a0)}┴${operand(a1)}`;
    default:
      return undefined;
  }
}

// --- Ink to Shape --------------------------------------------------------------------

type Pt = [number, number];

/**
 * Name a converted stroke with crates/engine/src/shapes.rs's ShapeKind names.
 * OneNote's InkShape2DInfo / InkLineShapeInfo bytes are not decoded, so the
 * kind comes from the clean outline OneNote drew: lines and arrows (open),
 * triangles, rectangles, diamonds, other polygons and ellipses (closed).
 */
export function shapeKindOf(points: number[], info: Pick<InkShapeInfo, "source">): string | undefined {
  const ps: Pt[] = [];
  for (let k = 0; k + 1 < points.length; k += 2) ps.push([points[k]!, points[k + 1]!]);
  if (ps.length < 2) return undefined;
  const xs = ps.map((p) => p[0]);
  const ys = ps.map((p) => p[1]);
  const [l, r, t, b] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const diag = Math.hypot(r - l, b - t);
  if (!(diag > 0)) return undefined;
  const dist = (p: Pt, q: Pt) => Math.hypot(p[0] - q[0], p[1] - q[1]);
  const poly = simplify(ps, 0.03 * diag);
  const closed = ps.length > 3 && dist(ps[0]!, ps[ps.length - 1]!) < 0.1 * diag;
  if (info.source === "line" || !closed) {
    if (poly.length <= 2) return "line";
    // A shaft, then the two wings of a head near its tip.
    const tip = poly[1]!;
    const shaft = dist(poly[0]!, tip);
    if (poly.length <= 6 && poly.slice(2).every((w) => dist(w, tip) < 0.45 * shaft)) return "arrow";
    return info.source === "line" ? "line" : undefined;
  }
  // Round: every point near the ellipse inscribed in the bounding box.
  const [cx, cy, rx, ry] = [(l + r) / 2, (t + b) / 2, (r - l) / 2, (b - t) / 2];
  if (ps.length >= 8 && rx > 0 && ry > 0 && ps.every(([x, y]) => Math.abs(((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 - 1) < 0.2)) return "ellipse";
  const corners = dist(poly[0]!, poly[poly.length - 1]!) < 0.1 * diag ? poly.slice(0, -1) : poly;
  if (corners.length === 3) return "triangle";
  if (corners.length === 4) {
    // Each corner near the middle of a side of the bounding box: a diamond.
    if (corners.every(([x, y]) => Math.abs(x - cx) < 0.2 * (r - l) || Math.abs(y - cy) < 0.2 * (b - t))) return "diamond";
    const square = corners.every((p, k) => {
      const prev = corners[(k + 3) % 4]!;
      const next = corners[(k + 1) % 4]!;
      const [ux, uy, vx, vy] = [prev[0] - p[0], prev[1] - p[1], next[0] - p[0], next[1] - p[1]];
      return Math.abs((ux * vx + uy * vy) / (Math.hypot(ux, uy) * Math.hypot(vx, vy) || 1)) < 0.35;
    });
    return square ? "rectangle" : "polygon";
  }
  return corners.length >= 5 ? "polygon" : undefined;
}

/** Douglas–Peucker. */
function simplify(ps: Pt[], eps: number): Pt[] {
  if (ps.length < 3) return ps.slice();
  const [a, b] = [ps[0]!, ps[ps.length - 1]!];
  const seg = (p: Pt) => {
    const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
    const len2 = dx * dx + dy * dy;
    const u = len2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2)) : 0;
    return Math.hypot(p[0] - (a[0] + u * dx), p[1] - (a[1] + u * dy));
  };
  let idx = 0;
  let max = 0;
  for (let k = 1; k < ps.length - 1; k++) {
    const d = seg(ps[k]!);
    if (d > max) [idx, max] = [k, d];
  }
  if (max <= eps) return [a, b];
  return [...simplify(ps.slice(0, idx + 1), eps).slice(0, -1), ...simplify(ps.slice(idx), eps)];
}
