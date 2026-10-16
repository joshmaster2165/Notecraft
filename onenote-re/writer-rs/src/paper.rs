//! View › Paper Style on the PageNode: page color, and rule lines or grids,
//! written the way OneNote for Mac's own commands write them
//! (`docs/file-format.md` §16; addresses are in OneNote for Mac's binary).
//!
//! - Page color: `PageColor` (0x14001D2A), a COLORREF; left out for none.
//!   The page color command stores the gallery's COLORREF (0x10030c44c) and
//!   the page renderer reads it as one, 0xFF000000 / 0xFFFFFFFF meaning none
//!   (0x1002731c4).
//! - Rule lines: applying rule line style *n* (0x1009d9e7c) writes
//!   `PageStyleID` = *n* and `PageStyleLineGroups` from OneNote's built-in
//!   style table (initialised at 0x100050d20, written by 0x100ecbd3c), then
//!   the older `PageHorizontalLine*` / `PageVerticalLine*` properties from
//!   the style's resource strings (strman 0x25: "A,R,G,B,type,inches") and
//!   `GridStepX` / `GridStepY` from the horizontal spacing.
//! - Rule line color: `PageHorizontalLineColor` (and `PageVerticalLineColor`
//!   for grids) as 0xAARRGGBB with alpha 0xFF, as the rule line color command
//!   stores it (0x1009da7a4, gallery 0x100471fb0); the line groups keep their
//!   default color.
//!
//! Notecraft's rule names map to OneNote's style numbers by name and size
//! order (Narrow, College, Standard ruled are 1–3, then Wide; Small, Medium,
//! Large grids 5–7, then Very Large): that mapping is inferred, the rest is
//! read from the binary.

use crate::model::{Paper, Rgb};
use crate::propset::{PropSet, Value};
use crate::schema::prop;

/// GridStepX/Y and GridGravityX/Y on every PageNode of OneNote's files.
pub(crate) const GRID_STEP: f32 = 0.5;
pub(crate) const GRID_GRAVITY: f32 = 0.25;

/// One line of a line group: repeats every `rep` units from `from`, in a
/// COLORREF.
struct Line {
    rep: u32,
    from: u32,
    colorref: u32,
}

struct Group {
    angle: f32,
    /// Half-inches per unit.
    factor: f32,
    line: Line,
}

/// A legacy line description ("A,R,G,B,type,inches").
struct Legacy {
    argb: u32,
    kind: char,
    inches: f64,
}

struct Style {
    id: u8,
    groups: [Group; 2],
    horizontal: Legacy,
    vertical: Legacy,
}

/// 1/48 half-inch (a pixel at 96 dpi) and a millimetre in half-inches, as
/// OneNote stores them.
const PER_PIXEL: f32 = f32::from_bits(0x3caa_aaab);
const PER_MM: f32 = f32::from_bits(0x3da1_4285);
const RULE_BLUE: u32 = 0x00fd_ebca;
const MARGIN_RED: u32 = 0x0050_50ff;

fn ruled(id: u8, rep: u32, from: u32, inches: f64) -> Style {
    Style {
        id,
        groups: [
            Group {
                angle: 0.0,
                factor: PER_PIXEL,
                line: Line {
                    rep,
                    from,
                    colorref: RULE_BLUE,
                },
            },
            // The red margin line.
            Group {
                angle: 90.0,
                factor: PER_PIXEL,
                line: Line {
                    rep: 0,
                    from: 35,
                    colorref: MARGIN_RED,
                },
            },
        ],
        horizontal: Legacy {
            argb: argb(RULE_BLUE),
            kind: 'L',
            inches,
        },
        vertical: Legacy {
            argb: argb(MARGIN_RED),
            kind: 'M',
            inches: 0.0,
        },
    }
}

fn grid(id: u8, rep: u32, factor: f32, inches: f64) -> Style {
    let group = |angle| Group {
        angle,
        factor,
        line: Line {
            rep,
            from: 0,
            colorref: RULE_BLUE,
        },
    };
    let legacy = || Legacy {
        argb: argb(RULE_BLUE),
        kind: 'G',
        inches,
    };
    Style {
        id,
        groups: [group(0.0), group(90.0)],
        horizontal: legacy(),
        vertical: legacy(),
    }
}

/// OneNote's built-in style for a Notecraft rule name.
fn style(rule: &str) -> Option<Style> {
    Some(match rule {
        "narrow" => ruled(1, 18, 1, 0.186_496_055),
        "college" => ruled(2, 32, 22, 0.33),
        "standard" => ruled(3, 44, 18, 0.46),
        "grid-small" => grid(5, 16, PER_PIXEL, 0.166_666_667),
        "grid-medium" => grid(6, 10, PER_MM, 0.3937),
        "grid-large" => grid(7, 15, PER_MM, 0.590_55),
        _ => return None,
    })
}

/// COLORREF (0x00BBGGRR) to the opaque 0xFFRRGGBB line colors use.
fn argb(colorref: u32) -> u32 {
    0xff00_0000 | (colorref & 0xff) << 16 | (colorref & 0xff00) | (colorref >> 16 & 0xff)
}

fn rgb_argb(c: Rgb) -> u32 {
    argb(c.colorref())
}

/// Legacy line type: G (grid) 1, L (lines) 2, M (margin) 3.
fn legacy_type(kind: char) -> u32 {
    match kind {
        'G' => 1,
        'L' => 2,
        'M' => 3,
        _ => 0,
    }
}

/// The grid step OneNote derives from the horizontal spacing: the spacing
/// split into steps of at most a quarter inch, in half-inches.
fn grid_step(inches: f64) -> f32 {
    let d = inches as f32;
    let n = (d * 4.0).ceil().max(1.0);
    let s = d / n;
    s + s
}

/// What the paper style adds to a PageNode: `GridStepX`/`Y` first (so the
/// caller can place them), then the rest. `warn` hears about rule names
/// OneNote has no style for.
pub(crate) struct PaperProps {
    pub grid_step: f32,
    pub props: PropSet,
}

pub(crate) fn paper_props(paper: &Paper, warn: &mut dyn FnMut(String)) -> PaperProps {
    let mut p = PropSet::new();
    let mut grid_step_value = GRID_STEP;
    if let Some(c) = paper.color {
        p.u32(prop::PAGE_COLOR, c.colorref());
    }
    let rule = paper
        .rule
        .as_deref()
        .filter(|r| !r.is_empty() && *r != "none");
    if let Some(rule) = rule {
        match style(rule) {
            None => warn(format!("rule lines “{rule}” have no OneNote equivalent")),
            Some(st) => {
                let groups = st
                    .groups
                    .iter()
                    .map(|g| {
                        let mut line = PropSet::new();
                        line.u32(prop::LINE_COLOR, argb(g.line.colorref))
                            .u32(prop::LINE_DISTANCE_FROM_START, g.line.from)
                            .u32(prop::LINE_REPETITION_DISTANCE, g.line.rep);
                        let mut set = PropSet::new();
                        set.set(
                            prop::LINE_GROUP_LINES,
                            Value::Sets(prop::ARRAY_ELEMENT, vec![line]),
                        )
                        .f32(prop::LINE_GROUP_ANGLE, g.angle)
                        .f32(prop::LINE_GROUP_CONVERSION_FACTOR, g.factor);
                        set
                    })
                    .collect();
                p.u8(prop::PAGE_STYLE_ID, st.id).set(
                    prop::PAGE_STYLE_LINE_GROUPS,
                    Value::Sets(prop::ARRAY_ELEMENT, groups),
                );
                grid_step_value = grid_step(st.horizontal.inches);
                let user = paper.rule_color.map(rgb_argb);
                let h = &st.horizontal;
                p.u32(prop::PAGE_HORIZONTAL_LINE_COLOR, user.unwrap_or(h.argb))
                    .u32(prop::PAGE_HORIZONTAL_LINE_TYPE, legacy_type(h.kind))
                    .f32(prop::PAGE_HORIZONTAL_LINE_DISTANCE, {
                        let d = h.inches as f32;
                        d + d
                    });
                let v = &st.vertical;
                // A grid's vertical lines take the rule color; the margin
                // stays red.
                let v_color = if v.kind == 'G' {
                    user.unwrap_or(v.argb)
                } else {
                    v.argb
                };
                p.u32(prop::PAGE_VERTICAL_LINE_TYPE, legacy_type(v.kind))
                    .f32(prop::PAGE_VERTICAL_LINE_DISTANCE, {
                        let d = v.inches as f32;
                        d + d
                    })
                    .u32(prop::PAGE_VERTICAL_LINE_COLOR, v_color);
            }
        }
    }
    PaperProps {
        grid_step: grid_step_value,
        props: p,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn colors_and_steps() {
        assert_eq!(argb(RULE_BLUE), 0xffca_ebfd);
        assert_eq!(argb(MARGIN_RED), 0xffff_5050);
        assert!((PER_PIXEL - 1.0 / 48.0).abs() < 1e-9);
        assert!((PER_MM - 2.0 / 25.4).abs() < 1e-7);
        // Narrow ruled: one step of 0.1865 in; grids: 1 cm in two steps.
        let narrow: f64 = 0.186_496_055;
        assert_eq!(grid_step(narrow), narrow as f32 * 2.0);
        assert!((grid_step(0.3937) - 0.3937).abs() < 1e-6);
        assert!((grid_step(0.65) - 0.65 / 3.0 * 2.0).abs() < 1e-6);
    }

    #[test]
    fn spacing_matches_the_legacy_inches() {
        // Line group spacing in half-inches is twice the legacy inches.
        for rule in [
            "narrow",
            "college",
            "standard",
            "grid-small",
            "grid-medium",
            "grid-large",
        ] {
            let st = style(rule).unwrap();
            let g = &st.groups[0];
            let half_inches = g.line.rep as f32 * g.factor;
            assert!(
                (half_inches - 2.0 * st.horizontal.inches as f32).abs() < 0.02,
                "{rule}: {half_inches} vs {}",
                st.horizontal.inches
            );
        }
    }
}
