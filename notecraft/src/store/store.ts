// App state: the Library (persisted, undoable) and transient UI state.
import { produce, type Draft } from "immer";
import { useRef, useSyncExternalStore } from "react";
import type { Id, Library, ListRef, PageVersion } from "../model/types.ts";
import type { ZoomAnchor } from "@re/canvas/viewport.ts";

export interface FocusRequest {
  elementId: Id;
  offset: number | "end";
  seq: number;
}

export interface ActiveParagraph {
  ref: ListRef;
  elementId: Id;
}

export type DrawTool = "type" | "pen" | "highlighter" | "eraser" | "lasso" | "shape";
export type ShapeKind = "line" | "arrow" | "rect" | "ellipse";
export interface DrawState {
  tool: DrawTool;
  penColor: string;
  penWidth: number;
  highlighterColor: string;
  highlighterWidth: number;
  shape: ShapeKind;
  /** Draw › Ink to Shape: pen strokes become clean shapes when the engine recognizes one. */
  inkToShape: boolean;
}

export type SidePanel = "versions" | "tags" | "assistant" | null;
export type Dialog = { kind: "movePage"; pageId: Id } | { kind: "moveSection"; sectionId: Id } | { kind: "moveGroup"; groupId: Id } | { kind: "templates" } | { kind: "trash" } | { kind: "oneNoteImport" } | { kind: "customTags" } | { kind: "settings"; tab?: "ai" | "agents" | "library" } | { kind: "generate"; media: "image" | "video" } | { kind: "protectSection" | "changePassword" | "removePassword"; sectionId: Id } | PromptDialog | null;
export interface PromptDialog {
  kind: "prompt";
  title: string;
  label: string;
  value: string;
  resolve: (value: string | null) => void;
}

export interface UiState {
  notebookId: Id | null;
  sectionId: Id | null;
  pageId: Id | null;
  focus: FocusRequest | null;
  active: ActiveParagraph | null;
  searchOpen: boolean;
  /** Text to start the search panel with (e.g. a search an agent asked to show). */
  searchQuery?: string;
  /** Right-hand pane: page versions or the Find Tags summary. */
  sidePanel: SidePanel;
  /** Draw tab tool; "type" is normal editing. */
  draw: DrawState;
  /** View > Full Page View hides the notebook and page lists. */
  fullPage: boolean;
  /** ⌘F find-on-page bar. */
  findOpen: boolean;
  dialog: Dialog;
  /** A historical version shown read-only in place of the live page. */
  preview: { pageId: Id; version: PageVersion } | null;
  zoomAnchor: ZoomAnchor;
  toast: { id: number; text: string } | null;
  /** Insert › Record Audio / Record Video: the recording in progress. */
  recording: { since: number; kind: "audio" | "video" } | null;
}

export interface AppState {
  lib: Library;
  ui: UiState;
  loaded: boolean;
  saveState: "saved" | "saving" | "error";
  canUndo: boolean;
  canRedo: boolean;
}

type Listener = () => void;
const HISTORY_LIMIT = 200;
const COALESCE_MS = 1500;

class Store {
  private state: AppState;
  private listeners = new Set<Listener>();
  private past: Library[] = [];
  private future: Library[] = [];
  private lastKey: string | null = null;
  private lastAt = 0;
  private focusSeq = 0;
  private toastSeq = 0;
  /** Called after every library change (persistence hooks in here). */
  onLibraryChange: ((lib: Library) => void) | null = null;

  constructor() {
    this.state = {
      lib: { version: 1, notebooks: [] },
      ui: {
        notebookId: null,
        sectionId: null,
        pageId: null,
        focus: null,
        active: null,
        searchOpen: false,
        sidePanel: null,
        draw: { tool: "type", penColor: "#1f3a5f", penWidth: 2, highlighterColor: "#ffe14d", highlighterWidth: 14, shape: "rect", inkToShape: false },
        fullPage: false,
        findOpen: false,
        dialog: null,
        preview: null,
        zoomAnchor: "viewportOrigin",
        toast: null,
        recording: null,
      },
      loaded: false,
      saveState: "saved",
      canUndo: false,
      canRedo: false,
    };
  }

  getState = () => this.state;

  subscribe = (l: Listener) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  private set(next: AppState) {
    this.state = next;
    this.listeners.forEach((l) => l());
  }

  setUi(patch: Partial<UiState> | ((ui: UiState) => Partial<UiState>)) {
    const p = typeof patch === "function" ? patch(this.state.ui) : patch;
    this.set({ ...this.state, ui: { ...this.state.ui, ...p } });
  }

  setMeta(patch: Partial<Pick<AppState, "loaded" | "saveState">>) {
    this.set({ ...this.state, ...patch });
  }

  /**
   * Apply an edit to the library. Edits sharing a `coalesce` key within
   * 1.5s form one undo step (typing in one paragraph).
   */
  edit<R>(fn: (lib: Draft<Library>) => R, opts: { coalesce?: string } = {}): R {
    let result!: R;
    const prev = this.state.lib;
    const next = produce(prev, (d) => {
      result = fn(d);
    });
    if (next === prev) return result;
    const now = Date.now();
    const merge = opts.coalesce && opts.coalesce === this.lastKey && now - this.lastAt < COALESCE_MS;
    if (!merge) {
      this.past.push(prev);
      if (this.past.length > HISTORY_LIMIT) this.past.shift();
    }
    this.lastKey = opts.coalesce ?? null;
    this.lastAt = now;
    this.future = [];
    this.set({ ...this.state, lib: next, canUndo: true, canRedo: false, saveState: "saving" });
    this.onLibraryChange?.(next);
    return result;
  }

  replaceLibrary(lib: Library, opts: { resetHistory?: boolean } = {}) {
    if (opts.resetHistory) {
      this.past = [];
      this.future = [];
    }
    this.lastKey = null;
    this.set({ ...this.state, lib, canUndo: this.past.length > 0, canRedo: this.future.length > 0 });
  }

  /** Forget undo/redo (password-protected sections locking or unlocking). */
  clearHistory() {
    this.past = [];
    this.future = [];
    this.lastKey = null;
    this.set({ ...this.state, canUndo: false, canRedo: false });
  }

  undo() {
    const prev = this.past.pop();
    if (!prev) return;
    this.future.push(this.state.lib);
    this.lastKey = null;
    this.set({ ...this.state, lib: prev, canUndo: this.past.length > 0, canRedo: true, saveState: "saving" });
    this.onLibraryChange?.(prev);
  }

  redo() {
    const next = this.future.pop();
    if (!next) return;
    this.past.push(this.state.lib);
    this.lastKey = null;
    this.set({ ...this.state, lib: next, canUndo: true, canRedo: this.future.length > 0, saveState: "saving" });
    this.onLibraryChange?.(next);
  }

  /** Ask the editor to put the caret in an element (handled by Paragraph). */
  focus(elementId: Id, offset: number | "end" = "end") {
    this.setUi({ focus: { elementId, offset, seq: ++this.focusSeq } });
  }

  toast(text: string) {
    const id = ++this.toastSeq;
    this.setUi({ toast: { id, text } });
    setTimeout(() => {
      if (this.state.ui.toast?.id === id) this.setUi({ toast: null });
    }, 3200);
  }
}

export const store = new Store();

/** Subscribe to a slice of state. The selector should return stable references. */
export function useStore<T>(selector: (s: AppState) => T): T {
  const sel = useRef(selector);
  sel.current = selector;
  return useSyncExternalStore(store.subscribe, () => sel.current(store.getState()));
}
