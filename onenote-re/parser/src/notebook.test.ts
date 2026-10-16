// The file-format.md §15 properties: crop, printouts, Ink to Shape,
// equations, media and password-protected sections, on hand-built sections.
import { test } from "node:test";
import assert from "node:assert/strict";
import { J, StoreBuilder, V, makeRng, type Eg, type Revision, type Value } from "../../parser-rs/tests/synthetic.mjs";
import { encodeInkPath } from "./ink.ts";
import { parseOneNote, sniffMediaType, type EmbeddedFileBlock, type ImageBlock, type InkBlock, type OutlineBlock, type RichTextBlock } from "./notebook.ts";
import { Prop as P } from "./schema.ts";

const ascii = (s: string) => Uint8Array.from([...s].map((c) => c.charCodeAt(0)));
const u32s = (...v: number[]) => {
  const b = new Uint8Array(v.length * 4);
  v.forEach((x, i) => new DataView(b.buffer).setUint32(i * 4, x, true));
  return b;
};

/** One section, one page whose blocks `content` builds. */
function section(
  content: (b: StoreBuilder, rev: Revision) => Eg[],
  opts: { encryptedRoot?: boolean; encryptedPage?: boolean; sectionProps?: Value[]; metaProps?: Value[]; pageProps?: (b: StoreBuilder, rev: Revision) => Value[] } = {},
) {
  const b = new StoreBuilder(makeRng(7), "one");
  const root = b.space({ encrypted: opts.encryptedRoot });
  const space = b.space({ encrypted: opts.encryptedPage });
  const rev = b.revision(space, { role: 1 });
  const page = b.object(rev, J.PageNode!, [V.oids(P.ElementChildNodes!, content(b, rev)), ...(opts.pageProps?.(b, rev) ?? [])]);
  rev.roots.push([1, b.object(rev, J.PageManifestNode!, [V.oids(P.ContentChildNodes!, [page])])]);
  const srev = b.revision(root, { role: 1 });
  const series = b.object(srev, J.PageSeriesNode!, [V.osids(P.ChildGraphSpaceElementNodes!, [space.gosid])]);
  srev.roots.push([1, b.object(srev, J.SectionNode!, [V.oids(P.ElementChildNodes!, [series]), ...(opts.sectionProps ?? [])])]);
  if (opts.metaProps) {
    const mrev = b.revision(root, { role: 2 });
    mrev.roots.push([2, b.object(mrev, J.SectionMetaData!, opts.metaProps)]);
  }
  return parseOneNote(b.build(), { onAsset: ({ id }) => id });
}

function picture(b: StoreBuilder, rev: Revision, props: Value[]): Eg {
  const container = b.fileObject(rev, J.PictureContainer14!, `<ifndf>${b.addFileData(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0, 0]))}`, ".png");
  return b.object(rev, J.ImageNode!, [V.oids(P.PictureContainer!, [container]), V.f32(P.PictureWidth!, 10), V.f32(P.PictureHeight!, 5), ...props]);
}

test("picture crop: fractions in either property family, as percentages", () => {
  const json = section((b, rev) => [
    picture(b, rev, [
      V.f32(P.ImageCroppedTopLeftXPercentage!, 0.25),
      V.f32(P.ImageCroppedTopLeftYPercentage!, 0.1),
      V.f32(P.ImageCroppedWidthPercentage!, 0.5),
      V.f32(P.ImageCroppedHeightPercentage!, 0.75),
      V.bool(P.ImageCroppingActive!, false),
    ]),
    // The deprecated family, written here in percent; missing values default to the full picture.
    picture(b, rev, [V.f32(P.Deprecated_ImageCroppedTopLeftXPercentage!, 10), V.f32(P.Deprecated_ImageCroppedWidthPercentage!, 80)]),
    // Present but uncropped.
    picture(b, rev, [V.f32(P.ImageCroppedWidthPercentage!, 1)]),
  ]);
  const [a, d, full] = json.section.pages[0]!.blocks as ImageBlock[];
  assert.deepEqual(a!.crop, { topLeftXPercentage: 25, topLeftYPercentage: 10, widthPercentage: 50, heightPercentage: 75 });
  assert.deepEqual(d!.crop, { topLeftXPercentage: 10, topLeftYPercentage: 0, widthPercentage: 80, heightPercentage: 100 });
  assert.equal(full!.crop, undefined);
  assert.deepEqual(a!.layout, { width: 360, height: 180 });
});

test("printout pages, split printouts and out-of-date attachments", () => {
  const json = section((b, rev) => [
    b.object(rev, J.EmbeddedFileNode!, [V.str(P.EmbeddedFileName!, "report.pdf"), V.bool(P.PrintoutOutOfDate!, true)]),
    picture(b, rev, [V.bool(P.IsPrintoutPage!, true), V.u32(P.OriginalPageNumber!, 2), V.u32(P.DisplayedPageNumber!, 2)]),
    picture(b, rev, [V.bool(P.IsPrintoutPage!, true), V.bool(P.IsPartOfSplitPrintout!, true), V.u32(P.OriginalPageNumber!, 0), V.u32(P.DisplayedPageNumber!, 7)]),
    picture(b, rev, [V.bool(P.IsPrintoutPage!, false), V.u32(P.OriginalPageNumber!, 0)]),
  ]);
  const [file, p2, p7, plain] = json.section.pages[0]!.blocks as [EmbeddedFileBlock, ImageBlock, ImageBlock, ImageBlock];
  assert.equal(file.printoutOutOfDate, true);
  assert.deepEqual(p2.printout, { page: 2 });
  assert.deepEqual(p7.printout, { page: 7, splitPart: true });
  assert.equal(plain.printout, undefined);
});

test("equations: MathFormatting runs keep RichEdit's structure characters and MathData_*", () => {
  const json = section((b, rev) => {
    const text = "y=﷐a﷮b﷯";
    const plain = b.object(rev, J.ParagraphStyleObject!, [V.bool(P.MathFormatting!, false), V.u8(P.MathData_Align!, 0)]);
    const math = b.object(rev, J.ParagraphStyleObject!, [V.bool(P.MathFormatting!, true)]);
    const fraction = b.object(rev, J.ParagraphStyleObject!, [
      V.bool(P.MathFormatting!, true),
      V.u32(P.MathData_Type!, 16),
      V.u32(P.MathData_cArg!, 2),
      V.u16(P.MathData_Char!, 0x2215),
      V.bool(P.MathNoBuildup!, true),
    ]);
    const rich = b.object(rev, J.RichTextOENode!, [
      V.str(P.RichEditTextUnicode!, text),
      // Run ends (the last run ends at the text's end), one formatting per run.
      V.bytes(P.TextRunIndex!, u32s(2, 3)),
      V.oids(P.TextRunFormatting!, [plain, fraction, math]),
    ]);
    const oe = b.object(rev, J.OutlineElementNode!, [V.oids(P.ContentChildNodes!, [rich])]);
    return [b.object(rev, J.OutlineNode!, [V.oids(P.ElementChildNodes!, [oe])])];
  });
  const outline = json.section.pages[0]!.blocks[0] as OutlineBlock;
  const rich = outline.children[0]!.content[0] as RichTextBlock;
  assert.equal(rich.text, "y=﷐a﷮b﷯");
  assert.deepEqual(
    rich.runs.map((r) => [r.text, r.style]),
    [
      ["y=", {}],
      ["﷐", { math: true, mathNoBuildup: true, mathObject: { type: 16, args: 2, char: 0x2215 } }],
      ["a﷮b﷯", { math: true }],
    ],
  );
});

test("Ink to Shape: InkShape2DInfo / InkLineShapeInfo on the stroke or its container", () => {
  const json = section((b, rev) => {
    const stroke = (props: Value[]) => b.object(rev, J.InkStrokeNode!, [V.bytes(P.InkPath!, encodeInkPath([0, 1000, 0, 500])), ...props]);
    const line = stroke([V.bytes(P.InkLineShapeInfo!, Uint8Array.from([1, 2, 255])), V.u32(P.InkLineShapeInfoModifiedProxy!, 9)]);
    const other = stroke([]);
    const data = b.object(rev, J.InkDataNode!, [V.oids(P.InkStrokes!, [line, other]), V.bytes(P.InkShape2DInfo!, new Uint8Array(300))]);
    return [b.object(rev, J.InkContainer!, [V.oids(P.InkData!, [data])])];
  });
  const ink = json.section.pages[0]!.blocks[0] as InkBlock;
  assert.deepEqual(ink.strokes[0]!.shape, { source: "line", byteLength: 3, data: "0102ff", modifiedProxy: 9 });
  const inherited = ink.strokes[1]!.shape!;
  assert.equal(inherited.source, "shape2d");
  assert.equal(inherited.byteLength, 300);
  assert.equal(inherited.data.length, 512); // the first 256 bytes
  assert.deepEqual(ink.strokes[1]!.points, [0, 0, 28.35, 14.17]);
});

test("recordings and media files get a media type", () => {
  const json = section((b, rev) => {
    const m4a = Uint8Array.from([0, 0, 0, 0x20, ...ascii("ftypM4A "), 0, 0]);
    const container = b.fileObject(rev, J.EmbeddedFileContainer!, `<ifndf>${b.addFileData(m4a)}`, "");
    return [
      b.object(rev, J.EmbeddedFileNode!, [
        V.oids(P.EmbeddedFileContainer!, [container]),
        V.str(P.EmbeddedFileName!, "Audio recording"),
        V.u32(P.IRecordMedia!, 1),
        V.u32(P.AudioRecordingDuration!, 5000),
      ]),
    ];
  });
  const file = json.section.pages[0]!.blocks[0] as EmbeddedFileBlock;
  assert.deepEqual(file.recording, { media: 1, duration: 5000 });
  assert.equal(file.asset?.mediaType, "audio/mp4");

  const ftyp = (brand: string) => Uint8Array.from([0, 0, 0, 0x20, ...ascii(`ftyp${brand}`)]);
  assert.equal(sniffMediaType(ftyp("isom")), "video/mp4");
  assert.equal(sniffMediaType(ftyp("qt  ")), "video/quicktime");
  assert.equal(sniffMediaType(ascii("RIFF\0\0\0\0WAVEfmt ")), "audio/wav");
  assert.equal(sniffMediaType(ascii("ID3\x04")), "audio/mpeg");
  assert.equal(sniffMediaType(Uint8Array.from([0xff, 0xfb, 0x90])), "audio/mpeg");
  assert.equal(sniffMediaType(Uint8Array.from([0xff, 0xf1, 0x50])), "audio/aac");
  assert.equal(sniffMediaType(Uint8Array.from([0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11]), ".WMA"), "audio/x-ms-wma");
  assert.equal(sniffMediaType(Uint8Array.from([0xff, 0xd8, 0xff])), "image/jpeg");
});

test("password-protected sections are flagged, not decrypted", () => {
  const page = (b: StoreBuilder, rev: Revision) => [picture(b, rev, [])];
  const root = section(page, { encryptedRoot: true });
  assert.equal(root.section.encrypted, true);
  assert.equal(root.section.pages.length, 0);
  assert.equal(root.diagnostics.encryptedObjectSpaces.length, 1);
  assert.match(root.diagnostics.warnings.join("\n"), /password-protected section: 1 of 2 object spaces are encrypted/);
  // Keys stay in a stable order: `encrypted` right after `id`.
  assert.deepEqual(Object.keys(JSON.parse(JSON.stringify(root.section))), ["id", "encrypted", "pages"]);

  const pageOnly = section(page, { encryptedPage: true });
  assert.equal(pageOnly.section.encrypted, true);
  assert.equal(pageOnly.section.pages.length, 0);

  const flagged = section(page, { sectionProps: [V.bool(P.IsEncrypted!, true)] });
  assert.equal(flagged.section.encrypted, true);
  assert.equal(flagged.section.pages.length, 1);
  assert.match(flagged.diagnostics.warnings.join("\n"), /marked IsEncrypted/);

  const plain = section(page, { sectionProps: [V.bool(P.IsEncrypted!, false)] });
  assert.equal(plain.section.encrypted, undefined);
  assert.equal("encrypted" in JSON.parse(JSON.stringify(plain.section)), false);
});

test("section color: SectionMetaData's NotebookColor first, as in OneNote's files", () => {
  const none = () => [];
  // COLORREF 0x00BBGGRR.
  assert.equal(section(none, { metaProps: [V.u32(P.NotebookColor!, 0x002f6ac4)] }).section.color, "#c46a2f");
  assert.equal(section(none, { metaProps: [V.u32(P.NotebookColor!, 0x002f6ac4)], sectionProps: [V.u32(P.NotebookColor!, 0x000000ff)] }).section.color, "#c46a2f");
  // "No color" on the metadata: the section node's.
  assert.equal(section(none, { metaProps: [V.u32(P.NotebookColor!, 0xffffffff)], sectionProps: [V.u32(P.NotebookColor!, 0x000000ff)] }).section.color, "#ff0000");
  assert.equal(section(none, { metaProps: [V.u32(P.Deprecated_SectionColor!, 0x00ff0000)] }).section.color, "#0000ff");
  assert.equal(section(none, { metaProps: [] }).section.color, undefined);
});

test("an untitled page stays untitled: the date/time line is not its title", () => {
  const titled = (outlines: [string, string][]) => (b: StoreBuilder, rev: Revision) => {
    const children = outlines.map(([role, text]) => {
      const rich = b.object(rev, J.RichTextOENode!, [V.str(P.RichEditTextUnicode!, text)]);
      const oe = b.object(rev, J.OutlineElementNode!, [V.oids(P.ContentChildNodes!, [rich])]);
      return b.object(rev, J.OutlineNode!, [V.bool(P[role]!, true), V.oids(P.ElementChildNodes!, [oe])]);
    });
    return [V.oids(P.StructureElementChildNodes!, [b.object(rev, J.TitleNode!, [V.oids(P.ElementChildNodes!, children)])])];
  };
  const none = () => [];
  const untitled = section(none, { pageProps: titled([["IsTitleText", ""], ["IsTitleDate", "Thursday, October 1, 2026"], ["IsTitleTime", "9:30 AM"]]) });
  assert.equal(untitled.section.pages[0]!.title, "");
  assert.equal(untitled.section.pages[0]!.titleBlocks.length, 3);
  // No cached title but a title outline: its text.
  const fromOutline = section(none, { pageProps: titled([["IsTitleText", "Plans"], ["IsTitleDate", "Thursday, October 1, 2026"]]) });
  assert.equal(fromOutline.section.pages[0]!.title, "Plans");
});
