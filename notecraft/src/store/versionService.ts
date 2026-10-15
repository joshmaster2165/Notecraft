// Connects the editor to version history: watches library changes and page
// switches, and feeds them to the VersionTracker.
import { changedPages, VersionTracker } from "../model/versions.ts";
import { findPage } from "../model/ops.ts";
import { store } from "./store.ts";
import { saveSnapshot } from "./versionStore.ts";
import type { Id, VersionReason } from "../model/types.ts";

let tracker: VersionTracker | null = null;

export function startVersionTracking(): void {
  if (tracker) return;
  const t = new VersionTracker({
    save: (pageId, page, reason) => {
      saveSnapshot(pageId, page, reason).catch((e) => console.error("Notecraft: could not save a page version", e));
    },
    currentPage: (pageId) => findPage(store.getState().lib, pageId)?.page,
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  });
  tracker = t;

  let prevLib = store.getState().lib;
  let prevPageId = store.getState().ui.pageId;
  store.subscribe(() => {
    const s = store.getState();
    if (s.lib !== prevLib) {
      for (const { pageId, before } of changedPages(prevLib, s.lib)) t.edited(pageId, before);
      prevLib = s.lib;
    }
    if (s.ui.pageId !== prevPageId) {
      if (prevPageId) t.left(prevPageId);
      prevPageId = s.ui.pageId;
    }
  });
  const flush = () => t.flushAll();
  window.addEventListener("pagehide", flush);
  document.addEventListener("visibilitychange", () => document.visibilityState === "hidden" && flush());
}

/**
 * Make sure the page's current state is in its history (before a restore
 * replaces it). Duplicates of the latest version are dropped by the store.
 */
export function settlePage(pageId: Id, reason: VersionReason): void {
  if (tracker?.hasPending(pageId)) return tracker.left(pageId, reason);
  const page = findPage(store.getState().lib, pageId)?.page;
  if (page) saveSnapshot(pageId, page, reason).catch((e) => console.error("Notecraft: could not save a page version", e));
}
