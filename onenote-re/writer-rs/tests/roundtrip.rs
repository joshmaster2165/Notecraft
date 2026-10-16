#![recursion_limit = "512"]
//! Write sections and read them back with this repository's reader
//! (`onenote-re`, the parser the writer inverts).

mod common;

use std::cell::RefCell;
use std::collections::HashMap;

use onenote_re::notebook::{
    AssetStatus, ContentBlock, ListInfo, NotebookJson, OutlineBlock, OutlineElementBlock,
    PageBlock, RichTextBlock,
};
use onenote_re::{parse_one_note, ConvertOptions};
use serde_json::json;

use common::*;

/// Parse with the asset hook collecting embedded bytes by container id.
fn read(bytes: &[u8]) -> (NotebookJson, HashMap<String, Vec<u8>>) {
    let assets = RefCell::new(HashMap::new());
    let json = {
        let opts = ConvertOptions {
            on_asset: Some(Box::new(|a: onenote_re::Asset<'_>| {
                assets
                    .borrow_mut()
                    .insert(a.id.to_string(), a.bytes.to_vec());
                Some(a.id.to_string())
            })),
            ..ConvertOptions::default()
        };
        parse_one_note(bytes, opts).expect("onenote-re parses the file")
    };
    assert!(
        json.diagnostics.warnings.is_empty(),
        "{:?}",
        json.diagnostics.warnings
    );
    (json, assets.into_inner())
}

fn outlines(blocks: &[PageBlock]) -> Vec<&OutlineBlock> {
    blocks
        .iter()
        .filter_map(|b| match b {
            PageBlock::Outline(o) => Some(o),
            _ => None,
        })
        .collect()
}

fn text_of(e: &OutlineElementBlock) -> &RichTextBlock {
    match &e.content[0] {
        ContentBlock::RichText(t) => t,
        other => panic!("expected rich text, got {other:?}"),
    }
}

/// NotebookColor of the section's metadata root.
fn section_color(bytes: &[u8]) -> Option<u32> {
    let store = onenote_re::OneStore::new(bytes).unwrap();
    let space = store.object_spaces.get(&store.root_gosid?)?;
    let rev = store.current_revision(space, 1, None)?;
    let meta = store.find_object(rev, &store.root_object(space, rev, 2)?, Some(space))?;
    assert_eq!(meta.jcid.raw, 0x0002_0031);
    let props = store.property_set(meta)?;
    props
        .properties
        .iter()
        .find(|p| p.prid == 0x1400_1cbe)
        .and_then(|p| match p.value {
            onenote_re::onestore::PropertyValue::Bytes(b) => {
                Some(u32::from_le_bytes(b.try_into().ok()?))
            }
            _ => None,
        })
}

fn close(a: f64, b: f64) -> bool {
    (a - b).abs() < 0.05
}

#[test]
fn section_pages_and_titles() {
    let bytes = onenote_writer::write_section(&sample()).unwrap();
    let (json, _) = read(&bytes);
    assert_eq!(json.source.file_kind, "section");
    let s = &json.section;
    assert_eq!(s.name.as_deref(), Some("Writer Test"));
    // NotebookColor sits on SectionMetaData ([MS-ONE] §2.2.31, and so in
    // OneNote's files), where onenote-re reads it.
    assert_eq!(section_color(&bytes), Some(0x002f_6ac4));
    assert_eq!(s.color.as_deref(), Some("#c46a2f"));
    assert_eq!(s.created_at.as_deref(), Some("2026-09-30T08:00:00.000Z"));
    let titles: Vec<&str> = s.pages.iter().map(|p| p.title.as_str()).collect();
    assert_eq!(&titles[..3], ["Welcome page", "Sub page", "Third"]);
    let levels: Vec<Option<u32>> = s.pages.iter().map(|p| p.level).collect();
    assert_eq!(levels, [Some(1), Some(2), Some(1), Some(3)]);
    let p = &s.pages[0];
    assert_eq!(p.created_at.as_deref(), Some("2026-10-01T09:30:00.000Z"));
    assert_eq!(p.last_modified.as_deref(), Some("2026-10-02T11:45:10.000Z"));
    assert_eq!(p.author.as_deref(), Some("Ada Lovelace"));
    // Title outline and OneNote's date/time line under it.
    let roles: Vec<Option<&str>> = p.title_blocks.iter().map(|b| b.role).collect();
    assert_eq!(roles, [Some("titleText"), Some("titleDate")]);
    assert_eq!(text_of(&p.title_blocks[0].children[0]).text, "Welcome page");
    assert_eq!(
        text_of(&p.title_blocks[1].children[0]).text,
        "Thursday, October 01, 2026"
    );
    assert_eq!(text_of(&p.title_blocks[1].children[1]).text, "9:30 AM");
    // An empty page and an empty outline still read.
    assert!(s.pages[3].blocks.is_empty());
    let third = outlines(&s.pages[2].blocks);
    assert_eq!(third.len(), 1);
    assert_eq!(text_of(&third[0].children[0]).text, "");
}

#[test]
fn outlines_paragraphs_and_runs() {
    let bytes = onenote_writer::write_section(&sample()).unwrap();
    let (json, _) = read(&bytes);
    let page = &json.section.pages[0];
    let os = outlines(&page.blocks);
    assert_eq!(os.len(), 2);
    let l = &os[0].layout;
    assert_eq!((l.x, l.y, l.width), (Some(54.0), Some(90.0), Some(520.0)));
    let l = &os[1].layout;
    assert_eq!((l.x, l.y, l.width), (Some(600.0), Some(300.0), Some(200.0)));
    let els = &os[0].children;

    let h = text_of(&els[0]);
    assert_eq!(h.text, "Heading One");
    assert_eq!(h.paragraph.style.style_id.as_deref(), Some("h1"));
    assert_eq!(h.paragraph.style.font_size, Some(16.0));
    assert_eq!(h.paragraph.style.color.as_deref(), Some("#1e4e79"));

    let f = text_of(&els[1]);
    assert_eq!(
        f.text,
        "Plain bold italic under strike red arial marked E=mc2 H2O and a link done"
    );
    let run = |t: &str| {
        f.runs
            .iter()
            .find(|r| r.text == t)
            .unwrap_or_else(|| panic!("run {t:?}"))
    };
    assert_eq!(run("bold").style.bold, Some(true));
    assert_eq!(run("italic").style.italic, Some(true));
    assert_eq!(run("under").style.underline, Some(true));
    assert_eq!(run("strike").style.strikethrough, Some(true));
    let red = &run("red arial").style;
    assert_eq!(red.font.as_deref(), Some("Arial"));
    assert_eq!(red.font_size, Some(14.0));
    assert_eq!(red.color.as_deref(), Some("#ff0000"));
    assert_eq!(run("marked").style.highlight.as_deref(), Some("#ffff00"));
    let sup = f
        .runs
        .iter()
        .find(|r| r.style.superscript == Some(true))
        .unwrap();
    assert_eq!(sup.text, "2");
    let sub = f
        .runs
        .iter()
        .find(|r| r.style.subscript == Some(true))
        .unwrap();
    assert_eq!(sub.text, "2");
    assert_eq!(run("Plain ").style.bold, None);
    let link = run("a link");
    assert_eq!(link.href.as_deref(), Some("https://example.com/a?b=1"));
    assert_eq!(run(" done").href, None);

    let styles: Vec<Option<&str>> = els[2..5]
        .iter()
        .map(|e| text_of(e).paragraph.style.style_id.as_deref())
        .collect();
    assert_eq!(styles, [Some("blockquote"), Some("code"), Some("cite")]);
    assert_eq!(
        text_of(&els[3]).paragraph.style.font.as_deref(),
        Some("Consolas")
    );

    let centered = els
        .iter()
        .map(text_of_any)
        .find(|t| t.is_some_and(|t| t.text == "Centered"))
        .flatten()
        .unwrap();
    assert_eq!(centered.paragraph.alignment, Some("center"));
    assert_eq!(centered.paragraph.space_before, Some(6.0));
    assert_eq!(centered.paragraph.space_after, Some(3.0));
    // Line feeds become OneNote's soft line break.
    assert!(els
        .iter()
        .filter_map(text_of_any)
        .any(|t| t.text == "line one\u{b}line two"));
    // The side outline.
    assert_eq!(text_of(&os[1].children[0]).text, "Side note");
}

fn text_of_any(e: &OutlineElementBlock) -> Option<&RichTextBlock> {
    match e.content.first() {
        Some(ContentBlock::RichText(t)) => Some(t),
        _ => None,
    }
}

#[test]
fn lists_indentation_and_tags() {
    let bytes = onenote_writer::write_section(&sample()).unwrap();
    let (json, _) = read(&bytes);
    let els = &outlines(&json.section.pages[0].blocks)[0].children;
    let by_text = |t: &str| {
        els.iter()
            .find(|e| text_of_any(e).is_some_and(|x| x.text == t))
            .unwrap_or_else(|| panic!("{t}"))
    };

    let b1 = by_text("Bullet one");
    match &b1.list {
        Some(ListInfo::Bullet(b)) => assert_eq!(b.bullet, "•"),
        other => panic!("{other:?}"),
    }
    // depth 1 → a child of the previous element.
    assert_eq!(b1.children.len(), 1);
    let nested = &b1.children[0];
    assert_eq!(text_of(nested).text, "Nested bullet");
    match &nested.list {
        Some(ListInfo::Bullet(b)) => assert_eq!(b.bullet, "◦"),
        other => panic!("{other:?}"),
    }
    match &by_text("Numbered three").list {
        Some(ListInfo::Numbered(n)) => {
            assert_eq!(n.scheme, "decimal");
            assert_eq!(n.suffix.as_deref(), Some("."));
            assert_eq!(n.restart, Some(3));
        }
        other => panic!("{other:?}"),
    }
    match &by_text("Lettered").list {
        Some(ListInfo::Numbered(n)) => {
            assert_eq!(n.scheme, "lowerLetter");
            assert_eq!(n.prefix.as_deref(), Some("("));
            assert_eq!(n.suffix.as_deref(), Some(")"));
            assert_eq!(n.restart, None);
        }
        other => panic!("{other:?}"),
    }

    let done = by_text("Done task").tags.as_ref().unwrap();
    assert_eq!(done.len(), 1);
    assert_eq!(done[0].label.as_deref(), Some("To Do"));
    assert_eq!(done[0].completed, Some(true));
    let open = by_text("Open task").tags.as_ref().unwrap();
    let labels: Vec<Option<&str>> = open.iter().map(|t| t.label.as_deref()).collect();
    assert_eq!(labels, [Some("To Do"), Some("Important")]);
    assert_eq!(open[0].completed, Some(false));
    assert!(open[0].action_item_type.is_some());
}

#[test]
fn tables() {
    let bytes = onenote_writer::write_section(&sample()).unwrap();
    let (json, _) = read(&bytes);
    let els = &outlines(&json.section.pages[0].blocks)[0].children;
    let t = els
        .iter()
        .find_map(|e| match e.content.first() {
            Some(ContentBlock::Table(t)) => Some(t),
            _ => None,
        })
        .unwrap();
    assert_eq!((t.row_count, t.column_count), (Some(2), Some(2)));
    assert_eq!(t.column_widths, [100.0, 150.0]);
    assert_eq!(t.borders_visible, Some(false));
    assert_eq!(t.rows[0].cells[0].shading.as_deref(), Some("#ddeeff"));
    let cell_text = |r: usize, c: usize| text_of(&t.rows[r].cells[c].children[0]).text.clone();
    assert_eq!(
        [
            cell_text(0, 0),
            cell_text(0, 1),
            cell_text(1, 0),
            cell_text(1, 1)
        ],
        ["A1", "B1", "A2", ""]
    );
    assert_eq!(
        text_of(&t.rows[0].cells[1].children[0]).runs[0].style.bold,
        Some(true)
    );
}

#[test]
fn pictures_attachments_crop_printout_math() {
    let bytes = onenote_writer::write_section(&sample()).unwrap();
    let (json, assets) = read(&bytes);
    let page = &json.section.pages[0];
    let els = &outlines(&page.blocks)[0].children;
    let images: Vec<_> = els
        .iter()
        .filter_map(|e| match e.content.first() {
            Some(ContentBlock::Image(i)) => Some(i),
            _ => None,
        })
        .collect();
    assert_eq!(images.len(), 3);
    let dot = images[0];
    assert_eq!(dot.asset_status, AssetStatus::Embedded);
    let asset = dot.asset.as_ref().unwrap();
    assert_eq!(asset.media_type, "image/png");
    assert_eq!(assets[asset.reference.as_deref().unwrap()], png_bytes());
    assert_eq!(
        (dot.layout.width, dot.layout.height),
        (Some(120.0), Some(80.0))
    );
    assert_eq!(dot.alt_text.as_deref(), Some("A dot"));
    assert_eq!(dot.filename.as_deref(), Some("dot.png"));
    assert_eq!(dot.ocr_text.as_deref(), Some("dot"));
    assert!(dot.crop.is_none() && dot.printout.is_none());

    // Cropped: the uncropped picture is stored, the frame is the cropped size.
    let cropped = images[1];
    let crop = cropped.crop.expect("crop");
    assert_eq!(
        (
            crop.top_left_x_percentage,
            crop.top_left_y_percentage,
            crop.width_percentage,
            crop.height_percentage
        ),
        (10.0, 20.0, 50.0, 60.0)
    );
    assert_eq!(
        (cropped.layout.width, cropped.layout.height),
        (Some(60.0), Some(40.0))
    );
    let original = &assets[cropped
        .asset
        .as_ref()
        .unwrap()
        .reference
        .as_deref()
        .unwrap()];
    assert_eq!(*original, big_png_like(4096, 7));

    let printout = images[2];
    assert_eq!(printout.printout.and_then(|p| p.page), Some(2));
    assert_eq!(
        printout.asset.as_ref().unwrap().extension.as_deref(),
        Some(".png")
    );

    let file = els
        .iter()
        .find_map(|e| match e.content.first() {
            Some(ContentBlock::EmbeddedFile(f)) => Some(f),
            _ => None,
        })
        .unwrap();
    assert_eq!(file.filename.as_deref(), Some("notes.pdf"));
    let fa = file.asset.as_ref().unwrap();
    assert_eq!(fa.extension.as_deref(), Some(".pdf"));
    assert_eq!(assets[fa.reference.as_deref().unwrap()], ATTACHMENT);

    let math = els
        .iter()
        .filter_map(text_of_any)
        .find(|t| t.runs.iter().any(|r| r.style.math == Some(true)))
        .unwrap();
    assert_eq!(math.text, "x=(-b±√(b^2-4ac))/2a");
    assert_eq!(math.runs[0].style.font.as_deref(), Some("Cambria Math"));

    // The floating picture.
    let float = page
        .blocks
        .iter()
        .find_map(|b| match b {
            PageBlock::Image(i) => Some(i),
            _ => None,
        })
        .unwrap();
    assert_eq!(
        (
            float.layout.x,
            float.layout.y,
            float.layout.width,
            float.layout.height
        ),
        (Some(400.0), Some(120.0), Some(50.0), Some(50.0))
    );
    assert_eq!(float.alt_text.as_deref(), Some("Floating"));
    assert_eq!(
        assets[float.asset.as_ref().unwrap().reference.as_deref().unwrap()],
        png_bytes()
    );
}

/// Raw (PropertyID → bytes or bool) of every ImageNode in the file.
fn image_props(bytes: &[u8]) -> Vec<HashMap<u32, Option<Vec<u8>>>> {
    use onenote_re::onestore::PropertyValue;
    let store = onenote_re::OneStore::new(bytes).unwrap();
    let mut out = Vec::new();
    for space in store.object_spaces.values() {
        for rev in space.revisions.values() {
            for o in rev.objects.values().filter(|o| o.jcid.raw == 0x0006_0011) {
                let set = store.property_set(o).unwrap();
                out.push(
                    set.properties
                        .iter()
                        .map(|p| {
                            let v = match &p.value {
                                PropertyValue::Bytes(b) => Some(b.to_vec()),
                                PropertyValue::Bool(b) => Some(vec![*b as u8]),
                                _ => None,
                            };
                            (p.prid & 0x7fff_ffff, v)
                        })
                        .collect(),
                );
            }
        }
    }
    out
}

#[test]
fn crop_and_printout_use_the_live_properties() {
    let bytes = onenote_writer::write_section(&sample()).unwrap();
    let images = image_props(&bytes);
    let f32_of = |m: &HashMap<u32, Option<Vec<u8>>>, id: u32| {
        m.get(&id)
            .and_then(|v| v.as_ref())
            .map(|b| f32::from_le_bytes(b[..4].try_into().unwrap()))
    };
    let cropped = images
        .iter()
        .find(|m| m.contains_key(&0x1400_12f5))
        .expect("a cropped picture");
    // Fractions of the uncropped picture: width, height, left, top.
    assert_eq!(f32_of(cropped, 0x1400_12f5), Some(0.5));
    assert_eq!(f32_of(cropped, 0x1400_12f6), Some(0.6));
    assert_eq!(f32_of(cropped, 0x1400_12f7), Some(0.1));
    assert_eq!(f32_of(cropped, 0x1400_12f8), Some(0.2));
    for m in &images {
        for deprecated in [
            0x1400_35ca,
            0x1400_35cb,
            0x1400_3620,
            0x1400_3621,
            0x0800_35cc,
            0x0800_12f4,
        ] {
            assert!(!m.contains_key(&deprecated), "{deprecated:#x}");
        }
    }
    let printout = images
        .iter()
        .find(|m| m.contains_key(&0x0800_1d85))
        .expect("a printout page");
    assert_eq!(printout[&0x0800_1d85], Some(vec![1]));
    assert_eq!(printout[&0x1400_1df9], Some(2u32.to_le_bytes().to_vec()));
}

#[test]
fn ink() {
    let bytes = onenote_writer::write_section(&sample()).unwrap();
    let (json, _) = read(&bytes);
    let ink = json.section.pages[0]
        .blocks
        .iter()
        .find_map(|b| match b {
            PageBlock::Ink(i) => Some(i),
            _ => None,
        })
        .expect("page ink");
    assert_eq!(ink.strokes.len(), 2);
    let pen = &ink.strokes[0];
    let want = [100.0, 500.0, 110.5, 505.25, 130.0, 520.0, 150.0, 515.0];
    assert_eq!(pen.points.len(), want.len());
    for (a, b) in pen.points.iter().zip(want) {
        assert!(close(*a, b), "{:?}", pen.points);
    }
    assert_eq!(pen.color.as_deref(), Some("#1d1f23"));
    assert!(close(pen.width.unwrap(), 2.0));
    assert_eq!(pen.highlighter, None);
    let hl = &ink.strokes[1];
    assert_eq!(hl.highlighter, Some(true));
    assert_eq!(hl.color.as_deref(), Some("#ffe14d"));
    assert!(close(hl.width.unwrap(), 14.0));
    for (a, b) in hl.points.iter().zip([100.0, 560.0, 300.0, 560.0]) {
        assert!(close(*a, b), "{:?}", hl.points);
    }
}

#[test]
fn subpages_share_a_page_series() {
    let bytes = onenote_writer::write_section(&sample()).unwrap();
    let store = onenote_re::OneStore::new(&bytes).unwrap();
    let root = store.root_gosid.unwrap();
    let space = store.object_spaces.get(&root).unwrap();
    let rev = store.current_revision(space, 1, None).unwrap();
    let series: Vec<_> = rev
        .objects
        .values()
        .filter(|o| o.jcid.raw == 0x0006_0008)
        .collect();
    // [Welcome, Sub page] and [Third, (level 3) untitled].
    assert_eq!(series.len(), 2);
    // Every page's metadata is also in the section.
    let metas = rev
        .objects
        .values()
        .filter(|o| o.jcid.raw == 0x0002_0030)
        .count();
    assert_eq!(metas, 4);
}

#[test]
fn unusual_input_still_reads() {
    let section = json!({
        "name": "Odd \"one\"",
        "pages": [
            { "id": "dup", "title": "A\nB", "level": 3, "outlines": [{ "elements": [
                { "kind": "text", "depth": 4, "runs": [{ "text": "deep\u{0}" }] },
                { "kind": "unknown" },
                { "kind": "table", "rows": [] },
                { "kind": "image", "image": { "src": "notecraft-blob:abc", "width": 10, "height": 10 } },
                { "kind": "file", "name": "", "src": null },
                { "kind": "text", "tags": [{ "kind": "custom:waiting", "label": "Waiting", "done": false }, { "kind": "custom:waiting" }], "runs": [{ "text": "x", "href": "javascript:\"" }] }
            ]}]},
            { "id": "dup", "title": "Same id", "outlines": [] }
        ]
    });
    let out = onenote_writer::write_section_with(&section, &Default::default()).unwrap();
    assert!(
        out.warnings.iter().any(|w| w.contains("not a data: URL")),
        "{:?}",
        out.warnings
    );
    let (json, _) = read(&out.bytes);
    let pages = &json.section.pages;
    assert_eq!(pages.len(), 2);
    assert_eq!(pages[0].title, "A B");
    assert_eq!(pages[0].level, Some(1));
    assert_eq!(pages[1].title, "Same id");
    assert_ne!(pages[0].id, pages[1].id);
    let els = &outlines(&pages[0].blocks)[0].children;
    assert_eq!(text_of(&els[0]).text, "deep");
    let img = els
        .iter()
        .find_map(|e| match e.content.first() {
            Some(ContentBlock::Image(i)) => Some(i),
            _ => None,
        })
        .unwrap();
    assert_eq!(img.asset_status, AssetStatus::NotEmbedded);
    let tagged = els.iter().find(|e| e.tags.is_some()).unwrap();
    assert_eq!(tagged.tags.as_ref().unwrap().len(), 1);
    assert_eq!(
        tagged.tags.as_ref().unwrap()[0].label.as_deref(),
        Some("Waiting")
    );
}

/// The reader's side of the round trip: section color from the metadata,
/// untitled pages, and the built-in quote style.
#[test]
fn reader_keeps_color_empty_titles_and_quotes() {
    let mut section = sample();
    let (json, _) = read(&onenote_writer::write_section(&section).unwrap());
    assert_eq!(json.section.color.as_deref(), Some("#c46a2f"));
    // An empty title stays empty: the date/time line under it is not the title.
    let untitled = &json.section.pages[3];
    assert_eq!(untitled.title, "");
    let roles: Vec<Option<&str>> = untitled.title_blocks.iter().map(|b| b.role).collect();
    assert!(roles.contains(&Some("titleDate")), "{roles:?}");
    // Quotes are written with OneNote's built-in "blockquote" style id
    // (notecraft/src/model/importOne.ts maps it back to "quote").
    let els = &outlines(&json.section.pages[0].blocks)[0].children;
    assert_eq!(
        text_of(&els[2]).paragraph.style.style_id.as_deref(),
        Some("blockquote")
    );

    // No color: none read back.
    section["color"] = serde_json::Value::Null;
    let (json, _) = read(&onenote_writer::write_section(&section).unwrap());
    assert_eq!(json.section.color, None);
}
