// Local-first persistence: the library lives in IndexedDB (notebooks can be
// megabytes once .one files are imported); small per-browser preferences and
// the scroll/zoom cache live in localStorage.
import type { Library } from "../model/types.ts";
import type { ViewportState } from "@re/canvas/viewport.ts";
import { seedLibrary } from "../model/seed.ts";
import { migrateLibrary } from "../model/migrate.ts";
import { expireTrash } from "../model/ops.ts";
import { store } from "./store.ts";
import { get, put, readLegacyLibrary } from "../lib/idb.ts";

const KEY = "library";

// --- library ----------------------------------------------------------------------

let saveTimer: ReturnType<typeof setTimeout> | undefined;
let pending: Library | null = null;

async function flush() {
  if (!pending) return;
  const lib = pending;
  pending = null;
  try {
    await put("kv", lib, KEY);
    if (!pending) store.setMeta({ saveState: "saved" });
  } catch (e) {
    console.error("Notecraft: save failed", e);
    store.setMeta({ saveState: "error" });
  }
}

export async function loadLibrary(): Promise<void> {
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
  store.onLibraryChange = (next) => {
    pending = next;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, 400);
  };
  window.addEventListener("pagehide", () => void flush());
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

function restoreSelection(lib: Library) {
  const saved = readJson<{ notebookId: string; sectionId: string; pageId: string; zoomAnchor?: "viewportOrigin" | "pointer" }>(SELECTION_KEY);
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
