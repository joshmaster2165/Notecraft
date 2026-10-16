//! Page styles: hidden titles, page color, rule lines and grids, checked on
//! the PageNode's properties (read with `onenote-re`'s revision store
//! reader) against what OneNote for Mac's own commands write, and opened by
//! both readers.

use onenote_parser::Parser;
use onenote_re::onestore::{PropertySet, PropertyValue};
use onenote_re::{parse_one_note, ConvertOptions, OneStore};
use serde_json::{json, Value};
use typed_path::TypedPath;

/// Narrow ruled lines, in inches (OneNote's resource string).
const NARROW_INCHES: f64 = 0.186_496_055;

fn page(id: &str, title: &str, extra: Value) -> Value {
    let mut p = json!({
        "id": id, "title": title, "level": 1,
        "createdAt": "2026-10-01T09:00:00Z", "modifiedAt": "2026-10-01T09:00:00Z",
        "outlines": [{ "id": format!("{id}-o"), "x": 54, "y": 90, "width": 300,
            "elements": [{ "id": format!("{id}-e"), "kind": "text", "depth": 0, "runs": [{ "text": format!("Body {id}") }] }] }],
        "images": []
    });
    for (k, v) in extra.as_object().unwrap() {
        p[k] = v.clone();
    }
    p
}

fn section() -> Value {
    json!({
        "id": "paper", "name": "Paper",
        "pages": [
            page("plain", "Plain", json!({})),
            page("hidden", "No title", json!({ "hideTitle": true })),
            page("ruled", "Narrow", json!({ "paper": { "color": "#FFF2CC", "rule": "narrow" } })),
            page("grid", "Grid", json!({ "paper": { "rule": "grid-medium", "ruleColor": "#D9EAD3" } })),
            page("college", "College", json!({ "paper": { "rule": "college", "ruleColor": "#F4CCCC" } })),
            page("odd", "Odd", json!({ "paper": { "rule": "hexagons" } })),
        ]
    })
}

/// The PageNode property sets, in page order.
fn page_nodes(bytes: &[u8]) -> Vec<PropertySet<'_>> {
    let store = OneStore::new(bytes).unwrap();
    let mut out = Vec::new();
    for space in store.object_spaces.values() {
        for rev in space.revisions.values() {
            for decl in rev.objects.values() {
                if decl.jcid.raw == 0x0006_000b {
                    out.push((*store.property_set(decl).unwrap()).clone());
                }
            }
        }
    }
    out
}

fn get<'a>(set: &'a PropertySet<'a>, prid: u32) -> Option<&'a PropertyValue<'a>> {
    set.properties
        .iter()
        .find(|p| p.prid & 0x7fff_ffff == prid)
        .map(|p| &p.value)
}

fn u32_of(set: &PropertySet<'_>, prid: u32) -> Option<u32> {
    match get(set, prid)? {
        PropertyValue::Bytes(b) => {
            let mut v = [0u8; 4];
            v[..b.len().min(4)].copy_from_slice(&b[..b.len().min(4)]);
            Some(u32::from_le_bytes(v))
        }
        _ => None,
    }
}

fn f32_of(set: &PropertySet<'_>, prid: u32) -> Option<f32> {
    u32_of(set, prid).map(f32::from_bits)
}

#[test]
fn page_style_properties() {
    let out = onenote_writer::write_section_with(&section(), &Default::default()).unwrap();
    assert!(
        out.warnings.iter().any(|w| w.contains("“hexagons”")),
        "{:?}",
        out.warnings
    );
    let nodes = page_nodes(&out.bytes);
    assert_eq!(nodes.len(), 6);
    let (plain, hidden, ruled, grid, college) =
        (&nodes[0], &nodes[1], &nodes[2], &nodes[3], &nodes[4]);

    // Every page: OneNote's snap grid.
    for n in &nodes {
        assert_eq!(f32_of(n, 0x1400_1ca0), Some(0.25), "GridGravityX");
        assert_eq!(f32_of(n, 0x1400_1ca1), Some(0.25), "GridGravityY");
    }
    assert_eq!(f32_of(plain, 0x1400_1c9e), Some(0.5));
    assert!(get(plain, 0x1400_1d2a).is_none(), "no page color");
    assert!(get(plain, 0x0c00_352d).is_none(), "no rule lines");

    // Hidden title: no TitleNode under StructureElementChildNodes.
    assert!(get(plain, 0x2400_1d5f).is_some());
    assert!(get(hidden, 0x2400_1d5f).is_none());

    // Page color: a COLORREF.
    assert_eq!(u32_of(ruled, 0x1400_1d2a), Some(0x00cc_f2ff));

    // Narrow ruled: style 1, rule lines every 18/48 half-inch from 1, and
    // the red margin line at 35.
    assert_eq!(u32_of(ruled, 0x0c00_352d), Some(1));
    let Some(PropertyValue::PropertyValues { prid, sets: groups }) = get(ruled, 0x4000_352c) else {
        panic!("PageStyleLineGroups");
    };
    assert_eq!(prid & 0x7fff_ffff, 0x4400_0811);
    assert_eq!(groups.len(), 2);
    let line = |g: &PropertySet<'_>| -> (u32, u32, u32) {
        let Some(PropertyValue::PropertyValues { sets, .. }) = get(g, 0x4000_352f) else {
            panic!("LineGroupLines");
        };
        assert_eq!(sets.len(), 1);
        let l = &sets[0];
        (
            u32_of(l, 0x1400_3530).unwrap(),
            u32_of(l, 0x1400_3531).unwrap(),
            u32_of(l, 0x1400_3533).unwrap(),
        )
    };
    assert_eq!(f32_of(&groups[0], 0x1400_352e), Some(0.0));
    assert_eq!(
        f32_of(&groups[0], 0x1400_3532).map(f32::to_bits),
        Some(0x3caa_aaab)
    );
    assert_eq!(line(&groups[0]), (18, 1, 0xffca_ebfd));
    assert_eq!(f32_of(&groups[1], 0x1400_352e), Some(90.0));
    assert_eq!(line(&groups[1]), (0, 35, 0xffff_5050));
    // The older properties, from OneNote's style strings.
    assert_eq!(u32_of(ruled, 0x1400_1cd3), Some(2), "lines");
    assert_eq!(f32_of(ruled, 0x1400_1cd4), Some(NARROW_INCHES as f32 * 2.0));
    assert_eq!(u32_of(ruled, 0x1400_1cd5), Some(0xffca_ebfd));
    assert_eq!(u32_of(ruled, 0x1400_1cd6), Some(3), "margin");
    assert_eq!(f32_of(ruled, 0x1400_1cd7), Some(0.0));
    assert_eq!(u32_of(ruled, 0x1400_1cd8), Some(0xffff_5050));
    assert_eq!(f32_of(ruled, 0x1400_1c9e), Some(NARROW_INCHES as f32 * 2.0));

    // Medium grid in a custom color: 10 mm both ways; both legacy colors
    // take the rule color (0xFFRRGGBB), the line groups keep the default.
    assert_eq!(u32_of(grid, 0x0c00_352d), Some(6));
    let Some(PropertyValue::PropertyValues { sets: groups, .. }) = get(grid, 0x4000_352c) else {
        panic!("PageStyleLineGroups");
    };
    assert_eq!(
        f32_of(&groups[0], 0x1400_3532).map(f32::to_bits),
        Some(0x3da1_4285)
    );
    assert_eq!(line(&groups[0]), (10, 0, 0xffca_ebfd));
    assert_eq!(line(&groups[1]), (10, 0, 0xffca_ebfd));
    assert_eq!(u32_of(grid, 0x1400_1cd3), Some(1));
    assert_eq!(u32_of(grid, 0x1400_1cd6), Some(1));
    assert_eq!(u32_of(grid, 0x1400_1cd5), Some(0xffd9_ead3));
    assert_eq!(u32_of(grid, 0x1400_1cd8), Some(0xffd9_ead3));
    assert!((f32_of(grid, 0x1400_1c9e).unwrap() - 0.3937).abs() < 1e-6);

    // College ruled in a custom color: the margin stays red.
    assert_eq!(u32_of(college, 0x0c00_352d), Some(2));
    assert_eq!(u32_of(college, 0x1400_1cd5), Some(0xfff4_cccc));
    assert_eq!(u32_of(college, 0x1400_1cd8), Some(0xffff_5050));
}

#[test]
fn readers_accept_page_styles() {
    let bytes = onenote_writer::write_section(&section()).unwrap();
    let json = parse_one_note(&bytes, ConvertOptions::default()).unwrap();
    assert!(
        json.diagnostics.warnings.is_empty(),
        "{:?}",
        json.diagnostics.warnings
    );
    assert_eq!(json.section.pages.len(), 6);
    let text = serde_json::to_value(&json.section.pages[1])
        .unwrap()
        .to_string();
    assert!(
        text.contains("Body hidden"),
        "the hidden-title page keeps its content"
    );

    let parsed = Parser::new()
        .parse_section_buffer(&bytes, TypedPath::derive("Paper.one"))
        .unwrap_or_else(|e| panic!("onenote_parser rejects the file: {e}"));
    let warnings: Vec<&str> = parsed
        .report()
        .warnings()
        .iter()
        .map(|w| w.message())
        .collect();
    assert!(warnings.is_empty(), "{warnings:?}");
    let pages: Vec<_> = parsed
        .page_series()
        .iter()
        .flat_map(|s| s.pages())
        .collect();
    assert_eq!(pages.len(), 6);
    assert!(
        pages[1].title().is_none(),
        "no title on the hidden-title page"
    );
    assert!(pages[2].title().is_some());
}
