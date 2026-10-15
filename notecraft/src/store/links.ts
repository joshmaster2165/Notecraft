// Links between pages: "Copy Link to Page", [[Page title]] wiki links, and
// following links from the editor.
import type { Draft } from "immer";
import type { Id, Library, Run } from "../model/types.ts";
import * as ops from "../model/ops.ts";
import { normalizeRuns, runsText } from "../lib/richtext.ts";
import { store } from "./store.ts";

export const PAGE_LINK_PREFIX = "notecraft:page/";
export const SECTION_LINK_PREFIX = "notecraft:section/";
/** A page, or one paragraph on it ("Copy Link to Paragraph"). */
export const pageHref = (id: Id, elementId?: Id) => PAGE_LINK_PREFIX + id + (elementId ? `#${elementId}` : "");
export const sectionHref = (id: Id) => SECTION_LINK_PREFIX + id;

type Target = { kind: "page"; id: Id; elementId?: Id } | { kind: "section"; id: Id };

function parseHref(href: string): Target | null {
  if (href.startsWith(PAGE_LINK_PREFIX)) {
    const [id, elementId] = href.slice(PAGE_LINK_PREFIX.length).split("#");
    return id ? { kind: "page", id, ...(elementId ? { elementId } : {}) } : null;
  }
  if (href.startsWith(SECTION_LINK_PREFIX)) return { kind: "section", id: href.slice(SECTION_LINK_PREFIX.length) };
  return null;
}

export function pageIdFromHref(href: string): Id | null {
  const t = parseHref(href);
  return t?.kind === "page" ? t.id : null;
}

/** Click on a link: pages, paragraphs and sections open in Notecraft, everything else in the browser. */
export function followLink(href: string): void {
  const t = parseHref(href);
  if (!t) {
    if (/^(https?:|mailto:)/i.test(href)) window.open(href, "_blank", "noopener,noreferrer");
    return;
  }
  const lib = store.getState().lib;
  // Imported lazily to avoid a cycle with actions.ts.
  if (t.kind === "section") {
    if (ops.findSection(lib, t.id)) void import("./actions.ts").then((a) => a.selectSection(t.id));
    else store.toast("That section no longer exists. It may be in Deleted Notes.");
    return;
  }
  if (!ops.findPage(lib, t.id)) return void store.toast("That page no longer exists. It may be in Deleted Notes.");
  void import("./actions.ts").then((a) => {
    a.selectPage(t.id);
    if (t.elementId) setTimeout(() => store.focus(t.elementId!, 0), 60);
  });
}

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

function linkTitle(t: Target): string | null {
  const lib = store.getState().lib;
  if (t.kind === "section") return ops.findSection(lib, t.id)?.section.name ?? null;
  const page = ops.findPage(lib, t.id)?.page;
  if (!page) return null;
  if (t.elementId) {
    const el = ops.findElement(page, t.elementId);
    const text = el?.kind === "text" ? runsText(el.runs).trim() : "";
    if (text) return text.length > 80 ? text.slice(0, 79) + "…" : text;
  }
  return page.title || "Untitled page";
}

/** Pasting a copied page, paragraph or section link inserts its title as a link. */
export function pageLinkHtml(text: string): string | null {
  const t = parseHref(text);
  const title = t && linkTitle(t);
  return title ? `<a href="${escape(text)}">${escape(title)}</a>` : null;
}

async function copyLink(href: string, what: string): Promise<void> {
  try {
    if ("ClipboardItem" in window) {
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/plain": new Blob([href], { type: "text/plain" }),
          "text/html": new Blob([pageLinkHtml(href) ?? href], { type: "text/html" }),
        }),
      ]);
    } else await navigator.clipboard.writeText(href);
    store.toast(`Copied a link to ${what}. Paste it into any page.`);
  } catch {
    store.toast("Couldn't copy to the clipboard.");
  }
}

export async function copyPageLink(pageId: Id): Promise<void> {
  const page = ops.findPage(store.getState().lib, pageId)?.page;
  if (page) await copyLink(pageHref(pageId), `“${page.title || "Untitled page"}”`);
}

export async function copySectionLink(sectionId: Id): Promise<void> {
  const section = ops.findSection(store.getState().lib, sectionId)?.section;
  if (section) await copyLink(sectionHref(sectionId), `the section “${section.name}”`);
}

export async function copyParagraphLink(pageId: Id, elementId: Id): Promise<void> {
  if (ops.findPage(store.getState().lib, pageId)) await copyLink(pageHref(pageId, elementId), "this paragraph");
}

/**
 * Turn [[Title]] into a link to the page with that title in the same notebook,
 * creating the page at the end of the current section when none exists.
 */
export function linkPagesByTitle(lib: Draft<Library>, currentPageId: Id, runs: Run[]) {
  const here = ops.findPage(lib, currentPageId);
  const removed: { at: number; count: number }[] = [];
  let changed = false;
  let pos = 0;
  const out: Run[] = [];
  for (const r of runs) {
    if (r.href) {
      out.push(r);
      pos += r.text.length;
      continue;
    }
    let last = 0;
    for (const m of r.text.matchAll(/\[\[([^[\]]+)\]\]/g)) {
      const title = m[1]!.trim();
      if (!title || !here) continue;
      let target = here.notebook.sections.flatMap((s) => s.pages).find((p) => p.title.trim().toLowerCase() === title.toLowerCase());
      if (!target) {
        target = ops.createPage(lib, here.section.id);
        target.title = title;
      }
      if (m.index! > last) out.push({ ...r, text: r.text.slice(last, m.index) });
      out.push({ ...r, text: title, href: pageHref(target.id) });
      removed.push({ at: pos + m.index!, count: 2 }, { at: pos + m.index! + 2 + m[1]!.length, count: 2 });
      last = m.index! + m[0].length;
      changed = true;
    }
    if (last < r.text.length) out.push({ ...r, text: r.text.slice(last) });
    pos += r.text.length;
  }
  return {
    runs: changed ? normalizeRuns(out) : runs,
    changed,
    /** Characters removed before a caret offset in the original text (the brackets). */
    removedBefore: (offset: number) => removed.filter((x) => x.at < offset).reduce((n, x) => n + Math.min(x.count, offset - x.at), 0),
  };
}
