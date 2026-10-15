import { test } from "node:test";
import assert from "node:assert/strict";
import {
  INK_DIMENSION_X,
  INK_DIMENSION_Y,
  decodeBoundingBox,
  decodeInkDimensions,
  decodeInkPath,
  encodeInkPath,
  inkToSvg,
  pointBounds,
  strokePoints,
} from "./ink.ts";
import { orderTocEntries, unescapeTocName } from "./toc.ts";

const guidBytes = (g: string) => {
  const h = g.replace(/[{}-]/g, "");
  const b = Buffer.from(h, "hex");
  // GUIDs are stored with their first three fields little-endian.
  return Uint8Array.from([b[3]!, b[2]!, b[1]!, b[0]!, b[5]!, b[4]!, b[7]!, b[6]!, ...b.subarray(8)]);
};

test("InkPath uses [MS-ISF] multi-byte values with the sign in the low bit", () => {
  // The vector from onenote.rs's multi_byte tests.
  assert.deepEqual(decodeInkPath(Uint8Array.from([0x04, 0x06, 0x05])), [3, -2]);
  const values = [0, 1, -1, 63, -64, 8191, -8192, 1_000_000, -123_456];
  assert.deepEqual(decodeInkPath(encodeInkPath(values)), values);
  // Truncated input stops cleanly.
  assert.deepEqual(decodeInkPath(Uint8Array.from([0x08, 0x02])), [1]);
});

test("strokes: dimensions are stored one after another and deltas accumulate", () => {
  // Three points (10,20) (13,18) (15,25): X = 10, +3, +2; Y = 20, −2, +7.
  const values = [10, 3, 2, 20, -2, 7];
  assert.deepEqual(strokePoints(values, [INK_DIMENSION_X, INK_DIMENSION_Y]), [10, 20, 13, 18, 15, 25]);
  // Y listed first, plus a pressure dimension that is ignored.
  const pressure = "{7307502D-F9F4-4E18-B3F2-2CE1B1A3610C}";
  assert.deepEqual(strokePoints([20, -2, 7, 10, 3, 2, 500, 0, 0], [INK_DIMENSION_Y, INK_DIMENSION_X, pressure]), [10, 20, 13, 18, 15, 25]);
  // Scaling multiplies after accumulation.
  assert.deepEqual(strokePoints([10, 3, 20, -2], [], 2, 0.5), [20, 10, 26, 9]);
});

test("InkDimensions entries are 32 bytes starting with a GUID", () => {
  const entry = (g: string) => [...guidBytes(g), ...new Array(16).fill(0)];
  const dims = decodeInkDimensions(Uint8Array.from([...entry(INK_DIMENSION_X), ...entry(INK_DIMENSION_Y)]));
  assert.deepEqual(dims, [INK_DIMENSION_X, INK_DIMENSION_Y]);
});

test("bounding box and SVG rendering", () => {
  const b = new Uint8Array(16);
  const dv = new DataView(b.buffer);
  [-5, 10, 300, 400].forEach((v, i) => dv.setInt32(i * 4, v, true));
  assert.deepEqual(decodeBoundingBox(b), [-5, 10, 300, 400]);
  assert.deepEqual(pointBounds([1, 2, 5, 9, 3, 4]), { x: 1, y: 2, width: 4, height: 7 });
  const svg = inkToSvg([{ points: [0, 0, 10, 5], color: "#ff0000", width: 2, transparency: 128 }]);
  assert.match(svg, /^<svg [^>]*width="18" height="13"/);
  assert.match(svg, /stroke="#ff0000"/);
  assert.match(svg, /stroke-opacity="0.5"/);
});

test(".onetoc2 entries: later names win, then ordering id", () => {
  assert.equal(unescapeTocName("Q1^M Q2^J notes.one"), "Q1+ Q2, notes.one");
  const ordered = orderTocEntries([
    { index: 0, name: "Ideas.one", order: 3 },
    { index: 1, name: "Projects", order: 1 },
    { index: 2, name: "Inbox.one", order: 2 },
    { index: 3, name: "ideas.one", order: 0, color: "#ff8800" },
    { index: 4, name: "Unordered.one" },
  ]);
  assert.deepEqual(ordered, [
    { name: "ideas.one", order: 0, color: "#ff8800" },
    { name: "Projects", order: 1 },
    { name: "Inbox.one", order: 2 },
    { name: "Unordered.one" },
  ]);
});
