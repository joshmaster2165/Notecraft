// The desktop app's backend (src-tauri), reached through Tauri commands.
// Undefined in the browser, where the same app runs on IndexedDB.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { NotebookJson } from "@re/parser/src/notebook.ts";
import type { NotebookToc } from "@re/parser/src/toc.ts";
import type { Library } from "./model/types.ts";

export interface FoundSection {
  path: string;
  name: string;
  /** Folder inside the notebook ("" for the top); subfolders are section groups. */
  dir: string;
  modified: string;
  bytes: number;
}
export interface FoundNotebook {
  name: string;
  sections: FoundSection[];
  tocs: { dir: string; path: string }[];
}

/** What changed since the last save (see notecraft-core's SaveChanges). */
export interface LibraryChanges {
  library?: { notebooks: string[]; templates?: unknown; customTags?: unknown };
  notebooks: unknown[];
  deletedNotebooks: string[];
  pages: unknown[];
  deletedPages: string[];
  blobs: Record<string, string>;
}

export interface VersionChanges {
  put: unknown[];
  delete: string[];
  blobs: Record<string, string>;
}

/** The library folder on disk. */
export interface DiskLibrary {
  info(): Promise<{ path: string; exists: boolean }>;
  load(): Promise<Library | null>;
  save(changes: LibraryChanges): Promise<void>;
  setLocation(path: string): Promise<{ path: string; exists: boolean }>;
  listVersions<T>(pageId: string): Promise<T[]>;
  getVersion<T>(id: string): Promise<T | null>;
  commitVersions(changes: VersionChanges): Promise<void>;
  /** Delete assets nothing refers to any more; resolves to the deleted keys. */
  pruneBlobs(): Promise<string[]>;
  /** Pages, notebooks or the index changed on disk by someone else (CLI, agent, sync). */
  onExternalChange(fn: (change: { pages: string[]; notebooks: string[]; library: boolean }) => void): () => void;
}

export interface DesktopBridge {
  platform: string;
  onCommand(fn: (command: string) => void): () => void;
  scanOneNote(): Promise<{ roots: string[]; notebooks: FoundNotebook[] }>;
  scanFolder(path: string): Promise<FoundNotebook[]>;
  pickFolder(title?: string): Promise<string | null>;
  parseOneNote(path: string): Promise<{ json: NotebookJson; assets: Record<string, string>; fileName: string }>;
  parseOneNoteToc(path: string): Promise<NotebookToc>;
  /** Save dialog; `data` is text or a data: URL. Resolves to the path, or null if cancelled. */
  saveFile(name: string, data: string): Promise<string | null>;
  openExternal(url: string): Promise<void>;
  revealLibrary(): Promise<void>;
  /** Agents asking the app to show something (see notecraft-core ops::request_ui). */
  onControl(fn: (request: { action: string; pageId?: string; sectionId?: string; query?: string }) => void): () => void;
  library: DiskLibrary;
}

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

function platformName(): string {
  const p = navigator.platform.toLowerCase();
  return p.includes("mac") ? "darwin" : p.includes("win") ? "win32" : "linux";
}

/** Subscribe to a Tauri event; returns a synchronous unsubscribe. */
function on<T>(event: string, fn: (payload: T) => void): () => void {
  let off: (() => void) | undefined;
  let cancelled = false;
  void listen<T>(event, (e) => fn(e.payload)).then((u) => (cancelled ? u() : (off = u)));
  return () => {
    cancelled = true;
    off?.();
  };
}

function tauriBridge(): DesktopBridge {
  return {
    platform: platformName(),
    onCommand: (fn) => on<string>("notecraft:command", fn),
    scanOneNote: () => invoke("onenote_scan"),
    scanFolder: (path) => invoke("onenote_scan_folder", { path }),
    pickFolder: (title) => invoke("pick_folder", { title: title ?? null }),
    parseOneNote: (path) => invoke("onenote_parse", { path }),
    parseOneNoteToc: (path) => invoke("onenote_toc", { path }),
    saveFile: (name, data) => invoke("save_file", { defaultName: name, data }),
    openExternal: (url) => invoke("open_external", { url }),
    revealLibrary: () => invoke("reveal_library"),
    onControl: (fn) => on("notecraft:control", fn),
    library: {
      info: () => invoke("library_info"),
      load: () => invoke("library_load"),
      save: (changes) => invoke("library_save", { changes }),
      setLocation: (path) => invoke("library_set_location", { path }),
      listVersions: (pageId) => invoke("versions_list", { pageId }),
      getVersion: (id) => invoke("versions_get", { id }),
      commitVersions: (changes) => invoke("versions_commit", { changes }),
      pruneBlobs: () => invoke("library_prune_blobs"),
      onExternalChange: (fn) => on("library-changed", fn),
    },
  };
}

export const desktop: DesktopBridge | undefined = isTauri ? tauriBridge() : undefined;
