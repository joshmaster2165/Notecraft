import { test } from "node:test";
import assert from "node:assert/strict";
import { produce } from "immer";
import type { Library } from "../model/types.ts";
import * as ops from "../model/ops.ts";
import { libraryChanges, savedStateOf } from "./diskSync.ts";
import { BLOB_PREFIX } from "../lib/blobs.ts";
import { markdownToElements } from "../lib/markdown.ts";

function lib(): Library {
  return produce({ version: 1, notebooks: [] } as Library, (d) => {
    const nb = ops.createNotebook(d, "NB");
    ops.createSection(d, nb.id, "Second");
  });
}

test("first save writes everything; later saves only what changed", () => {
  const l0 = lib();
  const first = libraryChanges(null, l0);
  assert.equal(first.changes.pages.length, 2);
  assert.equal(first.changes.notebooks.length, 1);
  assert.ok(first.changes.library);

  // Edit one page title: that page and its notebook manifest (stub title) change.
  const pageId = l0.notebooks[0]!.sections[1]!.pages[0]!.id;
  const l1 = produce(l0, (d) => void ops.setPageTitle(d, pageId, "Plans"));
  const second = libraryChanges(first.state, l1);
  assert.deepEqual(second.changes.pages.map((p) => (p as { id: string }).id), [pageId]);
  assert.equal(second.changes.notebooks.length, 1);
  assert.equal(second.changes.library, undefined);

  // Nothing changed: nothing to write.
  assert.equal(libraryChanges(second.state, l1).empty, true);

  // Delete a page: its file goes.
  const l2 = produce(l1, (d) => void ops.deletePage(d, pageId));
  const third = libraryChanges(second.state, l2);
  assert.ok(third.changes.deletedPages.includes(pageId));
});

test("pictures are stored once as blobs and referenced from pages", () => {
  const png = "data:image/png;base64,iVBORw0KGgo=";
  const l0 = produce(lib(), (d) => {
    const page = d.notebooks[0]!.sections[0]!.pages[0]!;
    ops.addFloatingImage(d, page.id, 10, 10, { src: png, width: 4, height: 4 });
  });
  const { changes, state } = libraryChanges(null, l0);
  const keys = Object.keys(changes.blobs);
  assert.equal(keys.length, 1);
  const page = changes.pages.find((p) => JSON.stringify(p).includes(BLOB_PREFIX)) as { images: { src: string }[] };
  assert.equal(page.images[0]!.src, BLOB_PREFIX + keys[0]);
  // The in-memory page keeps its data URL.
  assert.equal(l0.notebooks[0]!.sections[0]!.pages[0]!.images[0]!.src, png);
  // A later save of the same picture doesn't resend it.
  const l1 = produce(l0, (d) => void ops.setPageTitle(d, d.notebooks[0]!.sections[0]!.pages[0]!.id, "x"));
  assert.deepEqual(libraryChanges(state, l1).changes.blobs, {});
  // Loading from disk counts as saved.
  assert.equal(libraryChanges(savedStateOf(l0), l0).empty, true);
});

test("Markdown becomes paragraphs with lists, to-dos and emphasis", () => {
  const els = markdownToElements("## Plan\n- [ ] Book **venue**\n- [x] Draft\n- Goals\n  - Faster\n1. One\n> Quote\n`code` and [link](https://x.y)");
  assert.deepEqual(els.map((e) => (e.kind === "text" ? e.style : e.kind)), ["h2", "p", "p", "p", "p", "p", "quote", "p"]);
  const [, todo, done, bullet, nested, numbered, , last] = els as Extract<(typeof els)[number], { kind: "text" }>[];
  assert.deepEqual(todo!.tags, [{ kind: "todo", done: false }]);
  assert.deepEqual(todo!.runs, [{ text: "Book " }, { text: "venue", b: true }]);
  assert.equal(done!.tags![0]!.done, true);
  assert.equal(bullet!.list?.kind, "bullet");
  assert.equal(nested!.depth, 1);
  assert.equal(numbered!.list?.kind, "numbered");
  assert.deepEqual(last!.runs, [{ text: "code", font: "Consolas" }, { text: " and " }, { text: "link", href: "https://x.y" }]);
});
