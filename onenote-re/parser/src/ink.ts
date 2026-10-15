// Ink (pen and highlighter strokes). [MS-ONE] does not document ink; the
// object and property layout follows onenote.rs (msiemens), which was
// validated against real files, and the point encoding is [MS-ISF]'s
// multi-byte integer packing. See docs/file-format.md §13.
//
//   InkContainer ─InkData→ InkDataNode ─InkStrokes→ InkStrokeNode ─InkStrokeProperties→ StrokePropertiesNode
//        └─ContentChildNodes→ nested InkContainers (groups)
//
// Coordinates are HIMETRIC (0.01 mm) times InkScalingX/Y. The first point of
// each dimension is absolute, the rest are deltas. Values are stored one
// dimension after another (all X, then all Y, then pressure…), in the order
// of the stroke's InkDimensions.
import { formatGuid } from "./reader.ts";

export interface InkStroke {
  /** Flat [x0, y0, x1, y1, …] in points. */
  points: number[];
  /** #rrggbb */
  color?: string;
  /** Pen size in points. */
  width?: number;
  height?: number;
  /** 0 opaque … 255 invisible. */
  transparency?: number;
  highlighter?: boolean;
  /** 0 = round tip, otherwise rectangular. */
  penTip?: number;
  /** InkBias: what OneNote thought the stroke was. */
  bias?: "handwriting" | "drawing" | "both";
}

export interface InkBlock {
  type: "ink";
  id: string;
  /**
   * Page ink: strokes are in page points (offsets applied).
   * Embedded ink (inside an outline element): strokes are relative to the
   * top-left of `bounds`, so the block can flow with the text.
   */
  embedded?: boolean;
  /** Stroke extent in points: page coordinates for page ink, size for embedded ink. */
  bounds?: { x: number; y: number; width: number; height: number };
  strokes: InkStroke[];
}

export const INK_DIMENSION_X = "{598A6A8F-52C0-4BA0-93AF-AF357411A561}";
export const INK_DIMENSION_Y = "{B53F9F75-04E0-4498-A7EE-C30DBB5A9011}";

/** HIMETRIC (0.01 mm) → points (1/72 in). */
export const HIMETRIC_PT = 72 / 2540;

/** [MS-ISF] unsigned multi-byte integer: 7 bits per byte, low group first. */
function readVarint(b: Uint8Array, at: { i: number }): number {
  let value = 0;
  let mul = 1;
  for (let n = 0; n < 10 && at.i < b.length; n++) {
    const byte = b[at.i++]!;
    value += (byte & 0x7f) * mul;
    if (!(byte & 0x80)) return value;
    mul *= 128;
  }
  return value;
}

/**
 * InkPath: a count followed by that many signed values. Both use the sign in
 * the low bit (value >> 1, negated when bit 0 is set), not zigzag.
 */
export function decodeInkPath(b: Uint8Array): number[] {
  const at = { i: 0 };
  const count = Math.floor(readVarint(b, at) / 2);
  const out: number[] = [];
  for (let k = 0; k < count && at.i < b.length; k++) {
    const v = readVarint(b, at);
    const mag = Math.floor(v / 2);
    out.push(v % 2 ? -mag : mag);
  }
  return out;
}

/** The inverse of decodeInkPath, for tests and for writing ink later. */
export function encodeInkPath(values: number[]): Uint8Array {
  const bytes: number[] = [];
  const put = (v: number) => {
    do {
      let byte = v % 128;
      v = Math.floor(v / 128);
      if (v > 0) byte |= 0x80;
      bytes.push(byte);
    } while (v > 0);
  };
  put(values.length * 2);
  for (const v of values) put(Math.abs(v) * 2 + (v < 0 ? 1 : 0));
  return new Uint8Array(bytes);
}

/** InkDimensions: 32-byte entries, each a GUID, i32 lower limit, i32 upper limit and 8 more bytes. */
export function decodeInkDimensions(b: Uint8Array | undefined): string[] {
  if (!b) return [];
  const out: string[] = [];
  for (let i = 0; i + 16 <= b.length; i += 32) out.push(formatGuid(b.subarray(i, i + 16)));
  return out;
}

/**
 * Split the decoded values into dimensions, undo the delta encoding, and
 * return flat [x, y, …] in HIMETRIC × scale.
 */
export function strokePoints(values: number[], dimensions: string[], scaleX = 1, scaleY = 1): number[] {
  const dims = Math.max(2, dimensions.length || 2);
  const n = Math.floor(values.length / dims);
  if (!n) return [];
  let ix = dimensions.indexOf(INK_DIMENSION_X);
  let iy = dimensions.indexOf(INK_DIMENSION_Y);
  if (ix < 0) ix = 0;
  if (iy < 0) iy = ix === 0 ? 1 : 0;
  const out: number[] = new Array(n * 2);
  let x = 0, y = 0;
  for (let k = 0; k < n; k++) {
    x += values[ix * n + k]!;
    y += values[iy * n + k]!;
    out[k * 2] = x * scaleX;
    out[k * 2 + 1] = y * scaleY;
  }
  return out;
}

/** InkBoundingBox: four little-endian i32, [xMin, yMin, xMax, yMax], HIMETRIC. */
export function decodeBoundingBox(b: Uint8Array | undefined): [number, number, number, number] | undefined {
  if (!b || b.length < 16) return undefined;
  const dv = new DataView(b.buffer, b.byteOffset, 16);
  return [dv.getInt32(0, true), dv.getInt32(4, true), dv.getInt32(8, true), dv.getInt32(12, true)];
}

const r2 = (v: number) => Math.round(v * 100) / 100;

/** Bounds of flat points, in the same units. */
export function pointBounds(points: number[]): { x: number; y: number; width: number; height: number } | undefined {
  if (points.length < 2) return undefined;
  let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
  for (let i = 0; i + 1 < points.length; i += 2) {
    l = Math.min(l, points[i]!);
    r = Math.max(r, points[i]!);
    t = Math.min(t, points[i + 1]!);
    b = Math.max(b, points[i + 1]!);
  }
  return { x: r2(l), y: r2(t), width: r2(r - l), height: r2(b - t) };
}

/** Render strokes (points in pt) as a standalone SVG, e.g. for embedded handwriting. */
export function inkToSvg(strokes: InkStroke[], pad = 2): string {
  const all = strokes.flatMap((s) => s.points);
  const b = pointBounds(all) ?? { x: 0, y: 0, width: 1, height: 1 };
  const maxW = Math.max(1, ...strokes.map((s) => s.width ?? 1));
  const p = pad + maxW;
  const w = r2(b.width + p * 2), h = r2(b.height + p * 2);
  const paths = strokes
    .map((s) => {
      if (s.points.length < 2) return "";
      let d = `M${r2(s.points[0]! - b.x + p)} ${r2(s.points[1]! - b.y + p)}`;
      for (let i = 2; i + 1 < s.points.length; i += 2) d += `L${r2(s.points[i]! - b.x + p)} ${r2(s.points[i + 1]! - b.y + p)}`;
      if (s.points.length === 2) d += "l0.01 0";
      const opacity = s.transparency ? ` stroke-opacity="${r2((255 - s.transparency) / 255)}"` : "";
      const cap = s.penTip ? "square" : "round";
      return `<path d="${d}" fill="none" stroke="${s.color ?? "#000000"}" stroke-width="${r2(s.width ?? 1)}" stroke-linecap="${cap}" stroke-linejoin="round"${opacity}/>`;
    })
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${paths}</svg>`;
}
