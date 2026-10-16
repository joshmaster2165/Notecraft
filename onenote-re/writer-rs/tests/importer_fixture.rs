//! Equations for Notecraft's importer test (`notecraft/src/model/importOne.test.ts`).
//!
//! Writes a section of equations with this writer, reads it back with
//! `onenote-re`, and keeps both in `notecraft/src/model/fixtures/`:
//! `onenote-equations.one` (the file) and `onenote-equations.json`
//! (`onenote-re`'s JSON, as `onenote-parse` prints it). The TypeScript test
//! runs the importer on that JSON, so the round trip is
//! writer → onenote-re → importOne. The fixtures are rewritten whenever the
//! output changes; rerun `npm test` in `notecraft/` afterwards.

use std::path::PathBuf;

use onenote_re::notebook::{ContentBlock, PageBlock};
use onenote_re::{parse_one_note, ConvertOptions};
use serde_json::json;

/// The equations, as Notecraft's equation editor writes them (UnicodeMath).
/// importOne.test.ts lists what each comes back as.
pub const EQUATIONS: &[&str] = &[
    "(a+b)/c",
    "x=(-b±√(b^2-4ac))/2a",
    "x_i^2",
    "√(5&y)",
    "∑_(i=1)^n i^2",
    "■(a&b@c&d)",
    "█(x+y=1@x-y=0)",
    "x\u{0302}+¯y",
    "lim┬(n→∞) a_n",
    "sin^2 x+cos^2 x=1",
    "e^(iπ)+1=0",
    "log_2 x",
    "∫_0^1 f(x)dx",
];

fn fixtures() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../notecraft/src/model/fixtures")
}

/// Write `bytes` to `name` unless it already holds them.
fn refresh(name: &str, bytes: &[u8]) {
    let path = fixtures().join(name);
    if std::fs::read(&path).ok().as_deref() == Some(bytes) {
        return;
    }
    std::fs::create_dir_all(fixtures()).expect("fixtures folder");
    std::fs::write(&path, bytes).expect("write the fixture");
    eprintln!("updated {}", path.display());
}

#[test]
fn equations_fixture_for_the_importer() {
    let elements: Vec<_> = EQUATIONS
        .iter()
        .enumerate()
        .map(|(i, linear)| json!({ "id": format!("m{i}"), "kind": "math", "depth": 0, "linear": linear }))
        .collect();
    let section = json!({
        "id": "equations", "name": "Equations", "createdAt": "2026-10-16T09:00:00.000Z",
        "pages": [{ "id": "p", "title": "Equations", "createdAt": "2026-10-16T09:00:00.000Z",
            "modifiedAt": "2026-10-16T09:00:00.000Z",
            "outlines": [{ "id": "o", "x": 54, "y": 90, "width": 500, "elements": elements }] }]
    });
    let bytes = onenote_writer::write_section(&section).expect("the writer writes the section");
    let json = parse_one_note(&bytes, ConvertOptions::default()).expect("onenote-re reads it");
    assert!(
        json.diagnostics.warnings.is_empty(),
        "{:?}",
        json.diagnostics.warnings
    );

    // One paragraph per equation, each with built-up objects whose MathData_*
    // onenote-re now reads from TextRunData.
    let blocks: Vec<_> = json.section.pages[0]
        .blocks
        .iter()
        .filter_map(|b| match b {
            PageBlock::Outline(o) => Some(o),
            _ => None,
        })
        .flat_map(|o| &o.children)
        .filter_map(|e| match e.content.first() {
            Some(ContentBlock::RichText(t)) => Some(t),
            _ => None,
        })
        .collect();
    assert_eq!(blocks.len(), EQUATIONS.len());
    for (block, linear) in blocks.iter().zip(EQUATIONS) {
        assert!(
            block.runs.iter().all(|r| r.style.math == Some(true)),
            "{linear}"
        );
        let starts = block.text.matches('\u{FDD0}').count();
        let objects = block
            .runs
            .iter()
            .filter(|r| r.style.math_object.is_some())
            .count();
        assert_eq!(
            starts, objects,
            "{linear}: every object start has its MathData"
        );
        assert!(starts > 0, "{linear} is built up");
    }

    refresh("onenote-equations.one", &bytes);
    let text = onenote_re::json::to_string_pretty(&json).unwrap() + "\n";
    refresh("onenote-equations.json", text.as_bytes());
}
