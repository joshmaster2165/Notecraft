//! Ink (pen and highlighter strokes). [MS-ONE] does not document ink; the
//! object and property layout follows onenote.rs (msiemens), which was
//! validated against real files, and the point encoding is [MS-ISF]'s
//! multi-byte integer packing. See docs/file-format.md §13.
//!
//! ```text
//!   InkContainer ─InkData→ InkDataNode ─InkStrokes→ InkStrokeNode ─InkStrokeProperties→ StrokePropertiesNode
//!        └─ContentChildNodes→ nested InkContainers (groups)
//! ```
//!
//! Coordinates are HIMETRIC (0.01 mm) times InkScalingX/Y. The first point of
//! each dimension is absolute, the rest are deltas. Values are stored one
//! dimension after another (all X, then all Y, then pressure…), in the order
//! of the stroke's InkDimensions.
//!
//! Values are `f64` throughout, as in the TypeScript original, so overflowing
//! or malformed input degrades the same way (precision loss, NaN), never panics.

use serde::Serialize;

use crate::js::{self, round2};
use crate::reader::format_guid;

#[derive(Debug, Clone, PartialEq, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct InkStroke {
    /// Flat [x0, y0, x1, y1, …] in points.
    pub points: Vec<f64>,
    /// #rrggbb
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    /// Pen size in points.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<f64>,
    /// 0 opaque … 255 invisible.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transparency: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub highlighter: Option<bool>,
    /// 0 = round tip, otherwise rectangular.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pen_tip: Option<u32>,
    /// InkBias: what OneNote thought the stroke was ("handwriting", "drawing" or "both").
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bias: Option<&'static str>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct Bounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct InkBlock {
    /// Always "ink".
    pub r#type: &'static str,
    pub id: String,
    /// Page ink: strokes are in page points (offsets applied).
    /// Embedded ink (inside an outline element): strokes are relative to the
    /// top-left of `bounds`, so the block can flow with the text.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub embedded: Option<bool>,
    /// Stroke extent in points: page coordinates for page ink, size for embedded ink.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bounds: Option<Bounds>,
    pub strokes: Vec<InkStroke>,
}

pub const INK_DIMENSION_X: &str = "{598A6A8F-52C0-4BA0-93AF-AF357411A561}";
pub const INK_DIMENSION_Y: &str = "{B53F9F75-04E0-4498-A7EE-C30DBB5A9011}";

/// HIMETRIC (0.01 mm) → points (1/72 in).
pub const HIMETRIC_PT: f64 = 72.0 / 2540.0;

/// [MS-ISF] unsigned multi-byte integer: 7 bits per byte, low group first.
fn read_varint(b: &[u8], at: &mut usize) -> f64 {
    let mut value = 0.0;
    let mut mul = 1.0;
    let mut n = 0;
    while n < 10 && *at < b.len() {
        let byte = b[*at];
        *at += 1;
        value += f64::from(byte & 0x7f) * mul;
        if byte & 0x80 == 0 {
            return value;
        }
        mul *= 128.0;
        n += 1;
    }
    value
}

/// InkPath: a count followed by that many signed values. Both use the sign in
/// the low bit (value >> 1, negated when bit 0 is set), not zigzag.
pub fn decode_ink_path(b: &[u8]) -> Vec<f64> {
    let mut at = 0;
    let count = (read_varint(b, &mut at) / 2.0).floor();
    let mut out = Vec::new();
    let mut k = 0.0;
    while k < count && at < b.len() {
        let v = read_varint(b, &mut at);
        let mag = (v / 2.0).floor();
        out.push(if v % 2.0 != 0.0 { -mag } else { mag });
        k += 1.0;
    }
    out
}

/// The inverse of [`decode_ink_path`], for tests and for writing ink later.
pub fn encode_ink_path(values: &[f64]) -> Vec<u8> {
    let mut bytes = Vec::new();
    let mut put = |mut v: f64| loop {
        let mut byte = (v % 128.0) as u8;
        v = (v / 128.0).floor();
        if v > 0.0 {
            byte |= 0x80;
        }
        bytes.push(byte);
        if v.is_nan() || v <= 0.0 {
            break;
        }
    };
    put(values.len() as f64 * 2.0);
    for &v in values {
        put(v.abs() * 2.0 + if v < 0.0 { 1.0 } else { 0.0 });
    }
    bytes
}

/// InkDimensions: 32-byte entries, each a GUID, i32 lower limit, i32 upper limit and 8 more bytes.
pub fn decode_ink_dimensions(b: Option<&[u8]>) -> Vec<String> {
    let Some(b) = b else { return Vec::new() };
    let mut out = Vec::new();
    let mut i = 0;
    while i + 16 <= b.len() {
        out.push(format_guid(&b[i..i + 16]));
        i += 32;
    }
    out
}

/// Split the decoded values into dimensions, undo the delta encoding, and
/// return flat [x, y, …] in HIMETRIC × scale.
pub fn stroke_points(
    values: &[f64],
    dimensions: &[String],
    scale_x: f64,
    scale_y: f64,
) -> Vec<f64> {
    let dims = dimensions.len().max(2);
    let n = values.len() / dims;
    if n == 0 {
        return Vec::new();
    }
    let ix = dimensions
        .iter()
        .position(|d| d == INK_DIMENSION_X)
        .unwrap_or(0);
    let iy = match dimensions.iter().position(|d| d == INK_DIMENSION_Y) {
        Some(i) => i,
        None if ix == 0 => 1,
        None => 0,
    };
    let mut out = Vec::with_capacity(n * 2);
    let (mut x, mut y) = (0.0, 0.0);
    for k in 0..n {
        x += values[ix * n + k];
        y += values[iy * n + k];
        out.push(x * scale_x);
        out.push(y * scale_y);
    }
    out
}

/// InkBoundingBox: four little-endian i32, [xMin, yMin, xMax, yMax], HIMETRIC.
pub fn decode_bounding_box(b: Option<&[u8]>) -> Option<[i32; 4]> {
    let b = b.filter(|b| b.len() >= 16)?;
    let at = |i: usize| i32::from_le_bytes([b[i], b[i + 1], b[i + 2], b[i + 3]]);
    Some([at(0), at(4), at(8), at(12)])
}

/// Bounds of flat points, in the same units.
pub fn point_bounds(points: &[f64]) -> Option<Bounds> {
    if points.len() < 2 {
        return None;
    }
    let (mut l, mut t, mut r, mut b) = (
        f64::INFINITY,
        f64::INFINITY,
        f64::NEG_INFINITY,
        f64::NEG_INFINITY,
    );
    for p in points.as_chunks::<2>().0 {
        l = js::min(l, p[0]);
        r = js::max(r, p[0]);
        t = js::min(t, p[1]);
        b = js::max(b, p[1]);
    }
    Some(Bounds {
        x: round2(l),
        y: round2(t),
        width: round2(r - l),
        height: round2(b - t),
    })
}

/// Render strokes (points in pt) as a standalone SVG, e.g. for embedded handwriting.
pub fn ink_to_svg(strokes: &[InkStroke], pad: f64) -> String {
    let num = js::number_to_string;
    let all: Vec<f64> = strokes
        .iter()
        .flat_map(|s| s.points.iter().copied())
        .collect();
    let b = point_bounds(&all).unwrap_or(Bounds {
        x: 0.0,
        y: 0.0,
        width: 1.0,
        height: 1.0,
    });
    let max_w = strokes
        .iter()
        .fold(1.0, |m, s| js::max(m, s.width.unwrap_or(1.0)));
    let p = pad + max_w;
    let w = round2(b.width + p * 2.0);
    let h = round2(b.height + p * 2.0);
    let mut paths = String::new();
    for s in strokes {
        if s.points.len() < 2 {
            continue;
        }
        let mut d = format!(
            "M{} {}",
            num(round2(s.points[0] - b.x + p)),
            num(round2(s.points[1] - b.y + p))
        );
        for pt in s.points[2..].as_chunks::<2>().0 {
            d += &format!(
                "L{} {}",
                num(round2(pt[0] - b.x + p)),
                num(round2(pt[1] - b.y + p))
            );
        }
        if s.points.len() == 2 {
            d += "l0.01 0";
        }
        let opacity = match s.transparency {
            Some(t) if t != 0 => format!(
                " stroke-opacity=\"{}\"",
                num(round2((255.0 - f64::from(t)) / 255.0))
            ),
            _ => String::new(),
        };
        let cap = if s.pen_tip.unwrap_or(0) != 0 {
            "square"
        } else {
            "round"
        };
        paths += &format!(
            "<path d=\"{d}\" fill=\"none\" stroke=\"{}\" stroke-width=\"{}\" stroke-linecap=\"{cap}\" stroke-linejoin=\"round\"{opacity}/>",
            s.color.as_deref().unwrap_or("#000000"),
            num(round2(s.width.unwrap_or(1.0)))
        );
    }
    format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"{}\" height=\"{}\" viewBox=\"0 0 {} {}\">{paths}</svg>",
        num(w),
        num(h),
        num(w),
        num(h)
    )
}
