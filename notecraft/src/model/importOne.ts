// .one import: run the reverse-engineered revision-store parser in the browser
// and map its NotebookJson onto Notecraft's model.
import { parseSection } from "./parser.ts";
import { inkToSvg } from "@re/parser/src/ink.ts";
import type {
  ContentBlock,
  ImageBlock,
  InkBlock,
  ListInfo,
  NoteTag as OneNoteTag,
  NotebookJson,
  OutlineBlock,
  OutlineElementBlock,
  Page as OnePage,
  TextRun,
} from "@re/parser/src/notebook.ts";
import type { CustomTagDef, Element, FloatingImage, InkStroke, ListStyle, NoteTag, NumberScheme, Outline, Page, PageLevel, PageVersion, ParagraphStyle, Run, Section } from "./types.ts";
import { LAYOUT } from "./types.ts";
import { newId, nowIso } from "../lib/id.ts";
import { normalizeRuns } from "../lib/richtext.ts";
import { paragraph, SECTION_COLORS } from "./ops.ts";
import { tagFromOneNote } from "./tags.ts";

export interface ImportResult {
  section: Section;
  stats: { pages: number; outlines: number; paragraphs: number; tables: number; images: number; imagesWithoutData: number; inkStrokes: number; warnings: number };
  /** OneNote's page history (VersionHistoryContent → VersionProxy), mapped onto the imported pages. */
  versions: Omit<PageVersion, "id">[];
  /** Custom tags (not in the default catalog) used by the imported notes. */
  customTags: CustomTagDef[];
  /** The section file stored its own color (a notebook TOC's color applies otherwise). */
  colorFromFile: boolean;
}

const PARAGRAPH_STYLES = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "quote", "code", "cite"]);

/** Parse a .one file in this process (Rust/WebAssembly parser when built) and import it. */
export async function importOneFile(bytes: Uint8Array, fileName: string): Promise<ImportResult> {
  const { json, assets } = await parseSection(bytes, fileName);
  return importNotebookJson(json, fileName, assets);
}

/**
 * Import already-parsed parser output. `assets` maps the ids the parser's
 * onAsset hook returned to data URLs (the desktop app parses in its main
 * process, where OneNote's cache can fill in missing pictures).
 */
export function importNotebookJson(json: NotebookJson, fileName: string, assets: Map<string, string>): ImportResult {
  const stats = { pages: 0, outlines: 0, paragraphs: 0, tables: 0, images: 0, imagesWithoutData: 0, inkStrokes: 0, warnings: json.diagnostics.warnings.length };

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
      const { tag, def } = tagFromOneNote(t);
      if (def) customTags.set(def.id, def);
      if (!out.some((x) => x.kind === tag.kind)) out.push(tag);
    }
    return out;
  };

  const imageOf = (b: ImageBlock) => {
    stats.images++;
    const src = b.asset?.ref ? assets.get(b.asset.ref) : undefined;
    if (!src) stats.imagesWithoutData++;
    return {
      ...(src ? { src } : {}),
      width: Math.round(b.layout.width ?? 160),
      height: Math.round(b.layout.height ?? 120),
      ...(b.altText ? { alt: b.altText } : {}),
      ...(b.filename ? { filename: b.filename } : {}),
      ...(b.ocrText ? { ocrText: b.ocrText } : {}),
    };
  };

  // Page ink becomes Notecraft ink: same page points, editable with the Draw tools.
  const strokesOf = (b: InkBlock): InkStroke[] =>
    b.strokes
      .filter((st) => st.points.length >= 2)
      .map((st) => {
        stats.inkStrokes++;
        const hl = !!st.highlighter;
        const size = Math.max(st.width ?? 0, st.height ?? 0);
        return {
          id: newId("k"),
          tool: hl ? "highlighter" : "pen",
          color: st.color ?? (hl ? "#ffe14d" : "#1d1f23"),
          width: Math.round((size || (hl ? 14 : 2)) * 10) / 10,
          points: st.points,
        };
      });

  // Handwriting inside an outline flows with the text, so it comes in as a drawing.
  const inkImageOf = (b: InkBlock) => {
    stats.inkStrokes += b.strokes.length;
    const svg = inkToSvg(b.strokes);
    const w = Number(/width="([\d.]+)"/.exec(svg)?.[1] ?? 40);
    const h = Number(/height="([\d.]+)"/.exec(svg)?.[1] ?? 20);
    return { src: `data:image/svg+xml;base64,${btoa(svg)}`, width: Math.max(8, Math.round(w)), height: Math.max(8, Math.round(h)), alt: "Handwriting", filename: "ink.svg" };
  };

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
          stats.paragraphs++;
          const styleId = c.paragraph.styleId?.toLowerCase();
          const style = (styleId && PARAGRAPH_STYLES.has(styleId) ? styleId : "p") as ParagraphStyle;
          const pp = c.paragraph;
          const extra = {
            ...(pp.alignment && pp.alignment !== "left" ? { align: pp.alignment } : {}),
            ...(pp.spaceBefore ? { spaceBefore: pp.spaceBefore } : {}),
            ...(pp.spaceAfter ? { spaceAfter: pp.spaceAfter } : {}),
            ...(pp.lineSpacing ? { lineSpacing: pp.lineSpacing } : {}),
          };
          out.push(paragraph(normalizeRuns(c.runs.map(runOf)), { ...common(), style, ...extra }));
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
          out.push({ id: newId("e"), kind: "image", ...common(), image: imageOf(c) });
        } else if (c.type === "ink") {
          if (c.strokes.length) out.push({ id: newId("e"), kind: "image", ...common(), image: inkImageOf(c) });
        } else if (c.type === "embeddedFile") {
          const src = c.asset?.ref ? assets.get(c.asset.ref) : undefined;
          out.push({ id: newId("e"), kind: "file", ...common(), name: c.filename ?? "attachment", ...(c.asset ? { size: c.asset.byteLength } : {}), ...(src ? { src } : {}) });
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

  const pageOf = (p: OnePage): Page => {
    stats.pages++;
    const outlines: Outline[] = [];
    const images: FloatingImage[] = [];
    const ink: InkStroke[] = [];
    for (const b of p.blocks) {
      if (b.type === "outline") outlines.push(outlineOf(b));
      else if (b.type === "image") images.push({ id: newId("i"), x: Math.round(b.layout.x ?? LAYOUT.bodyX), y: Math.round(b.layout.y ?? LAYOUT.bodyY), ...imageOf(b) });
      else if (b.type === "ink") ink.push(...strokesOf(b));
    }
    const created = p.createdAt ?? p.lastModified ?? nowIso();
    return {
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
  };

  // Backups are named "Section (On 2026-10-14).one".
  const name = (json.section.name ?? fileName).replace(/\.one$/i, "").replace(/\s*\(On \d{4}-\d{2}-\d{2}\)$/, "");
  const section: Section = {
    id: newId("s"),
    name,
    color: json.section.color ?? SECTION_COLORS[Math.abs(hash(name)) % SECTION_COLORS.length]!,
    createdAt: json.section.createdAt ?? nowIso(),
    pages: json.section.pages.map(pageOf),
    source: { file: fileName, guidFile: json.source.guidFile, importedAt: nowIso() },
  };

  // Historical versions are converted the same way but don't count in the import stats.
  const counted = { ...stats };
  const versions: Omit<PageVersion, "id">[] = [];
  json.section.pages.forEach((p, i) => {
    const target = section.pages[i]!;
    for (const v of p.versions ?? []) {
      const page = pageOf(v.page);
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

  if (!section.pages.length) section.pages.push({ ...pageOf({ id: "", title: "", size: {}, titleBlocks: [], blocks: [] }) });
  return { section, stats, versions, customTags: [...customTags.values()], colorFromFile: !!json.section.color };
}

function hash(s: string): number {
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return h;
}
