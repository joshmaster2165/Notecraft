// Pure editing operations on an (immer draft of the) Library. Behaviour follows
// OneNote where the analysis showed how the data is shaped; see the comments.
import type {
  Element,
  FloatingImage,
  Id,
  ImageData,
  Library,
  ListRef,
  ListStyle,
  Notebook,
  Outline,
  Page,
  PageLevel,
  ParagraphEl,
  ParagraphStyle,
  Run,
  Section,
  TableEl,
  TagKind,
} from "./types.ts";
import { LAYOUT } from "./types.ts";
import { newId, nowIso } from "../lib/id.ts";
import { normalizeRuns, splitRuns, textLength } from "../lib/richtext.ts";
import { defaultList } from "./lists.ts";

export const SECTION_COLORS = ["#4f7cac", "#c46a2f", "#5b8c5a", "#9a5fb0", "#c2464f", "#3c9a9a", "#b08a2e", "#6b6f80"];

// --- lookup -------------------------------------------------------------------------

export function findSection(lib: Library, sectionId: Id): { notebook: Notebook; section: Section } | undefined {
  for (const notebook of lib.notebooks) {
    const section = notebook.sections.find((s) => s.id === sectionId);
    if (section) return { notebook, section };
  }
  return undefined;
}

export function findPage(lib: Library, pageId: Id): { notebook: Notebook; section: Section; page: Page } | undefined {
  for (const notebook of lib.notebooks) {
    for (const section of notebook.sections) {
      const page = section.pages.find((p) => p.id === pageId);
      if (page) return { notebook, section, page };
    }
  }
  return undefined;
}

export function findOutline(lib: Library, pageId: Id, outlineId: Id): Outline | undefined {
  return findPage(lib, pageId)?.page.outlines.find((o) => o.id === outlineId);
}

export function getList(lib: Library, ref: ListRef): Element[] | undefined {
  const outline = findOutline(lib, ref.pageId, ref.outlineId);
  if (!outline) return undefined;
  if (!("tableId" in ref)) return outline.elements;
  const table = outline.elements.find((e): e is TableEl => e.id === ref.tableId && e.kind === "table");
  return table?.rows.find((r) => r.id === ref.rowId)?.cells.find((c) => c.id === ref.cellId)?.elements;
}

function touch(lib: Library, pageId: Id): void {
  const hit = findPage(lib, pageId);
  if (hit) hit.page.modifiedAt = nowIso();
}

/** Index one past the last descendant of list[i] (children follow at greater depth). */
export function subtreeEnd(list: Element[], i: number): number {
  const depth = list[i]!.depth;
  let j = i + 1;
  while (j < list.length && list[j]!.depth > depth) j++;
  return j;
}

// --- factories ---------------------------------------------------------------------

export function paragraph(runs: Run[] = [], extra: Partial<ParagraphEl> = {}): ParagraphEl {
  return { id: newId("e"), kind: "text", depth: 0, style: "p", runs, ...extra };
}

export function emptyPage(title = "", level: PageLevel = 1): Page {
  const t = nowIso();
  return { id: newId("p"), title, level, createdAt: t, modifiedAt: t, outlines: [], images: [] };
}

export function emptySection(name: string, color: string): Section {
  return { id: newId("s"), name, color, createdAt: nowIso(), pages: [emptyPage()] };
}

// --- notebooks, sections, pages ------------------------------------------------------

export function createNotebook(lib: Library, name: string): Notebook {
  const notebook: Notebook = {
    id: newId("n"),
    name,
    color: SECTION_COLORS[lib.notebooks.length % SECTION_COLORS.length]!,
    createdAt: nowIso(),
    sections: [],
  };
  notebook.sections.push(emptySection("New Section", SECTION_COLORS[0]!));
  lib.notebooks.push(notebook);
  return notebook;
}

export function createSection(lib: Library, notebookId: Id, name = "New Section"): Section {
  const nb = lib.notebooks.find((n) => n.id === notebookId)!;
  const section = emptySection(name, SECTION_COLORS[nb.sections.length % SECTION_COLORS.length]!);
  nb.sections.push(section);
  return section;
}

export function renameSection(lib: Library, sectionId: Id, name: string): void {
  const hit = findSection(lib, sectionId);
  if (hit) hit.section.name = name.trim() || hit.section.name;
}

export function setSectionColor(lib: Library, sectionId: Id, color: string): void {
  const hit = findSection(lib, sectionId);
  if (hit) hit.section.color = color;
}

export function deleteSection(lib: Library, sectionId: Id): void {
  for (const nb of lib.notebooks) nb.sections = nb.sections.filter((s) => s.id !== sectionId);
}

export function renameNotebook(lib: Library, notebookId: Id, name: string): void {
  const nb = lib.notebooks.find((n) => n.id === notebookId);
  if (nb && name.trim()) nb.name = name.trim();
}

export function deleteNotebook(lib: Library, notebookId: Id): void {
  lib.notebooks = lib.notebooks.filter((n) => n.id !== notebookId);
}

/** New page after `afterPageId` (or at the end) at the same level, like OneNote's "Add Page". */
export function createPage(lib: Library, sectionId: Id, afterPageId?: Id, level?: PageLevel): Page {
  const { section } = findSection(lib, sectionId)!;
  const idx = afterPageId ? section.pages.findIndex((p) => p.id === afterPageId) : -1;
  const page = emptyPage("", level ?? (idx >= 0 ? section.pages[idx]!.level : 1));
  if (idx >= 0) {
    // Insert after the page's own subpages.
    let j = idx + 1;
    while (j < section.pages.length && section.pages[j]!.level > section.pages[idx]!.level) j++;
    section.pages.splice(j, 0, page);
  } else section.pages.push(page);
  return page;
}

export function setPageTitle(lib: Library, pageId: Id, title: string): void {
  const hit = findPage(lib, pageId);
  if (!hit || hit.page.title === title) return;
  hit.page.title = title;
  hit.page.modifiedAt = nowIso();
}

export function deletePage(lib: Library, pageId: Id): void {
  for (const nb of lib.notebooks) for (const s of nb.sections) s.pages = s.pages.filter((p) => p.id !== pageId);
}

/** PageLevel: 1 = page, 2-3 = subpages. A page can sit at most one level below its predecessor. */
export function setPageLevel(lib: Library, pageId: Id, delta: 1 | -1): void {
  const hit = findPage(lib, pageId);
  if (!hit) return;
  const pages = hit.section.pages;
  const i = pages.indexOf(hit.page);
  const max = i === 0 ? 1 : Math.min(3, pages[i - 1]!.level + 1);
  hit.page.level = Math.max(1, Math.min(max, hit.page.level + delta)) as PageLevel;
}

export function movePage(lib: Library, pageId: Id, toIndex: number): void {
  const hit = findPage(lib, pageId);
  if (!hit) return;
  const pages = hit.section.pages;
  const from = pages.indexOf(hit.page);
  const [p] = pages.splice(from, 1);
  pages.splice(Math.max(0, Math.min(pages.length, toIndex > from ? toIndex - 1 : toIndex)), 0, p!);
  if (pages[0]) pages[0].level = 1;
}

// --- outlines -----------------------------------------------------------------------

/** Clicking empty canvas starts a new outline there (OutlineNode with OffsetFromParent*). */
export function createOutline(lib: Library, pageId: Id, x: number, y: number, first?: Element): { outline: Outline; element: Element } {
  const { page } = findPage(lib, pageId)!;
  const element = first ?? paragraph();
  const outline: Outline = { id: newId("o"), x: Math.round(x), y: Math.round(y), width: LAYOUT.outlineWidth, widthSetByUser: false, elements: [element] };
  page.outlines.push(outline);
  touch(lib, pageId);
  return { outline, element };
}

export function moveOutline(lib: Library, pageId: Id, outlineId: Id, x: number, y: number): void {
  const o = findOutline(lib, pageId, outlineId);
  if (!o) return;
  o.x = Math.round(Math.max(0, x));
  o.y = Math.round(Math.max(0, y));
  touch(lib, pageId);
}

/** Dragging the right edge sets LayoutMaxWidth and IsLayoutSizeSetByUser. */
export function resizeOutline(lib: Library, pageId: Id, outlineId: Id, width: number): void {
  const o = findOutline(lib, pageId, outlineId);
  if (!o) return;
  o.width = Math.round(Math.max(80, width));
  o.widthSetByUser = true;
  touch(lib, pageId);
}

export function deleteOutline(lib: Library, pageId: Id, outlineId: Id): void {
  const hit = findPage(lib, pageId);
  if (!hit) return;
  hit.page.outlines = hit.page.outlines.filter((o) => o.id !== outlineId);
  touch(lib, pageId);
}

export function outlineIsEmpty(o: Outline): boolean {
  return o.elements.every((e) => e.kind === "text" && textLength(e.runs) === 0 && !e.tag);
}

// --- paragraphs ---------------------------------------------------------------------

function indexIn(list: Element[], elId: Id): number {
  return list.findIndex((e) => e.id === elId);
}

export function setRuns(lib: Library, ref: ListRef, elId: Id, runs: Run[]): void {
  const list = getList(lib, ref);
  const el = list?.find((e) => e.id === elId);
  if (el?.kind !== "text") return;
  el.runs = normalizeRuns(runs);
  touch(lib, ref.pageId);
}

/**
 * Enter: split at the caret. The new paragraph keeps depth, list and an
 * unchecked copy of the tag; headings hand over to "p" (OneNote's NextStyle).
 * Enter on an empty list item ends the list, then outdents.
 */
export function splitParagraph(lib: Library, ref: ListRef, elId: Id, offset: number): { focusId: Id; offset: number } {
  const list = getList(lib, ref)!;
  const i = indexIn(list, elId);
  const el = list[i] as ParagraphEl;
  if (textLength(el.runs) === 0 && (el.list || el.depth > 0) && !el.tag) {
    if (el.list) delete el.list;
    else outdent(lib, ref, elId);
    return { focusId: elId, offset: 0 };
  }
  const [before, after] = splitRuns(el.runs, offset);
  el.runs = before;
  const next = paragraph(after, {
    depth: el.depth,
    style: el.style.startsWith("h") ? "p" : el.style,
    ...(el.list ? { list: el.list } : {}),
    ...(el.tag ? { tag: { ...el.tag, done: false } } : {}),
  });
  // Splitting at the very start keeps the new (empty) line above, like a word processor.
  if (offset === 0 && after.length) {
    el.runs = [];
    next.runs = after;
  }
  list.splice(i + 1, 0, next);
  touch(lib, ref.pageId);
  return { focusId: next.id, offset: 0 };
}

/** Backspace at the start: drop list, then outdent, then merge into the previous paragraph. */
export function backspaceAtStart(lib: Library, ref: ListRef, elId: Id): { focusId: Id; offset: number } | null {
  const list = getList(lib, ref)!;
  const i = indexIn(list, elId);
  const el = list[i] as ParagraphEl;
  if (el.list) {
    delete el.list;
    return { focusId: elId, offset: 0 };
  }
  if (el.tag) {
    delete el.tag;
    return { focusId: elId, offset: 0 };
  }
  if (el.depth > 0) {
    outdent(lib, ref, elId);
    return { focusId: elId, offset: 0 };
  }
  const prev = list[i - 1];
  if (!prev) return null;
  if (prev.kind !== "text") {
    if (textLength(el.runs) === 0) list.splice(i, 1);
    return null;
  }
  const offset = textLength(prev.runs);
  prev.runs = normalizeRuns([...prev.runs, ...el.runs]);
  // Children of the removed paragraph stay where they are, re-parented to prev.
  list.splice(i, 1);
  touch(lib, ref.pageId);
  return { focusId: prev.id, offset };
}

/** Delete at the end: pull the next paragraph's text up. */
export function deleteAtEnd(lib: Library, ref: ListRef, elId: Id): { focusId: Id; offset: number } | null {
  const list = getList(lib, ref)!;
  const i = indexIn(list, elId);
  const el = list[i] as ParagraphEl;
  const next = list[i + 1];
  if (!next || next.kind !== "text") return null;
  const offset = textLength(el.runs);
  el.runs = normalizeRuns([...el.runs, ...next.runs]);
  list.splice(i + 1, 1);
  touch(lib, ref.pageId);
  return { focusId: el.id, offset };
}

/** Move a subtree by `delta` levels; default list styles follow the new level (1. → a. → i.). */
function shiftDepth(list: Element[], i: number, delta: 1 | -1): void {
  const end = subtreeEnd(list, i);
  for (let j = i; j < end; j++) {
    const el = list[j]!;
    if (el.list && JSON.stringify(el.list) === JSON.stringify(defaultList(el.list.kind, el.depth))) {
      el.list = defaultList(el.list.kind, el.depth + delta);
    }
    el.depth += delta;
  }
}

/** Tab: indent the element and its children (ElementChildNodes move with their parent). */
export function indent(lib: Library, ref: ListRef, elId: Id): boolean {
  const list = getList(lib, ref)!;
  const i = indexIn(list, elId);
  if (i <= 0 || list[i - 1]!.depth < list[i]!.depth) return false;
  shiftDepth(list, i, 1);
  touch(lib, ref.pageId);
  return true;
}

export function outdent(lib: Library, ref: ListRef, elId: Id): boolean {
  const list = getList(lib, ref)!;
  const i = indexIn(list, elId);
  if (i < 0 || list[i]!.depth === 0) return false;
  shiftDepth(list, i, -1);
  touch(lib, ref.pageId);
  return true;
}

export function toggleList(lib: Library, ref: ListRef, elIds: Id[], kind: ListStyle["kind"]): void {
  const list = getList(lib, ref)!;
  const targets = list.filter((e) => elIds.includes(e.id));
  const allOn = targets.every((e) => e.list?.kind === kind);
  for (const e of targets) {
    if (allOn) delete e.list;
    else e.list = defaultList(kind, e.depth);
  }
  touch(lib, ref.pageId);
}

/** Ctrl+1/2/3 in OneNote apply To Do / Important / Question tags. */
export function toggleTag(lib: Library, ref: ListRef, elId: Id, kind: TagKind): void {
  const el = getList(lib, ref)?.find((e) => e.id === elId);
  if (!el) return;
  if (el.tag?.kind === kind) delete el.tag;
  else el.tag = { kind, ...(kind === "todo" ? { done: false } : {}) };
  touch(lib, ref.pageId);
}

/** ActionItemStatus bit 0: completed. */
export function toggleTodoDone(lib: Library, ref: ListRef, elId: Id): void {
  const el = getList(lib, ref)?.find((e) => e.id === elId);
  if (!el?.tag) return;
  el.tag.done = !el.tag.done;
  touch(lib, ref.pageId);
}

export function setParagraphStyle(lib: Library, ref: ListRef, elId: Id, style: ParagraphStyle): void {
  const el = getList(lib, ref)?.find((e) => e.id === elId);
  if (el?.kind !== "text") return;
  el.style = style;
  touch(lib, ref.pageId);
}

/** Ctrl+Shift+N in OneNote: back to Normal, plain runs. */
export function clearFormatting(lib: Library, ref: ListRef, elId: Id): void {
  const el = getList(lib, ref)?.find((e) => e.id === elId);
  if (el?.kind !== "text") return;
  el.style = "p";
  el.runs = normalizeRuns(el.runs.map((r) => ({ text: r.text, ...(r.href ? { href: r.href } : {}) })));
  touch(lib, ref.pageId);
}

export function insertAfter(lib: Library, ref: ListRef, afterId: Id | null, el: Element): void {
  const list = getList(lib, ref)!;
  const i = afterId ? indexIn(list, afterId) : list.length - 1;
  const anchor = list[i];
  if (anchor) el.depth = anchor.depth;
  list.splice(i >= 0 ? subtreeEnd(list, i) : list.length, 0, el);
  touch(lib, ref.pageId);
}

export function deleteElement(lib: Library, ref: ListRef, elId: Id): void {
  const list = getList(lib, ref)!;
  const i = indexIn(list, elId);
  if (i < 0) return;
  list.splice(i, 1);
  if (!list.length) list.push(paragraph());
  touch(lib, ref.pageId);
}

// --- tables ------------------------------------------------------------------------

export function newTable(rows: number, cols: number, width = 360): TableEl {
  const colW = Math.round(width / cols);
  return {
    id: newId("t"),
    kind: "table",
    depth: 0,
    borders: true,
    columns: Array.from({ length: cols }, () => colW),
    rows: Array.from({ length: rows }, () => ({
      id: newId("r"),
      cells: Array.from({ length: cols }, () => ({ id: newId("c"), elements: [paragraph()] })),
    })),
  };
}

export function findTable(lib: Library, pageId: Id, outlineId: Id, tableId: Id): TableEl | undefined {
  return findOutline(lib, pageId, outlineId)?.elements.find((e): e is TableEl => e.id === tableId && e.kind === "table");
}

export function addTableRow(lib: Library, pageId: Id, outlineId: Id, tableId: Id, afterRowId?: Id): Id | undefined {
  const t = findTable(lib, pageId, outlineId, tableId);
  if (!t) return;
  const i = afterRowId ? t.rows.findIndex((r) => r.id === afterRowId) : t.rows.length - 1;
  const row = { id: newId("r"), cells: t.columns.map(() => ({ id: newId("c"), elements: [paragraph()] as Element[] })) };
  t.rows.splice(i + 1, 0, row);
  touch(lib, pageId);
  return row.cells[0]!.elements[0]!.id;
}

export function addTableColumn(lib: Library, pageId: Id, outlineId: Id, tableId: Id, afterIndex?: number): void {
  const t = findTable(lib, pageId, outlineId, tableId);
  if (!t) return;
  const at = (afterIndex ?? t.columns.length - 1) + 1;
  t.columns.splice(at, 0, 120);
  for (const r of t.rows) r.cells.splice(at, 0, { id: newId("c"), elements: [paragraph()] });
  touch(lib, pageId);
}

export function deleteTableRow(lib: Library, pageId: Id, outlineId: Id, tableId: Id, rowId: Id): void {
  const t = findTable(lib, pageId, outlineId, tableId);
  if (!t || t.rows.length <= 1) return;
  t.rows = t.rows.filter((r) => r.id !== rowId);
  touch(lib, pageId);
}

export function deleteTableColumn(lib: Library, pageId: Id, outlineId: Id, tableId: Id, index: number): void {
  const t = findTable(lib, pageId, outlineId, tableId);
  if (!t || t.columns.length <= 1) return;
  t.columns.splice(index, 1);
  for (const r of t.rows) r.cells.splice(index, 1);
  touch(lib, pageId);
}

export function setColumnWidth(lib: Library, pageId: Id, outlineId: Id, tableId: Id, index: number, width: number): void {
  const t = findTable(lib, pageId, outlineId, tableId);
  if (!t) return;
  t.columns[index] = Math.round(Math.max(40, width));
  touch(lib, pageId);
}

// --- images -------------------------------------------------------------------------

export function addFloatingImage(lib: Library, pageId: Id, x: number, y: number, image: ImageData): FloatingImage {
  const { page } = findPage(lib, pageId)!;
  const img: FloatingImage = { id: newId("i"), x: Math.round(x), y: Math.round(y), ...image };
  page.images.push(img);
  touch(lib, pageId);
  return img;
}

export function updateFloatingImage(lib: Library, pageId: Id, imageId: Id, patch: Partial<FloatingImage>): void {
  const img = findPage(lib, pageId)?.page.images.find((i) => i.id === imageId);
  if (!img) return;
  Object.assign(img, patch);
  touch(lib, pageId);
}

export function deleteFloatingImage(lib: Library, pageId: Id, imageId: Id): void {
  const hit = findPage(lib, pageId);
  if (!hit) return;
  hit.page.images = hit.page.images.filter((i) => i.id !== imageId);
  touch(lib, pageId);
}

export function resizeInlineImage(lib: Library, ref: ListRef, elId: Id, width: number): void {
  const el = getList(lib, ref)?.find((e) => e.id === elId);
  if (el?.kind !== "image") return;
  const ratio = el.image.height / el.image.width || 1;
  el.image.width = Math.round(Math.max(24, width));
  el.image.height = Math.round(el.image.width * ratio);
  touch(lib, ref.pageId);
}

// --- search -------------------------------------------------------------------------

export function pageText(page: Page): string {
  const parts: string[] = [page.title];
  const walk = (els: Element[]) => {
    for (const e of els) {
      if (e.kind === "text") parts.push(e.runs.map((r) => r.text).join(""));
      else if (e.kind === "table") e.rows.forEach((r) => r.cells.forEach((c) => walk(c.elements)));
      else if (e.kind === "image") parts.push(e.image.ocrText ?? e.image.alt ?? "");
      else parts.push(e.name);
    }
  };
  page.outlines.forEach((o) => walk(o.elements));
  page.images.forEach((i) => parts.push(i.ocrText ?? i.alt ?? ""));
  return parts.join("\n");
}
