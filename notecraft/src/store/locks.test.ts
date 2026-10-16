import { test } from "node:test";
import assert from "node:assert/strict";
import { produce } from "immer";
import type { Library, Page, SealedPages } from "../model/types.ts";
import * as ops from "../model/ops.ts";
import { store } from "./store.ts";
import { _resetLocks, changePassword, forStorage, lockSection, lockState, protectSection, removePassword, unlockSection } from "./locks.ts";
import { libraryChanges } from "./diskSync.ts";

// A stand-in for the Rust engine's AES-GCM: readable, but it checks passwords
// and gives every seal a new nonce like the real one.
let nonce = 0;
const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64");
const dec = <T,>(data: string) => JSON.parse(Buffer.from(data, "base64").toString()) as T;
const pack = (password: string, plaintext: string): SealedPages => ({ version: 1, kdf: "test", iterations: 1, salt: "salt", nonce: String(++nonce), data: enc({ password, plaintext }) });
const fake = {
  protect: async (plaintext: string, password: string) => ({ sealed: pack(password, plaintext), key: `key:${password}` }),
  unlock: async (sealed: SealedPages, password: string) => {
    const d = dec<{ password: string; plaintext: string }>(sealed.data);
    if (d.password !== password) throw new Error("That password isn't right.");
    return { plaintext: d.plaintext, key: `key:${password}` };
  },
  reseal: async (plaintext: string, key: string) => pack(key.slice(4), plaintext),
};
const opened = (s: SealedPages) => (JSON.parse(dec<{ plaintext: string }>(s.data).plaintext) as { pages: Page[] }).pages;

function setup(): { sectionId: string; pageId: string } {
  _resetLocks(fake);
  const lib = produce({ version: 1, notebooks: [] } as Library, (d) => {
    const nb = ops.createNotebook(d, "NB");
    const s = ops.createSection(d, nb.id, "Private");
    ops.setPageTitle(d, s.pages[0]!.id, "Diary");
  });
  store.replaceLibrary(lib, { resetHistory: true });
  const section = lib.notebooks[0]!.sections[1]!;
  return { sectionId: section.id, pageId: section.pages[0]!.id };
}
const section = (id: string) => ops.findSection(store.getState().lib, id)!.section;

test("a protected section is only ever stored sealed", async () => {
  const { sectionId, pageId } = setup();
  store.edit((d) => ops.setPageTitle(d, pageId, "Before"));
  await protectSection(sectionId, "pw", "the usual");
  assert.equal(lockState(section(sectionId)), "unlocked");
  assert.equal(store.getState().canUndo, false, "protecting can't be undone into plain pages");

  const stored = await forStorage(store.getState().lib);
  const s = stored.notebooks[0]!.sections[1]!;
  assert.deepEqual(s.pages, []);
  assert.equal(s.locked!.hint, "the usual");
  assert.deepEqual(opened(s.locked!.sealed).map((p) => p.title), ["Before"]);
  // Other sections are stored as they are.
  assert.equal(stored.notebooks[0]!.sections[0], store.getState().lib.notebooks[0]!.sections[0]);

  // On disk: no page file for the protected page, and the manifest carries the seal.
  const { changes } = libraryChanges(null, stored);
  const files = changes.pages.map((p) => (p as Page).id);
  assert.ok(!files.includes(pageId));
  assert.match(JSON.stringify(changes.notebooks), /"locked"/);
  assert.doesNotMatch(JSON.stringify(changes), /Before/);
});

test("edits re-seal with the cached key; unchanged pages keep their seal", async () => {
  const { sectionId, pageId } = setup();
  await protectSection(sectionId, "pw");
  const first = (await forStorage(store.getState().lib)).notebooks[0]!.sections[1]!.locked!.sealed;
  const again = (await forStorage(store.getState().lib)).notebooks[0]!.sections[1]!.locked!.sealed;
  assert.equal(again, first, "no re-seal without changes");
  store.edit((d) => ops.setPageTitle(d, pageId, "Edited"));
  const next = (await forStorage(store.getState().lib)).notebooks[0]!.sections[1]!.locked!.sealed;
  assert.notEqual(next.nonce, first.nonce);
  assert.deepEqual(opened(next).map((p) => p.title), ["Edited"]);
  assert.equal(dec<{ password: string }>(next.data).password, "pw");
});

test("lock, wrong password, unlock", async () => {
  const { sectionId, pageId } = setup();
  await protectSection(sectionId, "pw");
  store.edit((d) => ops.setPageTitle(d, pageId, "Latest"));
  store.setUi({ sectionId, pageId });
  await lockSection(sectionId);
  assert.equal(lockState(section(sectionId)), "locked");
  assert.deepEqual(section(sectionId).pages, []);
  assert.equal(store.getState().ui.pageId, null);
  assert.equal(store.getState().canUndo, false, "undo can't bring the plain pages back");
  assert.deepEqual(opened(section(sectionId).locked!.sealed).map((p) => p.title), ["Latest"]);

  await assert.rejects(unlockSection(sectionId, "nope"), /isn't right/);
  assert.equal(lockState(section(sectionId)), "locked");
  await unlockSection(sectionId, "pw");
  assert.equal(lockState(section(sectionId)), "unlocked");
  assert.deepEqual(section(sectionId).pages.map((p) => [p.id, p.title]), [[pageId, "Latest"]]);
});

test("a reload underneath an unlocked section never seals it empty", async () => {
  const { sectionId } = setup();
  await protectSection(sectionId, "pw");
  const good = (await forStorage(store.getState().lib)).notebooks[0]!.sections[1]!.locked!.sealed;
  // The library folder changed outside the app and was reloaded: the section comes back locked.
  const reloaded = await forStorage(store.getState().lib);
  store.replaceLibrary(reloaded, { resetHistory: true });
  const stored = (await forStorage(store.getState().lib)).notebooks[0]!.sections[1]!.locked!.sealed;
  assert.equal(stored, good);
  assert.equal(lockState(section(sectionId)), "locked");
});

test("deleted protected sections stay sealed in Deleted Notes", async () => {
  const { sectionId } = setup();
  await protectSection(sectionId, "pw");
  store.edit((d) => ops.trashSection(d, sectionId));
  const nb = (await forStorage(store.getState().lib)).notebooks[0]!;
  const t = nb.trash![0]!;
  assert.equal(t.kind, "section");
  assert.deepEqual(t.kind === "section" && t.section.pages, []);
  assert.ok(t.kind === "section" && t.section.locked);
});

test("change and remove the password", async () => {
  const { sectionId } = setup();
  await protectSection(sectionId, "old");
  await assert.rejects(changePassword(sectionId, "wrong", "new"), /isn't right/);
  await changePassword(sectionId, "old", "new", "second");
  assert.equal(section(sectionId).locked!.hint, "second");
  await lockSection(sectionId);
  await assert.rejects(unlockSection(sectionId, "old"), /isn't right/);
  await unlockSection(sectionId, "new");
  await removePassword(sectionId, "new");
  assert.equal(lockState(section(sectionId)), "none");
  const stored = (await forStorage(store.getState().lib)).notebooks[0]!.sections[1]!;
  assert.equal(stored.pages.length, 1, "stored plainly again");
});

test("protecting clears the section's Deleted Notes; nothing is restored into a locked section", async () => {
  const { sectionId, pageId } = setup();
  const nbId = store.getState().lib.notebooks[0]!.id;
  const other = store.getState().lib.notebooks[0]!.sections[0]!.id;
  store.edit((d) => ops.createPage(d, sectionId));
  store.edit((d) => ops.trashPage(d, pageId));
  await protectSection(sectionId, "pw");
  assert.deepEqual(store.getState().lib.notebooks[0]!.trash, [], "its deleted pages would stay readable");
  await lockSection(sectionId);
  assert.equal(ops.isSealedShut(section(sectionId)), true);
  // A deleted page that names the locked section (e.g. from an imported notebook) restores elsewhere.
  store.edit((d) => void d.notebooks[0]!.trash!.push({ kind: "page", page: ops.emptyPage("Old"), sectionId, sectionName: "Private", deletedAt: new Date().toISOString() }));
  const restored = store.edit((d) => ops.restoreFromTrash(d, nbId, 0));
  assert.equal(ops.findPage(store.getState().lib, restored!)!.section.id, other);
  assert.deepEqual(section(sectionId).pages, []);
});
