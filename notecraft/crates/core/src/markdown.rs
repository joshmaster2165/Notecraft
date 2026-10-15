//! Pages as Markdown, for agents and the CLI: render a page's notes, and turn
//! Markdown into the web app's paragraph elements.

use serde_json::{json, Map, Value};

use crate::util::new_id;

const BULLETS: [&str; 3] = ["•", "◦", "▪"];
const SCHEMES: [&str; 3] = ["decimal", "lowerLetter", "lowerRoman"];

// --- reading ---------------------------------------------------------------------------------

/// Plain text of a paragraph's runs.
pub fn runs_text(runs: &Value) -> String {
    runs.as_array().map(|a| a.iter().filter_map(|r| r["text"].as_str()).collect()).unwrap_or_default()
}

fn runs_markdown(runs: &Value) -> String {
    let Some(runs) = runs.as_array() else { return String::new() };
    let mut out = String::new();
    for r in runs {
        let text = r["text"].as_str().unwrap_or("");
        if text.is_empty() {
            continue;
        }
        let mut t = text.replace('\n', "  \n");
        if r["b"] == true {
            t = format!("**{t}**");
        }
        if r["i"] == true {
            t = format!("*{t}*");
        }
        if r["s"] == true {
            t = format!("~~{t}~~");
        }
        if let Some(href) = r["href"].as_str() {
            t = format!("[{t}]({href})");
        }
        out.push_str(&t);
    }
    out
}

fn tag_prefix(el: &Value) -> String {
    let mut out = String::new();
    for t in el["tags"].as_array().into_iter().flatten() {
        match (t["kind"].as_str(), t.get("done")) {
            (_, Some(Value::Bool(done))) => out.push_str(if *done { "[x] " } else { "[ ] " }),
            (Some("important"), _) => out.push_str("⭐ "),
            (Some("question"), _) => out.push_str("❓ "),
            (Some(kind), _) => out.push_str(&format!("#{} ", t["label"].as_str().unwrap_or(kind).replace(' ', "-"))),
            _ => {}
        }
    }
    out
}

/// Elements (paragraphs, tables, pictures, files) as Markdown lines.
pub fn elements_markdown(elements: &Value, out: &mut Vec<String>) {
    let mut counters = [0usize; 16];
    for el in elements.as_array().into_iter().flatten() {
        let depth = el["depth"].as_u64().unwrap_or(0).min(15) as usize;
        let indent = "  ".repeat(depth);
        match el["kind"].as_str() {
            Some("text") => {
                let text = runs_markdown(&el["runs"]);
                let tags = tag_prefix(el);
                let line = match (el["style"].as_str().unwrap_or("p"), el["list"]["kind"].as_str()) {
                    (s, _) if s.len() == 2 && s.starts_with('h') => format!("{} {tags}{text}", "#".repeat(s[1..].parse::<usize>().unwrap_or(1))),
                    ("quote", _) => format!("{indent}> {tags}{text}"),
                    ("code", _) => format!("{indent}`{}`", runs_text(&el["runs"])),
                    (_, Some("bullet")) => format!("{indent}- {tags}{text}"),
                    (_, Some("numbered")) => {
                        counters[depth] += 1;
                        counters[depth + 1..].iter_mut().for_each(|c| *c = 0);
                        format!("{indent}{}. {tags}{text}", el["list"]["start"].as_u64().map(|s| s as usize + counters[depth] - 1).unwrap_or(counters[depth]))
                    }
                    _ if !tags.is_empty() && tags.starts_with('[') => format!("{indent}- {tags}{text}"),
                    _ => format!("{indent}{tags}{text}"),
                };
                if el["list"]["kind"].as_str() != Some("numbered") {
                    counters[depth] = 0;
                }
                out.push(line);
            }
            Some("table") => {
                let rows: Vec<Vec<String>> = el["rows"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(|r| {
                        r["cells"].as_array().into_iter().flatten().map(|c| {
                            let mut lines = Vec::new();
                            elements_markdown(&c["elements"], &mut lines);
                            lines.join(" ").replace('|', "\\|")
                        }).collect()
                    })
                    .collect();
                if let Some(first) = rows.first() {
                    out.push(String::new());
                    out.push(format!("| {} |", first.join(" | ")));
                    out.push(format!("|{}", "---|".repeat(first.len())));
                    for r in &rows[1..] {
                        out.push(format!("| {} |", r.join(" | ")));
                    }
                    out.push(String::new());
                }
            }
            Some("image") => {
                let img = &el["image"];
                let alt = img["alt"].as_str().or(img["filename"].as_str()).unwrap_or("picture");
                out.push(format!("{indent}![{alt}]({})", img["src"].as_str().filter(|s| !s.starts_with("data:")).unwrap_or("")));
                if let Some(ocr) = img["ocrText"].as_str() {
                    out.push(format!("{indent}  (text in picture: {})", ocr.replace('\n', " ")));
                }
            }
            Some("file") => out.push(format!("{indent}📎 {}", el["name"].as_str().unwrap_or("attachment"))),
            _ => {}
        }
    }
}

/// A page as Markdown: title, then each note container top to bottom.
pub fn page_markdown(page: &Value) -> String {
    let mut lines = vec![format!("# {}", page["title"].as_str().unwrap_or("Untitled page"))];
    let mut outlines: Vec<&Value> = page["outlines"].as_array().into_iter().flatten().collect();
    outlines.sort_by(|a, b| {
        let key = |o: &Value| (o["y"].as_f64().unwrap_or(0.0), o["x"].as_f64().unwrap_or(0.0));
        key(a).partial_cmp(&key(b)).unwrap_or(std::cmp::Ordering::Equal)
    });
    for o in outlines {
        lines.push(String::new());
        elements_markdown(&o["elements"], &mut lines);
    }
    for img in page["images"].as_array().into_iter().flatten() {
        lines.push(format!("![{}]({})", img["alt"].as_str().unwrap_or("picture"), img["src"].as_str().filter(|s| !s.starts_with("data:")).unwrap_or("")));
    }
    if page["ink"].as_array().is_some_and(|a| !a.is_empty()) {
        lines.push(format!("\n(drawing: {} ink strokes)", page["ink"].as_array().map(Vec::len).unwrap_or(0)));
    }
    let mut s = lines.join("\n");
    s.push('\n');
    s
}

/// All searchable text of a page: title, paragraphs, table cells, picture text.
pub fn page_text(page: &Value) -> String {
    let mut parts = vec![page["title"].as_str().unwrap_or("").to_string()];
    fn walk(els: &Value, parts: &mut Vec<String>) {
        for el in els.as_array().into_iter().flatten() {
            match el["kind"].as_str() {
                Some("text") => parts.push(runs_text(&el["runs"])),
                Some("table") => {
                    for r in el["rows"].as_array().into_iter().flatten() {
                        for c in r["cells"].as_array().into_iter().flatten() {
                            walk(&c["elements"], parts);
                        }
                    }
                }
                Some("image") => parts.push(el["image"]["ocrText"].as_str().or(el["image"]["alt"].as_str()).unwrap_or("").to_string()),
                Some("file") => parts.push(el["name"].as_str().unwrap_or("").to_string()),
                _ => {}
            }
        }
    }
    for o in page["outlines"].as_array().into_iter().flatten() {
        walk(&o["elements"], &mut parts);
    }
    for img in page["images"].as_array().into_iter().flatten() {
        parts.push(img["ocrText"].as_str().or(img["alt"].as_str()).unwrap_or("").to_string());
    }
    parts.retain(|p| !p.is_empty());
    parts.join("\n")
}

// --- writing -----------------------------------------------------------------------------------

/// `**bold**`, `*italic*` / `_italic_`, `~~strike~~`, `` `code` `` and `[text](url)` as runs.
pub fn inline_runs(text: &str) -> Vec<Value> {
    let mut runs: Vec<Value> = Vec::new();
    let mut push = |t: &str, style: Map<String, Value>| {
        if t.is_empty() {
            return;
        }
        let mut r = style;
        r.insert("text".into(), json!(t));
        runs.push(Value::Object(r));
    };
    let chars: Vec<char> = text.chars().collect();
    let mut i = 0;
    let mut plain = String::new();
    let flush = |plain: &mut String, push: &mut dyn FnMut(&str, Map<String, Value>)| {
        push(plain, Map::new());
        plain.clear();
    };
    let find = |from: usize, pat: &[char]| -> Option<usize> { (from..chars.len().saturating_sub(pat.len() - 1)).find(|&k| chars[k..k + pat.len()] == *pat) };
    while i < chars.len() {
        let rest = &chars[i..];
        let styled = |marker: &str| -> Option<(usize, String)> {
            let m: Vec<char> = marker.chars().collect();
            if rest.starts_with(&m) {
                let end = find(i + m.len(), &m)?;
                if end > i + m.len() {
                    return Some((end + m.len(), chars[i + m.len()..end].iter().collect()));
                }
            }
            None
        };
        if let Some((next, inner)) = styled("**").or_else(|| styled("__")) {
            flush(&mut plain, &mut push);
            push(&inner, Map::from_iter([("b".into(), json!(true))]));
            i = next;
        } else if let Some((next, inner)) = styled("~~") {
            flush(&mut plain, &mut push);
            push(&inner, Map::from_iter([("s".into(), json!(true))]));
            i = next;
        } else if let Some((next, inner)) = styled("*").or_else(|| styled("_")) {
            flush(&mut plain, &mut push);
            push(&inner, Map::from_iter([("i".into(), json!(true))]));
            i = next;
        } else if let Some((next, inner)) = styled("`") {
            flush(&mut plain, &mut push);
            push(&inner, Map::from_iter([("font".into(), json!("Consolas"))]));
            i = next;
        } else if rest[0] == '[' {
            let close = find(i + 1, &[']', '(']);
            let end = close.and_then(|c| find(c + 2, &[')']));
            if let (Some(c), Some(e)) = (close, end) {
                flush(&mut plain, &mut push);
                let label: String = chars[i + 1..c].iter().collect();
                let url: String = chars[c + 2..e].iter().collect();
                push(&label, Map::from_iter([("href".into(), json!(url))]));
                i = e + 1;
            } else {
                plain.push(rest[0]);
                i += 1;
            }
        } else {
            plain.push(rest[0]);
            i += 1;
        }
    }
    flush(&mut plain, &mut push);
    runs
}

fn paragraph(runs: Vec<Value>, depth: usize, style: &str) -> Map<String, Value> {
    Map::from_iter([
        ("id".into(), json!(new_id("e"))),
        ("kind".into(), json!("text")),
        ("depth".into(), json!(depth)),
        ("style".into(), json!(style)),
        ("runs".into(), Value::Array(runs)),
    ])
}

/// Markdown → paragraph elements: headings, quotes, code, bullets, numbered
/// lists and `- [ ]` / `- [x]` to-dos (OneNote's To Do tag). Two spaces of
/// indent are one outline level.
pub fn markdown_elements(md: &str) -> Vec<Value> {
    let mut out = Vec::new();
    let mut in_code = false;
    for raw in md.lines() {
        let line = raw.trim_end();
        if line.trim_start().starts_with("```") {
            in_code = !in_code;
            continue;
        }
        if in_code {
            out.push(Value::Object(paragraph(vec![json!({ "text": line })], 0, "code")));
            continue;
        }
        if line.trim().is_empty() {
            continue;
        }
        let spaces = line.len() - line.trim_start().len();
        let depth = (spaces / 2).min(8);
        let t = line.trim_start();
        let heading = t.chars().take_while(|c| *c == '#').count();
        let el = if (1..=6).contains(&heading) && t[heading..].starts_with(' ') {
            paragraph(inline_runs(t[heading..].trim()), 0, &format!("h{heading}"))
        } else if let Some(q) = t.strip_prefix("> ") {
            paragraph(inline_runs(q), depth, "quote")
        } else if let Some(item) = t.strip_prefix("- ").or_else(|| t.strip_prefix("* ")).or_else(|| t.strip_prefix("+ ")) {
            if let Some((done, text)) = item.strip_prefix("[ ] ").map(|x| (false, x)).or_else(|| item.strip_prefix("[x] ").or_else(|| item.strip_prefix("[X] ")).map(|x| (true, x))) {
                let mut p = paragraph(inline_runs(text), depth, "p");
                p.insert("tags".into(), json!([{ "kind": "todo", "done": done }]));
                p
            } else {
                let mut p = paragraph(inline_runs(item), depth, "p");
                p.insert("list".into(), json!({ "kind": "bullet", "glyph": BULLETS[depth % 3] }));
                p
            }
        } else if let Some(dot) = t.find(". ").filter(|&d| d > 0 && d <= 3 && t[..d].chars().all(|c| c.is_ascii_digit())) {
            let mut p = paragraph(inline_runs(&t[dot + 2..]), depth, "p");
            p.insert("list".into(), json!({ "kind": "numbered", "scheme": SCHEMES[depth % 3], "suffix": "." }));
            p
        } else {
            paragraph(inline_runs(t), depth, "p")
        };
        out.push(Value::Object(el));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inline_styles() {
        let runs = inline_runs("Plain **bold** and *it* with [a link](https://x.y) and `code`.");
        let texts: Vec<_> = runs.iter().map(|r| r["text"].as_str().unwrap()).collect();
        assert_eq!(texts, ["Plain ", "bold", " and ", "it", " with ", "a link", " and ", "code", "."]);
        assert_eq!(runs[1]["b"], true);
        assert_eq!(runs[3]["i"], true);
        assert_eq!(runs[5]["href"], "https://x.y");
        assert_eq!(runs[7]["font"], "Consolas");
        assert_eq!(inline_runs("2 * 3 = 6")[0]["text"], "2 * 3 = 6");
    }

    #[test]
    fn markdown_round_trip() {
        let md = "## Plan\n- [ ] Write the spec\n- [x] Book the room\n- Goals\n  - Faster\n1. One\n2. Two\n> Quote\nPlain text";
        let els = markdown_elements(md);
        assert_eq!(els.len(), 9);
        assert_eq!(els[0]["style"], "h2");
        assert_eq!(els[1]["tags"][0], json!({ "kind": "todo", "done": false }));
        assert_eq!(els[2]["tags"][0]["done"], true);
        assert_eq!(els[4]["depth"], 1);
        assert_eq!(els[4]["list"]["glyph"], "◦");
        assert_eq!(els[5]["list"]["kind"], "numbered");
        let mut lines = Vec::new();
        elements_markdown(&Value::Array(els), &mut lines);
        assert_eq!(lines.join("\n"), "## Plan\n- [ ] Write the spec\n- [x] Book the room\n- Goals\n  - Faster\n1. One\n2. Two\n> Quote\nPlain text");
    }
}
