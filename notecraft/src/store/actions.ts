// App-level actions: selection, CRUD with sensible focus, import/export.
import type { Element, Id, Library, ListRef, NoteTag, Page, Run } from "../model/types.ts";
import { LAYOUT } from "../model/types.ts";
import * as ops from "../model/ops.ts";
import { importNotebookJson, importOneFile, type ImportResult } from "../model/importOne.ts";
import { assembleNotebook, type FolderSection, type FolderToc } from "../model/notebookImport.ts";
import { parseToc } from "../model/parser.ts";
import { desktop, type FoundSection } from "../desktop.ts";
import { invoke } from "@tauri-apps/api/core";
import { listMarkers } from "../model/lists.ts";
import { tagLabel } from "../model/tags.ts";
import { migrateLibrary } from "../model/migrate.ts";
import { normalizeRuns, splitRuns, textLength } from "../lib/richtext.ts";
import { newId } from "../lib/id.ts";
import type { PastedBlock } from "../lib/paste.ts";
import { pageHref } from "./links.ts";
import { store } from "./store.ts";
import { addImportedVersions } from "./versionStore.ts";
import { flushLibrary, persistSelection } from "./persist.ts";

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
  store.edit((d) => ops.trashPage(d, pageId));
  const s = ops.findSection(lib(), hit.section.id)?.section;
  selectPage(neighbour?.id ?? s!.pages[0]!.id);
  store.toast(`Moved “${hit.page.title || "Untitled page"}” to Deleted Notes · ⌘Z to undo`);
}

export function deleteSection(sectionId: Id) {
  const hit = ops.findSection(lib(), sectionId);
  if (!hit) return;
  store.edit((d) => ops.trashSection(d, sectionId));
  const nb = lib().notebooks.find((n) => n.id === hit.notebook.id)!;
  selectSection(nb.sections[0]!.id);
  store.toast(`Moved section “${hit.section.name}” to Deleted Notes · ⌘Z to undo`);
}

// --- Deleted Notes, move/copy, groups, templates ----------------------------------------------

export function restoreFromTrash(notebookId: Id, index: number) {
  const id = store.edit((d) => ops.restoreFromTrash(d, notebookId, index));
  if (!id) return;
  if (ops.findPage(lib(), id)) selectPage(id);
  else selectSection(id);
  store.toast("Restored from Deleted Notes");
}

export function movePage(pageId: Id, sectionId: Id, copy: boolean) {
  const id = store.edit((d) => ops.movePageToSection(d, pageId, sectionId, copy));
  if (!id) return;
  const hit = ops.findPage(lib(), id);
  selectPage(id);
  store.toast(`${copy ? "Copied" : "Moved"} “${hit?.page.title || "Untitled page"}” to ${hit?.section.name ?? "the section"}`);
}

export function moveSectionTo(sectionId: Id, notebookId: Id, groupId?: Id) {
  store.edit((d) => ops.moveSection(d, sectionId, { notebookId, ...(groupId ? { groupId } : {}) }));
  selectSection(sectionId);
}

export function newSectionGroup(parentId?: Id) {
  const { notebookId } = store.getState().ui;
  if (!notebookId) return;
  return store.edit((d) => ops.createSectionGroup(d, notebookId, "New Section Group", parentId)).id;
}

export function newPageFromTemplate(template: Page) {
  const { sectionId, pageId } = store.getState().ui;
  if (!sectionId) return;
  const page = store.edit((d) => ops.createPageFromTemplate(d, sectionId, template, pageId ?? undefined));
  selectPage(page.id);
}

export function saveCurrentPageAsTemplate(name: string) {
  const page = currentPage();
  if (!page || !name.trim()) return;
  store.edit((d) => ops.saveTemplate(d, name.trim(), page));
  store.toast(`Saved “${name.trim()}” as a template`);
}

/** Insert > File. OneNote refuses very large attachments; so does Notecraft. */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export function insertAttachments(files: File[], target: { ref: ListRef; afterId: Id } | { pageId: Id; x: number; y: number }) {
  for (const file of files) {
    if (file.size > MAX_ATTACHMENT_BYTES) {
      store.toast(`“${file.name}” is larger than 25 MB, so it wasn't attached.`);
      continue;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const el = { id: newId("e"), kind: "file" as const, depth: 0, name: file.name, size: file.size, src: String(reader.result) };
      store.edit((d) => {
        if ("ref" in target) ops.insertAfter(d, target.ref, target.afterId, el);
        else ops.createOutline(d, target.pageId, target.x, target.y, el);
      });
    };
    reader.readAsDataURL(file);
  }
}

/** Print the current page (the system dialog also offers Save as PDF). */
export function printPage() {
  document.body.classList.add("is-printing");
  const done = () => {
    document.body.classList.remove("is-printing");
    window.removeEventListener("afterprint", done);
  };
  window.addEventListener("afterprint", done);
  // The desktop web view prints through the app; browsers print themselves.
  if (desktop) setTimeout(() => void invoke("print_page").catch((e) => store.toast(String(e))).finally(() => setTimeout(done, 1500)), 50);
  else setTimeout(() => window.print(), 50);
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

export interface SummaryItem {
  tag: NoteTag;
  text: string;
  pageId: Id;
  pageTitle: string;
  elementId: Id;
}

/**
 * Find Tags › "Create Summary Page": a new page in the current section listing
 * every tagged note under its tag, each with a link back to where it lives.
 */
export function createTagSummaryPage(groups: [string, SummaryItem[]][]) {
  const sectionId = store.getState().ui.sectionId;
  if (!sectionId || !groups.length) return;
  const pageId = store.edit((d) => {
    const page = ops.createPage(d, sectionId);
    page.title = "Tags Summary";
    const els: Element[] = [ops.paragraph([{ text: `Created ${new Date().toLocaleString()}`, i: true, color: "#727780" }])];
    for (const [, items] of groups) {
      els.push(ops.paragraph([{ text: tagLabel(items[0]!.tag) }], { style: "h2" }));
      for (const h of items) {
        const text = h.text.trim() || "(empty line)";
        els.push(
          ops.paragraph(normalizeRuns([{ text }, { text: "  " }, { text: h.pageTitle, href: pageHref(h.pageId, h.elementId), color: "#727780" }]), {
            tags: [{ ...h.tag }],
          }),
        );
      }
    }
    page.outlines.push({ id: newId("o"), x: LAYOUT.bodyX, y: LAYOUT.bodyY, width: 620, widthSetByUser: true, elements: els });
    return page.id;
  });
  selectPage(pageId);
  store.toast("Created a Tags Summary page in this section.");
}

/**
 * Paste with formatting. Plain text joins the paragraph at the caret; headings
 * and list items start their own paragraphs. Text after the caret follows the
 * last pasted block.
 */
export function pasteBlocks(ref: ListRef, elId: Id, offset: number, blocks: PastedBlock[]) {
  if (!blocks.length) return;
  const result = store.edit((d) => {
    const list = ops.getList(d, ref)!;
    const i = list.findIndex((e) => e.id === elId);
    const el = list[i];
    if (el?.kind !== "text") return null;
    const [before, after] = splitRuns(el.runs, offset);
    const first = blocks[0]!;
    const structured = !!(first.style || first.list);
    if (blocks.length === 1 && !structured) {
      el.runs = normalizeRuns([...before, ...first.runs, ...after]);
      return { id: el.id, offset: textLength(before) + textLength(first.runs) };
    }
    // Into an empty line, the first block takes over that paragraph.
    const reuse = !textLength(before) && !textLength(after);
    const mergeFirst = !structured || reuse;
    const rest = mergeFirst ? blocks.slice(1) : blocks;
    if (mergeFirst) {
      el.runs = normalizeRuns([...before, ...first.runs, ...(rest.length ? [] : after)]);
      if (reuse) {
        el.style = first.style ?? "p";
        if (first.list) el.list = first.list;
        else delete el.list;
        el.depth += first.depth ?? 0;
      }
    } else el.runs = normalizeRuns(before);
    const added: Element[] = rest.map((b, k) =>
      ops.paragraph(normalizeRuns(k === rest.length - 1 ? [...b.runs, ...after] : b.runs), {
        depth: el.depth + (b.depth ?? 0) - (reuse ? first.depth ?? 0 : 0),
        style: b.style ?? "p",
        ...(b.list ? { list: b.list } : {}),
      }),
    );
    list.splice(i + 1, 0, ...added);
    const last = added[added.length - 1];
    return last ? { id: last.id, offset: textLength(rest[rest.length - 1]!.runs) } : { id: el.id, offset: textLength(el.runs) };
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
  const tocFile = files.find((f) => /\.onetoc2$/i.test(f.name));
  const jsonFiles = files.filter((f) => /\.json$/i.test(f.name));
  for (const f of jsonFiles) await importLibraryJson(f);
  if (!oneFiles.length) return;
  const { notebookId } = store.getState().ui;
  const results: ImportResult[] = [];
  const failures: string[] = [];
  const placed: FolderSection[] = [];
  for (const f of oneFiles) {
    try {
      const r = await importOneFile(new Uint8Array(await f.arrayBuffer()), f.name);
      results.push(r);
      placed.push({ dir: "", fileName: f.name, section: r.section, colorFromFile: r.colorFromFile });
    } catch (e) {
      console.error(e);
      failures.push(`${f.name}: ${(e as Error).message}`);
    }
  }
  // Sections picked together with their notebook's .onetoc2 follow its order and colors.
  const tocs: FolderToc[] = [];
  if (tocFile) {
    try {
      tocs.push({ dir: "", toc: await parseToc(new Uint8Array(await tocFile.arrayBuffer())) });
    } catch (e) {
      console.warn("Notecraft: could not read", tocFile.name, e);
    }
  }
  const ordered = assembleNotebook(placed, tocs).sections;
  if (results.length) {
    store.edit((d) => {
      const nb = d.notebooks.find((n) => n.id === notebookId) ?? d.notebooks[0]!;
      nb.sections.push(...ordered);
      ops.mergeCustomTags(d, results.flatMap((r) => r.customTags));
    });
    selectSection(ordered[0]?.id ?? results[0]!.section.id);
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

/**
 * "Open OneNote notebook folder": a notebook folder (or a folder of notebooks)
 * picked or dropped in the app. Each top folder becomes a notebook; its
 * subfolders become section groups and its .onetoc2 files give the order.
 */
export async function importNotebookFolder(files: { file: File; path: string }[]) {
  const usable = files.filter((f) => /\.(one|onetoc2)$/i.test(f.path));
  if (!usable.length) return store.toast("That folder has no OneNote sections (.one files).");
  // "Notebook/Group/Section.one" → notebook "Notebook", dir "Group".
  const byNotebook = new Map<string, { file: File; dir: string; name: string }[]>();
  for (const f of usable) {
    const parts = f.path.split("/").filter(Boolean);
    const top = parts.length > 1 ? parts[0]! : "Imported notebook";
    const rest = parts.length > 1 ? parts.slice(1) : parts;
    const list = byNotebook.get(top) ?? [];
    list.push({ file: f.file, dir: rest.slice(0, -1).join("/"), name: rest[rest.length - 1]! });
    byNotebook.set(top, list);
  }
  let pages = 0;
  let firstSection: Id | undefined;
  const failures: string[] = [];
  for (const [name, list] of byNotebook) {
    const placed: FolderSection[] = [];
    const tocs: FolderToc[] = [];
    const results: ImportResult[] = [];
    for (const f of list) {
      try {
        const bytes = new Uint8Array(await f.file.arrayBuffer());
        if (/\.onetoc2$/i.test(f.name)) tocs.push({ dir: f.dir, toc: await parseToc(bytes) });
        else {
          const r = await importOneFile(bytes, f.name);
          results.push(r);
          placed.push({ dir: f.dir, fileName: f.name, section: r.section, colorFromFile: r.colorFromFile });
        }
      } catch (e) {
        failures.push(`${f.name}: ${(e as Error).message}`);
      }
    }
    if (!placed.length) continue;
    const assembled = assembleNotebook(placed, tocs);
    store.edit((d) => {
      const nb = ops.createNotebook(d, name);
      nb.sections = assembled.sections;
      if (assembled.groups.length) nb.groups = assembled.groups;
      if (assembled.color) nb.color = assembled.color;
      ops.mergeCustomTags(d, results.flatMap((r) => r.customTags));
    });
    firstSection ??= assembled.sections[0]?.id;
    pages += results.reduce((n, r) => n + r.stats.pages, 0);
    await addImportedVersions(results.flatMap((r) => r.versions)).catch(() => 0);
  }
  if (firstSection) selectSection(firstSection);
  store.toast(
    `Imported ${byNotebook.size} notebook${byNotebook.size === 1 ? "" : "s"}, ${pages} page${pages === 1 ? "" : "s"}` +
      (failures.length ? ` · ${failures.length} file${failures.length === 1 ? "" : "s"} failed` : ""),
  );
  if (failures.length) console.error("Notecraft: notebook folder import failures", failures);
}

/** Walk dropped folders (FileSystemEntry) into files with their relative paths. */
export async function readDroppedEntries(entries: FileSystemEntry[]): Promise<{ file: File; path: string }[]> {
  const out: { file: File; path: string }[] = [];
  const walk = async (entry: FileSystemEntry, prefix: string): Promise<void> => {
    if (entry.isFile) {
      const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
      out.push({ file, path: prefix + entry.name });
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      // readEntries returns batches until it returns an empty one.
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        for (const child of batch) await walk(child, `${prefix}${entry.name}/`);
      }
    }
  };
  for (const e of entries) await walk(e, "");
  return out;
}

async function importLibraryJson(file: File) {
  try {
    // "onecraft" is the format key used before the app was renamed.
    const data = JSON.parse(await file.text()) as Library | { notecraft?: 1; onecraft?: 1; notebook: Library["notebooks"][number] };
    if (("notecraft" in data || "onecraft" in data) && "notebook" in data && data.notebook) {
      migrateLibrary({ version: 1, notebooks: [data.notebook] });
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

/** Save a file: a save dialog in the desktop app, a download in the browser. `content` is text or a data: URL. */
export async function download(name: string, content: string, type = "application/octet-stream") {
  if (desktop) {
    try {
      const path = await desktop.saveFile(name, content);
      if (path) store.toast(`Saved ${path.split(/[\\/]/).pop()}`);
    } catch (e) {
      store.toast(`Couldn't save ${name}: ${(e as Error).message ?? e}`);
    }
    return;
  }
  const url = content.startsWith("data:") ? content : URL.createObjectURL(new Blob([content], { type }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  a.click();
  if (!content.startsWith("data:")) setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Desktop: pick a OneNote notebook folder (or a folder of notebooks) and import it. */
export async function importOneNoteFolder() {
  if (!desktop) {
    document.querySelector<HTMLInputElement>(".sidebar-foot input.folder-input")?.click();
    return;
  }
  const path = await desktop.pickFolder("Choose a OneNote notebook folder");
  if (!path) return;
  const found = await desktop.scanFolder(path).catch((e) => (store.toast(String(e)), []));
  if (!found.length) return store.toast("That folder has no OneNote sections (.one files).");
  store.toast(`Importing ${found.reduce((n, f) => n + f.sections.length, 0)} sections…`);
  await importOneNoteNotebooks(found.map((n) => ({ notebook: n.name, sections: n.sections, tocs: n.tocs })), () => {});
}

/** Desktop: show the library folder in Finder / Explorer. */
export function revealLibrary() {
  void desktop?.revealLibrary().catch((e) => store.toast(String(e)));
}

/** Desktop: keep the library in another folder (e.g. one a sync tool watches). */
export async function chooseLibraryFolder() {
  if (!desktop) return;
  const path = await desktop.pickFolder("Choose a folder for your Notecraft library");
  if (!path) return;
  await flushLibrary();
  const info = await desktop.library.setLocation(path);
  store.toast(info.exists ? `Opening the library in ${path}` : `Starting a new library in ${path}`);
  setTimeout(() => location.reload(), 600);
}

const safeName = (s: string) => s.replace(/[\\/:*?"<>|]+/g, "-").trim() || "untitled";

export function exportNotebook() {
  const nb = lib().notebooks.find((n) => n.id === store.getState().ui.notebookId);
  if (!nb) return;
  void download(`${safeName(nb.name)}.notecraft.json`, JSON.stringify({ notecraft: 1, notebook: nb }), "application/json");
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
      const check = e.tags?.find((t) => t.done !== undefined);
      const tag = [check ? (check.done ? "[x] " : "[ ] ") : "", ...(e.tags ?? []).filter((t) => t !== check).map((t) => `(${tagLabel(t)}) `)].join("");
      if (h) return [`${"#".repeat(Number(h[1]) + 1)} ${text}`];
      if (e.list) return [`${pad}${e.list.kind === "bullet" ? "-" : markers[i]} ${tag}${text}`];
      if (check) return [`${pad}- ${tag}${text}`];
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

/** A page as Markdown: title, then its note containers top to bottom. */
export function pageMarkdown(page: Page): string {
  const outlines = [...page.outlines].sort((a, b) => a.y - b.y || a.x - b.x);
  return [`# ${page.title || "Untitled page"}`, "", ...outlines.flatMap((o) => [...elementsToMarkdown(o.elements), ""])].join("\n");
}

export function exportPageMarkdown() {
  const page = currentPage();
  if (!page) return;
  void download(`${safeName(page.title || "page")}.md`, pageMarkdown(page), "text/markdown");
}

export function isEmptyParagraph(e: Element): boolean {
  return e.kind === "text" && textLength(e.runs) === 0;
}

// --- desktop: import OneNote notebooks from this computer ---------------------------------

export interface OneNoteImportProgress {
  done: number;
  total: number;
  current?: string;
}

/**
 * Import whole OneNote notebooks found on disk (desktop app only). Each OneNote
 * notebook becomes a Notecraft notebook; pages keep their OneNote history, and
 * pictures come from OneNote's cache where it has them.
 */
export async function importOneNoteNotebooks(
  picks: { notebook: string; sections: FoundSection[]; tocs?: { dir: string; path: string }[] }[],
  onProgress: (p: OneNoteImportProgress) => void,
): Promise<void> {
  if (!desktop) return;
  const total = picks.reduce((n, p) => n + p.sections.length, 0);
  let done = 0;
  let pages = 0;
  let pictures = 0;
  let missing = 0;
  let history = 0;
  const failures: string[] = [];
  let firstSection: Id | undefined;
  for (const pick of picks) {
    const results: ImportResult[] = [];
    const files: FolderSection[] = [];
    for (const s of pick.sections) {
      onProgress({ done, total, current: `${pick.notebook} › ${s.name}` });
      try {
        const { json, assets, fileName } = await desktop.parseOneNote(s.path);
        const r = importNotebookJson(json, fileName, new Map(Object.entries(assets)));
        results.push(r);
        files.push({ dir: s.dir ?? "", fileName, section: r.section, colorFromFile: r.colorFromFile });
      } catch (e) {
        failures.push(`${s.name}: ${(e as Error).message}`);
      }
      done++;
    }
    if (!results.length) continue;
    // Each folder's .onetoc2 gives section order and colors; subfolders are section groups.
    const tocs: FolderToc[] = [];
    for (const t of pick.tocs ?? []) {
      try {
        tocs.push({ dir: t.dir, toc: await desktop.parseOneNoteToc(t.path) });
      } catch (e) {
        console.warn("Notecraft: could not read", t.path, e);
      }
    }
    const assembled = assembleNotebook(files, tocs);
    store.edit((d) => {
      const nb = ops.createNotebook(d, pick.notebook);
      nb.sections = assembled.sections;
      if (assembled.groups.length) nb.groups = assembled.groups;
      if (assembled.color) nb.color = assembled.color;
      ops.mergeCustomTags(d, results.flatMap((r) => r.customTags));
    });
    firstSection ??= assembled.sections[0]?.id;
    for (const r of results) {
      pages += r.stats.pages;
      pictures += r.stats.images - r.stats.imagesWithoutData;
      missing += r.stats.imagesWithoutData;
    }
    history += await addImportedVersions(results.flatMap((r) => r.versions)).catch(() => 0);
  }
  onProgress({ done, total });
  if (firstSection) selectSection(firstSection);
  store.toast(
    `Imported ${pages} page${pages === 1 ? "" : "s"} with ${history} earlier version${history === 1 ? "" : "s"}` +
      (pictures + missing ? ` · ${pictures} of ${pictures + missing} pictures found in OneNote's cache` : "") +
      (failures.length ? ` · ${failures.length} section${failures.length === 1 ? "" : "s"} failed` : ""),
  );
  if (failures.length) console.error("Notecraft: OneNote import failures", failures);
}
