#![recursion_limit = "512"]
//! Equations: write them as OneNote's built-up math objects, read the file
//! back with `onenote-re`, turn the runs into UnicodeMath the way Notecraft's
//! importer does (`buildDown` / `mathObjectLinear` in
//! `notecraft/src/model/importOne.ts`, ported below), and check that every
//! equation comes back equivalent: it parses to the same tree, up to
//! grouping parentheses.
//!
//! The objects' `MathData_*` are read from where OneNote keeps them, each
//! run's element of the paragraph's `TextRunData` (`file-format.md` §15.4),
//! through `onenote-re`'s revision store reader.

use std::collections::HashMap;

use onenote_parser::Parser;
use onenote_re::notebook::{ContentBlock, PageBlock, RichTextBlock, TextRun};
use onenote_re::onestore::PropertyValue;
use onenote_re::{parse_one_note, ConvertOptions, OneStore};
use serde_json::{json, Value};
use typed_path::TypedPath;

#[path = "../src/math.rs"]
#[allow(dead_code)]
mod writer_math;

// --- the importer's decoding, ported from importOne.ts ---------------------------

const MATH_START: u16 = 0xFDD0;
const MATH_SEPARATOR: u16 = 0xFDEE;
const MATH_END: u16 = 0xFDEF;

fn strip_structure(s: &str) -> String {
    s.chars()
        .filter(|c| !matches!(c, '\u{FDD0}' | '\u{FDEE}' | '\u{FDEF}'))
        .collect()
}

fn is_number(t: &str) -> bool {
    let mut parts = t.splitn(2, '.');
    let int = parts.next().unwrap_or("");
    let frac = parts.next();
    !int.is_empty()
        && int.bytes().all(|b| b.is_ascii_digit())
        && frac.is_none_or(|f| !f.is_empty() && f.bytes().all(|b| b.is_ascii_digit()))
}

const FUNCTION_NAMES: &[&str] = &["sin", "cos", "tan", "cot", "sec", "csc", "log", "ln", "exp", "lim", "max", "min", "det", "sinh", "cosh", "tanh", "arg", "gcd", "Pr"];

fn operand(s: &str) -> String {
    let t = s.trim();
    if t.is_empty() || t.chars().count() == 1 || is_number(t) || FUNCTION_NAMES.contains(&t) {
        return t.to_string();
    }
    if t.starts_with('(') && t.ends_with(')') {
        let units: Vec<u16> = t.encode_utf16().collect();
        let mut depth = 0i32;
        let mut closes_at_end = true;
        for (k, &u) in units.iter().enumerate() {
            if u == u16::from(b'(') {
                depth += 1;
            } else if u == u16::from(b')') {
                depth -= 1;
                if depth == 0 && k < units.len() - 1 {
                    closes_at_end = false;
                }
            }
        }
        if closes_at_end && depth == 0 {
            return t.to_string();
        }
    }
    format!("({t})")
}

/// A function argument or n-ary operand: bare when it is one element, in
/// parentheses when it has an operator or a space outside brackets (importOne.ts `element`).
fn element(s: &str) -> String {
    let t = s.trim();
    let mut depth = 0i32;
    for ch in t.chars() {
        if "([{⟨".contains(ch) {
            depth += 1;
        } else if ")]}⟩".contains(ch) {
            depth -= 1;
        } else if depth == 0 && (ch.is_whitespace() || "+-−=±∓<>≤≥≠,/".contains(ch)) {
            return operand(t);
        }
    }
    t.to_string()
}

fn chr(code: Option<u32>, fallback: &str) -> String {
    match code {
        Some(c) if c != 0 => String::from_utf16_lossy(&[c as u16]),
        _ => fallback.to_string(),
    }
}

/// The `MathData_*` of one object (the importer's `MathObject`).
#[derive(Debug, Clone, Default, PartialEq)]
struct MathObject {
    r#type: u32,
    args: Option<u32>,
    char: Option<u32>,
    char1: Option<u32>,
    char2: Option<u32>,
    columns: Option<u32>,
}

fn math_object_linear(o: &MathObject, a: &[String]) -> Option<String> {
    let get = |k: usize| a.get(k).map(String::as_str).unwrap_or("");
    let (a0, a1, a2) = (get(0), get(1), get(2));
    let scripts = |sub: &str, sup: &str| {
        let mut s = String::new();
        if !sub.trim().is_empty() {
            s += &format!("_{}", operand(sub));
        }
        if !sup.trim().is_empty() {
            s += &format!("^{}", operand(sup));
        }
        s
    };
    Some(match o.r#type {
        10 => format!("{}{}", operand(a0), chr(o.char, "\u{0302}")),
        11 => format!("□{}", operand(a0)),
        12 => format!("▭({})", a0.trim()),
        13 => format!("{}{}{}", chr(o.char, "("), a0.trim(), chr(o.char1, ")")),
        14 => format!(
            "{}{}{}",
            chr(o.char, "("),
            a.iter()
                .map(|x| x.trim())
                .collect::<Vec<_>>()
                .join(&chr(o.char2, "│")),
            chr(o.char1, ")")
        ),
        15 => format!(
            "█({})",
            a.iter().map(|x| x.trim()).collect::<Vec<_>>().join("@")
        ),
        16 => {
            let op = match o.char.map(|c| String::from_utf16_lossy(&[c as u16])) {
                Some(c) if "⁄∕¦".contains(c.as_str()) && !c.is_empty() => c,
                _ => "/".to_string(),
            };
            format!("{}{op}{}", operand(a0), operand(a1))
        }
        17 => {
            // The engine would read U+2061 into a limit (lim┬(n→∞)), so a space follows those.
            let name = a0.trim();
            format!("{name}{}{}", if name.contains(['┬', '┴']) { " " } else { "\u{2061}" }, element(a1))
        }
        18 => format!("({}){}", scripts(a0, a1), operand(a2)),
        19 => format!("{}┬{}", operand(a0), operand(a1)),
        20 => {
            let cols = match o.columns {
                Some(c) if c > 0 => c as usize,
                _ => a.len().max(1),
            };
            let rows: Vec<String> = a
                .chunks(cols)
                .map(|r| r.iter().map(|x| x.trim()).collect::<Vec<_>>().join("&"))
                .collect();
            format!("■({})", rows.join("@"))
        }
        21 => {
            let body = a2.trim();
            format!(
                "{}{}{}",
                chr(o.char, "∫"),
                scripts(a0, a1),
                if body.is_empty() {
                    String::new()
                } else {
                    format!(" {}", element(body))
                }
            )
        }
        22 => format!("{}{}", chr(o.char, ""), a.join("")),
        23 => format!("¯{}", operand(a0)),
        24 => format!("⟡{}", operand(a0)),
        25 => {
            if a.len() < 2 {
                return Some(format!("√{}", operand(a0)));
            }
            match a0.trim() {
                "" => format!("√{}", operand(a1)),
                "3" => format!("∛{}", operand(a1)),
                "4" => format!("∜{}", operand(a1)),
                degree => format!("√({degree}&{})", a1.trim()),
            }
        }
        26 => format!("{}⁄{}", operand(a0), operand(a1)),
        27 => format!("{}¦{}", operand(a0), operand(a1)),
        28 => format!("{}{}", chr(o.char, "⏟"), operand(a0)),
        29 => format!("{}{}", operand(a0), scripts(a1, "")),
        30 => format!("{}{}", operand(a0), scripts(a1, a2)),
        31 => format!("{}{}", operand(a0), scripts("", a1)),
        32 => format!("▁{}", operand(a0)),
        33 => format!("{}┴{}", operand(a0), operand(a1)),
        _ => return None,
    })
}

/// buildDown: RichEdit's built-up math → UnicodeMath; false when an object
/// had to fall back to its visible text.
fn build_down(text: &[u16], objects: &HashMap<usize, MathObject>) -> (String, bool) {
    struct S<'a> {
        text: &'a [u16],
        objects: &'a HashMap<usize, MathObject>,
        i: usize,
        decoded: bool,
    }
    impl S<'_> {
        fn seq(&mut self) -> String {
            let mut out: Vec<u16> = Vec::new();
            while self.i < self.text.len() {
                let c = self.text[self.i];
                if c == MATH_SEPARATOR || c == MATH_END {
                    break;
                }
                if c != MATH_START {
                    out.push(c);
                    self.i += 1;
                    continue;
                }
                let obj = self.objects.get(&self.i).cloned();
                self.i += 1;
                let mut args: Vec<String> = Vec::new();
                loop {
                    args.push(self.seq());
                    if self.text.get(self.i) == Some(&MATH_SEPARATOR) {
                        self.i += 1;
                        continue;
                    }
                    if self.text.get(self.i) == Some(&MATH_END) {
                        self.i += 1;
                    }
                    break;
                }
                let built = obj.and_then(|o| math_object_linear(&o, &args));
                if built.is_none() {
                    self.decoded = false;
                }
                let s = built.unwrap_or_else(|| {
                    args.iter()
                        .map(|a| strip_structure(a))
                        .filter(|a| !a.trim().is_empty())
                        .collect::<Vec<_>>()
                        .join(" ")
                });
                out.extend(s.encode_utf16());
            }
            String::from_utf16_lossy(&out)
        }
    }
    let mut s = S {
        text,
        objects,
        i: 0,
        decoded: true,
    };
    let mut linear = String::new();
    while s.i < text.len() {
        linear += &s.seq();
        if s.i < text.len() {
            s.i += 1;
        }
    }
    (strip_structure(&linear).trim().to_string(), s.decoded)
}

/// mathOf for a paragraph whose runs are all math: its UnicodeMath. `data`
/// is the paragraph's TextRunData, one entry per run.
fn decode(block: &RichTextBlock, data: &[Option<MathObject>]) -> (String, bool) {
    assert!(
        block.runs.iter().all(|r| r.style.math == Some(true)),
        "every run of an equation is math"
    );
    assert_eq!(
        data.len(),
        block.runs.len(),
        "a TextRunData element per run"
    );
    let units: Vec<u16> = block.text.encode_utf16().collect();
    let mut objects = HashMap::new();
    for (r, d) in block.runs.iter().zip(data) {
        for (k, &u) in units.iter().enumerate().take(r.end).skip(r.start) {
            if u == MATH_START {
                if let Some(o) = d {
                    objects.insert(k, o.clone());
                }
            }
        }
    }
    build_down(&units, &objects)
}

/// Each run's MathData (None for an empty element) of a paragraph's
/// TextRunData.
type RunData = Vec<Option<MathObject>>;

/// TextRunData of every RichTextOENode, in declaration order (the order of
/// the page's content), with the node's text. Nodes without TextRunData are
/// left out.
fn run_data(bytes: &[u8]) -> Vec<(String, RunData)> {
    let store = OneStore::new(bytes).unwrap();
    let mut out = Vec::new();
    for space in store.object_spaces.values() {
        for rev in space.revisions.values() {
            for decl in rev.objects.values() {
                if decl.jcid.raw != 0x0006_000e {
                    continue;
                }
                let Some(set) = store.property_set(decl) else {
                    continue;
                };
                let get = |prid: u32| set.properties.iter().find(|p| p.prid & 0x7fff_ffff == prid);
                let text = match get(0x1c00_1c22).map(|p| &p.value) {
                    Some(PropertyValue::Bytes(b)) => {
                        let units: Vec<u16> = b
                            .as_chunks::<2>()
                            .0
                            .iter()
                            .map(|c| u16::from_le_bytes(*c))
                            .take_while(|&u| u != 0)
                            .collect();
                        String::from_utf16_lossy(&units)
                    }
                    _ => String::new(),
                };
                let Some(PropertyValue::PropertyValues { sets, .. }) =
                    get(0x4000_3499).map(|p| &p.value)
                else {
                    continue;
                };
                let data = sets
                    .iter()
                    .map(|s| {
                        let num = |prid: u32| {
                            s.properties.iter().find(|p| p.prid == prid).and_then(|p| {
                                match &p.value {
                                    PropertyValue::Bytes(b) => {
                                        let mut v = [0u8; 4];
                                        v[..b.len().min(4)].copy_from_slice(&b[..b.len().min(4)]);
                                        Some(u32::from_le_bytes(v))
                                    }
                                    _ => None,
                                }
                            })
                        };
                        num(0x1400_344f).map(|ty| MathObject {
                            r#type: ty,
                            args: num(0x1400_3450),
                            char: num(0x1000_3453),
                            char1: num(0x1000_3454),
                            char2: num(0x1000_3455),
                            columns: num(0x0c00_3451),
                        })
                    })
                    .collect();
                out.push((text, data));
            }
        }
    }
    out
}

// --- the test ------------------------------------------------------------------------

/// (written, what the importer reads back)
const EQUATIONS: &[(&str, &str)] = &[
    ("a/b", "a/b"),
    ("x=(-b±√(b^2-4ac))/2a", "x=(−b±√(b^2−4ac))/(2a)"),
    ("∑_(i=1)^n i^2", "∑_(i=1)^n i^2"),
    ("∫_0^1 f(x)dx", "∫_0^1 f(x)dx"),
    // Function names stay bare; a limit is followed by a space, not U+2061.
    ("sin^2 x+cos^2 x=1", "sin^2\u{2061}x+cos^2\u{2061}x=1"),
    ("lim┬(n→∞) a_n", "lim┬(n→∞) a_n"),
    ("sin x", "sin\u{2061}x"),
    ("■(a&b@c&d)", "■(a&b@c&d)"),
    ("█(x+y=1@x-y=0)", "█(x+y=1@x−y=0)"),
    ("√(3&x)+√(5&y)", "∛x+√(5&y)"),
    ("x\u{0302}+¯y+▁z", "x\u{0302}+¯y+▁z"),
    ("▭(E=mc^2)", "▭(E=mc^2)"),
    ("n¦k+⟡x", "n¦k+⟡x"),
    ("⏟(a+b)+a┴b", "⏟(a+b)+a┴b"),
    ("|x|+[y]+⟨z⟩", "|x|+[y]+⟨z⟩"),
    ("e^(iπ)+1=0", "e^(iπ)+1=0"),
    ("x_i^2", "x_i^2"),
    ("\\frac{1}{2}+\\alpha", "1/2+α"),
    ("\"speed\"=d/t", "\"speed\"=d/t"),
];

fn section() -> Value {
    let elements: Vec<Value> = EQUATIONS
        .iter()
        .enumerate()
        .map(|(i, (linear, _))| json!({ "id": format!("m{i}"), "kind": "math", "depth": 0, "linear": linear }))
        .collect();
    json!({
        "id": "math", "name": "Math",
        "pages": [{ "id": "p", "title": "Equations",
            "outlines": [{ "id": "o", "x": 54, "y": 90, "width": 500, "elements": elements }] }]
    })
}

fn equations(bytes: &[u8]) -> Vec<RichTextBlock> {
    let json = parse_one_note(bytes, ConvertOptions::default()).unwrap();
    assert!(
        json.diagnostics.warnings.is_empty(),
        "{:?}",
        json.diagnostics.warnings
    );
    let page = &json.section.pages[0];
    page.blocks
        .iter()
        .filter_map(|b| match b {
            PageBlock::Outline(o) => Some(o),
            _ => None,
        })
        .flat_map(|o| o.children.iter())
        .filter_map(|e| match e.content.first() {
            Some(ContentBlock::RichText(t)) => Some(t.clone()),
            _ => None,
        })
        .collect()
}

#[test]
fn equations_come_back_equivalent() {
    let bytes = onenote_writer::write_section(&section()).unwrap();
    let blocks = equations(&bytes);
    let data = block_data(&blocks, &bytes);
    assert_eq!(blocks.len(), EQUATIONS.len());
    for ((block, d), (written, expected)) in blocks.iter().zip(&data).zip(EQUATIONS) {
        let (linear, decoded) = decode(block, d);
        assert!(decoded, "{written}: an object was not decoded");
        assert_eq!(&linear, expected, "{written}");
        assert!(
            writer_math::equivalent(written, &linear),
            "{written} came back as {linear}"
        );
        assert!(
            block.text.contains('\u{FDD0}') || !written.contains(['/', '^', '_', '√']),
            "{written} is built up"
        );
        for r in &block.runs {
            assert_eq!(r.style.font.as_deref(), Some("Cambria Math"), "{written}");
        }
    }
}

/// The TextRunData of each block: the store's paragraphs are matched to
/// the blocks in order (several equations share a text, since an object's
/// characters live in its MathData).
fn block_data(blocks: &[RichTextBlock], bytes: &[u8]) -> Vec<RunData> {
    let mut nodes = run_data(bytes).into_iter();
    blocks
        .iter()
        .map(|b| {
            nodes
                .by_ref()
                .find(|(text, _)| *text == b.text)
                .map(|(_, d)| d)
                .unwrap_or_default()
        })
        .collect()
}

/// The runs that start a math object, with the object.
fn objects<'b>(block: &'b RichTextBlock, d: &'b RunData) -> Vec<(&'b TextRun, &'b MathObject)> {
    block
        .runs
        .iter()
        .zip(d)
        .filter_map(|(r, o)| o.as_ref().map(|o| (r, o)))
        .collect()
}

#[test]
fn objects_carry_their_math_data() {
    let bytes = onenote_writer::write_section(&section()).unwrap();
    let all = equations(&bytes);
    let data = block_data(&all, &bytes);
    let at = |written: &str| EQUATIONS.iter().position(|(w, _)| *w == written).unwrap();
    let block = |written: &str| &all[at(written)];

    // a/b: one fraction of two arguments, its U+FDD0 a run of its own.
    let frac = objects(block("a/b"), &data[at("a/b")]);
    assert_eq!(frac.len(), 1);
    let (run, o) = frac[0];
    assert_eq!((o.r#type, o.args), (16, Some(2)));
    assert_eq!(run.text, "\u{FDD0}");
    assert_eq!(
        block("a/b").text,
        "\u{FDD0}a\u{FDEE}b\u{FDEF}",
        "numerator, separator, denominator, end"
    );

    // ∑: the operator character, three arguments.
    let (_, nary) = objects(block("∑_(i=1)^n i^2"), &data[at("∑_(i=1)^n i^2")])[0];
    assert_eq!(
        (nary.r#type, nary.args, nary.char),
        (21, Some(3), Some('∑' as u32))
    );

    // ■: cells row by row, two columns.
    let (_, matrix) = objects(block("■(a&b@c&d)"), &data[at("■(a&b@c&d)")])[0];
    assert_eq!(
        (matrix.r#type, matrix.args, matrix.columns),
        (20, Some(4), Some(2))
    );

    // |x|, [y], ⟨z⟩: brackets with both characters.
    let brackets: Vec<(Option<u32>, Option<u32>)> =
        objects(block("|x|+[y]+⟨z⟩"), &data[at("|x|+[y]+⟨z⟩")])
            .iter()
            .map(|(_, o)| (o.char, o.char1))
            .collect();
    assert_eq!(
        brackets,
        [
            (Some('|' as u32), Some('|' as u32)),
            (Some('[' as u32), Some(']' as u32)),
            (Some('⟨' as u32), Some('⟩' as u32)),
        ]
    );

    // The accent's combining character.
    let accent = objects(block("x\u{0302}+¯y+▁z"), &data[at("x\u{0302}+¯y+▁z")])
        .into_iter()
        .find(|(_, o)| o.r#type == 10)
        .unwrap()
        .1;
    assert_eq!(accent.char, Some(0x0302));
}

#[test]
fn unknown_constructs_stay_linear_text() {
    let section = json!({
        "id": "m2", "name": "Math",
        "pages": [{ "id": "p", "title": "Plain",
            "outlines": [{ "id": "o", "x": 54, "y": 90, "width": 500, "elements": [
                { "id": "a", "kind": "math", "depth": 0, "linear": "\\unknown+x" },
                { "id": "b", "kind": "math", "depth": 0, "linear": "" }
            ] }] }]
    });
    let bytes = onenote_writer::write_section(&section).unwrap();
    let blocks = equations(&bytes);
    assert_eq!(blocks[0].text, "\\unknown+x");
    assert!(
        run_data(&bytes).is_empty(),
        "no TextRunData without objects"
    );
    assert_eq!(blocks[1].text, "");
}

#[test]
fn independent_reader_accepts_equations() {
    let bytes = onenote_writer::write_section(&section()).unwrap();
    let parsed = Parser::new()
        .parse_section_buffer(&bytes, TypedPath::derive("Math.one"))
        .unwrap_or_else(|e| panic!("onenote_parser rejects the file: {e}"));
    let warnings: Vec<&str> = parsed
        .report()
        .warnings()
        .iter()
        .map(|w| w.message())
        .collect();
    assert!(warnings.is_empty(), "{warnings:?}");
    let page = &parsed.page_series()[0].pages()[0];
    let outline = page.contents()[0].outline().unwrap();
    let texts: Vec<String> = outline
        .items()
        .iter()
        .filter_map(|i| i.element())
        .filter_map(|e| e.contents().first()?.rich_text())
        .map(|t| t.text().to_string())
        .collect();
    assert_eq!(texts.len(), EQUATIONS.len());
    assert_eq!(texts[0], "\u{FDD0}a\u{FDEE}b\u{FDEF}");
}
