// Bring stored data up to the current model. Runs on load, on JSON import and
// on page versions read back from storage. Mutates plain (non-immer) objects.
import type { CustomTagDef, Element, Library, NoteTag, Page } from "./types.ts";
import { customTagId } from "./tags.ts";

type Legacy = Element & { tag?: NoteTag };

let found: Map<string, CustomTagDef> | null = null;

function migrateElements(els: Element[]): void {
  for (const e of els as Legacy[]) {
    // 0.1: one tag per paragraph → NoteTagStates-style list.
    if (e.tag) {
      e.tags = [...(e.tags ?? []), e.tag];
      delete e.tag;
    }
    // 0.2: label-only custom tags → registered custom tag definitions.
    for (const t of e.tags ?? []) {
      if (t.kind !== "custom") continue;
      const label = t.label?.trim() || "Tag";
      t.kind = customTagId(label);
      found?.set(t.kind, { id: t.kind, label, shape: t.done !== undefined ? "checkbox" : "letter", color: "#5b6b8c", ...(t.done !== undefined ? { check: true } : {}) });
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
  found = new Map();
  for (const nb of lib.notebooks) {
    for (const s of nb.sections) s.pages.forEach(migratePage);
    for (const t of nb.trash ?? []) {
      if (t.kind === "page") migratePage(t.page);
      else t.section.pages.forEach(migratePage);
    }
  }
  for (const t of lib.templates ?? []) migratePage(t.page);
  if (found.size) {
    const have = new Set((lib.customTags ?? []).map((t) => t.id));
    lib.customTags = [...(lib.customTags ?? []), ...[...found.values()].filter((t) => !have.has(t.id))];
  }
  found = null;
  return lib;
}
