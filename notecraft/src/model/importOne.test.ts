// importOne's mappings for the OneNote features of file-format.md §15:
// crop, printouts, equations, Ink to Shape, password-protected sections and media.
//
// importOne.ts imports the Rust engine (../engine.ts) and the vite-only parser
// loader (./parser.ts). Node's module hooks stand in for both, the way vi.mock
// would, and resolve the @re alias that vite.config.ts defines.
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { readFileSync } from "node:fs";
import type { ContentBlock, EmbeddedFileBlock, ImageBlock, InkBlock, InkStroke as OneInkStroke, MathObject, NotebookJson, OutlineElementBlock, Page as OnePage, PageBlock, TextRun } from "@re/parser/src/notebook.ts";
import type { CropRect, Element, FileEl, ImageEl, MathEl, ParagraphEl } from "./types.ts";

const reRoot = new URL("../../../onenote-re/", import.meta.url).href;
const stub = (code: string) => ({ url: `data:text/javascript,${encodeURIComponent(code)}`, shortCircuit: true });
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@re/")) return nextResolve(reRoot + specifier.slice(4), context);
    if (context.parentURL?.endsWith("/src/model/importOne.ts")) {
      if (specifier === "../engine.ts") return stub("export const cropImage = (src, rect) => globalThis.__notecraftCrop(src, rect);");
      if (specifier === "./parser.ts") return stub("export const parseSection = () => { throw new Error('not in tests'); };");
    }
    return nextResolve(specifier, context);
  },
});
const { importNotebookJson, importNotebookJsonAsync, finishImport, buildDown, shapeKindOf, LOCKED_SECTION_MESSAGE } = await import("./importOne.ts");

type Crop = (src: string, rect: CropRect) => Promise<{ src: string; width: number; height: number }>;
const engine = globalThis as { __notecraftCrop?: Crop };

// --- fixtures ----------------------------------------------------------------------

let ids = 0;
const id = () => `{00000000-0000-0000-0000-${String(++ids).padStart(12, "0")}}#1`;

function notebook(pages: OnePage[], section: Partial<NotebookJson["section"]> = {}): NotebookJson {
  return {
    format: "onenote-revision-store",
    source: { fileKind: "one", guidFile: "{G}", fileFormatVersion: { lastWriter: "0x2a", oldestWriter: "0x2a", newestWriter: "0x2a", oldestReader: "0x2a" }, byteLength: 0, objectSpaces: 1, embeddedFiles: 0 },
    section: { id: "{S}#1", pages, ...section },
    diagnostics: { warnings: [], encryptedObjectSpaces: [] },
  };
}
const page = (blocks: PageBlock[], title = "Page"): OnePage => ({ id: id(), title, size: {}, titleBlocks: [], blocks });
const outline = (...content: ContentBlock[]): PageBlock => ({
  type: "outline",
  id: id(),
  layout: { x: 50, y: 80, width: 400 },
  children: content.map((c) => ({ type: "outlineElement", id: id(), content: [c], children: [] })),
});
const image = (ref: string | undefined, extra: Partial<ImageBlock> = {}): ImageBlock => ({
  type: "image",
  id: id(),
  layout: { width: 100, height: 50 },
  assetStatus: ref ? "embedded" : "notEmbedded",
  asset: ref ? { byteLength: 10, mediaType: "image/png", ref } : null,
  ...extra,
});
const file = (name: string | undefined, mediaType: string, ref: string, extra: Partial<EmbeddedFileBlock> = {}): EmbeddedFileBlock => ({
  type: "embeddedFile",
  id: id(),
  layout: { x: 300, y: 400 },
  ...(name ? { filename: name } : {}),
  assetStatus: "embedded",
  asset: { byteLength: 1234, mediaType, ref },
  ...extra,
});
const run = (text: string, math = false, mathObject?: MathObject): TextRun => ({ start: 0, end: text.length, text, style: { ...(math ? { math: true } : {}), ...(mathObject ? { mathObject } : {}) } });
const rich = (...runs: TextRun[]): ContentBlock => ({ type: "richText", id: id(), text: runs.map((r) => r.text).join(""), runs, paragraph: {} });
const assets = new Map([
  ["pic", "data:image/png;base64,UElD"],
  ["pdf", "data:application/pdf;base64,UERG"],
  ["m4a", "data:application/octet-stream;base64,TTRB"],
  ["mp4", "data:video/mp4;base64,TVA0"],
]);
const elements = (r: { section: { pages: { outlines: { elements: Element[] }[] }[] } }, p = 0) => r.section.pages[p]!.outlines.flatMap((o) => o.elements);

// --- crop --------------------------------------------------------------------------

test("crop: the picture comes in whole, then finishImport crops it and keeps the original", async () => {
  const crop = { topLeftXPercentage: 25, topLeftYPercentage: 10, widthPercentage: 50, heightPercentage: 75 };
  const r = importNotebookJson(notebook([page([image("pic", { crop })])]), "S.one", assets);
  const img = r.section.pages[0]!.images[0]!;
  // Whole picture at the size the cropped frame (100×50) implies.
  assert.deepEqual([img.src, img.width, img.height, img.crop, img.original], ["data:image/png;base64,UElD", 200, 67, undefined, undefined]);
  assert.equal(r.pendingCrops.length, 1);

  const calls: [string, CropRect][] = [];
  engine.__notecraftCrop = async (src, rect) => (calls.push([src, rect]), { src: "data:image/png;base64,Q1JPUA==", width: 50, height: 25 });
  await finishImport(r);
  assert.deepEqual(calls, [["data:image/png;base64,UElD", crop]]);
  assert.equal(img.src, "data:image/png;base64,Q1JPUA==");
  assert.deepEqual([img.width, img.height], [100, 50]);
  assert.deepEqual(img.crop, crop);
  assert.deepEqual(img.original, { src: "data:image/png;base64,UElD", width: 200, height: 67 });
  assert.equal(r.stats.croppedImages, 1);
  assert.equal(r.pendingCrops.length, 0);
});

test("crop: a frame shaped like the whole picture is the whole picture", async () => {
  // 200×100 frame; the crop keeps half the width (an 80×120 px region of a 160×120 px picture).
  const crop = { topLeftXPercentage: 50, topLeftYPercentage: 0, widthPercentage: 50, heightPercentage: 100 };
  const r = importNotebookJson(notebook([page([outline(image("pic", { crop, layout: { width: 160, height: 120 } }))])]), "S.one", assets);
  const img = (elements(r)[0] as ImageEl).image;
  await finishImport(r, async () => ({ src: "data:image/png;base64,QQ==", width: 80, height: 120 }));
  assert.deepEqual([img.width, img.height, img.original?.width, img.original?.height], [80, 120, 160, 120]);
});

test("crop: when the engine can't crop, the picture stays whole without a crop", async () => {
  const crop = { topLeftXPercentage: 0, topLeftYPercentage: 0, widthPercentage: 50, heightPercentage: 50 };
  engine.__notecraftCrop = async () => {
    throw new Error("unsupported picture");
  };
  const warn = console.warn;
  console.warn = () => {};
  try {
    const r = await importNotebookJsonAsync(notebook([page([image("pic", { crop }), image(undefined, { crop })])]), "S.one", assets);
    const [a, missing] = r.section.pages[0]!.images;
    assert.deepEqual([a!.src, a!.width, a!.height, a!.crop, a!.original], ["data:image/png;base64,UElD", 200, 100, undefined, undefined]);
    // No bytes, nothing to crop: the frame's size, no crop either.
    assert.deepEqual([missing!.src, missing!.width, missing!.height, missing!.crop], [undefined, 100, 50, undefined]);
    assert.equal(r.stats.croppedImages, 0);
  } finally {
    console.warn = warn;
  }
});

// --- printouts ---------------------------------------------------------------------

test("printouts link to the attachment before them, across a split onto the next page", () => {
  const r = importNotebookJson(
    notebook([
      page([outline(file("report.pdf", "application/pdf", "pdf", { printoutOutOfDate: true }), image("pic", { printout: { page: 1 } }), image("pic", { printout: { page: 2 } }))]),
      // The rest of a long printout: no attachment on this page.
      page([image("pic", { printout: { page: 3, splitPart: true } })]),
      page([outline(file("notes.pdf", "application/pdf", "pdf"), image("pic", { printout: {} }), image(undefined, { printout: {} }))]),
    ]),
    "S.one",
    assets,
  );
  const [attachment, p1, p2] = elements(r) as [FileEl, ImageEl, ImageEl];
  assert.equal(attachment.name, "report.pdf");
  assert.deepEqual(p1.image.printout, { file: "report.pdf", page: 1, pages: 3 });
  assert.deepEqual(p2.image.printout, { file: "report.pdf", page: 2, pages: 3 });
  const p3 = r.section.pages[1]!.images[0]!;
  assert.deepEqual(p3.printout, { file: "report.pdf", page: 3, pages: 3 });
  // The attachment changed after the pictures were made: kept, and labelled.
  assert.equal(p1.image.alt, "report.pdf, page 1 of 3 (out of date)");
  const [, q1, q2] = elements(r, 2) as [FileEl, ImageEl, ImageEl];
  assert.deepEqual([q1.image.printout, q2.image.printout], [
    { file: "notes.pdf", page: 1, pages: 2 },
    { file: "notes.pdf", page: 2, pages: 2 },
  ]);
  assert.equal(q1.image.alt, "notes.pdf, page 1 of 2");
  assert.equal(r.stats.printouts, 5);
});

// --- equations ---------------------------------------------------------------------

const FRACTION = { type: 16, args: 2 };
test("equations: an all-math paragraph becomes a math element in UnicodeMath", () => {
  const r = importNotebookJson(
    notebook([
      page([
        outline(
          rich(run("﷐", true, FRACTION), run("a+b﷮c﷯", true)),
          rich(run("Area is "), run("﷐", true, { type: 31 }), run("r﷮2﷯", true), run(" m.")),
          rich(run("  "), run("x=5", true)),
          rich(run("﷐", true, { type: 99 }), run("p﷮q﷯", true)),
        ),
      ]),
    ]),
    "S.one",
    assets,
  );
  const [fraction, mixed, plain, unknown] = elements(r) as [MathEl, ParagraphEl, MathEl, MathEl];
  assert.deepEqual([fraction.kind, fraction.linear], ["math", "(a+b)/c"]);
  // Text with an inline equation keeps flowing; the equation is its linear form.
  assert.deepEqual(mixed.runs, [{ text: "Area is " }, { text: "r^2", font: "Cambria Math" }, { text: " m." }]);
  assert.equal(plain.linear, "x=5");
  // MathData_Type not known: the visible text.
  assert.equal(unknown.linear, "p q");
  assert.deepEqual([r.stats.equations, r.stats.equationsUndecoded, r.stats.paragraphs], [4, 1, 1]);
});

test("equations: build-down of RichEdit's math objects", () => {
  const at = (objs: Record<number, MathObject>) => (i: number) => objs[i];
  // ∑_(i=1)^n i
  assert.deepEqual(buildDown("﷐i=1﷮n﷮i﷯", at({ 0: { type: 21, char: 0x2211 } })), { linear: "∑_(i=1)^n i", decoded: true });
  // x=(-b±√(b^2-4ac))/2a, with nesting.
  const quad = "x=﷐-b±﷐﷐b﷮2﷯-4ac﷯﷮2a﷯";
  assert.equal(buildDown(quad, at({ 2: FRACTION, 6: { type: 25, args: 1 }, 7: { type: 31 } })).linear, "x=(-b±√(b^2-4ac))/(2a)");
  assert.equal(buildDown("﷐x﷮﷮﷯", at({ 0: { type: 30 } })).linear, "x");
  assert.equal(buildDown("﷐﷮x﷯", at({ 0: { type: 25, args: 2 } })).linear, "√x");
  assert.equal(buildDown("﷐n﷮x﷯", at({ 0: { type: 25, args: 2 } })).linear, "√(n&x)");
  assert.equal(buildDown("﷐a+b﷯", at({ 0: { type: 13, char: 0x5b, char1: 0x5d } })).linear, "[a+b]");
  assert.equal(buildDown("﷐sin﷮x﷯", at({ 0: { type: 17 } })).linear, "sin⁡x");
  assert.equal(buildDown("﷐a﷮b﷮c﷮d﷯", at({ 0: { type: 20, columns: 2 } })).linear, "■(a&b@c&d)");
  // Function names are one operand; a limit under one is followed by a space, not U+2061.
  const sinSquared = "\ufdd0\ufdd0sin\ufdee2\ufdef\ufdeex\ufdef";
  assert.equal(buildDown(sinSquared, at({ 0: { type: 17 }, 1: { type: 31 } })).linear, "sin^2\u2061x");
  const limit = "\ufdd0\ufdd0lim\ufdeen→∞\ufdef\ufdee\ufdd0a\ufdeen\ufdef\ufdef";
  assert.equal(buildDown(limit, at({ 0: { type: 17 }, 1: { type: 19 }, 11: { type: 29 } })).linear, "lim┬(n→∞) a_n");
  assert.equal(buildDown("\ufdd0sin\ufdeex+y\ufdef", at({ 0: { type: 17 } })).linear, "sin\u2061(x+y)");
  // Missing MathData: visible text, flagged.
  assert.deepEqual(buildDown("﷐a﷮b﷯", at({})), { linear: "a b", decoded: false });
});

// --- Ink to Shape ------------------------------------------------------------------

test("Ink to Shape: converted strokes are shapes named like the engine's ShapeKind", () => {
  const stroke = (points: number[], source?: "shape2d" | "line"): OneInkStroke => ({ points, ...(source ? { shape: { source, byteLength: 8, data: "00" } } : {}) });
  const ring = Array.from({ length: 33 }, (_, k) => [200 + 60 * Math.cos((k / 32) * 2 * Math.PI), 200 + 30 * Math.sin((k / 32) * 2 * Math.PI)]).flat();
  const ink: InkBlock = {
    type: "ink",
    id: id(),
    strokes: [
      stroke([0, 0, 100, 0, 100, 50, 0, 50, 0, 0], "shape2d"),
      stroke([0, 0, 50, 80, 100, 0, 0, 0], "shape2d"),
      stroke([50, 0, 100, 40, 50, 80, 0, 40, 50, 0], "shape2d"),
      stroke(ring, "shape2d"),
      stroke([0, 0, 120, 40], "line"),
      stroke([0, 0, 100, 0, 88, -8, 100, 0, 88, 8], "line"),
      stroke([0, 0, 30, 10, 60, 0]),
    ],
  };
  const r = importNotebookJson(notebook([page([ink])]), "S.one", assets);
  const strokes = r.section.pages[0]!.ink!;
  assert.deepEqual(
    strokes.map((s) => [s.shape, s.shapeKind]),
    [
      [true, "rectangle"],
      [true, "triangle"],
      [true, "diamond"],
      [true, "ellipse"],
      [true, "line"],
      [true, "arrow"],
      [undefined, undefined],
    ],
  );
  // The geometry blob isn't decoded: the stroke keeps OneNote's own points.
  assert.deepEqual(strokes[0]!.points, [0, 0, 100, 0, 100, 50, 0, 50, 0, 0]);
  assert.equal(r.stats.inkShapes, 6);
  assert.equal(shapeKindOf([0, 0, 10, 0, 10, 10, 0, 10, 5, 15, 0, 0], { source: "shape2d" }), "polygon");
});

// --- password-protected sections ---------------------------------------------------

test("a password-protected section comes in locked-by-name with one explanatory page", () => {
  const json = notebook([], { name: "Finance", encrypted: true });
  json.diagnostics.encryptedObjectSpaces.push("{E}#1");
  const r = importNotebookJson(json, "Finance.one", assets);
  assert.equal(r.passwordProtected, true);
  assert.equal(r.section.name, "Finance (locked)");
  // Not Notecraft's own lock: that needs a sealed payload.
  assert.equal(r.section.locked, undefined);
  assert.equal(r.section.pages.length, 1);
  const p = r.section.pages[0]!;
  assert.equal(p.title, "Password protected in OneNote");
  assert.deepEqual((p.outlines[0]!.elements[0] as ParagraphEl).runs, [{ text: LOCKED_SECTION_MESSAGE }]);
  assert.equal(LOCKED_SECTION_MESSAGE, "This section is password protected in OneNote. Unlock it in OneNote and import it again.");

  // Readable pages of a partly encrypted section follow the explanation.
  const partly = importNotebookJson(notebook([page([], "Open page")], { encrypted: true }), "Mixed.one", assets);
  assert.deepEqual(partly.section.pages.map((x) => x.title), ["Password protected in OneNote", "Open page"]);
  assert.equal(importNotebookJson(notebook([page([])]), "Plain.one", assets).passwordProtected, false);
});

// --- media -------------------------------------------------------------------------

test("recordings and media attachments become playable files", () => {
  const r = importNotebookJson(
    notebook([
      page([
        outline(file(undefined, "audio/mp4", "m4a", { recording: { media: 1, duration: 5000 } }), file("clip", "video/mp4", "mp4"), file("report.pdf", "application/pdf", "pdf")),
        // Attachments placed straight on the page land in an outline at their position.
        file("lecture.mp4", "video/mp4", "mp4"),
        image("pic", { embed: { url: "https://video.example/v/1", title: "Talk" } }),
      ]),
    ]),
    "S.one",
    assets,
  );
  const [audio, video, pdf, onPage, link] = elements(r) as [FileEl, FileEl, FileEl, FileEl, ParagraphEl];
  assert.deepEqual([audio.name, audio.src, audio.size], ["Audio recording.m4a", "data:audio/mp4;base64,TTRB", 1234]);
  assert.deepEqual([video.name, video.src], ["clip.mp4", "data:video/mp4;base64,TVA0"]);
  assert.deepEqual([pdf.name, pdf.src], ["report.pdf", "data:application/pdf;base64,UERG"]);
  assert.equal(onPage.name, "lecture.mp4");
  const outlines = r.section.pages[0]!.outlines;
  assert.deepEqual([outlines[1]!.x, outlines[1]!.y], [300, 400]);
  // An online video (IFrame*) has no bytes: its link.
  assert.deepEqual(link.runs, [{ text: "Talk", href: "https://video.example/v/1" }]);
  assert.equal(r.stats.media, 3);
});

// --- styles and tags (writer round trip) -------------------------------------------

test("OneNote's built-in blockquote style is Notecraft's quote", () => {
  const para = (styleId: string): ContentBlock => ({ type: "richText", id: id(), text: "q", runs: [run("q")], paragraph: { styleId } });
  const r = importNotebookJson(notebook([page([outline(para("blockquote"), para("Quote"), para("cite"), para("PageTitle"))])]), "S.one", assets);
  assert.deepEqual((elements(r) as ParagraphEl[]).map((e) => e.style), ["quote", "quote", "cite", "p"]);
});

test("a custom tag is checkable only when its shape is a check box", () => {
  const tagged = (tags: NonNullable<OutlineElementBlock["tags"]>): PageBlock => ({
    type: "outline",
    id: id(),
    layout: {},
    children: [{ type: "outlineElement", id: id(), tags, content: [rich(run("x"))], children: [] }],
  });
  const r = importNotebookJson(
    notebook([
      page([
        // Every OneNote tag definition has an ActionItemType; a tag that can't be
        // checked is stored "completed" when created ([MS-ONE] §2.1.9).
        tagged([{ label: "Waiting", shape: 102, actionItemType: 42, completed: true }]),
        tagged([{ label: "Follow up", shape: 94, actionItemType: 106, completed: true }]),
        tagged([{ label: "Legacy", actionItemType: 7, completed: false }]),
        tagged([{ label: "To Do", shape: 3, actionItemType: 0, completed: false }]),
      ]),
    ]),
    "S.one",
    assets,
  );
  const tags = r.section.pages[0]!.outlines.map((o) => o.elements[0]!.tags![0]!);
  assert.deepEqual(tags, [
    { kind: "custom:waiting", label: "Waiting" },
    { kind: "custom:follow up", label: "Follow up", done: true },
    { kind: "custom:legacy", label: "Legacy", done: false },
    { kind: "todo", done: false },
  ]);
  const defs = new Map(r.customTags.map((d) => [d.label, d]));
  assert.equal(defs.get("Waiting")!.check, undefined);
  assert.equal(defs.get("Follow up")!.check, true);
});

// --- writer round trip --------------------------------------------------------------

test("equations from onenote-re/writer-rs come back as the same UnicodeMath (writer → onenote-re → importer)", async () => {
  // Written and parsed by onenote-re/writer-rs/tests/importer_fixture.rs (cargo test refreshes them).
  const fixtures = new URL("./fixtures/", import.meta.url);
  const bytes = new Uint8Array(readFileSync(new URL("onenote-equations.one", fixtures)));
  const rust = JSON.parse(readFileSync(new URL("onenote-equations.json", fixtures), "utf8")) as NotebookJson;
  // The TypeScript parser reads the writer's file exactly as the Rust one did.
  const { parseOneNote } = await import("@re/parser/src/notebook.ts");
  assert.deepEqual(JSON.parse(JSON.stringify(parseOneNote(bytes, {}))), rust);

  const r = importNotebookJson(rust, "Equations.one", new Map());
  const linear = (elements(r) as MathEl[]).map((e) => [e.kind, e.linear]);
  // [written by Notecraft's editor, what the importer reads back]: equivalent
  // UnicodeMath (the writer stores "-" as U+2212; "2a" as a denominator gets its parentheses).
  const pairs: [string, string][] = [
    ["(a+b)/c", "(a+b)/c"],
    ["x=(-b±√(b^2-4ac))/2a", "x=(\u2212b±√(b^2\u22124ac))/(2a)"],
    ["x_i^2", "x_i^2"],
    ["√(5&y)", "√(5&y)"],
    ["∑_(i=1)^n i^2", "∑_(i=1)^n i^2"],
    ["■(a&b@c&d)", "■(a&b@c&d)"],
    ["█(x+y=1@x-y=0)", "█(x+y=1@x\u2212y=0)"],
    ["x\u0302+¯y", "x\u0302+¯y"],
    ["lim┬(n→∞) a_n", "lim┬(n→∞) a_n"],
    ["sin^2 x+cos^2 x=1", "sin^2\u2061x+cos^2\u2061x=1"],
    ["e^(iπ)+1=0", "e^(iπ)+1=0"],
    ["log_2 x", "log_2\u2061x"],
    ["∫_0^1 f(x)dx", "∫_0^1 f(x)dx"],
  ];
  assert.deepEqual(linear, pairs.map(([, back]) => ["math", back]));
  assert.deepEqual([r.stats.equations, r.stats.equationsUndecoded], [pairs.length, 0]);
});
