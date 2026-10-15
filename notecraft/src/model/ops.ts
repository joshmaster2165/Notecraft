// Pure editing operations on an (immer draft of the) Library. Behaviour follows
// OneNote where the analysis showed how the data is shaped; see the comments.
import type {
  Alignment,
  Element,
  FloatingImage,
  InkStroke,
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
  CustomTagDef,
  PageTemplate,
  PaperStyle,
  ParagraphStyle,
  Run,
  Section,
  SectionGroup,
  TableEl,
  TagKind,
} from "./types.ts";
import { LAYOUT } from "./types.ts";
import { newId, nowIso } from "../lib/id.ts";
import { normalizeRuns, splitRuns, textLength } from "../lib/richtext.ts";
import { defaultList } from "./lists.ts";
import { tagDefById } from "./tags.ts";

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

/** Any element on a page, including paragraphs inside table cells. */
export function findElement(page: Page, elementId: Id): Element | undefined {
  const walk = (els: Element[]): Element | undefined => {
    for (const e of els) {
      if (e.id === elementId) return e;
      if (e.kind === "table") for (const r of e.rows) for (const c of r.cells) {
        const hit = walk(c.elements);
        if (hit) return hit;
      }
    }
  };
  for (const o of page.outlines) {
    const hit = walk(o.elements);
    if (hit) return hit;
  }
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
  return o.elements.every((e) => e.kind === "text" && textLength(e.runs) === 0 && !e.tags?.length);
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
 * unchecked copy of its tags; headings hand over to "p" (OneNote's NextStyle).
 * Enter on an empty list item ends the list, then outdents.
 */
export function splitParagraph(lib: Library, ref: ListRef, elId: Id, offset: number): { focusId: Id; offset: number } {
  const list = getList(lib, ref)!;
  const i = indexIn(list, elId);
  const el = list[i] as ParagraphEl;
  if (textLength(el.runs) === 0 && (el.list || el.depth > 0) && !el.tags?.length) {
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
    ...(el.tags?.length ? { tags: el.tags.map((t) => (t.done === undefined ? { ...t } : { ...t, done: false })) } : {}),
    ...(el.align ? { align: el.align } : {}),
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
  if (el.tags?.length) {
    delete el.tags;
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

/** ⌘1–⌘9 / the Tags menu: add the tag, or remove it if the paragraph already has it. */
export function toggleTag(lib: Library, ref: ListRef, elId: Id, kind: TagKind): void {
  const el = getList(lib, ref)?.find((e) => e.id === elId);
  if (!el) return;
  const tags = el.tags ?? [];
  if (tags.some((t) => t.kind === kind)) {
    el.tags = tags.filter((t) => t.kind !== kind);
    if (!el.tags.length) delete el.tags;
  } else {
    const def = tagDefById(kind);
    el.tags = [...tags, { kind, ...(def?.check ? { done: false } : {}), ...(kind.startsWith("custom:") && def ? { label: def.label } : {}) }];
  }
  touch(lib, ref.pageId);
}

/** ⌘0: remove all tags. */
export function clearTags(lib: Library, ref: ListRef, elId: Id): void {
  const el = getList(lib, ref)?.find((e) => e.id === elId);
  if (!el?.tags) return;
  delete el.tags;
  touch(lib, ref.pageId);
}

/** ActionItemStatus bit 0: completed. */
export function toggleTagDone(lib: Library, ref: ListRef, elId: Id, kind: TagKind): void {
  const tag = getList(lib, ref)?.find((e) => e.id === elId)?.tags?.find((t) => t.kind === kind);
  if (!tag || tag.done === undefined) return;
  tag.done = !tag.done;
  touch(lib, ref.pageId);
}

/** ParagraphAlignment. */
export function setAlignment(lib: Library, ref: ListRef, elId: Id, align: Alignment): void {
  const el = getList(lib, ref)?.find((e) => e.id === elId);
  if (el?.kind !== "text") return;
  if (align === "left") delete el.align;
  else el.align = align;
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

/** Add a row after `afterRowId` (default: at the end), or at the top with `atStart`. */
export function addTableRow(lib: Library, pageId: Id, outlineId: Id, tableId: Id, afterRowId?: Id, atStart = false): Id | undefined {
  const t = findTable(lib, pageId, outlineId, tableId);
  if (!t) return;
  const i = atStart ? -1 : afterRowId ? t.rows.findIndex((r) => r.id === afterRowId) : t.rows.length - 1;
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

export function updateInlineImage(lib: Library, ref: ListRef, elId: Id, patch: Partial<ImageData>): void {
  const el = getList(lib, ref)?.find((e) => e.id === elId);
  if (el?.kind !== "image") return;
  Object.assign(el.image, patch);
  for (const k of Object.keys(patch) as (keyof ImageData)[]) if (patch[k] === undefined) delete el.image[k];
  touch(lib, ref.pageId);
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

// --- copying -----------------------------------------------------------------------

/** Deep copy of a page with fresh ids (Copy page, templates). */
export function clonePage(page: Page, overrides: Partial<Page> = {}): Page {
  const copy: Page = JSON.parse(JSON.stringify(page));
  const now = nowIso();
  const fresh = (els: Element[]) => {
    for (const e of els) {
      e.id = newId(e.kind === "table" ? "t" : "e");
      if (e.kind === "table") {
        for (const r of e.rows) {
          r.id = newId("r");
          for (const c of r.cells) {
            c.id = newId("c");
            fresh(c.elements);
          }
        }
      }
    }
  };
  copy.id = newId("p");
  copy.createdAt = now;
  copy.modifiedAt = now;
  for (const o of copy.outlines) {
    o.id = newId("o");
    fresh(o.elements);
  }
  for (const i of copy.images) i.id = newId("i");
  for (const k of copy.ink ?? []) k.id = newId("k");
  return Object.assign(copy, overrides);
}

// --- section groups ------------------------------------------------------------------

export function createSectionGroup(lib: Library, notebookId: Id, name = "New Section Group", parentId?: Id): SectionGroup {
  const nb = lib.notebooks.find((n) => n.id === notebookId)!;
  const group: SectionGroup = { id: newId("g"), name, ...(parentId ? { parentId } : {}) };
  (nb.groups ??= []).push(group);
  return group;
}

export function renameSectionGroup(lib: Library, groupId: Id, name: string): void {
  for (const nb of lib.notebooks) {
    const g = nb.groups?.find((x) => x.id === groupId);
    if (g && name.trim()) g.name = name.trim();
  }
}

export function toggleGroupCollapsed(lib: Library, groupId: Id): void {
  for (const nb of lib.notebooks) {
    const g = nb.groups?.find((x) => x.id === groupId);
    if (g) g.collapsed = !g.collapsed;
  }
}

/** Deleting a group keeps its contents: sections and subgroups move up a level. */
export function deleteSectionGroup(lib: Library, groupId: Id): void {
  for (const nb of lib.notebooks) {
    const g = nb.groups?.find((x) => x.id === groupId);
    if (!g) continue;
    for (const s of nb.sections) if (s.groupId === groupId) g.parentId ? (s.groupId = g.parentId) : delete s.groupId;
    for (const sub of nb.groups!) if (sub.parentId === groupId) g.parentId ? (sub.parentId = g.parentId) : delete sub.parentId;
    nb.groups = nb.groups!.filter((x) => x.id !== groupId);
  }
}

/** A group and every group nested inside it. */
export function groupFamily(nb: Notebook, groupId: Id): Set<Id> {
  const ids = new Set([groupId]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const g of nb.groups ?? []) if (g.parentId && ids.has(g.parentId) && !ids.has(g.id)) (ids.add(g.id), (grew = true));
  }
  return ids;
}

/** "Move Section Group": the group, its subgroups and their sections go into another notebook or group. */
export function moveSectionGroup(lib: Library, groupId: Id, to: { notebookId: Id; parentId?: Id }): boolean {
  const from = lib.notebooks.find((n) => n.groups?.some((g) => g.id === groupId));
  const target = lib.notebooks.find((n) => n.id === to.notebookId);
  if (!from || !target) return false;
  const family = groupFamily(from, groupId);
  if (to.parentId && family.has(to.parentId)) return false;
  const group = from.groups!.find((g) => g.id === groupId)!;
  if (to.parentId) group.parentId = to.parentId;
  else delete group.parentId;
  if (from === target) return true;
  const groups = from.groups!.filter((g) => family.has(g.id));
  const sections = from.sections.filter((s) => s.groupId && family.has(s.groupId));
  from.groups = from.groups!.filter((g) => !family.has(g.id));
  from.sections = from.sections.filter((s) => !sections.includes(s));
  (target.groups ??= []).push(...groups);
  target.sections.push(...sections);
  if (!from.sections.length) from.sections.push(emptySection("New Section", SECTION_COLORS[0]!));
  return true;
}

/**
 * Move a section (drag in the sidebar, or "Move or Copy Section"): into another
 * notebook and/or group, before `beforeSectionId` or at the end.
 */
export function moveSection(lib: Library, sectionId: Id, to: { notebookId: Id; groupId?: Id; beforeSectionId?: Id }): void {
  const hit = findSection(lib, sectionId);
  if (!hit || to.beforeSectionId === sectionId) return;
  hit.notebook.sections = hit.notebook.sections.filter((s) => s.id !== sectionId);
  const target = lib.notebooks.find((n) => n.id === to.notebookId)!;
  const section = hit.section;
  if (to.groupId) section.groupId = to.groupId;
  else delete section.groupId;
  const at = to.beforeSectionId ? target.sections.findIndex((s) => s.id === to.beforeSectionId) : -1;
  if (at >= 0) target.sections.splice(at, 0, section);
  else target.sections.push(section);
  if (!hit.notebook.sections.length) hit.notebook.sections.push(emptySection("New Section", SECTION_COLORS[0]!));
}

// --- move / copy pages ---------------------------------------------------------------------

/** "Move or Copy Pages": the page (and its subpages) go to the end of another section. Returns the (new) page id. */
export function movePageToSection(lib: Library, pageId: Id, sectionId: Id, copy = false): Id | undefined {
  const hit = findPage(lib, pageId);
  const target = findSection(lib, sectionId)?.section;
  if (!hit || !target) return;
  const pages = hit.section.pages;
  const i = pages.indexOf(hit.page);
  let j = i + 1;
  while (j < pages.length && pages[j]!.level > hit.page.level) j++;
  const family = pages.slice(i, j);
  const base = family[0]!.level - 1;
  const moved = family.map((p) => {
    const out = copy ? clonePage(p) : p;
    return Object.assign(out, { level: Math.max(1, p.level - base) as PageLevel });
  });
  if (!copy) {
    if (hit.section === target) return hit.page.id;
    pages.splice(i, j - i);
    if (!pages.length) pages.push(emptyPage());
  }
  target.pages.push(...moved);
  return moved[0]!.id;
}

// --- Deleted Notes -----------------------------------------------------------------------

export const TRASH_DAYS = 60;

export function trashPage(lib: Library, pageId: Id): void {
  const hit = findPage(lib, pageId);
  if (!hit) return;
  (hit.notebook.trash ??= []).unshift({ kind: "page", page: hit.page, sectionId: hit.section.id, sectionName: hit.section.name, deletedAt: nowIso() });
  hit.section.pages = hit.section.pages.filter((p) => p.id !== pageId);
  if (!hit.section.pages.length) hit.section.pages.push(emptyPage());
}

export function trashSection(lib: Library, sectionId: Id): void {
  const hit = findSection(lib, sectionId);
  if (!hit) return;
  (hit.notebook.trash ??= []).unshift({ kind: "section", section: hit.section, deletedAt: nowIso() });
  hit.notebook.sections = hit.notebook.sections.filter((s) => s.id !== sectionId);
  if (!hit.notebook.sections.length) hit.notebook.sections.push(emptySection("New Section", SECTION_COLORS[0]!));
}

/** Put an item back where it was (or into the first section if that section is gone). Returns the restored page or section id. */
export function restoreFromTrash(lib: Library, notebookId: Id, index: number): Id | undefined {
  const nb = lib.notebooks.find((n) => n.id === notebookId);
  const item = nb?.trash?.[index];
  if (!nb || !item) return;
  nb.trash!.splice(index, 1);
  if (item.kind === "section") {
    nb.sections.push(item.section);
    return item.section.id;
  }
  const section = nb.sections.find((s) => s.id === item.sectionId) ?? nb.sections[0]!;
  section.pages.push({ ...item.page, level: 1 });
  return item.page.id;
}

export function purgeTrash(lib: Library, notebookId: Id, index?: number): void {
  const nb = lib.notebooks.find((n) => n.id === notebookId);
  if (!nb?.trash) return;
  if (index === undefined) nb.trash = [];
  else nb.trash.splice(index, 1);
}

/** Items older than TRASH_DAYS are removed for good, as in OneNote. */
export function expireTrash(lib: Library, now = Date.now()): void {
  const cutoff = now - TRASH_DAYS * 86_400_000;
  for (const nb of lib.notebooks) {
    if (nb.trash?.some((t) => Date.parse(t.deletedAt) < cutoff)) nb.trash = nb.trash.filter((t) => Date.parse(t.deletedAt) >= cutoff);
  }
}

// --- ink, paper, title ----------------------------------------------------------------------

export function addInkStroke(lib: Library, pageId: Id, stroke: InkStroke): void {
  const hit = findPage(lib, pageId);
  if (!hit) return;
  (hit.page.ink ??= []).push(stroke);
  touch(lib, pageId);
}

export function removeInkStrokes(lib: Library, pageId: Id, ids: Id[]): void {
  const hit = findPage(lib, pageId);
  if (!hit?.page.ink) return;
  hit.page.ink = hit.page.ink.filter((k) => !ids.includes(k.id));
  touch(lib, pageId);
}

export function moveInkStrokes(lib: Library, pageId: Id, ids: Id[], dx: number, dy: number): void {
  const hit = findPage(lib, pageId);
  if (!hit?.page.ink) return;
  for (const k of hit.page.ink) {
    if (!ids.includes(k.id)) continue;
    k.points = k.points.map((v, i) => Math.round((v + (i % 2 ? dy : dx)) * 10) / 10);
  }
  touch(lib, pageId);
}

export function setPaper(lib: Library, pageId: Id, patch: Partial<PaperStyle>): void {
  const hit = findPage(lib, pageId);
  if (!hit) return;
  const next = { ...hit.page.paper, ...patch };
  for (const k of Object.keys(next) as (keyof PaperStyle)[]) if (next[k] === undefined) delete next[k];
  hit.page.paper = next;
  touch(lib, pageId);
}

export function setHideTitle(lib: Library, pageId: Id, hide: boolean): void {
  const hit = findPage(lib, pageId);
  if (!hit) return;
  if (hide) hit.page.hideTitle = true;
  else delete hit.page.hideTitle;
}

// --- templates --------------------------------------------------------------------------------

export function saveTemplate(lib: Library, name: string, page: Page): PageTemplate {
  const t: PageTemplate = { id: newId("tp"), name, page: clonePage(page) };
  (lib.templates ??= []).push(t);
  return t;
}

export function deleteTemplate(lib: Library, templateId: Id): void {
  lib.templates = (lib.templates ?? []).filter((t) => t.id !== templateId);
}

export function createPageFromTemplate(lib: Library, sectionId: Id, template: Page, afterPageId?: Id): Page {
  const page = createPage(lib, sectionId, afterPageId);
  const fresh = clonePage(template, { id: page.id, level: page.level });
  Object.assign(page, fresh);
  return page;
}

// --- more table commands (OneNote Table tab) -----------------------------------------------

export function setTableBorders(lib: Library, pageId: Id, outlineId: Id, tableId: Id, borders: boolean): void {
  const t = findTable(lib, pageId, outlineId, tableId);
  if (!t) return;
  t.borders = borders;
  touch(lib, pageId);
}

export function setCellShading(lib: Library, ref: Extract<ListRef, { tableId: Id }>, color: string | null): void {
  const cell = findTable(lib, ref.pageId, ref.outlineId, ref.tableId)?.rows.find((r) => r.id === ref.rowId)?.cells.find((c) => c.id === ref.cellId);
  if (!cell) return;
  if (color) cell.shading = color;
  else delete cell.shading;
  touch(lib, ref.pageId);
}

/** Sort rows by a column's text; a first row that looks like a header stays on top. */
export function sortTable(lib: Library, pageId: Id, outlineId: Id, tableId: Id, col: number): void {
  const t = findTable(lib, pageId, outlineId, tableId);
  if (!t || col < 0 || t.rows.length < 2) return;
  const text = (r: TableEl["rows"][number]) =>
    (r.cells[col]?.elements ?? []).map((e) => (e.kind === "text" ? e.runs.map((x) => x.text).join("") : "")).join(" ").trim();
  const isHeader = t.rows[0]!.cells.every((c) => c.elements.every((e) => e.kind !== "text" || e.runs.every((r) => r.b)));
  const head = isHeader ? t.rows.slice(0, 1) : [];
  const body = (isHeader ? t.rows.slice(1) : t.rows).slice();
  body.sort((a, b) => text(a).localeCompare(text(b), undefined, { numeric: true, sensitivity: "base" }));
  t.rows = [...head, ...body];
  touch(lib, pageId);
}

// --- custom tags (Customize Tags) ------------------------------------------------------------

/** Add tag definitions that aren't registered yet (by id). */
export function mergeCustomTags(lib: Library, defs: CustomTagDef[]): void {
  if (!defs.length) return;
  const have = new Set((lib.customTags ?? []).map((t) => t.id));
  const add = defs.filter((d) => !have.has(d.id));
  if (add.length) lib.customTags = [...(lib.customTags ?? []), ...add];
}

export function saveCustomTag(lib: Library, def: CustomTagDef): void {
  const list = (lib.customTags ??= []);
  const i = list.findIndex((t) => t.id === def.id);
  if (i >= 0) list[i] = def;
  else list.push(def);
}

/** Deleting a tag definition keeps the tags on notes; they show their label. */
export function deleteCustomTag(lib: Library, id: string): void {
  lib.customTags = (lib.customTags ?? []).filter((t) => t.id !== id);
}

// --- paragraph spacing and list formats --------------------------------------------------------

/** Paragraph Spacing Options: before / after / line spacing at least (points; 0 or undefined clears). */
export function setParagraphSpacing(lib: Library, ref: ListRef, elId: Id, patch: { spaceBefore?: number; spaceAfter?: number; lineSpacing?: number }): void {
  const el = getList(lib, ref)?.find((e) => e.id === elId);
  if (el?.kind !== "text") return;
  for (const k of ["spaceBefore", "spaceAfter", "lineSpacing"] as const) {
    if (!(k in patch)) continue;
    const v = patch[k];
    if (v) el[k] = v;
    else delete el[k];
  }
  touch(lib, ref.pageId);
}

/** Bullet / numbering library: apply a specific list format (null removes the list). */
export function setListStyle(lib: Library, ref: ListRef, elId: Id, list: ListStyle | null): void {
  const el = getList(lib, ref)?.find((e) => e.id === elId);
  if (!el) return;
  if (list) el.list = list;
  else delete el.list;
  touch(lib, ref.pageId);
}

/** Restart numbering at `start` from this item, or continue the previous list (start undefined). */
export function setListStart(lib: Library, ref: ListRef, elId: Id, start: number | undefined): void {
  const el = getList(lib, ref)?.find((e) => e.id === elId);
  if (el?.list?.kind !== "numbered") return;
  if (start) el.list = { ...el.list, start };
  else {
    const { start: _s, ...rest } = el.list;
    el.list = rest;
  }
  touch(lib, ref.pageId);
}
