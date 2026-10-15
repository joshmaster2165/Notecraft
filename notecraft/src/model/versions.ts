// Page version history: when to take snapshots, how to compare them, and how
// to restore one. Pure logic; storage lives in store/versionStore.ts.
import type { Id, Library, Page, PageVersion, VersionReason } from "./types.ts";
import { findPage } from "./ops.ts";
import { nowIso } from "../lib/id.ts";

/** Snapshot after this much quiet time following an edit. */
export const IDLE_MS = 60_000;
/** Notecraft snapshots kept per page (imported OneNote versions are kept separately). */
export const MAX_VERSIONS_PER_PAGE = 50;

// --- signatures ---------------------------------------------------------------------

/** 53-bit string hash (cyrb53): cheap, stable, collision-safe enough for dedupe keys. */
export function hashString(str: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** What a reader sees: title, outlines and images. Timestamps and levels don't count. */
export function pageSignature(page: Page): string {
  return hashString(JSON.stringify([page.title, page.outlines, page.images, page.ink ?? [], page.paper ?? null]));
}

// --- snapshot timing -------------------------------------------------------------------

export interface TrackerDeps {
  save(pageId: Id, page: Page, reason: VersionReason): void;
  currentPage(pageId: Id): Page | undefined;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

/**
 * The first edit to a page saves the state it had before ("before-edit");
 * the page is snapshotted again once edits pause for IDLE_MS ("idle") or when
 * the user leaves it ("leave"). Identical states are dropped by the saver.
 */
export class VersionTracker {
  private readonly pending = new Map<Id, unknown>();
  private readonly deps: TrackerDeps;
  private readonly idleMs: number;

  constructor(deps: TrackerDeps, idleMs = IDLE_MS) {
    this.deps = deps;
    this.idleMs = idleMs;
  }

  edited(pageId: Id, before: Page): void {
    const timer = this.pending.get(pageId);
    if (timer === undefined) this.deps.save(pageId, before, "before-edit");
    else this.deps.clearTimer(timer);
    this.pending.set(pageId, this.deps.setTimer(() => this.settle(pageId, "idle"), this.idleMs));
  }

  left(pageId: Id, reason: VersionReason = "leave"): void {
    if (this.pending.has(pageId)) this.settle(pageId, reason);
  }

  flushAll(): void {
    for (const id of [...this.pending.keys()]) this.settle(id, "leave");
  }

  hasPending(pageId: Id): boolean {
    return this.pending.has(pageId);
  }

  private settle(pageId: Id, reason: VersionReason): void {
    this.deps.clearTimer(this.pending.get(pageId));
    this.pending.delete(pageId);
    const page = this.deps.currentPage(pageId);
    if (page) this.deps.save(pageId, page, reason);
  }
}

/** Pages present in both libraries whose object changed (immer keeps untouched pages identical). */
export function changedPages(prev: Library, next: Library): { pageId: Id; before: Page }[] {
  if (prev === next) return [];
  const before = new Map<Id, Page>();
  for (const nb of prev.notebooks) for (const s of nb.sections) for (const p of s.pages) before.set(p.id, p);
  const out: { pageId: Id; before: Page }[] = [];
  for (const nb of next.notebooks) {
    for (const s of nb.sections) {
      for (const p of s.pages) {
        const old = before.get(p.id);
        if (old && old !== p && (old.title !== p.title || old.outlines !== p.outlines || old.images !== p.images || old.ink !== p.ink || old.paper !== p.paper)) out.push({ pageId: p.id, before: old });
      }
    }
  }
  return out;
}

/** Which Notecraft snapshots to delete so at most `max` remain (oldest go first). */
export function pruneIds(versions: Pick<PageVersion, "id" | "at" | "source">[], max = MAX_VERSIONS_PER_PAGE): Id[] {
  const own = versions.filter((v) => v.source === "notecraft").sort((a, b) => b.at.localeCompare(a.at));
  return own.slice(max).map((v) => v.id);
}

// --- restore ---------------------------------------------------------------------------

/** Replace a page's content with a version's, keeping its identity and place. One undo step. */
export function restorePageVersion(lib: Library, pageId: Id, snapshot: Page): void {
  const hit = findPage(lib, pageId);
  if (!hit) return;
  hit.page.title = snapshot.title;
  hit.page.outlines = snapshot.outlines;
  hit.page.images = snapshot.images;
  if (snapshot.ink?.length) hit.page.ink = snapshot.ink;
  else delete hit.page.ink;
  if (snapshot.paper) hit.page.paper = snapshot.paper;
  else delete hit.page.paper;
  hit.page.modifiedAt = nowIso();
}

export const REASON_LABEL: Record<VersionReason, string> = {
  "before-edit": "Before edits",
  idle: "Auto-saved",
  leave: "When you left the page",
  "before-restore": "Before restoring a version",
  import: "From OneNote",
};
