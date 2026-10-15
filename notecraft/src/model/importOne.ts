// .one import: run the reverse-engineered revision-store parser in the browser
// and map its NotebookJson onto Notecraft's model.
import { parseOneNote } from "@re/parser/src/notebook.ts";
import type {
  ContentBlock,
  ImageBlock,
  ListInfo,
  NoteTag as OneNoteTag,
  NotebookJson,
  OutlineBlock,
  OutlineElementBlock,
  Page as OnePage,
  TextRun,
} from "@re/parser/src/notebook.ts";
import type { Element, FloatingImage, ListStyle, NoteTag, NumberScheme, Outline, Page, PageLevel, PageVersion, ParagraphStyle, Run, Section } from "./types.ts";
import { LAYOUT } from "./types.ts";
import { newId, nowIso } from "../lib/id.ts";
import { normalizeRuns } from "../lib/richtext.ts";
import { paragraph, SECTION_COLORS } from "./ops.ts";

export interface ImportResult {
  section: Section;
  stats: { pages: number; outlines: number; paragraphs: number; tables: number; images: number; imagesWithoutData: number; warnings: number };
  /** OneNote's page history (VersionHistoryContent → VersionProxy), mapped onto the imported pages. */
  versions: Omit<PageVersion, "id">[];
}

const PARAGRAPH_STYLES = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "quote", "code"]);

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function importOneFile(bytes: Uint8Array, fileName: string): ImportResult {
  const assets = new Map<string, string>();
  const json: NotebookJson = parseOneNote(bytes, {
    sectionName: fileName,
    includeVersions: true,
    onAsset: ({ id, bytes: data, mediaType }) => {
      assets.set(id, `data:${mediaType};base64,${toBase64(data)}`);
      return id;
    },
  });
  const stats = { pages: 0, outlines: 0, paragraphs: 0, tables: 0, images: 0, imagesWithoutData: 0, warnings: json.diagnostics.warnings.length };

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

  const tagOf = (tags: OneNoteTag[] | undefined): NoteTag | undefined => {
    const t = tags?.[0];
    if (!t) return undefined;
    const label = (t.label ?? "").toLowerCase();
    const kind = label.includes("to do") ? "todo" : label.includes("important") ? "important" : label.includes("question") ? "question" : "custom";
    return { kind, ...(t.label && kind === "custom" ? { label: t.label } : {}), ...(t.completed !== undefined ? { done: t.completed } : {}) };
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

  // OneNote nests children (ElementChildNodes); Notecraft flattens to depth.
  const flatten = (els: OutlineElementBlock[], depth: number, out: Element[]) => {
    for (const oe of els) {
      const list = listOf(oe.list);
      const tag = tagOf(oe.tags);
      const contents: ContentBlock[] = oe.content.length ? oe.content : [];
      let first = true;
      const common = () => {
        const c = { depth, ...(first && list ? { list } : {}), ...(first && tag ? { tag } : {}) };
        first = false;
        return c;
      };
      if (!contents.length) out.push(paragraph([], common()));
      for (const c of contents) {
        if (c.type === "richText") {
          stats.paragraphs++;
          const styleId = c.paragraph.styleId?.toLowerCase();
          const style = (styleId && PARAGRAPH_STYLES.has(styleId) ? styleId : "p") as ParagraphStyle;
          out.push(paragraph(normalizeRuns(c.runs.map(runOf)), { ...common(), style }));
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
    for (const b of p.blocks) {
      if (b.type === "outline") outlines.push(outlineOf(b));
      else if (b.type === "image") images.push({ id: newId("i"), x: Math.round(b.layout.x ?? LAYOUT.bodyX), y: Math.round(b.layout.y ?? LAYOUT.bodyY), ...imageOf(b) });
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
  return { section, stats, versions };
}

function hash(s: string): number {
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return h;
}
