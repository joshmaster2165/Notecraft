// Password Protect This Section. A protected section's pages are stored only
// sealed (AES-256-GCM, key from the password; crates/engine/src/lock.rs) in
// `section.locked`. Unlocking opens them into memory and keeps the key here,
// so every save re-seals the current pages; locking (or 10 minutes away)
// drops the pages and the key. Plain pages never reach the library folder,
// IndexedDB or page history.
import { useSyncExternalStore } from "react";
import type { Id, Library, Page, Section, SealedPages } from "../model/types.ts";
import * as ops from "../model/ops.ts";
import { migratePage } from "../model/migrate.ts";
import { store } from "./store.ts";

interface Crypto {
  protect(plaintext: string, password: string): Promise<{ sealed: SealedPages; key: string }>;
  unlock(sealed: SealedPages, password: string): Promise<{ plaintext: string; key: string }>;
  reseal(plaintext: string, key: string, like: SealedPages): Promise<SealedPages>;
}
// The Rust engine (native or WebAssembly), loaded when first needed.
let crypto: Crypto | null = null;
const engine = async (): Promise<Crypto> => (crypto ??= await import("../engine.ts"));

/** OneNote's default: lock sections you haven't worked in for 10 minutes. */
export const LOCK_AFTER_MS = 10 * 60_000;

interface Key {
  key: string;
  /** KDF parameters and salt to re-seal with. */
  like: SealedPages;
  /** The pages last sealed, by identity, and their seal. */
  pages: Page[] | null;
  sealed: SealedPages;
  lastUsed: number;
}

const keys = new Map<Id, Key>();
const listeners = new Set<() => void>();
let version = 0;
const changed = () => {
  version++;
  listeners.forEach((l) => l());
};

export type LockState = "none" | "locked" | "unlocked";

export function lockState(section: Section | undefined): LockState {
  if (!section?.locked) return "none";
  return keys.has(section.id) && section.pages.length ? "unlocked" : "locked";
}

/** Re-renders when sections lock or unlock. */
export function useLockVersion(): number {
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => version,
  );
}

const lib = () => store.getState().lib;
const sectionOf = (l: Library, id: Id) => ops.findSection(l, id)?.section ?? trashedSection(l, id);
function trashedSection(l: Library, id: Id): Section | undefined {
  for (const nb of l.notebooks) for (const t of nb.trash ?? []) if (t.kind === "section" && t.section.id === id) return t.section;
}

/** Locked or unlocked, a protected section's sections (and trashed copies) by id. */
function eachSection(d: Library, id: Id, fn: (s: Section) => void) {
  for (const nb of d.notebooks) {
    for (const s of nb.sections) if (s.id === id) fn(s);
    for (const t of nb.trash ?? []) if (t.kind === "section" && t.section.id === id) fn(t.section);
  }
}

/** Lock-state changes can't be undone: older states hold plain pages, or none. */
function settle() {
  store.clearHistory();
  changed();
}

const seal = (pages: Page[]) => JSON.stringify({ pages });

export async function protectSection(sectionId: Id, password: string, hint?: string): Promise<void> {
  const section = sectionOf(lib(), sectionId);
  if (!section || section.locked) return;
  const pages = section.pages;
  const { sealed, key } = await (await engine()).protect(seal(pages), password);
  keys.set(sectionId, { key, like: sealed, pages, sealed, lastUsed: Date.now() });
  const trashed: Id[] = [];
  store.edit((d) => {
    eachSection(d, sectionId, (s) => (s.locked = { sealed, ...(hint?.trim() ? { hint: hint.trim() } : {}) }));
    // Its pages in Deleted Notes would stay readable: they go for good.
    for (const nb of d.notebooks) {
      if (!nb.trash) continue;
      for (const t of nb.trash) if (t.kind === "page" && t.sectionId === sectionId) trashed.push(t.page.id);
      nb.trash = nb.trash.filter((t) => t.kind !== "page" || t.sectionId !== sectionId);
    }
  });
  // The edit replaced the section object but not its pages array.
  keys.get(sectionId)!.pages = sectionOf(lib(), sectionId)!.pages;
  settle();
  await forgetPlainCopies([...pages.map((p) => p.id), ...trashed]);
}

export async function unlockSection(sectionId: Id, password: string): Promise<void> {
  const section = sectionOf(lib(), sectionId);
  if (!section?.locked) return;
  const { sealed } = section.locked;
  const opened = await (await engine()).unlock(sealed, password);
  const pages = (JSON.parse(opened.plaintext) as { pages: Page[] }).pages.map(migratePage);
  if (!pages.length) pages.push(ops.emptyPage());
  keys.set(sectionId, { key: opened.key, like: sealed, pages: null, sealed, lastUsed: Date.now() });
  store.edit((d) => eachSection(d, sectionId, (s) => (s.pages = pages)));
  keys.get(sectionId)!.pages = sectionOf(lib(), sectionId)!.pages;
  settle();
}

export async function lockSection(sectionId: Id): Promise<void> {
  const k = keys.get(sectionId);
  const section = sectionOf(lib(), sectionId);
  if (!k || !section?.locked) return void keys.delete(sectionId);
  const sealed = section.pages.length ? await sealCurrent(k, section.pages) : section.locked.sealed;
  keys.delete(sectionId);
  store.edit((d) =>
    eachSection(d, sectionId, (s) => {
      s.pages = [];
      if (s.locked) s.locked.sealed = sealed;
    }),
  );
  const ui = store.getState().ui;
  if (ui.sectionId === sectionId) store.setUi({ pageId: null, active: null, preview: null });
  settle();
}

export async function lockAll(): Promise<number> {
  const ids = [...keys.keys()];
  for (const id of ids) await lockSection(id);
  return ids.length;
}

/** Needs the section unlocked and its current password. */
export async function changePassword(sectionId: Id, oldPassword: string, newPassword: string, hint?: string): Promise<void> {
  const section = sectionOf(lib(), sectionId);
  if (!section?.locked || !keys.has(sectionId)) return;
  const e = await engine();
  await e.unlock(section.locked.sealed, oldPassword);
  const { sealed, key } = await e.protect(seal(section.pages), newPassword);
  keys.set(sectionId, { key, like: sealed, pages: section.pages, sealed, lastUsed: Date.now() });
  store.edit((d) => eachSection(d, sectionId, (s) => (s.locked = { sealed, ...(hint?.trim() ? { hint: hint.trim() } : {}) })));
  keys.get(sectionId)!.pages = sectionOf(lib(), sectionId)!.pages;
  settle();
}

/** Needs the section unlocked and its password; the pages are stored plainly again. */
export async function removePassword(sectionId: Id, password: string): Promise<void> {
  const section = sectionOf(lib(), sectionId);
  if (!section?.locked || !keys.has(sectionId)) return;
  await (await engine()).unlock(section.locked.sealed, password);
  keys.delete(sectionId);
  store.edit((d) => eachSection(d, sectionId, (s) => delete s.locked));
  settle();
}

async function sealCurrent(k: Key, pages: Page[]): Promise<SealedPages> {
  if (k.pages === pages) return k.sealed;
  const sealed = await (await engine()).reseal(seal(pages), k.key, k.like);
  k.pages = pages;
  k.sealed = sealed;
  return sealed;
}

/**
 * The library as it may be stored: every protected section without its
 * pages, sealed as of now. An unlocked section with no pages (the library
 * was reloaded from disk underneath it) counts as locked again.
 */
export async function forStorage(l: Library): Promise<Library> {
  let any = false;
  const protectedIds = new Set<Id>();
  for (const nb of l.notebooks) {
    for (const s of nb.sections) if (s.locked) protectedIds.add(s.id);
    for (const t of nb.trash ?? []) if (t.kind === "section" && t.section.locked) protectedIds.add(t.section.id);
  }
  if (!protectedIds.size) return l;
  const stored = async (s: Section): Promise<Section> => {
    if (!s.locked) return s;
    any = true;
    const k = keys.get(s.id);
    if (k && !s.pages.length) {
      keys.delete(s.id);
      changed();
    }
    const sealed = k && s.pages.length ? await sealCurrent(k, s.pages) : s.locked.sealed;
    return { ...s, pages: [], locked: { ...s.locked, sealed } };
  };
  const notebooks = await Promise.all(
    l.notebooks.map(async (nb) => ({
      ...nb,
      sections: await Promise.all(nb.sections.map(stored)),
      ...(nb.trash
        ? {
            trash: await Promise.all(
              nb.trash
                // Pages deleted from a protected section are deleted for good (see deletePage).
                .filter((t) => t.kind !== "page" || !protectedIds.has(t.sectionId))
                .map(async (t) => (t.kind === "section" ? { ...t, section: await stored(t.section) } : t)),
            ),
          }
        : {}),
    })),
  );
  return any ? { ...l, notebooks } : l;
}

export function isProtectedPage(pageId: Id): boolean {
  return !!ops.findPage(lib(), pageId)?.section.locked;
}

/** Old page versions and stored pictures of a section that just became protected. */
let forget: (pageIds: Id[]) => Promise<void> = async () => {};
export function onForgetPlainCopies(fn: (pageIds: Id[]) => Promise<void>) {
  forget = fn;
}
async function forgetPlainCopies(pageIds: Id[]) {
  try {
    await forget(pageIds);
  } catch (e) {
    console.error("Notecraft: could not remove unprotected copies", e);
  }
}

// --- auto-lock ----------------------------------------------------------------------------

let watching = false;
export function startAutoLock(): void {
  if (watching) return;
  watching = true;
  store.subscribe(() => {
    const id = store.getState().ui.sectionId;
    const k = id ? keys.get(id) : undefined;
    if (k) k.lastUsed = Date.now();
  });
  setInterval(() => {
    const now = Date.now();
    for (const [id, k] of keys) {
      if (now - k.lastUsed < LOCK_AFTER_MS) continue;
      void lockSection(id).then(() => store.toast(`Locked “${sectionOf(lib(), id)?.name ?? "section"}” after 10 minutes away`));
    }
  }, 30_000);
}

/** Tests only: forget every key and use `c` instead of the engine. */
export function _resetLocks(c?: Crypto) {
  keys.clear();
  if (c) crypto = c;
  changed();
}
