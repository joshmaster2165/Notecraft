#![recursion_limit = "512"]
//! Read the writer's output with an independent [MS-ONESTORE]/[MS-ONE]
//! implementation: `onenote_parser` (msiemens/onenote.rs). It validates
//! fragment sizes, node sizes, the transaction log, revision manifests and
//! the property sets of every object type, so its errors are the best
//! stand-in for OneNote rejecting a file.

mod common;

use std::io::Read;

use onenote_parser::contents::{
    Content, EmbeddedFile, Image, OutlineElement, OutlineItem, RichText,
};
use onenote_parser::page::{Page, PageContent};
use onenote_parser::section::Section;
use onenote_parser::Parser;
use serde_json::json;
use typed_path::TypedPath;

use common::*;

fn parse(bytes: &[u8]) -> Section {
    let section = Parser::new()
        .parse_section_buffer(bytes, TypedPath::derive("Writer Test.one"))
        .unwrap_or_else(|e| panic!("onenote_parser rejects the file: {e}"));
    let warnings: Vec<&str> = section
        .report()
        .warnings()
        .iter()
        .map(|w| w.message())
        .collect();
    assert!(warnings.is_empty(), "{warnings:?}");
    section
}

fn pages(s: &Section) -> Vec<&Page> {
    s.page_series().iter().flat_map(|ps| ps.pages()).collect()
}

fn elements(items: &[OutlineItem]) -> Vec<&OutlineElement> {
    let mut out = Vec::new();
    fn walk<'a>(items: &'a [OutlineItem], out: &mut Vec<&'a OutlineElement>) {
        for i in items {
            match i {
                OutlineItem::Element(e) => {
                    out.push(e);
                    walk(e.children(), out);
                }
                OutlineItem::Group(g) => walk(g.outlines(), out),
            }
        }
    }
    walk(items, &mut out);
    out
}

fn texts(page: &Page) -> Vec<&RichText> {
    page.contents()
        .iter()
        .filter_map(PageContent::outline)
        .flat_map(|o| elements(o.items()))
        .flat_map(|e| e.contents())
        .filter_map(Content::rich_text)
        .collect()
}

fn bytes_of(mut r: Box<dyn Read>) -> Vec<u8> {
    let mut v = Vec::new();
    r.read_to_end(&mut v).unwrap();
    v
}

#[test]
fn reads_section_pages_titles_and_text() {
    let bytes = onenote_writer::write_section(&sample()).unwrap();
    let s = parse(&bytes);
    assert_eq!(s.display_name(), "Writer Test");
    let c = s.color().expect("section color");
    assert_eq!((c.r(), c.g(), c.b(), c.alpha()), (0xc4, 0x6a, 0x2f, 255));
    // Two series: [Welcome, Sub page], [Third, untitled].
    assert_eq!(s.page_series().len(), 2);
    let ps = pages(&s);
    let titles: Vec<Option<&str>> = ps.iter().map(|p| p.title_text()).collect();
    assert_eq!(
        &titles[..3],
        [Some("Welcome page"), Some("Sub page"), Some("Third")]
    );
    let levels: Vec<i32> = ps.iter().map(|p| p.level()).collect();
    assert_eq!(levels, [1, 2, 1, 3]);
    assert_eq!(ps[0].author(), Some("Ada Lovelace"));
    assert_eq!(ps[0].created_time().unix_timestamp(), 1_790_847_000); // 2026-10-01T09:30Z
    assert_eq!(ps[0].updated_time().unix_timestamp(), 1_790_941_510); // 2026-10-02T11:45:10Z

    let t: Vec<&str> = texts(ps[0]).iter().map(|t| t.text()).collect();
    assert_eq!(t[0], "Heading One");
    assert!(t.contains(&"Side note"));
    assert!(t.contains(&"x=(-b±√(b^2-4ac))/2a"));
    let fmt = texts(ps[0])
        .into_iter()
        .find(|t| t.text().contains("Plain"))
        .unwrap();
    assert!(fmt.text().contains("bold italic under strike"));
    let links = fmt.hyperlinks();
    assert_eq!(links.len(), 1);
    assert_eq!(links[0].target(), "https://example.com/a?b=1");
    let visible: String = String::from_utf16_lossy(
        &fmt.text().encode_utf16().collect::<Vec<_>>()
            [links[0].start() as usize..links[0].end() as usize],
    );
    assert_eq!(visible, "a link");
    assert!(fmt.text_run_formatting().iter().any(|s| s.bold()));
    assert!(fmt
        .text_run_formatting()
        .iter()
        .any(|s| s.font() == Some("Arial") && s.font_size() == Some(28)));
    assert_eq!(fmt.paragraph_style().style_id(), Some("p"));
    let heading = texts(ps[0])[0];
    assert_eq!(heading.paragraph_style().style_id(), Some("h1"));
}

#[test]
fn reads_lists_tags_tables() {
    let bytes = onenote_writer::write_section(&sample()).unwrap();
    let s = parse(&bytes);
    let page = pages(&s)[0];
    let outline = page
        .contents()
        .iter()
        .find_map(PageContent::outline)
        .unwrap();
    let els = elements(outline.items());
    let with_text = |want: &str| {
        els.iter()
            .find(|e| {
                e.contents()
                    .iter()
                    .any(|c| c.rich_text().is_some_and(|t| t.text() == want))
            })
            .unwrap_or_else(|| panic!("{want}"))
    };
    let bullet = with_text("Bullet one");
    assert_eq!(bullet.list_contents()[0].list_format(), ['•']);
    assert_eq!(bullet.children().len(), 1);
    let numbered = with_text("Numbered three");
    assert_eq!(
        numbered.list_contents()[0].list_format(),
        ['\u{fffd}', '\0', '.']
    );
    assert_eq!(numbered.list_contents()[0].list_restart(), Some(3));

    let tags = |want: &str| {
        with_text(want).contents()[0]
            .rich_text()
            .unwrap()
            .note_tags()
            .to_vec()
    };
    let done = tags("Done task");
    assert_eq!(done[0].definition().unwrap().label(), "To Do");
    assert!(done[0].item_status().completed());
    let open = tags("Open task");
    assert_eq!(open.len(), 2);
    assert_eq!(open[0].definition().unwrap().label(), "To Do");
    assert!(!open[0].item_status().completed());
    // "Important" cannot be checked, so it is stored as completed. (onenote_parser
    // resolves every state of a NoteTagStates array against the first state's
    // object ids, so it reports the second definition as "To Do"; onenote-re
    // reads "Important", see roundtrip.rs.)
    assert!(open[1].item_status().completed());

    let table = els
        .iter()
        .flat_map(|e| e.contents())
        .find_map(Content::table)
        .unwrap();
    assert_eq!((table.rows(), table.cols()), (2, 2));
    assert_eq!(table.col_widths(), [100.0 / 36.0, 150.0 / 36.0]);
    assert!(!table.borders_visible());
    let cell = |r: usize, c: usize| {
        table.contents()[r].contents()[c].contents()[0].contents()[0]
            .rich_text()
            .unwrap()
            .text()
            .to_string()
    };
    assert_eq!(
        [cell(0, 0), cell(0, 1), cell(1, 0), cell(1, 1)],
        ["A1", "B1", "A2", ""]
    );
}

#[test]
fn reads_pictures_attachments_and_ink() {
    let bytes = onenote_writer::write_section(&sample()).unwrap();
    let s = parse(&bytes);
    let page = pages(&s)[0];
    let outline = page
        .contents()
        .iter()
        .find_map(PageContent::outline)
        .unwrap();
    let els = elements(outline.items());
    let images: Vec<&Image> = els
        .iter()
        .flat_map(|e| e.contents())
        .filter_map(Content::image)
        .collect();
    assert_eq!(images.len(), 3);
    assert_eq!(bytes_of(images[0].read().unwrap()), png_bytes());
    assert_eq!(images[0].alt_text(), Some("A dot"));
    assert_eq!(images[0].image_filename(), Some("dot.png"));
    assert_eq!(images[0].extension(), None); // onenote_parser looks for it on the container's properties
    assert_eq!(images[0].layout_max_width(), Some(120.0 / 36.0));
    assert_eq!(bytes_of(images[1].read().unwrap()), big_png_like(4096, 7));

    let file: &EmbeddedFile = els
        .iter()
        .flat_map(|e| e.contents())
        .find_map(Content::embedded_file)
        .unwrap();
    assert_eq!(file.filename(), "notes.pdf");
    assert_eq!(bytes_of(file.read()), ATTACHMENT);

    let floating = page.contents().iter().find_map(PageContent::image).unwrap();
    assert_eq!(floating.offset_horizontal(), Some(400.0 / 36.0));
    assert_eq!(bytes_of(floating.read().unwrap()), png_bytes());

    let ink = page.contents().iter().find_map(PageContent::ink).unwrap();
    let strokes = ink.ink_strokes();
    assert_eq!(strokes.len(), 2);
    assert_eq!(strokes[0].path().len(), 4);
    assert_eq!(strokes[1].path().len(), 2);
    assert_eq!(strokes[0].color(), Some(0x0023_1f1d));
}

#[test]
fn reads_empty_and_odd_sections() {
    for section in [
        json!({ "id": "empty", "name": "Empty", "pages": [] }),
        json!({ "id": "blank", "name": "Blank", "pages": [{ "id": "p", "title": "", "outlines": [], "images": [] }] }),
        json!({}),
    ] {
        let bytes = onenote_writer::write_section(&section).unwrap();
        parse(&bytes);
    }
}
