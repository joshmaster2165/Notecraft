//! File › Export › Word document (.docx).
//!
//! Takes pages in Notecraft's model (the same JSON the library folder stores,
//! pictures as data: URLs) and writes a WordprocessingML package: the title
//! and headings as Word heading styles, bullets and numbering as Word lists,
//! to-do tags as ☐/☑, tables, pictures, hyperlinks and character formatting.

use base64::Engine;
use serde_json::Value;

use crate::zipw::ZipWriter;

fn esc(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

struct Doc {
    body: String,
    rels: Vec<(String, String, String)>, // id, type, target
    media: Vec<(String, Vec<u8>)>,
    links: Vec<String>,
}

const REL_IMAGE: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image";
const REL_LINK: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink";

impl Doc {
    fn rel(&mut self, kind: &str, target: String) -> String {
        let id = format!("rId{}", 10 + self.rels.len());
        self.rels.push((id.clone(), kind.to_string(), target));
        id
    }

    fn runs(&mut self, runs: &Value) -> String {
        let mut out = String::new();
        for r in runs.as_array().into_iter().flatten() {
            let text = r["text"].as_str().unwrap_or("");
            if text.is_empty() {
                continue;
            }
            let mut props = String::new();
            if let Some(font) = r["font"].as_str() {
                props += &format!(r#"<w:rFonts w:ascii="{0}" w:hAnsi="{0}" w:cs="{0}"/>"#, esc(font));
            }
            for (key, tag) in [("b", "w:b"), ("i", "w:i"), ("s", "w:strike")] {
                if r[key] == true {
                    props += &format!("<{tag}/>");
                }
            }
            if r["u"] == true || r["href"].is_string() {
                props += r#"<w:u w:val="single"/>"#;
            }
            if let Some(c) = r["color"].as_str().and_then(|c| c.strip_prefix('#')) {
                props += &format!(r#"<w:color w:val="{}"/>"#, esc(c));
            } else if r["href"].is_string() {
                props += r#"<w:color w:val="1A5FB4"/>"#;
            }
            if let Some(sz) = r["size"].as_f64() {
                props += &format!(r#"<w:sz w:val="{}"/>"#, (sz * 2.0).round() as i64);
            }
            if let Some(h) = r["highlight"].as_str().and_then(|c| c.strip_prefix('#')) {
                props += &format!(r#"<w:shd w:val="clear" w:color="auto" w:fill="{}"/>"#, esc(h));
            }
            if r["sup"] == true {
                props += r#"<w:vertAlign w:val="superscript"/>"#;
            } else if r["sub"] == true {
                props += r#"<w:vertAlign w:val="subscript"/>"#;
            }
            let mut body = String::new();
            for (i, line) in text.split('\n').enumerate() {
                if i > 0 {
                    body += "<w:br/>";
                }
                body += &format!(r#"<w:t xml:space="preserve">{}</w:t>"#, esc(line));
            }
            let run = format!("<w:r><w:rPr>{props}</w:rPr>{body}</w:r>");
            match r["href"].as_str().filter(|h| h.starts_with("http") || h.starts_with("mailto:")) {
                Some(href) => {
                    let id = self.rel(REL_LINK, esc(href));
                    self.links.push(id.clone());
                    out += &format!(r#"<w:hyperlink r:id="{id}">{run}</w:hyperlink>"#);
                }
                None => out += &run,
            }
        }
        out
    }

    fn image(&mut self, img: &Value) -> Option<String> {
        let src = img["src"].as_str()?;
        let (meta, data) = src.strip_prefix("data:")?.split_once(',')?;
        let bytes = base64::engine::general_purpose::STANDARD.decode(data).ok()?;
        let ext = match meta.split(';').next().unwrap_or("") {
            "image/jpeg" => "jpeg",
            "image/gif" => "gif",
            "image/png" => "png",
            _ => return None,
        };
        let name = format!("image{}.{ext}", self.media.len() + 1);
        self.media.push((name.clone(), bytes));
        let id = self.rel(REL_IMAGE, format!("media/{name}"));
        // Points → EMU (12,700 per point), at most a page width (6.5 in).
        let (mut w, mut h) = (img["width"].as_f64().unwrap_or(200.0), img["height"].as_f64().unwrap_or(150.0));
        if w > 468.0 {
            h *= 468.0 / w;
            w = 468.0;
        }
        let (cx, cy) = ((w * 12700.0) as i64, (h * 12700.0) as i64);
        let n = self.media.len();
        let alt = esc(img["alt"].as_str().unwrap_or(""));
        Some(format!(
            r#"<w:r><w:drawing><wp:inline><wp:extent cx="{cx}" cy="{cy}"/><wp:docPr id="{n}" name="Picture {n}" descr="{alt}"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="{n}" name="{name}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="{id}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="{cx}" cy="{cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>"#
        ))
    }

    fn elements(&mut self, els: &Value) {
        for el in els.as_array().into_iter().flatten() {
            let depth = el["depth"].as_u64().unwrap_or(0).min(8);
            match el["kind"].as_str() {
                Some("text") => {
                    let style = match el["style"].as_str().unwrap_or("p") {
                        s @ ("h1" | "h2" | "h3" | "h4" | "h5" | "h6") => format!("Heading{}", &s[1..]),
                        "quote" => "Quote".into(),
                        "code" => "Code".into(),
                        "cite" => "Citation".into(),
                        _ => String::new(),
                    };
                    let mut ppr = String::new();
                    if !style.is_empty() {
                        ppr += &format!(r#"<w:pStyle w:val="{style}"/>"#);
                    }
                    match el["list"]["kind"].as_str() {
                        Some("bullet") => ppr += &format!(r#"<w:numPr><w:ilvl w:val="{depth}"/><w:numId w:val="1"/></w:numPr>"#),
                        Some("numbered") => ppr += &format!(r#"<w:numPr><w:ilvl w:val="{depth}"/><w:numId w:val="2"/></w:numPr>"#),
                        _ if depth > 0 => ppr += &format!(r#"<w:ind w:left="{}"/>"#, depth * 540),
                        _ => {}
                    }
                    if let Some(a) = el["align"].as_str().filter(|a| *a != "left") {
                        ppr += &format!(r#"<w:jc w:val="{}"/>"#, if a == "center" { "center" } else { "right" });
                    }
                    let mut prefix = String::new();
                    for t in el["tags"].as_array().into_iter().flatten() {
                        prefix += match (t["kind"].as_str(), t["done"].as_bool()) {
                            (_, Some(true)) => "☑ ",
                            (_, Some(false)) => "☐ ",
                            (Some("important"), _) => "★ ",
                            (Some("question"), _) => "? ",
                            _ => "• ",
                        };
                    }
                    let pre = if prefix.is_empty() { String::new() } else { format!(r#"<w:r><w:t xml:space="preserve">{}</w:t></w:r>"#, esc(&prefix)) };
                    let runs = self.runs(&el["runs"]);
                    self.body += &format!("<w:p><w:pPr>{ppr}</w:pPr>{pre}{runs}</w:p>");
                }
                Some("table") => {
                    let cols: Vec<i64> = el["columns"].as_array().into_iter().flatten().map(|c| (c.as_f64().unwrap_or(100.0) * 20.0) as i64).collect();
                    let borders = if el["borders"] == false { "nil" } else { "single" };
                    self.body += &format!(
                        r#"<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders><w:top w:val="{borders}" w:sz="4"/><w:left w:val="{borders}" w:sz="4"/><w:bottom w:val="{borders}" w:sz="4"/><w:right w:val="{borders}" w:sz="4"/><w:insideH w:val="{borders}" w:sz="4"/><w:insideV w:val="{borders}" w:sz="4"/></w:tblBorders></w:tblPr><w:tblGrid>"#
                    );
                    for c in &cols {
                        self.body += &format!(r#"<w:gridCol w:w="{c}"/>"#);
                    }
                    self.body += "</w:tblGrid>";
                    for row in el["rows"].as_array().into_iter().flatten() {
                        self.body += "<w:tr>";
                        for (i, cell) in row["cells"].as_array().into_iter().flatten().enumerate() {
                            let shade = cell["shading"].as_str().and_then(|c| c.strip_prefix('#')).map(|c| format!(r#"<w:shd w:val="clear" w:color="auto" w:fill="{}"/>"#, esc(c))).unwrap_or_default();
                            self.body += &format!(r#"<w:tc><w:tcPr><w:tcW w:w="{}" w:type="dxa"/>{shade}</w:tcPr>"#, cols.get(i).copied().unwrap_or(2000));
                            let before = self.body.len();
                            self.elements(&cell["elements"]);
                            if self.body.len() == before {
                                self.body += "<w:p/>";
                            }
                            self.body += "</w:tc>";
                        }
                        self.body += "</w:tr>";
                    }
                    self.body += "</w:tbl><w:p/>";
                }
                Some("image") => {
                    if let Some(run) = self.image(&el["image"]) {
                        self.body += &format!("<w:p>{run}</w:p>");
                    }
                }
                Some("file") => {
                    self.body += &format!(r#"<w:p><w:r><w:t xml:space="preserve">📎 {}</w:t></w:r></w:p>"#, esc(el["name"].as_str().unwrap_or("attachment")));
                }
                Some("math") => {
                    // A real Word equation (Office Math), built up from the linear form.
                    let linear = el["linear"].as_str().unwrap_or("");
                    self.body += &format!("<w:p><m:oMathPara>{}</m:oMathPara></w:p>", crate::math::to_omml(linear));
                }
                _ => {}
            }
        }
    }

    fn page(&mut self, page: &Value, first: bool) {
        if !first {
            self.body += r#"<w:p><w:r><w:br w:type="page"/></w:r></w:p>"#;
        }
        self.body += &format!(r#"<w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t xml:space="preserve">{}</w:t></w:r></w:p>"#, esc(page["title"].as_str().filter(|t| !t.is_empty()).unwrap_or("Untitled page")));
        let mut outlines: Vec<&Value> = page["outlines"].as_array().into_iter().flatten().collect();
        outlines.sort_by(|a, b| {
            let k = |o: &Value| (o["y"].as_f64().unwrap_or(0.0), o["x"].as_f64().unwrap_or(0.0));
            k(a).partial_cmp(&k(b)).unwrap_or(std::cmp::Ordering::Equal)
        });
        for o in outlines {
            self.elements(&o["elements"]);
        }
        for img in page["images"].as_array().into_iter().flatten() {
            if let Some(run) = self.image(img) {
                self.body += &format!("<w:p>{run}</w:p>");
            }
        }
    }
}

const STYLES: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="80"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="200"/></w:pPr><w:rPr><w:rFonts w:ascii="Calibri Light" w:hAnsi="Calibri Light"/><w:sz w:val="40"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:color w:val="1E4E79"/><w:sz w:val="32"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:color w:val="2E75B5"/><w:sz w:val="28"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:color w:val="1F3763"/><w:sz w:val="24"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading4"><w:name w:val="heading 4"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="3"/></w:pPr><w:rPr><w:i/><w:color w:val="2E75B5"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading5"><w:name w:val="heading 5"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="4"/></w:pPr><w:rPr><w:color w:val="2E75B5"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading6"><w:name w:val="heading 6"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="5"/></w:pPr><w:rPr><w:i/><w:color w:val="1F3763"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="720"/></w:pPr><w:rPr><w:i/><w:color w:val="595959"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Citation"><w:name w:val="Citation"/><w:basedOn w:val="Normal"/><w:rPr><w:color w:val="595959"/><w:sz w:val="18"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/><w:basedOn w:val="Normal"/><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:sz w:val="20"/></w:rPr></w:style>
</w:styles>"#;

fn numbering() -> String {
    let bullets = ["•", "◦", "▪"];
    let formats = ["decimal", "lowerLetter", "lowerRoman"];
    let mut out = String::from(r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:abstractNum w:abstractNumId="1">"#);
    for i in 0..9 {
        out += &format!(r#"<w:lvl w:ilvl="{i}"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="{}"/><w:pPr><w:ind w:left="{}" w:hanging="360"/></w:pPr></w:lvl>"#, bullets[i % 3], 720 + i * 540);
    }
    out += r#"</w:abstractNum><w:abstractNum w:abstractNumId="2">"#;
    for i in 0..9 {
        out += &format!(r#"<w:lvl w:ilvl="{i}"><w:start w:val="1"/><w:numFmt w:val="{}"/><w:lvlText w:val="%{}."/><w:pPr><w:ind w:left="{}" w:hanging="360"/></w:pPr></w:lvl>"#, formats[i % 3], i + 1, 720 + i * 540);
    }
    out + r#"</w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="1"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="2"/></w:num></w:numbering>"#
}

/// Pages (Notecraft JSON) → a .docx file, one page per Word page.
pub fn export_docx(pages: &[Value]) -> Vec<u8> {
    let mut doc = Doc { body: String::new(), rels: Vec::new(), media: Vec::new(), links: Vec::new() };
    for (i, p) in pages.iter().enumerate() {
        doc.page(p, i == 0);
    }
    let document = format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"><w:body>{}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>"#,
        doc.body
    );
    let mut rels = String::from(r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>"#);
    for (id, kind, target) in &doc.rels {
        let mode = if kind == REL_LINK { r#" TargetMode="External""# } else { "" };
        rels += &format!(r#"<Relationship Id="{id}" Type="{kind}" Target="{target}"{mode}/>"#);
    }
    rels += "</Relationships>";
    let content_types = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/><Default Extension="gif" ContentType="image/gif"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/></Types>"#;
    let root_rels = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>"#;
    let mut zip = ZipWriter::default();
    zip.add("[Content_Types].xml", content_types.as_bytes());
    zip.add("_rels/.rels", root_rels.as_bytes());
    zip.add("word/document.xml", document.as_bytes());
    zip.add("word/styles.xml", STYLES.as_bytes());
    zip.add("word/numbering.xml", numbering().as_bytes());
    zip.add("word/_rels/document.xml.rels", rels.as_bytes());
    for (name, bytes) in &doc.media {
        zip.add(&format!("word/media/{name}"), bytes);
    }
    zip.finish()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn writes_a_word_package() {
        let page = json!({
            "title": "Kickoff & plan",
            "outlines": [{ "x": 54, "y": 90, "elements": [
                { "kind": "text", "style": "h2", "depth": 0, "runs": [{ "text": "Goals" }] },
                { "kind": "text", "style": "p", "depth": 0, "list": { "kind": "bullet", "glyph": "•" }, "runs": [{ "text": "Fast " }, { "text": "site", "b": true }] },
                { "kind": "text", "style": "p", "depth": 1, "tags": [{ "kind": "todo", "done": true }], "runs": [{ "text": "Audit", "href": "https://example.com" }] },
                { "kind": "table", "depth": 0, "columns": [100, 120], "rows": [{ "cells": [{ "shading": "#dbe7f5", "elements": [{ "kind": "text", "style": "p", "depth": 0, "runs": [{ "text": "A1" }] }] }, { "elements": [] }] }] },
                { "kind": "image", "depth": 0, "image": { "src": "data:image/png;base64,iVBORw0KGgo=", "width": 40, "height": 20, "alt": "logo" } },
                { "kind": "math", "depth": 0, "linear": "x=(-b±√(b^2-4ac))/2a" }
            ]}],
            "images": []
        });
        let bytes = export_docx(&[page]);
        assert_eq!(&bytes[..4], b"PK\x03\x04");
        let text = String::from_utf8_lossy(&bytes);
        for name in ["[Content_Types].xml", "word/document.xml", "word/styles.xml", "word/numbering.xml", "word/media/image1.png"] {
            assert!(text.contains(name), "missing {name}");
        }
        // End-of-central-directory record with 7 entries.
        let eocd = bytes.windows(4).rposition(|w| w == b"PK\x05\x06").unwrap();
        assert_eq!(u16::from_le_bytes([bytes[eocd + 10], bytes[eocd + 11]]), 7);
        // Walk the central directory: every record must start with its signature.
        let mut at = u32::from_le_bytes(bytes[eocd + 16..eocd + 20].try_into().unwrap()) as usize;
        for _ in 0..7 {
            assert_eq!(&bytes[at..at + 4], b"PK\x01\x02");
            let n = u16::from_le_bytes([bytes[at + 28], bytes[at + 29]]) as usize;
            at += 46 + n;
        }
        assert_eq!(at, eocd);
        if let Some(path) = std::env::var_os("NOTECRAFT_DOCX_SAMPLE") {
            std::fs::write(path, &bytes).unwrap();
        }
    }
}
