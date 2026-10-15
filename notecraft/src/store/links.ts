// Links between pages: "Copy Link to Page", [[Page title]] wiki links, and
// following links from the editor.
import type { Draft } from "immer";
import type { Id, Library, Run } from "../model/types.ts";
import * as ops from "../model/ops.ts";
import { normalizeRuns } from "../lib/richtext.ts";
import { store } from "./store.ts";

export const PAGE_LINK_PREFIX = "notecraft:page/";
export const pageHref = (id: Id) => PAGE_LINK_PREFIX + id;

export function pageIdFromHref(href: string): Id | null {
  return href.startsWith(PAGE_LINK_PREFIX) ? href.slice(PAGE_LINK_PREFIX.length) : null;
}

/** Click on a link: pages open in Notecraft, everything else in the browser. */
export function followLink(href: string): void {
  const pageId = pageIdFromHref(href);
  if (pageId) {
    if (ops.findPage(store.getState().lib, pageId)) {
      // Imported lazily to avoid a cycle with actions.ts.
      void import("./actions.ts").then((a) => a.selectPage(pageId));
    } else store.toast("That page no longer exists. It may be in Deleted Notes.");
    return;
  }
  if (/^(https?:|mailto:)/i.test(href)) window.open(href, "_blank", "noopener,noreferrer");
}

/** Pasting a copied page link inserts the page's title as a link. */
export function pageLinkHtml(text: string): string | null {
  const id = pageIdFromHref(text);
  const page = id ? ops.findPage(store.getState().lib, id)?.page : undefined;
  if (!page) return null;
  const title = (page.title || "Untitled page").replace(/&/g, "&amp;").replace(/</g, "&lt;");
  return `<a href="${pageHref(page.id)}">${title}</a>`;
}

export async function copyPageLink(pageId: Id): Promise<void> {
  const page = ops.findPage(store.getState().lib, pageId)?.page;
  if (!page) return;
  const href = pageHref(pageId);
  try {
    if ("ClipboardItem" in window) {
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/plain": new Blob([href], { type: "text/plain" }),
          "text/html": new Blob([pageLinkHtml(href) ?? href], { type: "text/html" }),
        }),
      ]);
    } else await navigator.clipboard.writeText(href);
    store.toast(`Copied a link to “${page.title || "Untitled page"}”. Paste it into any page.`);
  } catch {
    store.toast("Couldn't copy to the clipboard.");
  }
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
