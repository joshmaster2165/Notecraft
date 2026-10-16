//! Ink strokes as OneNote ink (`docs/file-format.md` §13; [MS-ONE] does not
//! document ink):
//!
//! ```text
//!   PageNode.ElementChildNodes → InkContainer (0x60014)   OffsetFromParentHoriz/Vert
//!     InkData → InkDataNode (0x2003B)                     InkStrokes, InkBoundingBox (HIMETRIC)
//!       InkStrokeNode (0x20047)                           InkPath, InkBias
//!         InkStrokeProperties → StrokePropertiesNode (0x120048)
//!                                                         InkDimensions, InkWidth/Height, InkColor…
//! ```
//!
//! InkPath packs [MS-ISF] multi-byte integers: 7 bits per byte, low group
//! first, high bit = more. The first integer is twice the value count; each
//! value keeps its sign in the low bit. Values are grouped by dimension (all
//! X, then all Y); the first of each is absolute, the rest are deltas.

/// HIMETRIC units (0.01 mm) per point.
pub(crate) const HIMETRIC_PER_PT: f64 = 2540.0 / 72.0;

fn put(out: &mut Vec<u8>, mut v: u64) {
    loop {
        let byte = (v & 0x7f) as u8;
        v >>= 7;
        if v == 0 {
            out.push(byte);
            return;
        }
        out.push(byte | 0x80);
    }
}

/// Encode values (already split by dimension) as an InkPath.
pub(crate) fn encode_path(values: &[i64]) -> Vec<u8> {
    let mut out = Vec::with_capacity(values.len() * 2 + 2);
    put(&mut out, values.len() as u64 * 2);
    for &v in values {
        put(&mut out, v.unsigned_abs() * 2 + u64::from(v < 0));
    }
    out
}

/// X values then Y values, each delta-encoded after the first.
pub(crate) fn path_values(points: &[(i64, i64)]) -> Vec<i64> {
    let mut out = Vec::with_capacity(points.len() * 2);
    for dim in 0..2 {
        let mut prev = 0;
        for (i, p) in points.iter().enumerate() {
            let v = if dim == 0 { p.0 } else { p.1 };
            out.push(if i == 0 { v } else { v - prev });
            prev = v;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_the_ms_isf_vector() {
        // onenote.rs: [0x04, 0x06, 0x05] decodes to [3, -2].
        assert_eq!(encode_path(&[3, -2]), [0x04, 0x06, 0x05]);
        assert_eq!(encode_path(&[1000]), [0x02, 0xd0, 0x0f]);
    }

    #[test]
    fn deltas_per_dimension() {
        assert_eq!(
            path_values(&[(10, 20), (13, 18), (15, 25)]),
            [10, 3, 2, 20, -2, 7]
        );
    }
}
