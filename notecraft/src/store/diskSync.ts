// Desktop app: keep the library folder (src-tauri, notecraft-core) in step
// with the in-memory library. Each save writes only what changed: pages are
// compared by identity (edits replace a page object, untouched pages keep
// theirs) and notebook manifests by content.
import type { Id, Library, Notebook, Page } from "../model/types.ts";
import type { LibraryChanges } from "../desktop.ts";
import { extractBlobs } from "../lib/blobs.ts";

export interface SavedState {
  pages: Map<Id, Page>;
  manifests: Map<Id, string>;
  index: string;
  blobKeys: Set<string>;
}

const stub = (p: Page) => ({ id: p.id, title: p.title, level: p.level, createdAt: p.createdAt, modifiedAt: p.modifiedAt });

/** A notebook as stored in notebooks/<id>.json: sections list page stubs. */
function manifestOf(nb: Notebook, blobs: Map<string, string>) {
  return extractBlobs({ ...nb, sections: nb.sections.map((s) => ({ ...s, pages: s.pages.map(stub) })) }, blobs);
}

function indexOf(lib: Library, blobs: Map<string, string>) {
  return extractBlobs(
    {
      notebooks: lib.notebooks.map((n) => n.id),
      ...(lib.templates?.length ? { templates: lib.templates } : {}),
      ...(lib.customTags?.length ? { customTags: lib.customTags } : {}),
    },
    blobs,
  );
}

function allPages(lib: Library): Page[] {
  return lib.notebooks.flatMap((n) => n.sections.flatMap((s) => s.pages));
}

/** The state right after loading from disk: nothing needs saving yet. */
export function savedStateOf(lib: Library): SavedState {
  const scratch = new Map<string, string>();
  return {
    pages: new Map(allPages(lib).map((p) => [p.id, p])),
    manifests: new Map(lib.notebooks.map((n) => [n.id, JSON.stringify(manifestOf(n, scratch))])),
    index: JSON.stringify(indexOf(lib, scratch)),
    blobKeys: new Set(scratch.keys()),
  };
}

/** What to write to go from `prev` (null: nothing on disk yet) to `next`. */
export function libraryChanges(prev: SavedState | null, next: Library): { changes: LibraryChanges; state: SavedState; empty: boolean } {
  const blobs = new Map<string, string>();
  const state: SavedState = { pages: new Map(), manifests: new Map(), index: "", blobKeys: new Set(prev?.blobKeys) };
  const changes: LibraryChanges = { notebooks: [], deletedNotebooks: [], pages: [], deletedPages: [], blobs: {} };

  for (const page of allPages(next)) {
    state.pages.set(page.id, page);
    if (prev?.pages.get(page.id) !== page) changes.pages.push(extractBlobs(page, blobs));
  }
  for (const nb of next.notebooks) {
    const manifest = manifestOf(nb, blobs);
    const json = JSON.stringify(manifest);
    state.manifests.set(nb.id, json);
    if (prev?.manifests.get(nb.id) !== json) changes.notebooks.push(manifest);
  }
  const index = indexOf(next, blobs);
  state.index = JSON.stringify(index);
  if (prev?.index !== state.index) changes.library = index;

  if (prev) {
    for (const id of prev.pages.keys()) if (!state.pages.has(id)) changes.deletedPages.push(id);
    for (const id of prev.manifests.keys()) if (!state.manifests.has(id)) changes.deletedNotebooks.push(id);
  }
  for (const [k, v] of blobs) {
    if (state.blobKeys.has(k)) continue;
    changes.blobs[k] = v;
    state.blobKeys.add(k);
  }
  const empty = !changes.library && !changes.notebooks.length && !changes.pages.length && !changes.deletedPages.length && !changes.deletedNotebooks.length;
  return { changes, state, empty };
}
