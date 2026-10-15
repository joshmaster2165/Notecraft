// Bring stored data up to the current model. Runs on load, on JSON import and
// on page versions read back from storage. Mutates plain (non-immer) objects.
import type { Element, Library, NoteTag, Page } from "./types.ts";

type Legacy = Element & { tag?: NoteTag };

function migrateElements(els: Element[]): void {
  for (const e of els as Legacy[]) {
    // 0.1: one tag per paragraph → NoteTagStates-style list.
    if (e.tag) {
      e.tags = [...(e.tags ?? []), e.tag];
      delete e.tag;
    }
    if (e.kind === "table") for (const r of e.rows) for (const c of r.cells) migrateElements(c.elements);
  }
}

export function migratePage(page: Page): Page {
  for (const o of page.outlines ?? []) migrateElements(o.elements);
  page.images ??= [];
  return page;
}

export function migrateLibrary(lib: Library): Library {
  for (const nb of lib.notebooks) {
    for (const s of nb.sections) s.pages.forEach(migratePage);
    for (const t of nb.trash ?? []) {
      if (t.kind === "page") migratePage(t.page);
      else t.section.pages.forEach(migratePage);
    }
  }
  for (const t of lib.templates ?? []) migratePage(t.page);
  return lib;
}
