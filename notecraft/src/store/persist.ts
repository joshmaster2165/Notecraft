// Local-first persistence. In the desktop app the library is a folder of
// files on disk (src-tauri + notecraft-core); in the browser it lives in
// IndexedDB. Small per-device preferences and the scroll/zoom cache live in
// localStorage.
import type { Library } from "../model/types.ts";
import type { ViewportState } from "@re/canvas/viewport.ts";
import { seedLibrary } from "../model/seed.ts";
import { migrateLibrary } from "../model/migrate.ts";
import { expireTrash } from "../model/ops.ts";
import { store } from "./store.ts";
import { get, put, readLegacyLibrary } from "../lib/idb.ts";
import { desktop } from "../desktop.ts";
import { libraryChanges, savedStateOf, type SavedState } from "./diskSync.ts";

const KEY = "library";

// --- library ----------------------------------------------------------------------

let saveTimer: ReturnType<typeof setTimeout> | undefined;
let pending: Library | null = null;

let diskState: SavedState | null = null;
let saving: Promise<void> = Promise.resolve();

async function flush() {
  if (!pending) return saving;
  const lib = pending;
  pending = null;
  saving = saving.then(async () => {
    try {
      if (desktop) {
        const { changes, state, empty } = libraryChanges(diskState, lib);
        if (!empty) await desktop.library.save(changes);
        diskState = state;
      } else await put("kv", lib, KEY);
      if (!pending) store.setMeta({ saveState: "saved" });
    } catch (e) {
      console.error("Notecraft: save failed", e);
      store.setMeta({ saveState: "error" });
    }
  });
  return saving;
}

/** Write any unsaved changes now. */
export function flushLibrary(): Promise<void> {
  clearTimeout(saveTimer);
  return flush();
}

function watchChanges() {
  store.onLibraryChange = (next) => {
    pending = next;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void flush(), 400);
  };
  window.addEventListener("pagehide", () => void flush());
}

/** Desktop: open the library folder, or start one with the welcome notebook. */
async function loadFromDisk(lib0: NonNullable<typeof desktop>["library"]): Promise<void> {
  let lib: Library | null = null;
  try {
    lib = await lib0.load();
  } catch (e) {
    console.error("Notecraft: could not read the library folder", e);
    store.toast(`Couldn't read your library folder: ${(e as Error).message ?? e}`);
  }
  const fresh = !lib || lib.version !== 1 || !lib.notebooks?.length;
  const loaded = fresh ? seedLibrary() : lib!;
  migrateLibrary(loaded);
  expireTrash(loaded);
  store.replaceLibrary(loaded, { resetHistory: true });
  diskState = fresh ? null : savedStateOf(store.getState().lib);
  restoreSelection(loaded);
  store.setMeta({ loaded: true, saveState: "saved" });
  watchChanges();
  if (fresh) {
    pending = store.getState().lib;
    await flush();
  }
  // The CLI, an AI agent or a sync tool changed the folder: save ours, then reload.
  lib0.onExternalChange(async () => {
    await flush();
    const next = await lib0.load().catch(() => null);
    if (!next?.notebooks?.length) return;
    migrateLibrary(next);
    store.replaceLibrary(next, { resetHistory: true });
    diskState = savedStateOf(store.getState().lib);
    restoreSelection(next, store.getState().ui);
    store.toast("Updated with changes made outside Notecraft.");
  });
}

export async function loadLibrary(): Promise<void> {
  if (desktop) return loadFromDisk(desktop.library);
  let lib: Library | undefined;
  try {
    lib = await get<Library>("kv", KEY);
    // First run after the Onecraft → Notecraft rename: carry the old library over.
    if (!lib) {
      lib = await readLegacyLibrary<Library>();
      if (lib) await put("kv", lib, KEY);
    }
  } catch (e) {
    console.error("Notecraft: could not open IndexedDB", e);
  }
  if (!lib || lib.version !== 1 || !lib.notebooks?.length) lib = seedLibrary();
  migrateLibrary(lib);
  expireTrash(lib);
  store.replaceLibrary(lib, { resetHistory: true });
  restoreSelection(lib);
  store.setMeta({ loaded: true, saveState: "saved" });
  watchChanges();
}

// --- selection -------------------------------------------------------------------------

const SELECTION_KEY = "notecraft.selection";

function readJson<T>(key: string): T | null {
  try {
    const v = localStorage.getItem(key) ?? localStorage.getItem(key.replace(/^notecraft\./, "onecraft."));
    return v ? (JSON.parse(v) as T) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable: preferences just don't persist */
  }
}

/** Select what was open last (or, after an outside change, what is open now if it still exists). */
function restoreSelection(lib: Library, current?: { notebookId: string | null; sectionId: string | null; pageId: string | null }) {
  const saved = current?.pageId ? { ...current, zoomAnchor: store.getState().ui.zoomAnchor } : readJson<{ notebookId: string; sectionId: string; pageId: string; zoomAnchor?: "viewportOrigin" | "pointer" }>(SELECTION_KEY);
  const nb = lib.notebooks.find((n) => n.id === saved?.notebookId) ?? lib.notebooks[0]!;
  const section = nb.sections.find((s) => s.id === saved?.sectionId) ?? nb.sections[0];
  const page = section?.pages.find((p) => p.id === saved?.pageId) ?? section?.pages[0];
  store.setUi({ notebookId: nb.id, sectionId: section?.id ?? null, pageId: page?.id ?? null, zoomAnchor: saved?.zoomAnchor ?? "viewportOrigin" });
}

export function persistSelection() {
  const { notebookId, sectionId, pageId, zoomAnchor } = store.getState().ui;
  writeJson(SELECTION_KEY, { notebookId, sectionId, pageId, zoomAnchor });
}

// --- scroll and zoom cache --------------------------------------------------------------
// OneNote keeps one per page in ONWorkspace (getCachedScrollOffset:withZoomScale: /
// updateCachedScrollOffset:withZoomScale:); Notecraft does the same per browser.

const VIEW_KEY = "notecraft.views";
const views: Record<string, ViewportState> = readJson(VIEW_KEY) ?? {};
let viewTimer: ReturnType<typeof setTimeout> | undefined;

export function cachedView(pageId: string): ViewportState | undefined {
  return views[pageId];
}

export function cacheView(pageId: string, state: ViewportState) {
  views[pageId] = { zoom: state.zoom, origin: { x: Math.round(state.origin.x), y: Math.round(state.origin.y) } };
  clearTimeout(viewTimer);
  viewTimer = setTimeout(() => writeJson(VIEW_KEY, views), 500);
}
