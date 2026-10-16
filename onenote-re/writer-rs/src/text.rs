//! Rich text, lists and note tags.
//!
//! - RichTextOENode ([MS-ONE] §2.2.23): `RichEditTextUnicode`, run ends in
//!   `TextRunIndex` (one fewer than the runs), one `ParagraphStyleObjectForText`
//!   per run in `TextRunFormatting`, and the paragraph's `ParagraphStyle`, a
//!   `ParagraphStyleObject` named by `ParagraphStyleId` ("p", "h1"…,
//!   "blockquote", "code", "cite") with OneNote's built-in formatting.
//! - Hyperlinks are a hidden field code in the text, `U+FDDF HYPERLINK "url"`,
//!   in its own run (Hyperlink + Hidden + HyperlinkProtected), followed by the
//!   display text (Hyperlink + HyperlinkProtected), as OneNote writes them.
//! - Equations: the UnicodeMath linear form in a run with `MathFormatting`
//!   (0x08003401). OneNote's built-up math objects (`TextRunData`) are not
//!   written.
//! - NumberListNode (§2.2.25): `NumberListFormat` is length-prefixed; a
//!   numbered format holds U+FFFD and an MSONFC scheme code.
//! - Note tags: `NoteTagStates` (§2.2.88) on the content node, each pointing
//!   at a shared `NoteTagSharedDefinitionContainer` (§2.2.41).

use crate::model::{Align, ListStyle, Paragraph, Run, Tag};
use crate::page::{align, half_inches, PageWriter, TitleText};
use crate::propset::{ObjIdx, PropSet, Value};
use crate::schema::{jcid, prop, COLOR_AUTO, LCID_EN_US};

/// Text a property may hold: no NUL, no line feeds (a soft break is U+000B,
/// [MS-ONE] §2.2.23), no stray field-code markers. UTF-16.
pub(crate) fn clean_text(s: &str) -> Vec<u16> {
    let s = s.replace("\r\n", "\u{b}");
    s.chars()
        .filter(|&c| c != '\0')
        .map(|c| match c {
            '\n' | '\r' => '\u{b}',
            '\u{fddf}' => '\u{fffd}',
            c => c,
        })
        .collect::<String>()
        .encode_utf16()
        .collect()
}

/// A single line (titles, names): breaks become spaces.
pub(crate) fn clean_line(s: &str) -> String {
    s.chars()
        .filter(|&c| c != '\0')
        .map(|c| {
            if matches!(c, '\n' | '\r' | '\u{b}') {
                ' '
            } else {
                c
            }
        })
        .collect::<String>()
        .trim()
        .to_string()
}

fn wz_units(units: &[u16]) -> Vec<u8> {
    let mut b: Vec<u8> = units.iter().flat_map(|u| u.to_le_bytes()).collect();
    b.extend_from_slice(&[0, 0]);
    b
}

/// OneNote's built-in paragraph styles (as found in its files).
struct Builtin {
    id: &'static str,
    font: &'static str,
    /// Half-points.
    size: u16,
    color: u32,
    italic: bool,
}

const BUILTIN: &[Builtin] = &[
    Builtin {
        id: "p",
        font: "Calibri",
        size: 22,
        color: COLOR_AUTO,
        italic: false,
    },
    Builtin {
        id: "h1",
        font: "Calibri",
        size: 32,
        color: 0x0079_4e1e,
        italic: false,
    },
    Builtin {
        id: "h2",
        font: "Calibri",
        size: 28,
        color: 0x00b5_752e,
        italic: false,
    },
    Builtin {
        id: "h3",
        font: "Calibri",
        size: 24,
        color: 0x0063_371f,
        italic: false,
    },
    Builtin {
        id: "h4",
        font: "Calibri",
        size: 24,
        color: 0x0096_542f,
        italic: true,
    },
    Builtin {
        id: "h5",
        font: "Calibri",
        size: 22,
        color: 0x00b5_752e,
        italic: false,
    },
    Builtin {
        id: "h6",
        font: "Calibri",
        size: 22,
        color: 0x00b5_752e,
        italic: true,
    },
    Builtin {
        id: "blockquote",
        font: "Calibri",
        size: 22,
        color: 0x0059_5959,
        italic: true,
    },
    Builtin {
        id: "code",
        font: "Consolas",
        size: 22,
        color: COLOR_AUTO,
        italic: false,
    },
    Builtin {
        id: "cite",
        font: "Calibri",
        size: 18,
        color: 0x0059_5959,
        italic: false,
    },
    Builtin {
        id: "PageTitle",
        font: "Calibri Light",
        size: 40,
        color: COLOR_AUTO,
        italic: false,
    },
    Builtin {
        id: "PageDateTime",
        font: "Calibri",
        size: 20,
        color: 0x0076_7676,
        italic: false,
    },
];

/// Notecraft's paragraph style → OneNote's ParagraphStyleId.
pub(crate) fn style_id(style: &str) -> &'static str {
    match style {
        "h1" => "h1",
        "h2" => "h2",
        "h3" => "h3",
        "h4" => "h4",
        "h5" => "h5",
        "h6" => "h6",
        "quote" => "blockquote",
        "code" => "code",
        "cite" => "cite",
        _ => "p",
    }
}

/// FontSize in half-points, within [MS-ONE] §2.3.16's 12–288.
fn font_size(pt: f64) -> u16 {
    (pt * 2.0).round().clamp(12.0, 288.0) as u16
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Link {
    None,
    /// The hidden `HYPERLINK "url"` field code.
    Marker,
    /// Display text of a link.
    Text,
}

struct Piece {
    units: Vec<u16>,
    run: Run,
    link: Link,
}

/// A link target safe inside the field code's quotes.
fn clean_url(url: &str) -> String {
    url.trim()
        .chars()
        .filter(|c| !c.is_control())
        .map(|c| {
            if c == '"' {
                "%22".to_string()
            } else {
                c.to_string()
            }
        })
        .collect()
}

/// Runs as text pieces, with each link's field code in front of its text.
fn pieces(runs: &[Run]) -> Vec<Piece> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < runs.len() {
        let Some(url) = runs[i]
            .href
            .as_deref()
            .map(clean_url)
            .filter(|u| !u.is_empty())
        else {
            let units = clean_text(&runs[i].text);
            if !units.is_empty() {
                out.push(Piece {
                    units,
                    run: runs[i].clone(),
                    link: Link::None,
                });
            }
            i += 1;
            continue;
        };
        let mut j = i;
        while j < runs.len() && runs[j].href == runs[i].href {
            j += 1;
        }
        let display: Vec<Piece> = runs[i..j]
            .iter()
            .map(|r| Piece {
                units: clean_text(&r.text),
                run: r.clone(),
                link: Link::Text,
            })
            .filter(|p| !p.units.is_empty())
            .collect();
        if let Some(first) = display.first() {
            let marker = format!("\u{fddf}HYPERLINK \"{url}\"");
            out.push(Piece {
                units: marker.encode_utf16().collect(),
                run: first.run.clone(),
                link: Link::Marker,
            });
            out.extend(display);
        }
        i = j;
    }
    out
}

impl PageWriter<'_> {
    /// A ParagraphStyleObject for one of OneNote's built-in styles.
    pub(crate) fn paragraph_style(&mut self, id: &str) -> ObjIdx {
        let b = BUILTIN.iter().find(|b| b.id == id).unwrap_or(&BUILTIN[0]);
        let mut p = PropSet::new();
        p.bool(prop::BOLD, false)
            .bool(prop::ITALIC, b.italic)
            .bool(prop::UNDERLINE, false)
            .bool(prop::STRIKETHROUGH, false)
            .bool(prop::SUPERSCRIPT, false)
            .bool(prop::SUBSCRIPT, false)
            .wz(prop::FONT, b.font)
            .u16(prop::FONT_SIZE, b.size)
            .u32(prop::FONT_COLOR, b.color)
            .u32(prop::HIGHLIGHT, COLOR_AUTO)
            .wz(prop::PARAGRAPH_STYLE_ID, b.id)
            .f32(prop::PARAGRAPH_SPACE_BEFORE, 0.0)
            .f32(prop::PARAGRAPH_SPACE_AFTER, 0.0)
            .f32(prop::PARAGRAPH_LINE_SPACING_EXACT, 0.0);
        self.shared(jcid::PARAGRAPH_STYLE_OBJECT, "paragraph-style", p)
    }

    /// A ParagraphStyleObjectForText for one run.
    fn run_style(&mut self, r: &Run, link: Link, math: bool) -> ObjIdx {
        let mut p = PropSet::new();
        for (on, id) in [
            (r.bold, prop::BOLD),
            (r.italic, prop::ITALIC),
            (r.underline, prop::UNDERLINE),
            (r.strike, prop::STRIKETHROUGH),
            (r.sup, prop::SUPERSCRIPT),
            (r.sub && !r.sup, prop::SUBSCRIPT),
        ] {
            if on {
                p.bool(id, true);
            }
        }
        if let Some(f) = &r.font {
            p.wz(prop::FONT, &crate::text::clean_line(f));
        }
        if let Some(s) = r.size {
            p.u16(prop::FONT_SIZE, font_size(s));
        }
        if let Some(c) = r.color {
            p.u32(prop::FONT_COLOR, c.colorref());
        }
        if let Some(c) = r.highlight {
            p.u32(prop::HIGHLIGHT, c.colorref());
        }
        p.u8(prop::CHARSET, 0)
            .u32(prop::LANGUAGE_ID, LCID_EN_US)
            .bool(prop::MATH_FORMATTING, math)
            .bool(prop::HYPERLINK, link != Link::None)
            .bool(prop::HYPERLINK_PROTECTED, link != Link::None)
            .bool(prop::HIDDEN, link == Link::Marker);
        self.shared(jcid::PARAGRAPH_STYLE_OBJECT, "text-style", p)
    }

    /// Text, run index and run styles of a paragraph.
    fn runs_props(&mut self, p: &mut PropSet, runs: &[Run], math: bool) {
        let mut pieces = pieces(runs);
        if math {
            for piece in &mut pieces {
                if piece.run.font.is_none() {
                    piece.run.font = Some("Cambria Math".into());
                }
            }
        }
        if pieces.is_empty() {
            let style = self.run_style(&Run::default(), Link::None, math);
            p.oids(prop::TEXT_RUN_FORMATTING, vec![style]);
            return;
        }
        // Styles per piece; neighbours with the same style become one run.
        let mut text: Vec<u16> = Vec::new();
        let mut ends: Vec<u32> = Vec::new();
        let mut styles: Vec<ObjIdx> = Vec::new();
        let mut last: Option<(ObjIdx, Link)> = None;
        for piece in &pieces {
            let style = self.run_style(&piece.run, piece.link, math);
            let merge = last == Some((style, piece.link)) && piece.link != Link::Marker;
            text.extend_from_slice(&piece.units);
            if merge {
                *ends.last_mut().expect("a run to extend") = text.len() as u32;
            } else {
                ends.push(text.len() as u32);
                styles.push(style);
            }
            last = Some((style, piece.link));
        }
        ends.pop(); // the last run ends with the text
        p.u16(prop::RICH_EDIT_TEXT_LANG_ID, LCID_EN_US as u16)
            .oids(prop::TEXT_RUN_FORMATTING, styles);
        if !ends.is_empty() {
            p.bytes(
                prop::TEXT_RUN_INDEX,
                ends.iter().flat_map(|e| e.to_le_bytes()).collect(),
            );
        }
        p.bytes(prop::RICH_EDIT_TEXT_UNICODE, wz_units(&text));
    }

    /// RichTextOENode for a paragraph.
    pub(crate) fn rich_text(&mut self, key: &str, para: &Paragraph, tags: &[Tag]) -> ObjIdx {
        self.text_node(key, para, tags, false)
    }

    /// An equation: its linear form as math-formatted text.
    pub(crate) fn math(&mut self, key: &str, linear: &str, tags: &[Tag]) -> ObjIdx {
        let para = Paragraph {
            runs: vec![Run {
                text: linear.to_string(),
                ..Run::default()
            }],
            ..Paragraph::empty()
        };
        self.text_node(key, &para, tags, true)
    }

    fn text_node(&mut self, key: &str, para: &Paragraph, tags: &[Tag], math: bool) -> ObjIdx {
        let idx = self.reserve("text", key, jcid::RICH_TEXT_OE_NODE);
        let style = self.paragraph_style(style_id(&para.style));
        let mut p = PropSet::new();
        self.stamp(&mut p);
        p.oid(prop::PARAGRAPH_STYLE, style);
        self.runs_props(&mut p, &para.runs, math);
        let (lha, code) = match para.align {
            Some(Align::Center) => (align::CENTER, Some(1)),
            Some(Align::Right) => (align::RIGHT, Some(2)),
            _ => (align::LEFT, None),
        };
        p.u32(prop::LAYOUT_ALIGNMENT_IN_PARENT, lha)
            .u32(prop::LAYOUT_ALIGNMENT_SELF, lha);
        if let Some(c) = code {
            p.u8(prop::PARAGRAPH_ALIGNMENT, c);
        }
        for (v, id) in [
            (para.space_before, prop::PARAGRAPH_SPACE_BEFORE),
            (para.space_after, prop::PARAGRAPH_SPACE_AFTER),
            (para.line_spacing, prop::PARAGRAPH_LINE_SPACING_EXACT),
        ] {
            if let Some(v) = v {
                p.f32(id, half_inches(v).min(27_777.777));
            }
        }
        if let Some(states) = self.note_tags(tags) {
            p.set(prop::NOTE_TAG_STATES, states);
        }
        self.sp.fill(idx, p);
        idx
    }

    /// The title's text, or its date or time line.
    pub(crate) fn boiler_text(&mut self, text: &str, style: &str, which: TitleText) -> ObjIdx {
        let kind = match which {
            TitleText::Title => "title-text",
            TitleText::Date => "date-text",
            TitleText::Time => "time-text",
        };
        let idx = self.reserve(kind, "", jcid::RICH_TEXT_OE_NODE);
        let style = self.paragraph_style(style);
        let mut p = PropSet::new();
        self.stamp(&mut p);
        if which != TitleText::Title {
            p.bool(prop::LAYOUT_TIGHT_LAYOUT, true);
        }
        p.oid(prop::PARAGRAPH_STYLE, style);
        let run = Run {
            text: clean_line(text),
            ..Run::default()
        };
        self.runs_props(&mut p, std::slice::from_ref(&run), false);
        match which {
            TitleText::Title => {
                p.bool(prop::IS_TITLE_TEXT, true);
            }
            TitleText::Date | TitleText::Time => {
                p.bool(prop::IS_BOILER_TEXT, true)
                    .bool(
                        if which == TitleText::Date {
                            prop::IS_TITLE_DATE
                        } else {
                            prop::IS_TITLE_TIME
                        },
                        true,
                    )
                    .bool(prop::DELETABLE, true)
                    .bool(prop::IS_READ_ONLY, true)
                    .u32(prop::LAYOUT_ALIGNMENT_SELF, align::TITLE);
            }
        }
        self.sp.fill(idx, p);
        idx
    }

    // --- lists -----------------------------------------------------------------------

    /// NumberListNode ([MS-ONE] §2.2.25).
    pub(crate) fn list_node(&mut self, key: &str, l: &ListStyle) -> ObjIdx {
        let mut p = PropSet::new();
        self.stamp(&mut p);
        let keep = |s: &str, max: usize| -> Vec<u16> {
            clean_line(s)
                .replace('\u{fffd}', "")
                .encode_utf16()
                .take(max)
                .collect()
        };
        match l {
            ListStyle::Bullet(glyph) => {
                let mut g = keep(glyph, 4);
                if g.is_empty() {
                    g = vec![0x2022];
                }
                let mut fmt = vec![g.len() as u16];
                fmt.extend(g);
                p.bytes(
                    prop::NUMBER_LIST_FORMAT,
                    fmt.iter().flat_map(|u| u.to_le_bytes()).collect(),
                )
                .u16(prop::FONT_SIZE, 22)
                .u32(prop::FONT_COLOR, COLOR_AUTO)
                .wz(prop::LIST_FONT, "Calibri");
            }
            ListStyle::Numbered {
                scheme,
                prefix,
                suffix,
                start,
            } => {
                let code: u16 = match scheme.as_str() {
                    "upperRoman" => 1,
                    "lowerRoman" => 2,
                    "upperLetter" => 3,
                    "lowerLetter" => 4,
                    _ => 0,
                };
                let mut body = keep(prefix, 16);
                body.push(0xfffd);
                body.push(code);
                body.extend(keep(suffix, 16));
                let mut fmt = vec![body.len() as u16];
                fmt.extend(body);
                p.bytes(
                    prop::NUMBER_LIST_FORMAT,
                    fmt.iter().flat_map(|u| u.to_le_bytes()).collect(),
                )
                .u16(prop::FONT_SIZE, 22)
                .u32(prop::FONT_COLOR, COLOR_AUTO)
                .wz(prop::FONT, "Calibri")
                .bool(prop::BOLD, false)
                .bool(prop::ITALIC, false)
                .u32(prop::LANGUAGE_ID, LCID_EN_US);
                if let Some(s) = start {
                    p.u32(prop::LIST_RESTART, *s);
                }
            }
        }
        self.add("list", key, jcid::NUMBER_LIST_NODE, p)
    }

    // --- note tags ---------------------------------------------------------------------

    /// NoteTagStates for an element's tags (at most nine, one per kind).
    pub(crate) fn note_tags(&mut self, tags: &[Tag]) -> Option<Value> {
        let mut sets = Vec::new();
        let mut types: Vec<u16> = Vec::new();
        let mut kinds: Vec<&str> = Vec::new();
        for t in tags {
            if sets.len() == 9 || kinds.contains(&t.kind.as_str()) {
                continue;
            }
            kinds.push(&t.kind);
            let def = tag_def(t);
            // ActionItemType identifies the tag; it is unique within an element.
            let mut action = def.action;
            while types.contains(&action) {
                action = (action + 1) % 100;
            }
            types.push(action);
            let mut d = PropSet::new();
            let status = 1
                | u32::from(def.text.is_some()) << 1
                | u32::from(def.highlight.is_some()) << 2
                | u32::from(def.shape != 0) << 3;
            d.wz(prop::NOTE_TAG_LABEL, &def.label)
                .u32(prop::NOTE_TAG_PROPERTY_STATUS, status)
                .u16(prop::NOTE_TAG_SHAPE, def.shape)
                .u8(prop::ACTION_ITEM_SCHEMA_VERSION, 0);
            if let Some(h) = def.highlight {
                d.u32(prop::NOTE_TAG_HIGHLIGHT_COLOR, h);
            }
            if let Some(c) = def.text {
                d.u32(prop::NOTE_TAG_TEXT_COLOR, c);
            }
            d.u16(prop::ACTION_ITEM_TYPE, action);
            let def_idx = self.shared(jcid::NOTE_TAG_SHARED_DEFINITION_CONTAINER, "tag", d);

            // [MS-ONE] §2.1.9: a tag that cannot be checked is "completed" when
            // created; a checkable one records when it was ticked.
            let checkable = checkable_shape(def.shape);
            let done = !checkable || t.done == Some(true);
            let completed_at = match (checkable, done) {
                (false, _) => self.created,
                (true, true) => self.modified,
                (true, false) => 0,
            };
            let mut s = PropSet::new();
            s.oid(prop::NOTE_TAG_DEFINITION_OID, def_idx)
                .u32(prop::NOTE_TAG_CREATED, self.created)
                .u32(prop::NOTE_TAG_COMPLETED, completed_at)
                .u16(prop::ACTION_ITEM_STATUS, u16::from(done));
            sets.push(s);
        }
        (!sets.is_empty()).then_some(Value::Sets(prop::NOTE_TAG_STATE, sets))
    }
}

impl Paragraph {
    pub(crate) fn empty() -> Paragraph {
        Paragraph {
            style: "p".into(),
            runs: Vec::new(),
            align: None,
            space_before: None,
            space_after: None,
            line_spacing: None,
        }
    }
}

/// A note tag definition: label, NoteTagShape ([MS-ONE] §2.3.86), colors
/// (COLORREF) and ActionItemType.
struct TagDef {
    label: String,
    shape: u16,
    highlight: Option<u32>,
    text: Option<u32>,
    action: u16,
}

/// Shapes that carry a check box ([MS-ONE] §2.3.86).
fn checkable_shape(shape: u16) -> bool {
    matches!(shape, 1..=12 | 28 | 30 | 32 | 48 | 50 | 52 | 69 | 71 | 73 | 89..=99)
}

/// Notecraft's tag catalog (`notecraft/src/model/tags.ts`) in OneNote's
/// terms: label, icon, highlight. The index is the ActionItemType.
const CATALOG: &[(&str, &str, u16, Option<u32>)] = &[
    ("todo", "To Do", 3, None),
    ("important", "Important", 13, None),
    ("question", "Question", 15, None),
    ("remember", "Remember for later", 0, Some(0x00a3_f3ff)),
    ("definition", "Definition", 0, Some(0x00c0_f2c8)),
    ("highlight", "Highlight", 0, Some(0x008a_e0ff)),
    ("contact", "Contact", 18, None),
    ("address", "Address", 23, None),
    ("phone", "Phone number", 109, None),
    ("website", "Web site to visit", 125, None),
    ("idea", "Idea", 21, None),
    ("password", "Password", 27, None),
    ("critical", "Critical", 17, None),
    ("projectA", "Project A", 100, None),
    ("projectB", "Project B", 101, None),
    ("movie", "Movie to see", 122, None),
    ("book", "Book to read", 132, None),
    ("music", "Music to listen to", 121, None),
    ("source", "Source for article", 134, None),
    ("blog", "Remember for blog", 136, None),
    ("discussA", "Discuss with Person A", 94, None),
    ("discussB", "Discuss with Person B", 95, None),
    ("manager", "Discuss with manager", 96, None),
    ("email", "Send in email", 106, None),
    ("meeting", "Schedule meeting", 1, None),
    ("callback", "Call back", 2, None),
    ("priority1", "To Do priority 1", 28, None),
    ("priority2", "To Do priority 2", 30, None),
    ("client", "Client request", 32, None),
];

fn tag_def(t: &Tag) -> TagDef {
    if let Some((i, &(_, label, shape, highlight))) =
        CATALOG.iter().enumerate().find(|(_, c)| c.0 == t.kind)
    {
        return TagDef {
            label: label.into(),
            shape,
            highlight,
            text: None,
            action: i as u16,
        };
    }
    // A custom tag: its label, a check box when it has a done state.
    let label = t
        .label
        .clone()
        .or_else(|| t.kind.strip_prefix("custom:").map(str::to_string))
        .unwrap_or_else(|| t.kind.clone());
    let mut label: String = clean_line(&label).chars().take(199).collect();
    if label.is_empty() {
        label = "Tag".into();
    }
    let hash = label
        .bytes()
        .fold(0u32, |h, b| h.wrapping_mul(31).wrapping_add(u32::from(b)));
    TagDef {
        label,
        shape: if t.done.is_some() { 3 } else { 102 },
        highlight: None,
        text: None,
        action: (CATALOG.len() as u32 + hash % (100 - CATALOG.len() as u32)) as u16,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cleaning() {
        assert_eq!(
            String::from_utf16_lossy(&clean_text("a\r\nb\nc\0")),
            "a\u{b}b\u{b}c"
        );
        assert_eq!(clean_line(" a\nb "), "a b");
        assert_eq!(clean_url("http://x/\"y\""), "http://x/%22y%22");
    }

    #[test]
    fn links_get_a_field_code_run() {
        let runs = vec![
            Run {
                text: "see ".into(),
                ..Run::default()
            },
            Run {
                text: "here".into(),
                href: Some("https://e.x".into()),
                ..Run::default()
            },
            Run {
                text: "!".into(),
                href: Some("https://e.x".into()),
                bold: true,
                ..Run::default()
            },
        ];
        let p = pieces(&runs);
        let kinds: Vec<Link> = p.iter().map(|p| p.link).collect();
        assert!(kinds == [Link::None, Link::Marker, Link::Text, Link::Text]);
        assert_eq!(
            String::from_utf16_lossy(&p[1].units),
            "\u{fddf}HYPERLINK \"https://e.x\""
        );
    }
}
