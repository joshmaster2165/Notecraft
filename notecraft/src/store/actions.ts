// App-level actions: selection, CRUD with sensible focus, import/export.
import type { Element, Id, Library, ListRef, Page, Run } from "../model/types.ts";
import { LAYOUT } from "../model/types.ts";
import * as ops from "../model/ops.ts";
import { importOneFile, type ImportResult } from "../model/importOne.ts";
import { listMarkers } from "../model/lists.ts";
import { normalizeRuns, splitRuns, textLength } from "../lib/richtext.ts";
import { newId } from "../lib/id.ts";
import { store } from "./store.ts";
import { addImportedVersions } from "./versionStore.ts";
import { persistSelection } from "./persist.ts";

const lib = () => store.getState().lib;

export function currentPage(): Page | undefined {
  const id = store.getState().ui.pageId;
  return id ? ops.findPage(lib(), id)?.page : undefined;
}

// --- selection ----------------------------------------------------------------------

export function selectPage(pageId: Id) {
  const hit = ops.findPage(lib(), pageId);
  if (!hit) return;
  store.setUi({ notebookId: hit.notebook.id, sectionId: hit.section.id, pageId, active: null, preview: null });
  persistSelection();
}

export function selectSection(sectionId: Id) {
  const hit = ops.findSection(lib(), sectionId);
  if (!hit) return;
  store.setUi({ notebookId: hit.notebook.id, sectionId, pageId: hit.section.pages[0]?.id ?? null, active: null, preview: null });
  persistSelection();
}

export function selectNotebook(notebookId: Id) {
  const nb = lib().notebooks.find((n) => n.id === notebookId);
  const s = nb?.sections[0];
  store.setUi({ notebookId, sectionId: s?.id ?? null, pageId: s?.pages[0]?.id ?? null, active: null, preview: null });
  persistSelection();
}

/** After undo/deletes the selection may point at nothing; fall back to neighbours. */
export function repairSelection() {
  const { notebookId, sectionId, pageId } = store.getState().ui;
  const l = lib();
  if (pageId && ops.findPage(l, pageId)) return;
  const sec = sectionId ? ops.findSection(l, sectionId) : undefined;
  if (sec) {
    store.setUi({ pageId: sec.section.pages[0]?.id ?? null });
    return;
  }
  const nb = l.notebooks.find((n) => n.id === notebookId) ?? l.notebooks[0];
  store.setUi({ notebookId: nb?.id ?? null, sectionId: nb?.sections[0]?.id ?? null, pageId: nb?.sections[0]?.pages[0]?.id ?? null });
}

// --- notebooks / sections / pages ---------------------------------------------------

export function newNotebook() {
  const nb = store.edit((d) => ops.createNotebook(d, `Notebook ${d.notebooks.length + 1}`));
  selectNotebook(nb.id);
}

export function newSection() {
  const { notebookId } = store.getState().ui;
  if (!notebookId) return;
  const s = store.edit((d) => ops.createSection(d, notebookId));
  selectSection(s.id);
  return s.id;
}

export function newPage(opts: { asSubpage?: boolean } = {}) {
  const { sectionId, pageId } = store.getState().ui;
  if (!sectionId) return;
  const page = store.edit((d) => {
    const after = pageId ?? undefined;
    const base = after ? ops.findPage(d, after)?.page.level ?? 1 : 1;
    return ops.createPage(d, sectionId, after, opts.asSubpage ? (Math.min(3, base + 1) as Page["level"]) : undefined);
  });
  selectPage(page.id);
  requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-title-for="${page.id}"]`)?.focus());
}

export function deletePage(pageId: Id) {
  const hit = ops.findPage(lib(), pageId);
  if (!hit) return;
  const pages = hit.section.pages;
  const i = pages.indexOf(hit.page);
  const neighbour = pages[i + 1] ?? pages[i - 1];
  store.edit((d) => {
    ops.deletePage(d, pageId);
    const s = ops.findSection(d, hit.section.id)?.section;
    if (s && !s.pages.length) s.pages.push(ops.emptyPage());
  });
  const s = ops.findSection(lib(), hit.section.id)?.section;
  selectPage(neighbour?.id ?? s!.pages[0]!.id);
  store.toast(`Deleted “${hit.page.title || "Untitled page"}” · ⌘Z to undo`);
}

export function deleteSection(sectionId: Id) {
  const hit = ops.findSection(lib(), sectionId);
  if (!hit) return;
  store.edit((d) => {
    ops.deleteSection(d, sectionId);
    const nb = d.notebooks.find((n) => n.id === hit.notebook.id);
    if (nb && !nb.sections.length) nb.sections.push(ops.emptySection("New Section", ops.SECTION_COLORS[0]!));
  });
  const nb = lib().notebooks.find((n) => n.id === hit.notebook.id)!;
  selectSection(nb.sections[0]!.id);
  store.toast(`Deleted section “${hit.section.name}” · ⌘Z to undo`);
}

// --- editing helpers used by the canvas ---------------------------------------------

export function createOutlineAt(pageId: Id, x: number, y: number) {
  const { element } = store.edit((d) => ops.createOutline(d, pageId, x, y));
  store.focus(element.id, 0);
}

/** Enter in the title jumps into the body, creating the first outline if needed. */
export function focusBody(pageId: Id) {
  const page = ops.findPage(lib(), pageId)?.page;
  if (!page) return;
  const first = [...page.outlines].sort((a, b) => a.y - b.y || a.x - b.x)[0];
  const el = first?.elements.find((e) => e.kind === "text");
  if (el) store.focus(el.id, 0);
  else createOutlineAt(pageId, LAYOUT.bodyX, LAYOUT.bodyY);
}

/** Paste multi-line plain text as one paragraph per line, the way OneNote does. */
export function pasteLines(ref: ListRef, elId: Id, offset: number, lines: string[]) {
  const result = store.edit((d) => {
    const list = ops.getList(d, ref)!;
    const i = list.findIndex((e) => e.id === elId);
    const el = list[i];
    if (el?.kind !== "text") return null;
    const [before, after] = splitRuns(el.runs, offset);
    el.runs = normalizeRuns([...before, { text: lines[0]! }]);
    const added: Element[] = lines.slice(1).map((line, k, arr) =>
      ops.paragraph(normalizeRuns(k === arr.length - 1 ? [{ text: line }, ...after] : [{ text: line }]), {
        depth: el.depth,
        style: el.style,
        ...(el.list ? { list: el.list } : {}),
      }),
    );
    list.splice(i + 1, 0, ...added);
    const last = added[added.length - 1]!;
    return { id: last.id, offset: lines[lines.length - 1]!.length };
  });
  if (result) store.focus(result.id, result.offset);
}

export function insertImageFiles(files: File[], target: { ref: ListRef; afterId: Id } | { pageId: Id; x: number; y: number }) {
  for (const file of files) {
    if (!file.type.startsWith("image/")) continue;
    const reader = new FileReader();
    reader.onload = () => {
      const src = String(reader.result);
      const probe = new Image();
      probe.onload = () => {
        const scale = Math.min(1, 480 / probe.naturalWidth);
        const image = { src, width: Math.round(probe.naturalWidth * scale), height: Math.round(probe.naturalHeight * scale), filename: file.name };
        store.edit((d) => {
          if ("ref" in target) ops.insertAfter(d, target.ref, target.afterId, { id: newId("e"), kind: "image", depth: 0, image });
          else ops.addFloatingImage(d, target.pageId, target.x, target.y, image);
        });
      };
      probe.src = src;
    };
    reader.readAsDataURL(file);
  }
}

// --- import / export ------------------------------------------------------------------

export async function importFiles(files: File[]) {
  const oneFiles = files.filter((f) => /\.one$/i.test(f.name));
  const jsonFiles = files.filter((f) => /\.json$/i.test(f.name));
  for (const f of jsonFiles) await importLibraryJson(f);
  if (!oneFiles.length) return;
  const { notebookId } = store.getState().ui;
  const results: ImportResult[] = [];
  const failures: string[] = [];
  for (const f of oneFiles) {
    try {
      results.push(importOneFile(new Uint8Array(await f.arrayBuffer()), f.name));
    } catch (e) {
      console.error(e);
      failures.push(`${f.name}: ${(e as Error).message}`);
    }
  }
  if (results.length) {
    store.edit((d) => {
      const nb = d.notebooks.find((n) => n.id === notebookId) ?? d.notebooks[0]!;
      nb.sections.push(...results.map((r) => r.section));
    });
    selectSection(results[0]!.section.id);
    const history = results.flatMap((r) => r.versions);
    const savedVersions = await addImportedVersions(history).catch((e) => {
      console.error("Notecraft: could not store imported page versions", e);
      return 0;
    });
    const pages = results.reduce((n, r) => n + r.stats.pages, 0);
    const missing = results.reduce((n, r) => n + r.stats.imagesWithoutData, 0);
    store.toast(
      `Imported ${results.length} section${results.length > 1 ? "s" : ""}, ${pages} page${pages === 1 ? "" : "s"}` +
        (savedVersions ? ` with ${savedVersions} earlier version${savedVersions === 1 ? "" : "s"}` : "") +
        (missing ? ` · ${missing} image${missing === 1 ? "" : "s"} had no data in the file` : ""),
    );
  }
  if (failures.length) store.toast(`Could not import ${failures.join("; ")}`);
}

async function importLibraryJson(file: File) {
  try {
    // "onecraft" is the format key used before the app was renamed.
    const data = JSON.parse(await file.text()) as Library | { notecraft?: 1; onecraft?: 1; notebook: Library["notebooks"][number] };
    if (("notecraft" in data || "onecraft" in data) && "notebook" in data && data.notebook) {
      store.edit((d) => {
        d.notebooks.push(data.notebook);
      });
      selectNotebook(data.notebook.id);
      store.toast(`Imported notebook “${data.notebook.name}”`);
    } else store.toast(`${file.name} is not a Notecraft export`);
  } catch {
    store.toast(`${file.name} is not valid JSON`);
  }
}

function download(name: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const safeName = (s: string) => s.replace(/[\\/:*?"<>|]+/g, "-").trim() || "untitled";

export function exportNotebook() {
  const nb = lib().notebooks.find((n) => n.id === store.getState().ui.notebookId);
  if (!nb) return;
  download(`${safeName(nb.name)}.notecraft.json`, JSON.stringify({ notecraft: 1, notebook: nb }), "application/json");
}

function runsToMarkdown(runs: Run[]): string {
  return runs
    .map((r) => {
      let t = r.text.replace(/([*_`[\]])/g, "\\$1");
      if (!t.trim()) return t;
      if (r.b) t = `**${t}**`;
      if (r.i) t = `*${t}*`;
      if (r.s) t = `~~${t}~~`;
      if (r.href) t = `[${t}](${r.href})`;
      return t;
    })
    .join("");
}

function elementsToMarkdown(els: Element[]): string[] {
  const markers = listMarkers(els);
  return els.flatMap((e, i) => {
    const pad = "  ".repeat(e.depth);
    if (e.kind === "text") {
      const text = runsToMarkdown(e.runs);
      const h = /^h([1-6])$/.exec(e.style);
      const tag = e.tag?.kind === "todo" ? (e.tag.done ? "[x] " : "[ ] ") : e.tag ? `(${e.tag.label ?? e.tag.kind}) ` : "";
      if (h) return [`${"#".repeat(Number(h[1]) + 1)} ${text}`];
      if (e.list) return [`${pad}${e.list.kind === "bullet" ? "-" : markers[i]} ${tag}${text}`];
      if (e.tag?.kind === "todo") return [`${pad}- ${tag}${text}`];
      return [`${pad}${tag}${text}`];
    }
    if (e.kind === "table") {
      const rows = e.rows.map((r) => `| ${r.cells.map((c) => elementsToMarkdown(c.elements).join(" ").replace(/\|/g, "\\|")).join(" | ")} |`);
      return [rows[0]!, `|${e.columns.map(() => " --- ").join("|")}|`, ...rows.slice(1)];
    }
    if (e.kind === "image") return [`${pad}![${e.image.alt ?? e.image.filename ?? "image"}](${e.image.src ? "embedded-image" : ""})`];
    return [`${pad}📎 ${e.name}`];
  });
}

export function exportPageMarkdown() {
  const page = currentPage();
  if (!page) return;
  const outlines = [...page.outlines].sort((a, b) => a.y - b.y || a.x - b.x);
  const md = [`# ${page.title || "Untitled page"}`, "", ...outlines.flatMap((o) => [...elementsToMarkdown(o.elements), ""])].join("\n");
  download(`${safeName(page.title || "page")}.md`, md, "text/markdown");
}

export function isEmptyParagraph(e: Element): boolean {
  return e.kind === "text" && textLength(e.runs) === 0;
}
