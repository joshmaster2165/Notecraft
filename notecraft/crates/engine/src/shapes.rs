//! Draw › Ink to Shape: turn a hand-drawn stroke into a clean line, arrow,
//! triangle, rectangle, diamond, other polygon or ellipse.
//!
//! OneNote keeps the recognized geometry next to the ink in
//! `InkShape2DInfo` (0x1C001DAA) and, for lines and arrows,
//! `InkLineShapeInfo` (0x1C001DAC), each with a "modified proxy"
//! (0x14001DAB / 0x14001DAD) so edits invalidate it. The recognizer here is
//! geometric: simplify the stroke (Douglas–Peucker), then classify by corner
//! count, closure and circularity.

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ShapeKind {
    Line,
    Arrow,
    Triangle,
    Rectangle,
    Diamond,
    Polygon,
    Ellipse,
}

#[derive(Debug, Clone, Serialize)]
pub struct Shape {
    pub kind: ShapeKind,
    /// Flat [x0, y0, x1, y1, …], ready to draw as straight segments.
    pub points: Vec<f32>,
}

type P = (f64, f64);

fn pts(flat: &[f32]) -> Vec<P> {
    flat.as_chunks::<2>().0.iter().map(|&[x, y]| (x as f64, y as f64)).collect()
}

fn flatten(ps: &[P]) -> Vec<f32> {
    ps.iter().flat_map(|&(x, y)| [(x * 10.0).round() as f32 / 10.0, (y * 10.0).round() as f32 / 10.0]).collect()
}

fn dist(a: P, b: P) -> f64 {
    (a.0 - b.0).hypot(a.1 - b.1)
}

fn path_len(ps: &[P]) -> f64 {
    ps.windows(2).map(|w| dist(w[0], w[1])).sum()
}

fn seg_dist(p: P, a: P, b: P) -> f64 {
    let (dx, dy) = (b.0 - a.0, b.1 - a.1);
    let len2 = dx * dx + dy * dy;
    if len2 == 0.0 {
        return dist(p, a);
    }
    let t = (((p.0 - a.0) * dx + (p.1 - a.1) * dy) / len2).clamp(0.0, 1.0);
    dist(p, (a.0 + t * dx, a.1 + t * dy))
}

/// Douglas–Peucker simplification.
fn simplify(ps: &[P], eps: f64) -> Vec<P> {
    if ps.len() < 3 {
        return ps.to_vec();
    }
    let (first, last) = (ps[0], ps[ps.len() - 1]);
    let (mut idx, mut max) = (0, 0.0);
    for (i, &p) in ps.iter().enumerate().take(ps.len() - 1).skip(1) {
        let d = seg_dist(p, first, last);
        if d > max {
            (idx, max) = (i, d);
        }
    }
    if max > eps {
        let mut left = simplify(&ps[..=idx], eps);
        let right = simplify(&ps[idx..], eps);
        left.pop();
        left.extend(right);
        left
    } else {
        vec![first, last]
    }
}

fn bbox(ps: &[P]) -> (f64, f64, f64, f64) {
    let (mut l, mut t, mut r, mut b) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
    for &(x, y) in ps {
        (l, t, r, b) = (l.min(x), t.min(y), r.max(x), b.max(y));
    }
    (l, t, r, b)
}

fn area(poly: &[P]) -> f64 {
    let n = poly.len();
    (0..n).map(|i| poly[i].0 * poly[(i + 1) % n].1 - poly[(i + 1) % n].0 * poly[i].1).sum::<f64>().abs() / 2.0
}

fn angle_at(a: P, b: P, c: P) -> f64 {
    let (v1, v2) = ((a.0 - b.0, a.1 - b.1), (c.0 - b.0, c.1 - b.1));
    let cos = (v1.0 * v2.0 + v1.1 * v2.1) / ((v1.0.hypot(v1.1) * v2.0.hypot(v2.1)).max(1e-9));
    cos.clamp(-1.0, 1.0).acos().to_degrees()
}

/// Recognize one stroke (flat points in page points). None when it doesn't look like a shape.
pub fn recognize(flat: &[f32]) -> Option<Shape> {
    let ps = pts(flat);
    if ps.len() < 3 {
        return None;
    }
    let len = path_len(&ps);
    let (l, t, r, b) = bbox(&ps);
    let diag = (r - l).hypot(b - t);
    if len < 8.0 || diag < 6.0 {
        return None;
    }
    let first = ps[0];
    let last = ps[ps.len() - 1];

    // Open strokes: straight line, or a line with an arrowhead drawn in the same stroke.
    if dist(first, last) > 0.25 * len.min(diag * 2.0) {
        if dist(first, last) / len > 0.9 {
            return Some(Shape { kind: ShapeKind::Line, points: flatten(&[first, last]) });
        }
        let simple = simplify(&ps, 0.05 * len);
        // Shaft then a "V" at its end: a → tip → wing1 → (back near tip) → wing2.
        if (4..=6).contains(&simple.len()) {
            let shaft = (simple[0], simple[1]);
            let shaft_len = dist(shaft.0, shaft.1);
            let wings: Vec<P> = simple[2..].to_vec();
            let near_tip = wings.iter().filter(|&&w| dist(w, shaft.1) < 0.45 * shaft_len).count();
            if shaft_len > 0.5 * len && near_tip == wings.len() {
                let tip = shaft.1;
                let ang = (shaft.0 .1 - tip.1).atan2(shaft.0 .0 - tip.0);
                let head = (0.18 * shaft_len).clamp(6.0, 24.0);
                let w1 = (tip.0 + head * (ang + 0.45).cos(), tip.1 + head * (ang + 0.45).sin());
                let w2 = (tip.0 + head * (ang - 0.45).cos(), tip.1 + head * (ang - 0.45).sin());
                return Some(Shape { kind: ShapeKind::Arrow, points: flatten(&[shaft.0, tip, w1, tip, w2]) });
            }
        }
        return None;
    }

    // Closed strokes.
    let mut poly = simplify(&ps, 0.035 * len);
    if poly.len() > 1 && dist(poly[0], poly[poly.len() - 1]) < 0.15 * len {
        poly.pop();
    }
    let circularity = 4.0 * std::f64::consts::PI * area(&ps) / (len * len);
    let close = |kind: ShapeKind, corners: &[P]| {
        let mut c = corners.to_vec();
        c.push(corners[0]);
        Some(Shape { kind, points: flatten(&c) })
    };
    match poly.len() {
        3 => return close(ShapeKind::Triangle, &poly),
        4 => {
            let cx = (l + r) / 2.0;
            let cy = (t + b) / 2.0;
            // Each corner near the middle of a side of the bounding box: a diamond.
            let on_axes = poly.iter().all(|&(x, y)| (x - cx).abs() < 0.2 * (r - l) || (y - cy).abs() < 0.2 * (b - t));
            if on_axes {
                return close(ShapeKind::Diamond, &[(cx, t), (r, cy), (cx, b), (l, cy)]);
            }
            let angles: Vec<f64> = (0..4).map(|i| angle_at(poly[(i + 3) % 4], poly[i], poly[(i + 1) % 4])).collect();
            if angles.iter().all(|a| (a - 90.0).abs() < 20.0) {
                // Axis-aligned when the first edge is close to horizontal or vertical: snap to the box.
                let e = (poly[1].0 - poly[0].0, poly[1].1 - poly[0].1);
                let tilt = e.1.atan2(e.0).to_degrees().rem_euclid(90.0);
                if !(12.0..=78.0).contains(&tilt) {
                    // Average the corners pairwise so hand jitter doesn't widen the box.
                    let mut xs: Vec<f64> = poly.iter().map(|p| p.0).collect();
                    let mut ys: Vec<f64> = poly.iter().map(|p| p.1).collect();
                    xs.sort_by(f64::total_cmp);
                    ys.sort_by(f64::total_cmp);
                    let (l, r) = ((xs[0] + xs[1]) / 2.0, (xs[2] + xs[3]) / 2.0);
                    let (t, b) = ((ys[0] + ys[1]) / 2.0, (ys[2] + ys[3]) / 2.0);
                    return close(ShapeKind::Rectangle, &[(l, t), (r, t), (r, b), (l, b)]);
                }
                return close(ShapeKind::Rectangle, &poly);
            }
            return close(ShapeKind::Polygon, &poly);
        }
        _ => {}
    }
    if circularity > 0.72 {
        let (cx, cy, rx, ry) = ((l + r) / 2.0, (t + b) / 2.0, (r - l) / 2.0, (b - t) / 2.0);
        let ring: Vec<P> = (0..=64).map(|i| {
            let a = i as f64 / 64.0 * std::f64::consts::TAU;
            (cx + rx * a.cos(), cy + ry * a.sin())
        }).collect();
        return Some(Shape { kind: ShapeKind::Ellipse, points: flatten(&ring) });
    }
    if (5..=8).contains(&poly.len()) {
        return close(ShapeKind::Polygon, &poly);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A wobbly hand-drawn path through the corners.
    fn hand(corners: &[(f64, f64)], steps: usize) -> Vec<f32> {
        let mut out = Vec::new();
        let mut k = 0.0f64;
        for w in corners.windows(2) {
            for i in 0..steps {
                let u = i as f64 / steps as f64;
                k += 1.0;
                let jitter = (k * 1.7).sin() * 0.8;
                out.push((w[0].0 + (w[1].0 - w[0].0) * u + jitter) as f32);
                out.push((w[0].1 + (w[1].1 - w[0].1) * u - jitter) as f32);
            }
        }
        let l = corners[corners.len() - 1];
        out.extend([l.0 as f32, l.1 as f32]);
        out
    }

    #[test]
    fn lines_and_arrows() {
        assert_eq!(recognize(&hand(&[(0.0, 0.0), (200.0, 10.0)], 30)).unwrap().kind, ShapeKind::Line);
        let arrow = recognize(&hand(&[(0.0, 100.0), (200.0, 100.0), (180.0, 85.0), (200.0, 100.0), (180.0, 115.0)], 15)).unwrap();
        assert_eq!(arrow.kind, ShapeKind::Arrow);
        assert_eq!(arrow.points.len(), 10);
    }

    #[test]
    fn closed_shapes() {
        let rect = recognize(&hand(&[(0.0, 0.0), (150.0, 2.0), (148.0, 90.0), (1.0, 88.0), (0.0, 1.0)], 20)).unwrap();
        assert_eq!(rect.kind, ShapeKind::Rectangle);
        let near = |a: f32, b: f32| (a - b).abs() < 3.0;
        assert!(near(rect.points[0], 0.0) && near(rect.points[1], 0.0) && near(rect.points[2], 150.0) && rect.points[1] == rect.points[3], "snapped to an axis-aligned box: {:?}", &rect.points[..4]);
        let tri = recognize(&hand(&[(50.0, 0.0), (100.0, 90.0), (0.0, 90.0), (50.0, 1.0)], 20)).unwrap();
        assert_eq!(tri.kind, ShapeKind::Triangle);
        let diamond = recognize(&hand(&[(50.0, 0.0), (100.0, 50.0), (50.0, 100.0), (0.0, 50.0), (50.0, 1.0)], 20)).unwrap();
        assert_eq!(diamond.kind, ShapeKind::Diamond);
        let circle: Vec<f32> = (0..=80).flat_map(|i| {
            let a = i as f32 / 80.0 * std::f32::consts::TAU;
            [100.0 + 60.0 * a.cos() + (i as f32).sin(), 100.0 + 40.0 * a.sin()]
        }).collect();
        assert_eq!(recognize(&circle).unwrap().kind, ShapeKind::Ellipse);
    }

    #[test]
    fn scribbles_stay_ink() {
        let scribble: Vec<f32> = (0..60).flat_map(|i| [(i * 3) as f32, if i % 2 == 0 { 0.0 } else { 30.0 }]).collect();
        assert!(recognize(&scribble).is_none());
        assert!(recognize(&[1.0, 1.0, 2.0, 2.0]).is_none());
    }
}
