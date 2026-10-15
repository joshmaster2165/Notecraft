//! Port of parser/src/ink.test.ts (ink decoding and .onetoc2 entry ordering).

use onenote_re::ink::{
    decode_bounding_box, decode_ink_dimensions, decode_ink_path, encode_ink_path, ink_to_svg,
    point_bounds, stroke_points, Bounds, InkStroke, INK_DIMENSION_X, INK_DIMENSION_Y,
};
use onenote_re::toc::{order_toc_entries, unescape_toc_name, RawTocEntry};
use onenote_re::TocEntry;

/// GUIDs are stored with their first three fields little-endian.
fn guid_bytes(g: &str) -> Vec<u8> {
    let h: String = g.chars().filter(|c| c.is_ascii_hexdigit()).collect();
    let b: Vec<u8> = (0..16)
        .map(|i| u8::from_str_radix(&h[i * 2..i * 2 + 2], 16).unwrap())
        .collect();
    let mut out = vec![b[3], b[2], b[1], b[0], b[5], b[4], b[7], b[6]];
    out.extend_from_slice(&b[8..]);
    out
}

fn dims(ds: &[&str]) -> Vec<String> {
    ds.iter().map(|d| d.to_string()).collect()
}

#[test]
fn ink_path_uses_ms_isf_multi_byte_values_with_the_sign_in_the_low_bit() {
    // The vector from onenote.rs's multi_byte tests.
    assert_eq!(decode_ink_path(&[0x04, 0x06, 0x05]), [3.0, -2.0]);
    let values = [
        0.0,
        1.0,
        -1.0,
        63.0,
        -64.0,
        8191.0,
        -8192.0,
        1_000_000.0,
        -123_456.0,
    ];
    assert_eq!(decode_ink_path(&encode_ink_path(&values)), values);
    // Truncated input stops cleanly.
    assert_eq!(decode_ink_path(&[0x08, 0x02]), [1.0]);
}

#[test]
fn strokes_dimensions_are_stored_one_after_another_and_deltas_accumulate() {
    // Three points (10,20) (13,18) (15,25): X = 10, +3, +2; Y = 20, −2, +7.
    let values = [10.0, 3.0, 2.0, 20.0, -2.0, 7.0];
    assert_eq!(
        stroke_points(
            &values,
            &dims(&[INK_DIMENSION_X, INK_DIMENSION_Y]),
            1.0,
            1.0
        ),
        [10.0, 20.0, 13.0, 18.0, 15.0, 25.0]
    );
    // Y listed first, plus a pressure dimension that is ignored.
    let pressure = "{7307502D-F9F4-4E18-B3F2-2CE1B1A3610C}";
    assert_eq!(
        stroke_points(
            &[20.0, -2.0, 7.0, 10.0, 3.0, 2.0, 500.0, 0.0, 0.0],
            &dims(&[INK_DIMENSION_Y, INK_DIMENSION_X, pressure]),
            1.0,
            1.0
        ),
        [10.0, 20.0, 13.0, 18.0, 15.0, 25.0]
    );
    // Scaling multiplies after accumulation.
    assert_eq!(
        stroke_points(&[10.0, 3.0, 20.0, -2.0], &[], 2.0, 0.5),
        [20.0, 10.0, 26.0, 9.0]
    );
}

#[test]
fn ink_dimensions_entries_are_32_bytes_starting_with_a_guid() {
    let mut b = Vec::new();
    for g in [INK_DIMENSION_X, INK_DIMENSION_Y] {
        b.extend(guid_bytes(g));
        b.extend([0u8; 16]);
    }
    assert_eq!(
        decode_ink_dimensions(Some(&b)),
        [INK_DIMENSION_X, INK_DIMENSION_Y]
    );
    assert!(decode_ink_dimensions(None).is_empty());
}

#[test]
fn bounding_box_and_svg_rendering() {
    let mut b = Vec::new();
    for v in [-5i32, 10, 300, 400] {
        b.extend(v.to_le_bytes());
    }
    assert_eq!(decode_bounding_box(Some(&b)), Some([-5, 10, 300, 400]));
    assert_eq!(decode_bounding_box(Some(&b[..15])), None);
    assert_eq!(
        point_bounds(&[1.0, 2.0, 5.0, 9.0, 3.0, 4.0]),
        Some(Bounds {
            x: 1.0,
            y: 2.0,
            width: 4.0,
            height: 7.0
        })
    );
    let svg = ink_to_svg(
        &[InkStroke {
            points: vec![0.0, 0.0, 10.0, 5.0],
            color: Some("#ff0000".into()),
            width: Some(2.0),
            transparency: Some(128),
            ..InkStroke::default()
        }],
        2.0,
    );
    let open_tag = &svg[..svg.find('>').unwrap()];
    assert!(open_tag.starts_with("<svg "), "{svg}");
    assert!(open_tag.contains("width=\"18\" height=\"13\""), "{svg}");
    assert!(svg.contains("stroke=\"#ff0000\""), "{svg}");
    assert!(svg.contains("stroke-opacity=\"0.5\""), "{svg}");
}

fn raw(index: usize, name: &str, order: Option<u32>, color: Option<&str>) -> RawTocEntry {
    RawTocEntry {
        index,
        entry: TocEntry {
            name: name.into(),
            order,
            color: color.map(Into::into),
            guid_file: None,
        },
    }
}

fn entry(name: &str, order: Option<u32>, color: Option<&str>) -> TocEntry {
    TocEntry {
        name: name.into(),
        order,
        color: color.map(Into::into),
        guid_file: None,
    }
}

#[test]
fn onetoc2_entries_later_names_win_then_ordering_id() {
    assert_eq!(
        unescape_toc_name("Q1^M Q2^J notes.one"),
        "Q1+ Q2, notes.one"
    );
    let ordered = order_toc_entries(vec![
        raw(0, "Ideas.one", Some(3), None),
        raw(1, "Projects", Some(1), None),
        raw(2, "Inbox.one", Some(2), None),
        raw(3, "ideas.one", Some(0), Some("#ff8800")),
        raw(4, "Unordered.one", None, None),
    ]);
    assert_eq!(
        ordered,
        [
            entry("ideas.one", Some(0), Some("#ff8800")),
            entry("Projects", Some(1), None),
            entry("Inbox.one", Some(2), None),
            entry("Unordered.one", None, None),
        ]
    );
}
