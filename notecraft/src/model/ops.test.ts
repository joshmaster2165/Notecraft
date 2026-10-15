import { test } from "node:test";
import assert from "node:assert/strict";
import { produce } from "immer";
import type { Library, ParagraphEl } from "./types.ts";
import * as ops from "./ops.ts";
import { listMarkers, defaultList } from "./lists.ts";
import { splitRuns, normalizeRuns, autoLink } from "../lib/richtext.ts";

function fixture() {
  const p = (text: string, extra: Partial<ParagraphEl> = {}) => ops.paragraph([{ text }], extra);
  const lib: Library = { version: 1, notebooks: [] };
  const draft = produce(lib, (d) => {
    const nb = ops.createNotebook(d, "NB");
    const page = nb.sections[0]!.pages[0]!;
    page.outlines.push({ id: "o1", x: 54, y: 90, width: 400, widthSetByUser: false, elements: [p("parent"), p("child", { depth: 1 }), p("sibling")] });
  });
  const pageId = draft.notebooks[0]!.sections[0]!.pages[0]!.id;
  return { lib: draft, ref: { pageId, outlineId: "o1" } };
}
const texts = (lib: Library, ref: { pageId: string; outlineId: string }) =>
  ops.findOutline(lib, ref.pageId, ref.outlineId)!.elements.map((e) => `${e.depth}:${e.kind === "text" ? e.runs.map((r) => r.text).join("") : e.kind}`);

test("Enter splits at the caret and keeps depth", () => {
  const { lib, ref } = fixture();
  const id = ops.findOutline(lib, ref.pageId, "o1")!.elements[0]!.id;
  const next = produce(lib, (d) => void ops.splitParagraph(d, ref, id, 3));
  assert.deepEqual(texts(next, ref), ["0:par", "0:ent", "1:child", "0:sibling"]);
});

test("Tab indents the subtree; Shift+Tab outdents it", () => {
  const { lib, ref } = fixture();
  const els = ops.findOutline(lib, ref.pageId, "o1")!.elements;
  // "parent" is first: it cannot be indented.
  assert.deepEqual(texts(produce(lib, (d) => void ops.indent(d, ref, els[0]!.id)), ref), texts(lib, ref));
  const indented = produce(lib, (d) => void ops.indent(d, ref, els[2]!.id));
  assert.deepEqual(texts(indented, ref), ["0:parent", "1:child", "1:sibling"]);
  const out = produce(lib, (d) => void ops.outdent(d, ref, els[1]!.id));
  assert.deepEqual(texts(out, ref), ["0:parent", "0:child", "0:sibling"]);
});

test("Backspace at start removes the list, then outdents, then merges", () => {
  const { lib, ref } = fixture();
  const child = ops.findOutline(lib, ref.pageId, "o1")!.elements[1]!;
  let s = produce(lib, (d) => void ops.toggleList(d, ref, [child.id], "bullet"));
  s = produce(s, (d) => void ops.backspaceAtStart(d, ref, child.id));
  assert.equal(ops.findOutline(s, ref.pageId, "o1")!.elements[1]!.list, undefined);
  s = produce(s, (d) => void ops.backspaceAtStart(d, ref, child.id));
  assert.deepEqual(texts(s, ref), ["0:parent", "0:child", "0:sibling"]);
  s = produce(s, (d) => void ops.backspaceAtStart(d, ref, child.id));
  assert.deepEqual(texts(s, ref), ["0:parentchild", "0:sibling"]);
});

test("Indenting a default numbered item switches 1. to a.", () => {
  const { lib, ref } = fixture();
  const els = ops.findOutline(lib, ref.pageId, "o1")!.elements;
  let s = produce(lib, (d) => void ops.toggleList(d, ref, [els[0]!.id, els[2]!.id], "numbered"));
  s = produce(s, (d) => void ops.indent(d, ref, els[2]!.id));
  assert.deepEqual(ops.findOutline(s, ref.pageId, "o1")!.elements[2]!.list, defaultList("numbered", 1));
});

test("Numbering counts siblings at the same depth across nested items", () => {
  const n = defaultList("numbered", 0);
  const els = [ops.paragraph([], { list: n }), ops.paragraph([], { depth: 1 }), ops.paragraph([], { list: n }), ops.paragraph([]), ops.paragraph([], { list: n })];
  assert.deepEqual(listMarkers(els), ["1.", null, "2.", null, "1."]);
});

test("Run helpers split, merge and auto-link", () => {
  const runs = normalizeRuns([{ text: "ab", b: true }, { text: "cd", b: true }, { text: "ef" }]);
  assert.deepEqual(runs, [{ text: "abcd", b: true }, { text: "ef" }]);
  assert.deepEqual(splitRuns(runs, 3), [[{ text: "abc", b: true }], [{ text: "d", b: true }, { text: "ef" }]]);
  assert.deepEqual(autoLink([{ text: "see https://example.com/x." }]), [{ text: "see " }, { text: "https://example.com/x", href: "https://example.com/x" }, { text: "." }]);
});

test("Pages nest at most one level below their predecessor", () => {
  const { lib } = fixture();
  const sectionId = lib.notebooks[0]!.sections[0]!.id;
  let s = produce(lib, (d) => void ops.createPage(d, sectionId));
  const second = s.notebooks[0]!.sections[0]!.pages[1]!.id;
  s = produce(s, (d) => {
    ops.setPageLevel(d, second, 1);
    ops.setPageLevel(d, second, 1);
  });
  assert.equal(ops.findPage(s, second)!.page.level, 2);
});
