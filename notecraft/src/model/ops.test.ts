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

test("Move Section Group carries its subgroups and sections to another notebook", () => {
  const lib = produce({ version: 1, notebooks: [] } as Library, (d) => {
    const a = ops.createNotebook(d, "A");
    ops.createNotebook(d, "B");
    const g = ops.createSectionGroup(d, a.id, "G");
    const sub = ops.createSectionGroup(d, a.id, "Sub", g.id);
    const s1 = ops.createSection(d, a.id, "In G");
    s1.groupId = g.id;
    const s2 = ops.createSection(d, a.id, "In Sub");
    s2.groupId = sub.id;
  });
  const [a, b] = lib.notebooks as [Library["notebooks"][0], Library["notebooks"][0]];
  const g = a.groups!.find((x) => x.name === "G")!;
  // A group can't move inside itself.
  assert.equal(produce(lib, (d) => void ops.moveSectionGroup(d, g.id, { notebookId: a.id, parentId: a.groups!.find((x) => x.name === "Sub")!.id })).notebooks[0]!.groups!.find((x) => x.id === g.id)!.parentId, undefined);
  const next = produce(lib, (d) => void ops.moveSectionGroup(d, g.id, { notebookId: b.id }));
  const [na, nb] = next.notebooks as [Library["notebooks"][0], Library["notebooks"][0]];
  assert.deepEqual(nb.groups!.map((x) => x.name), ["G", "Sub"]);
  assert.deepEqual(nb.sections.map((s) => s.name).filter((n) => n.startsWith("In")), ["In G", "In Sub"]);
  assert.equal(na.groups!.length, 0);
  assert.ok(na.sections.every((s) => !s.name.startsWith("In")));
});

test("findElement reaches paragraphs inside table cells", () => {
  const { lib, ref } = fixture();
  const cellPara = ops.paragraph([{ text: "in cell" }]);
  const next = produce(lib, (d) => {
    const o = ops.findOutline(d, ref.pageId, ref.outlineId)!;
    o.elements.push({ id: "t1", kind: "table", depth: 0, rows: [{ id: "r1", cells: [{ id: "c1", elements: [cellPara] }] }], columns: [100] } as never);
  });
  const page = ops.findPage(next, ref.pageId)!.page;
  assert.equal(ops.findElement(page, cellPara.id)?.id, cellPara.id);
  assert.equal(ops.findElement(page, "nope"), undefined);
});

test("moveInkStrokes shifts only the selected strokes", () => {
  const { lib, ref } = fixture();
  const next = produce(lib, (d) => {
    ops.addInkStroke(d, ref.pageId, { id: "k1", tool: "pen", color: "#000", width: 2, points: [0, 0, 10, 10] });
    ops.addInkStroke(d, ref.pageId, { id: "k2", tool: "pen", color: "#000", width: 2, points: [5, 5] });
    ops.moveInkStrokes(d, ref.pageId, ["k1"], 3, -2);
  });
  const ink = ops.findPage(next, ref.pageId)!.page.ink!;
  assert.deepEqual(ink[0]!.points, [3, -2, 13, 8]);
  assert.deepEqual(ink[1]!.points, [5, 5]);
});
