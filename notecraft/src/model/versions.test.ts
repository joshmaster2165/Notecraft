import { test } from "node:test";
import assert from "node:assert/strict";
import { produce } from "immer";
import type { Library, Page, VersionReason } from "./types.ts";
import * as ops from "./ops.ts";
import { changedPages, pageSignature, pruneIds, restorePageVersion, VersionTracker } from "./versions.ts";

function fakeTimers() {
  let now = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    set: (fn: () => void, ms: number) => {
      timers.set(++seq, { at: now + ms, fn });
      return seq;
    },
    clear: (h: unknown) => void timers.delete(h as number),
    advance(ms: number) {
      now += ms;
      for (const [id, t] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
        if (t.at <= now) {
          timers.delete(id);
          t.fn();
        }
      }
    },
  };
}

function page(text: string): Page {
  const p = ops.emptyPage("Notes");
  p.id = "p1";
  p.outlines = [{ id: "o1", x: 54, y: 90, width: 400, widthSetByUser: false, elements: [{ ...ops.paragraph([{ text }]), id: "e1" }] }];
  return p;
}

function harness() {
  const clock = fakeTimers();
  const saved: { reason: VersionReason; text: string }[] = [];
  let current = page("v0");
  const tracker = new VersionTracker(
    {
      save: (_id, p, reason) => saved.push({ reason, text: (p.outlines[0]!.elements[0] as { runs: { text: string }[] }).runs[0]!.text }),
      currentPage: () => current,
      setTimer: clock.set,
      clearTimer: clock.clear,
    },
    60_000,
  );
  const edit = (text: string) => {
    const before = current;
    current = page(text);
    tracker.edited("p1", before);
  };
  return { clock, saved, tracker, edit };
}

test("first edit saves the state before it, then one snapshot after a minute of quiet", () => {
  const { clock, saved, edit } = harness();
  edit("v1");
  edit("v2");
  clock.advance(30_000);
  edit("v3"); // re-arms the idle timer
  clock.advance(59_000);
  assert.deepEqual(saved, [{ reason: "before-edit", text: "v0" }]);
  clock.advance(1_000);
  assert.deepEqual(saved, [{ reason: "before-edit", text: "v0" }, { reason: "idle", text: "v3" }]);
});

test("leaving a page with unsaved edits snapshots it immediately", () => {
  const { clock, saved, tracker, edit } = harness();
  edit("v1");
  tracker.left("p1");
  assert.deepEqual(saved.map((s) => s.reason), ["before-edit", "leave"]);
  clock.advance(120_000);
  assert.equal(saved.length, 2, "the idle timer was cancelled");
  tracker.left("p1");
  assert.equal(saved.length, 2, "nothing pending, nothing saved");
});

test("signatures ignore timestamps but see content changes", () => {
  const a = page("same");
  const b = { ...page("same"), modifiedAt: "2030-01-01T00:00:00.000Z" };
  assert.equal(pageSignature(a), pageSignature(b));
  assert.notEqual(pageSignature(a), pageSignature(page("different")));
});

test("only content changes count as page edits", () => {
  const lib: Library = { version: 1, notebooks: [] };
  const base = produce(lib, (d) => {
    const nb = ops.createNotebook(d, "NB");
    nb.sections[0]!.pages = [page("v0")];
  });
  const levelOnly = produce(base, (d) => void (d.notebooks[0]!.sections[0]!.pages[0]!.level = 2));
  assert.deepEqual(changedPages(base, levelOnly), []);
  const edited = produce(base, (d) => void ops.setPageTitle(d, "p1", "Renamed"));
  assert.deepEqual(changedPages(base, edited).map((c) => c.pageId), ["p1"]);
});

test("pruning keeps the newest Notecraft versions and never imported ones", () => {
  const vs = [
    ...Array.from({ length: 5 }, (_, i) => ({ id: `n${i}`, at: `2026-01-0${i + 1}`, source: "notecraft" as const })),
    { id: "one", at: "2020-01-01", source: "onenote" as const },
  ];
  assert.deepEqual(pruneIds(vs, 3), ["n1", "n0"]);
});

test("restoring a version replaces content in one edit and keeps the page's place", () => {
  const lib: Library = { version: 1, notebooks: [] };
  const base = produce(lib, (d) => {
    const nb = ops.createNotebook(d, "NB");
    nb.sections[0]!.pages = [{ ...page("now"), level: 2 }];
  });
  const old = { ...page("then"), title: "Old title" };
  const restored = produce(base, (d) => restorePageVersion(d, "p1", old));
  const p = ops.findPage(restored, "p1")!.page;
  assert.equal(p.title, "Old title");
  assert.equal(p.level, 2);
  assert.equal(pageSignature(p), pageSignature({ ...old, modifiedAt: p.modifiedAt }));
});
