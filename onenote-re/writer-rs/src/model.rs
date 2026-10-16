//! Notecraft's section model, read leniently from JSON (see
//! `notecraft/src/model/types.ts`). Missing or malformed fields fall back to
//! defaults, so an export never fails on a stray value.

use serde_json::Value;

use crate::time::Timestamp;

/// An sRGB color.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) struct Rgb(pub u8, pub u8, pub u8);

impl Rgb {
    /// COLORREF: 0x00BBGGRR ([MS-ONE] §2.2.8).
    pub fn colorref(self) -> u32 {
        u32::from(self.0) | u32::from(self.1) << 8 | u32::from(self.2) << 16
    }
}

pub(crate) struct Section {
    pub id: String,
    pub name: String,
    pub color: Option<Rgb>,
    pub created_at: Option<Timestamp>,
    pub pages: Vec<Page>,
}

pub(crate) struct Page {
    pub id: String,
    pub title: String,
    pub level: u32,
    pub created_at: Option<Timestamp>,
    pub modified_at: Option<Timestamp>,
    pub author: Option<String>,
    pub outlines: Vec<Outline>,
    pub images: Vec<FloatingImage>,
    pub ink: Vec<InkStroke>,
}

pub(crate) struct Outline {
    pub id: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub width_set_by_user: bool,
    pub elements: Vec<Element>,
}

#[derive(Clone, Default, Debug, PartialEq)]
pub(crate) struct Run {
    pub text: String,
    pub bold: bool,
    pub italic: bool,
    pub underline: bool,
    pub strike: bool,
    pub sup: bool,
    pub sub: bool,
    pub highlight: Option<Rgb>,
    pub color: Option<Rgb>,
    pub font: Option<String>,
    /// Points.
    pub size: Option<f64>,
    pub href: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Align {
    Left,
    Center,
    Right,
}

pub(crate) struct Paragraph {
    pub style: String,
    pub runs: Vec<Run>,
    pub align: Option<Align>,
    pub space_before: Option<f64>,
    pub space_after: Option<f64>,
    pub line_spacing: Option<f64>,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum ListStyle {
    Bullet(String),
    Numbered {
        scheme: String,
        prefix: String,
        suffix: String,
        start: Option<u32>,
    },
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Tag {
    pub kind: String,
    pub label: Option<String>,
    pub done: Option<bool>,
}

pub(crate) struct TableCell {
    pub id: String,
    pub shading: Option<Rgb>,
    pub elements: Vec<Element>,
}

pub(crate) struct TableRow {
    pub id: String,
    pub cells: Vec<TableCell>,
}

pub(crate) struct Table {
    pub columns: Vec<f64>,
    pub borders: bool,
    pub rows: Vec<TableRow>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Crop {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

pub(crate) struct ImageData {
    pub src: Option<String>,
    /// Points.
    pub width: f64,
    pub height: f64,
    pub alt: Option<String>,
    pub filename: Option<String>,
    pub ocr_text: Option<String>,
    pub crop: Option<Crop>,
    /// The uncropped picture, when `crop` is set.
    pub original_src: Option<String>,
    /// One page of a File Printout: the 1-based page of the printed file.
    pub printout: Option<u32>,
}

pub(crate) struct FileAttachment {
    pub name: String,
    pub src: Option<String>,
}

pub(crate) enum ElementKind {
    Text(Paragraph),
    Table(Table),
    Image(ImageData),
    File(FileAttachment),
    Math(String),
}

pub(crate) struct Element {
    pub id: String,
    pub depth: usize,
    pub list: Option<ListStyle>,
    pub tags: Vec<Tag>,
    pub kind: ElementKind,
}

pub(crate) struct FloatingImage {
    pub id: String,
    pub x: f64,
    pub y: f64,
    pub image: ImageData,
}

pub(crate) struct InkStroke {
    pub id: String,
    pub highlighter: bool,
    pub color: Option<Rgb>,
    /// Points.
    pub width: f64,
    /// Flat [x0, y0, x1, y1, …], page points.
    pub points: Vec<f64>,
    pub shape: bool,
}

// --- readers -------------------------------------------------------------------

fn s(v: &Value, k: &str) -> Option<String> {
    v.get(k).and_then(Value::as_str).map(str::to_string)
}

fn num(v: &Value, k: &str) -> Option<f64> {
    v.get(k).and_then(Value::as_f64).filter(|x| x.is_finite())
}

fn flag(v: &Value, k: &str) -> bool {
    v.get(k).and_then(Value::as_bool).unwrap_or(false)
}

fn arr<'a>(v: &'a Value, k: &str) -> &'a [Value] {
    v.get(k)
        .and_then(Value::as_array)
        .map_or(&[], Vec::as_slice)
}

fn time(v: &Value, k: &str) -> Option<Timestamp> {
    v.get(k)
        .and_then(Value::as_str)
        .and_then(Timestamp::parse_iso)
}

/// `#rgb`, `#rrggbb`, `#rrggbbaa` or `rgb(r, g, b)`.
pub(crate) fn parse_color(c: &str) -> Option<Rgb> {
    let c = c.trim();
    if let Some(h) = c.strip_prefix('#') {
        let digit = |i: usize| u8::from_str_radix(h.get(i..i + 1)?, 16).ok();
        let pair = |i: usize| u8::from_str_radix(h.get(i..i + 2)?, 16).ok();
        return match h.len() {
            3 | 4 => Some(Rgb(digit(0)? * 17, digit(1)? * 17, digit(2)? * 17)),
            6 | 8 => Some(Rgb(pair(0)?, pair(2)?, pair(4)?)),
            _ => None,
        };
    }
    let inner = c
        .strip_prefix("rgba(")
        .or_else(|| c.strip_prefix("rgb("))?
        .strip_suffix(')')?;
    let mut parts = inner.split(',').map(|p| p.trim().parse::<f64>().ok());
    let mut channel = || -> Option<u8> { Some(parts.next()??.round().clamp(0.0, 255.0) as u8) };
    Some(Rgb(channel()?, channel()?, channel()?))
}

fn color(v: &Value, k: &str) -> Option<Rgb> {
    v.get(k).and_then(Value::as_str).and_then(parse_color)
}

impl Section {
    pub fn from_json(v: &Value) -> Option<Section> {
        v.as_object()?;
        Some(Section {
            id: s(v, "id").unwrap_or_default(),
            name: s(v, "name").unwrap_or_default(),
            color: color(v, "color"),
            created_at: time(v, "createdAt"),
            pages: arr(v, "pages")
                .iter()
                .filter(|p| p.is_object())
                .map(Page::from_json)
                .collect(),
        })
    }
}

impl Page {
    fn from_json(v: &Value) -> Page {
        Page {
            id: s(v, "id").unwrap_or_default(),
            title: s(v, "title").unwrap_or_default(),
            level: num(v, "level").map_or(1, |l| l.round().clamp(1.0, 3.0) as u32),
            created_at: time(v, "createdAt"),
            modified_at: time(v, "modifiedAt"),
            author: s(v, "author").filter(|a| !a.trim().is_empty()),
            outlines: arr(v, "outlines")
                .iter()
                .filter(|o| o.is_object())
                .map(Outline::from_json)
                .collect(),
            images: arr(v, "images")
                .iter()
                .filter(|i| i.is_object())
                .map(|i| FloatingImage {
                    id: s(i, "id").unwrap_or_default(),
                    x: num(i, "x").unwrap_or(0.0),
                    y: num(i, "y").unwrap_or(0.0),
                    image: ImageData::from_json(i),
                })
                .collect(),
            ink: arr(v, "ink")
                .iter()
                .filter(|k| k.is_object())
                .map(InkStroke::from_json)
                .collect(),
        }
    }
}

impl Outline {
    fn from_json(v: &Value) -> Outline {
        Outline {
            id: s(v, "id").unwrap_or_default(),
            x: num(v, "x").unwrap_or(54.0),
            y: num(v, "y").unwrap_or(90.0),
            width: num(v, "width").unwrap_or(520.0),
            width_set_by_user: v
                .get("widthSetByUser")
                .and_then(Value::as_bool)
                .unwrap_or(true),
            elements: elements(arr(v, "elements")),
        }
    }
}

fn elements(vs: &[Value]) -> Vec<Element> {
    vs.iter()
        .filter(|e| e.is_object())
        .filter_map(Element::from_json)
        .collect()
}

impl Run {
    fn from_json(v: &Value) -> Run {
        Run {
            text: s(v, "text").unwrap_or_default(),
            bold: flag(v, "b"),
            italic: flag(v, "i"),
            underline: flag(v, "u"),
            strike: flag(v, "s"),
            sup: flag(v, "sup"),
            sub: flag(v, "sub"),
            highlight: color(v, "highlight"),
            color: color(v, "color"),
            font: s(v, "font").filter(|f| !f.trim().is_empty()),
            size: num(v, "size").filter(|&x| x > 0.0),
            href: s(v, "href").filter(|h| !h.trim().is_empty()),
        }
    }
}

impl ListStyle {
    fn from_json(v: &Value) -> Option<ListStyle> {
        match v.get("kind")?.as_str()? {
            "bullet" => Some(ListStyle::Bullet(
                s(v, "glyph")
                    .filter(|g| !g.is_empty())
                    .unwrap_or_else(|| "•".into()),
            )),
            "numbered" => Some(ListStyle::Numbered {
                scheme: s(v, "scheme").unwrap_or_else(|| "decimal".into()),
                prefix: s(v, "prefix").unwrap_or_default(),
                suffix: s(v, "suffix").unwrap_or_else(|| ".".into()),
                start: num(v, "start")
                    .filter(|&x| x >= 0.0)
                    .map(|x| x.round().min(f64::from(u32::MAX)) as u32),
            }),
            _ => None,
        }
    }
}

impl ImageData {
    fn from_json(v: &Value) -> ImageData {
        let crop = v.get("crop").filter(|c| c.is_object()).map(|c| Crop {
            x: num(c, "topLeftXPercentage").unwrap_or(0.0),
            y: num(c, "topLeftYPercentage").unwrap_or(0.0),
            width: num(c, "widthPercentage").unwrap_or(100.0),
            height: num(c, "heightPercentage").unwrap_or(100.0),
        });
        ImageData {
            src: s(v, "src").filter(|x| !x.is_empty()),
            width: num(v, "width").filter(|&w| w > 0.0).unwrap_or(160.0),
            height: num(v, "height").filter(|&h| h > 0.0).unwrap_or(120.0),
            alt: s(v, "alt").filter(|x| !x.is_empty()),
            filename: s(v, "filename").filter(|x| !x.is_empty()),
            ocr_text: s(v, "ocrText").filter(|x| !x.is_empty()),
            crop,
            original_src: v
                .get("original")
                .and_then(|o| s(o, "src"))
                .filter(|x| !x.is_empty()),
            printout: v.get("printout").filter(|p| p.is_object()).map(|p| {
                num(p, "page").map_or(1, |n| n.round().clamp(1.0, f64::from(u32::MAX)) as u32)
            }),
        }
    }
}

impl Element {
    fn from_json(v: &Value) -> Option<Element> {
        let kind = match v.get("kind").and_then(Value::as_str).unwrap_or("text") {
            "text" => ElementKind::Text(Paragraph {
                style: s(v, "style").unwrap_or_else(|| "p".into()),
                runs: arr(v, "runs")
                    .iter()
                    .filter(|r| r.is_object())
                    .map(Run::from_json)
                    .collect(),
                align: match v.get("align").and_then(Value::as_str) {
                    Some("center") => Some(Align::Center),
                    Some("right") => Some(Align::Right),
                    Some("left") => Some(Align::Left),
                    _ => None,
                },
                space_before: num(v, "spaceBefore").filter(|&x| x > 0.0),
                space_after: num(v, "spaceAfter").filter(|&x| x > 0.0),
                line_spacing: num(v, "lineSpacing").filter(|&x| x > 0.0),
            }),
            "table" => ElementKind::Table(Table {
                columns: arr(v, "columns").iter().filter_map(Value::as_f64).collect(),
                borders: v.get("borders").and_then(Value::as_bool).unwrap_or(true),
                rows: arr(v, "rows")
                    .iter()
                    .filter(|r| r.is_object())
                    .map(|r| TableRow {
                        id: s(r, "id").unwrap_or_default(),
                        cells: arr(r, "cells")
                            .iter()
                            .filter(|c| c.is_object())
                            .map(|c| TableCell {
                                id: s(c, "id").unwrap_or_default(),
                                shading: color(c, "shading"),
                                elements: elements(arr(c, "elements")),
                            })
                            .collect(),
                    })
                    .collect(),
            }),
            "image" => {
                ElementKind::Image(ImageData::from_json(v.get("image").unwrap_or(&Value::Null)))
            }
            "file" => ElementKind::File(FileAttachment {
                name: s(v, "name")
                    .filter(|n| !n.trim().is_empty())
                    .unwrap_or_else(|| "attachment".into()),
                src: s(v, "src").filter(|x| !x.is_empty()),
            }),
            "math" => ElementKind::Math(s(v, "linear").unwrap_or_default()),
            _ => return None,
        };
        Some(Element {
            id: s(v, "id").unwrap_or_default(),
            depth: num(v, "depth").map_or(0, |d| d.clamp(0.0, 30.0) as usize),
            list: v.get("list").and_then(ListStyle::from_json),
            tags: arr(v, "tags")
                .iter()
                .filter_map(|t| {
                    Some(Tag {
                        kind: s(t, "kind").filter(|k| !k.is_empty())?,
                        label: s(t, "label").filter(|l| !l.trim().is_empty()),
                        done: t.get("done").and_then(Value::as_bool),
                    })
                })
                .collect(),
            kind,
        })
    }
}

impl InkStroke {
    fn from_json(v: &Value) -> InkStroke {
        InkStroke {
            id: s(v, "id").unwrap_or_default(),
            highlighter: v.get("tool").and_then(Value::as_str) == Some("highlighter"),
            color: color(v, "color"),
            width: num(v, "width").filter(|&w| w > 0.0).unwrap_or(2.0),
            points: arr(v, "points")
                .iter()
                .filter_map(Value::as_f64)
                .filter(|x| x.is_finite())
                .collect(),
            shape: flag(v, "shape"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn colors() {
        assert_eq!(parse_color("#1e4e79"), Some(Rgb(0x1e, 0x4e, 0x79)));
        assert_eq!(parse_color("#fff"), Some(Rgb(255, 255, 255)));
        assert_eq!(parse_color("rgb(1, 2, 300)"), Some(Rgb(1, 2, 255)));
        assert_eq!(parse_color("blue"), None);
        assert_eq!(Rgb(0x1e, 0x4e, 0x79).colorref(), 0x0079_4e1e);
    }
}
