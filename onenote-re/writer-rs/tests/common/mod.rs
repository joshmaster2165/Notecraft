//! A Notecraft section that exercises everything the writer covers.

#![allow(dead_code)]

use base64::Engine;
use serde_json::{json, Value};

/// A 1×1 PNG.
pub const PNG_1X1: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

pub fn png_bytes() -> Vec<u8> {
    base64::engine::general_purpose::STANDARD
        .decode(PNG_1X1)
        .unwrap()
}

pub fn data_url(media_type: &str, bytes: &[u8]) -> String {
    format!(
        "data:{media_type};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    )
}

/// Deterministic pseudo-random bytes after a PNG signature.
pub fn big_png_like(len: usize, seed: u32) -> Vec<u8> {
    let mut out = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
    let mut s = seed | 1;
    while out.len() < len {
        s ^= s << 13;
        s ^= s >> 17;
        s ^= s << 5;
        out.push((s >> 3) as u8);
    }
    out
}

pub fn text(id: &str, style: &str, runs: Value) -> Value {
    json!({ "id": id, "kind": "text", "depth": 0, "style": style, "runs": runs })
}

pub const ATTACHMENT: &[u8] = b"%PDF-1.4\nnot really a pdf, but bytes all the same\n";

pub fn sample() -> Value {
    let png = data_url("image/png", &png_bytes());
    json!({
        "id": "sec-1",
        "name": "Writer Test",
        "color": "#c46a2f",
        "createdAt": "2026-09-30T08:00:00.000Z",
        "pages": [
            {
                "id": "page-1",
                "title": "Welcome page",
                "level": 1,
                "createdAt": "2026-10-01T09:30:00.000Z",
                "modifiedAt": "2026-10-02T11:45:10.000Z",
                "author": "Ada Lovelace",
                "outlines": [
                    {
                        "id": "o-1", "x": 54, "y": 90, "width": 520, "widthSetByUser": true,
                        "elements": [
                            text("h", "h1", json!([{ "text": "Heading One" }])),
                            text("fmt", "p", json!([
                                { "text": "Plain " },
                                { "text": "bold", "b": true },
                                { "text": " " },
                                { "text": "italic", "i": true },
                                { "text": " " },
                                { "text": "under", "u": true },
                                { "text": " " },
                                { "text": "strike", "s": true },
                                { "text": " " },
                                { "text": "red arial", "font": "Arial", "size": 14, "color": "#ff0000" },
                                { "text": " " },
                                { "text": "marked", "highlight": "#ffff00" },
                                { "text": " E=mc" },
                                { "text": "2", "sup": true },
                                { "text": " H" },
                                { "text": "2", "sub": true },
                                { "text": "O and " },
                                { "text": "a link", "href": "https://example.com/a?b=1" },
                                { "text": " done" }
                            ])),
                            text("q", "quote", json!([{ "text": "A quotation" }])),
                            text("c", "code", json!([{ "text": "let x = 1;" }])),
                            text("ct", "cite", json!([{ "text": "A citation" }])),
                            { "id": "b1", "kind": "text", "depth": 0, "style": "p", "list": { "kind": "bullet", "glyph": "•" }, "runs": [{ "text": "Bullet one" }] },
                            { "id": "b2", "kind": "text", "depth": 1, "style": "p", "list": { "kind": "bullet", "glyph": "◦" }, "runs": [{ "text": "Nested bullet" }] },
                            { "id": "n1", "kind": "text", "depth": 0, "style": "p", "list": { "kind": "numbered", "scheme": "decimal", "suffix": ".", "start": 3 }, "runs": [{ "text": "Numbered three" }] },
                            { "id": "n2", "kind": "text", "depth": 0, "style": "p", "list": { "kind": "numbered", "scheme": "lowerLetter", "prefix": "(", "suffix": ")" }, "runs": [{ "text": "Lettered" }] },
                            { "id": "t1", "kind": "text", "depth": 0, "style": "p", "tags": [{ "kind": "todo", "done": true }], "runs": [{ "text": "Done task" }] },
                            { "id": "t2", "kind": "text", "depth": 0, "style": "p", "tags": [{ "kind": "todo", "done": false }, { "kind": "important" }], "runs": [{ "text": "Open task" }] },
                            { "id": "al", "kind": "text", "depth": 0, "style": "p", "align": "center", "spaceBefore": 6, "spaceAfter": 3, "runs": [{ "text": "Centered" }] },
                            text("nl", "p", json!([{ "text": "line one\nline two" }])),
                            {
                                "id": "tb", "kind": "table", "depth": 0, "columns": [100, 150], "borders": false,
                                "rows": [
                                    { "id": "r1", "cells": [
                                        { "id": "c11", "shading": "#ddeeff", "elements": [text("c11p", "p", json!([{ "text": "A1" }]))] },
                                        { "id": "c12", "elements": [text("c12p", "p", json!([{ "text": "B1", "b": true }]))] }
                                    ]},
                                    { "id": "r2", "cells": [
                                        { "id": "c21", "elements": [text("c21p", "p", json!([{ "text": "A2" }]))] },
                                        { "id": "c22", "elements": [] }
                                    ]}
                                ]
                            },
                            { "id": "img", "kind": "image", "depth": 0, "image": { "src": png, "width": 120, "height": 80, "alt": "A dot", "filename": "dot.png", "ocrText": "dot" } },
                            { "id": "crop", "kind": "image", "depth": 0, "image": {
                                "src": png, "width": 60, "height": 40,
                                "crop": { "topLeftXPercentage": 10, "topLeftYPercentage": 20, "widthPercentage": 50, "heightPercentage": 60 },
                                "original": { "src": data_url("image/png", &big_png_like(4096, 7)), "width": 120, "height": 66 }
                            }},
                            { "id": "pr", "kind": "image", "depth": 0, "image": { "src": png, "width": 300, "height": 400, "filename": "report.pdf", "printout": { "file": "report.pdf", "page": 2, "pages": 3 } } },
                            { "id": "f", "kind": "file", "depth": 0, "name": "notes.pdf", "size": ATTACHMENT.len(), "src": data_url("application/pdf", ATTACHMENT) },
                            { "id": "m", "kind": "math", "depth": 0, "linear": "x=(-b±√(b^2-4ac))/2a" }
                        ]
                    },
                    {
                        "id": "o-2", "x": 600, "y": 300, "width": 200, "widthSetByUser": false,
                        "elements": [text("side", "p", json!([{ "text": "Side note" }]))]
                    }
                ],
                "images": [
                    { "id": "float", "x": 400, "y": 120, "src": png, "width": 50, "height": 50, "alt": "Floating" }
                ],
                "ink": [
                    { "id": "k1", "tool": "pen", "color": "#1d1f23", "width": 2, "points": [100, 500, 110.5, 505.25, 130, 520, 150, 515] },
                    { "id": "k2", "tool": "highlighter", "color": "#ffe14d", "width": 14, "points": [100, 560, 300, 560] }
                ]
            },
            {
                "id": "page-2",
                "title": "Sub page",
                "level": 2,
                "createdAt": "2026-10-03T09:30:00.000Z",
                "modifiedAt": "2026-10-03T09:30:00.000Z",
                "outlines": [{ "id": "o-3", "x": 54, "y": 90, "width": 400, "widthSetByUser": true, "elements": [text("s1", "p", json!([{ "text": "Subpage text" }]))] }],
                "images": []
            },
            {
                "id": "page-3",
                "title": "Third",
                "level": 1,
                "createdAt": "2026-10-04T09:30:00.000Z",
                "modifiedAt": "2026-10-04T09:30:00.000Z",
                "outlines": [{ "id": "o-4", "x": 54, "y": 90, "width": 400, "widthSetByUser": true, "elements": [] }],
                "images": []
            },
            {
                "id": "page-4",
                "title": "",
                "level": 3,
                "createdAt": "2026-10-05T09:30:00.000Z",
                "modifiedAt": "2026-10-05T09:30:00.000Z",
                "outlines": [],
                "images": []
            }
        ]
    })
}
