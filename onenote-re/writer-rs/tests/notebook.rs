#![recursion_limit = "512"]
//! Notebook folders: write a notebook, read every table of contents and
//! section back with this repository's reader (`onenote-re`), save the
//! folder to disk and open it with the independent reader
//! (`onenote_parser::Parser::parse_notebook`), and check the `.onetoc2`
//! container with a verifier written here.

mod common;

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use onenote_parser::section::SectionEntry;
use onenote_parser::Parser;
use onenote_re::{parse_notebook_toc, parse_one_note, ConvertOptions, OneStore};
use onenote_writer::{write_notebook, NotebookOutput};
use serde_json::{json, Value};
use typed_path::TypedPath;

use common::*;

fn section(id: &str, name: &str, color: &str, group: Option<&str>, title: &str) -> Value {
    let mut s = json!({
        "id": id, "name": name, "color": color, "createdAt": "2026-10-01T09:00:00Z",
        "pages": [{
            "id": format!("{id}-p1"), "title": title, "level": 1,
            "createdAt": "2026-10-01T09:00:00Z", "modifiedAt": "2026-10-02T10:00:00Z",
            "outlines": [{ "id": format!("{id}-o1"), "x": 54, "y": 90, "width": 400,
                "elements": [text(&format!("{id}-e1"), "p", json!([{ "text": format!("Body of {title}") }]))] }],
            "images": []
        }]
    });
    if let Some(g) = group {
        s["groupId"] = json!(g);
    }
    s
}

/// Work/
///   Meetings.one, Plan+Budget, Q1.one, CON_.one, notes.one, notes (2).one
///   Projects/            (group g1)
///     Plan.one
///     Archive/           (group g2, inside g1)
///       Old.one
///   Empty group/         (group g3, no sections)
/// and a locked section that is left out.
fn notebook() -> Value {
    let mut sample = sample();
    sample["id"] = json!("s-sample");
    sample["name"] = json!("Meetings");
    json!({
        "id": "nb1", "name": "Work", "color": "#4f7cac", "createdAt": "2026-10-01T09:00:00Z",
        "sections": [
            sample,
            section("s2", "Plan+Budget, Q1", "#e07020", None, "Budget"),
            section("s3", "Plan", "#20a060", Some("g1"), "Roadmap"),
            {
                "id": "s4", "name": "Secret", "color": "#808080", "createdAt": "2026-10-01T09:00:00Z",
                "pages": [], "locked": { "sealed": { "version": 1, "kdf": "PBKDF2", "iterations": 1,
                    "salt": "", "nonce": "", "data": "" } }
            },
            section("s5", "Old", "#a0a0a0", Some("g2"), "History"),
            section("s6", "CON", "#102030", None, "Device"),
            section("s7", "notes", "#405060", None, "Lower"),
            section("s8", "Notes", "#706050", None, "Upper"),
        ],
        "groups": [
            { "id": "g1", "name": "Projects" },
            { "id": "g2", "name": "Archive", "parentId": "g1" },
            { "id": "g3", "name": "Empty group" },
        ]
    })
}

fn files(out: &NotebookOutput) -> HashMap<&str, &[u8]> {
    out.files
        .iter()
        .map(|f| (f.path.as_str(), f.bytes.as_slice()))
        .collect()
}

#[test]
fn folder_layout_names_and_order() {
    let out = write_notebook(&notebook()).unwrap();
    let paths: Vec<&str> = out.files.iter().map(|f| f.path.as_str()).collect();
    assert_eq!(
        paths,
        [
            "Work/Open Notebook.onetoc2",
            "Work/Meetings.one",
            "Work/Plan+Budget, Q1.one",
            "Work/CON_.one",
            "Work/notes.one",
            "Work/Notes (2).one",
            "Work/Projects/Open Notebook.onetoc2",
            "Work/Projects/Plan.one",
            "Work/Projects/Archive/Open Notebook.onetoc2",
            "Work/Projects/Archive/Old.one",
            "Work/Empty group/Open Notebook.onetoc2",
        ]
    );
    let w = out.warnings.join("\n");
    assert!(w.contains("“Secret” is locked"), "{w}");
    assert!(w.contains("“CON” is saved as “CON_.one”"), "{w}");
    assert!(w.contains("“Notes” is saved as “Notes (2).one”"), "{w}");
    assert!(!w.contains("Plan+Budget"), "{w}");
}

#[test]
fn tables_of_contents_read_back() {
    let out = write_notebook(&notebook()).unwrap();
    let f = files(&out);
    let guid_of = |path: &str| OneStore::new(f[path]).unwrap().header.guid_file.clone();
    let ancestor_of = |path: &str| OneStore::new(f[path]).unwrap().header.guid_ancestor.clone();

    let toc = parse_notebook_toc(f["Work/Open Notebook.onetoc2"]).unwrap();
    assert!(toc.warnings.is_empty(), "{:?}", toc.warnings);
    assert_eq!(toc.color.as_deref(), Some("#4f7cac"));
    let names: Vec<&str> = toc.entries.iter().map(|e| e.name.as_str()).collect();
    assert_eq!(
        names,
        [
            "Meetings.one",
            "Plan+Budget, Q1.one",
            "CON_.one",
            "notes.one",
            "Notes (2).one",
            "Projects",
            "Empty group",
        ]
    );
    let orders: Vec<Option<u32>> = toc.entries.iter().map(|e| e.order).collect();
    assert_eq!(orders, (1..=7).map(Some).collect::<Vec<_>>());
    assert_eq!(toc.entries[1].color.as_deref(), Some("#e07020"));
    assert_eq!(toc.entries[5].color, None, "groups have no color");
    // FileIdentityGuid is the section's (or the group TOC's) guidFile, and
    // guidAncestor points the other way.
    let root_guid = guid_of("Work/Open Notebook.onetoc2");
    assert_eq!(toc.guid_file, root_guid);
    for (entry, path) in [
        (0, "Work/Meetings.one"),
        (1, "Work/Plan+Budget, Q1.one"),
        (4, "Work/Notes (2).one"),
        (5, "Work/Projects/Open Notebook.onetoc2"),
        (6, "Work/Empty group/Open Notebook.onetoc2"),
    ] {
        assert_eq!(
            toc.entries[entry].guid_file.as_deref(),
            Some(guid_of(path).as_str()),
            "{path}"
        );
        assert_eq!(ancestor_of(path), root_guid, "{path}");
    }
    assert_eq!(
        ancestor_of("Work/Open Notebook.onetoc2"),
        "{00000000-0000-0000-0000-000000000000}"
    );

    let projects = parse_notebook_toc(f["Work/Projects/Open Notebook.onetoc2"]).unwrap();
    assert!(projects.warnings.is_empty(), "{:?}", projects.warnings);
    assert_eq!(projects.color, None);
    let names: Vec<&str> = projects.entries.iter().map(|e| e.name.as_str()).collect();
    assert_eq!(names, ["Plan.one", "Archive"]);
    let projects_guid = guid_of("Work/Projects/Open Notebook.onetoc2");
    assert_eq!(ancestor_of("Work/Projects/Plan.one"), projects_guid);
    assert_eq!(
        ancestor_of("Work/Projects/Archive/Open Notebook.onetoc2"),
        projects_guid
    );
    let archive = parse_notebook_toc(f["Work/Projects/Archive/Open Notebook.onetoc2"]).unwrap();
    assert_eq!(archive.entries.len(), 1);
    assert_eq!(archive.entries[0].name, "Old.one");
    let empty = parse_notebook_toc(f["Work/Empty group/Open Notebook.onetoc2"]).unwrap();
    assert!(empty.entries.is_empty());
    assert!(empty.warnings.is_empty(), "{:?}", empty.warnings);

    // Every section reads back.
    for (path, title) in [
        ("Work/Plan+Budget, Q1.one", "Budget"),
        ("Work/CON_.one", "Device"),
        ("Work/Projects/Archive/Old.one", "History"),
    ] {
        let json = parse_one_note(f[path], ConvertOptions::default()).unwrap();
        assert!(
            json.diagnostics.warnings.is_empty(),
            "{path}: {:?}",
            json.diagnostics.warnings
        );
        let text = serde_json::to_value(&json).unwrap().to_string();
        assert!(text.contains(title), "{path}");
    }
}

/// A fresh directory under the system's temporary directory.
fn temp_dir(name: &str) -> PathBuf {
    let dir =
        std::env::temp_dir().join(format!("onenote-writer-test-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn save(out: &NotebookOutput, dir: &Path) {
    for f in &out.files {
        let path = dir.join(&f.path);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, &f.bytes).unwrap();
    }
}

#[derive(Debug, PartialEq)]
enum Tree {
    Section(String, usize),
    Group(String, Vec<Tree>),
}

fn tree(entries: &[SectionEntry]) -> Vec<Tree> {
    entries
        .iter()
        .map(|e| match e {
            SectionEntry::Section(s) => {
                assert!(
                    s.report().warnings().is_empty(),
                    "{}: {:?}",
                    s.display_name(),
                    s.report().warnings()
                );
                let pages = s.page_series().iter().map(|p| p.pages().len()).sum();
                Tree::Section(s.display_name().to_string(), pages)
            }
            SectionEntry::SectionGroup(g) => {
                Tree::Group(g.display_name().to_string(), tree(g.entries()))
            }
        })
        .collect()
}

#[test]
fn independent_reader_opens_the_folder() {
    let out = write_notebook(&notebook()).unwrap();
    let dir = temp_dir("independent");
    save(&out, &dir);
    let toc = dir.join("Work").join("Open Notebook.onetoc2");
    let notebook = Parser::new()
        .parse_notebook(TypedPath::derive(toc.to_str().unwrap()))
        .unwrap_or_else(|e| panic!("onenote_parser rejects the notebook: {e}"));
    let warnings: Vec<&str> = notebook
        .report()
        .warnings()
        .iter()
        .map(|w| w.message())
        .collect();
    assert!(warnings.is_empty(), "{warnings:?}");
    let color = notebook.color().unwrap();
    assert_eq!(
        (color.r(), color.g(), color.b()),
        (0x4f, 0x7c, 0xac),
        "notebook color"
    );
    let sample_pages = sample()["pages"].as_array().unwrap().len();
    assert_eq!(
        tree(notebook.entries()),
        [
            Tree::Section("Meetings".into(), sample_pages),
            Tree::Section("Plan+Budget, Q1".into(), 1),
            Tree::Section("CON".into(), 1),
            Tree::Section("notes".into(), 1),
            Tree::Section("Notes".into(), 1),
            Tree::Group(
                "Projects".into(),
                vec![
                    Tree::Section("Plan".into(), 1),
                    Tree::Group("Archive".into(), vec![Tree::Section("Old".into(), 1)]),
                ]
            ),
            Tree::Group("Empty group".into(), vec![]),
        ]
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn output_is_deterministic_and_identities_are_distinct() {
    let a = write_notebook(&notebook()).unwrap();
    let b = write_notebook(&notebook()).unwrap();
    assert_eq!(a.files.len(), b.files.len());
    for (x, y) in a.files.iter().zip(&b.files) {
        assert_eq!(x.path, y.path);
        assert!(x.bytes == y.bytes, "{} differs between runs", x.path);
    }
    let mut guids = HashSet::new();
    for f in &a.files {
        let g = OneStore::new(&f.bytes).unwrap().header.guid_file.clone();
        assert!(guids.insert(g), "{} repeats a guidFile", f.path);
    }
}

#[test]
fn awkward_input_is_repaired_with_warnings() {
    let nb = json!({
        "id": "nb2", "name": "  My: Notes?. ", "color": "nonsense",
        "sections": [
            section("dup", "A", "#111111", Some("missing"), "One"),
            section("dup", "B", "#222222", Some("c1"), "Two"),
            section("x", "", "#333333", Some("c3"), "Three"),
            "not a section",
        ],
        "groups": [
            { "id": "c1", "name": "Loop one", "parentId": "c2" },
            { "id": "c2", "name": "Loop two", "parentId": "c1" },
            { "id": "c1", "name": "Duplicate id" },
            { "id": "c3", "name": "Section.one", "parentId": "nowhere" },
            { "id": "c4", "name": "OneNote_RecycleBin" },
        ]
    });
    let out = write_notebook(&nb).unwrap();
    let paths: Vec<&str> = out.files.iter().map(|f| f.path.as_str()).collect();
    assert_eq!(
        paths,
        [
            "My_ Notes_/Open Notebook.onetoc2",
            "My_ Notes_/A.one",
            "My_ Notes_/Loop one/Open Notebook.onetoc2",
            "My_ Notes_/Loop one/B.one",
            "My_ Notes_/Loop one/Loop two/Open Notebook.onetoc2",
            "My_ Notes_/Section_one/Open Notebook.onetoc2",
            "My_ Notes_/Section_one/Untitled Section.one",
            "My_ Notes_/OneNote_RecycleBin (2)/Open Notebook.onetoc2",
        ]
    );
    let w = out.warnings.join("\n");
    for expected in [
        "saved as the folder “My_ Notes_”",
        "“A” belongs to a missing section group",
        "two sections have the id “dup”",
        "“Loop one” was inside itself",
        "the second, “Duplicate id”, was left out",
        "“Section.one” has a missing parent",
        "“Section.one” is saved as the folder “Section_one”",
        "“OneNote_RecycleBin” is saved as the folder “OneNote_RecycleBin (2)”",
        "a section that is not an object was left out",
    ] {
        assert!(w.contains(expected), "missing “{expected}” in:\n{w}");
    }
    // The two sections that share an id still get distinct identities.
    let f = files(&out);
    let a = OneStore::new(f["My_ Notes_/A.one"])
        .unwrap()
        .header
        .guid_file
        .clone();
    let b = OneStore::new(f["My_ Notes_/Loop one/B.one"])
        .unwrap()
        .header
        .guid_file
        .clone();
    assert_ne!(a, b);

    let dir = temp_dir("awkward");
    save(&out, &dir);
    let toc = dir.join("My_ Notes_").join("Open Notebook.onetoc2");
    let parsed = Parser::new()
        .parse_notebook(TypedPath::derive(toc.to_str().unwrap()))
        .unwrap();
    assert!(parsed.color().is_none());
    assert_eq!(
        parsed.entries().len(),
        4,
        "the recycle bin name was not reused"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn empty_and_minimal_notebooks() {
    let out = write_notebook(&json!({ "name": "Empty" })).unwrap();
    assert_eq!(out.files.len(), 1);
    assert_eq!(out.files[0].path, "Empty/Open Notebook.onetoc2");
    let toc = parse_notebook_toc(&out.files[0].bytes).unwrap();
    assert!(toc.entries.is_empty() && toc.warnings.is_empty());
    assert!(write_notebook(&json!([])).is_err());
    let out = write_notebook(&json!({})).unwrap();
    assert_eq!(out.files[0].path, "Notebook/Open Notebook.onetoc2");
}

// --- an independent check of the .onetoc2 container ---------------------------

fn u32_at(b: &[u8], o: usize) -> u32 {
    u32::from_le_bytes(b[o..o + 4].try_into().unwrap())
}
fn u64_at(b: &[u8], o: usize) -> u64 {
    u64::from_le_bytes(b[o..o + 8].try_into().unwrap())
}

/// MsoCrc32Compute ([MS-OSHARED] §2.4.3.2), bit by bit.
fn mso_crc32(data: &[u8]) -> u32 {
    let mut crc = 0u32;
    for &byte in data {
        crc ^= u32::from(byte) << 24;
        for _ in 0..8 {
            crc = if crc & 0x8000_0000 != 0 {
                (crc << 1) ^ 0xaf
            } else {
                crc << 1
            };
        }
    }
    crc
}

/// Bitwise CRC-32 (IEEE, reflected) for crcName.
fn crc32(data: &[u8]) -> u32 {
    let mut crc = !0u32;
    for &byte in data {
        crc ^= u32::from(byte);
        for _ in 0..8 {
            crc = if crc & 1 != 0 {
                (crc >> 1) ^ 0xedb8_8320
            } else {
                crc >> 1
            };
        }
    }
    !crc
}

/// (FileNodeID, reference (stp, cb), body) of a FileNode.
type Node = (u16, Option<(usize, usize)>, Vec<u8>);

/// Every node in a list.
fn read_list(b: &[u8], stp: usize, cb: usize, tx: &HashMap<u32, u32>) -> Vec<Node> {
    let mut out = Vec::new();
    let (mut stp, mut cb) = (stp, cb);
    let mut list_id = None;
    let mut seq = 0;
    loop {
        assert_eq!(u64_at(b, stp), 0xa456_7ab1_f5f7_f4c4, "fragment header");
        let id = u32_at(b, stp + 8);
        assert_eq!(*list_id.get_or_insert(id), id);
        assert_eq!(u32_at(b, stp + 12), seq);
        assert_eq!(
            u64_at(b, stp + cb - 8),
            0x8bc2_15c3_8233_ba4b,
            "fragment footer"
        );
        let end = stp + cb - 20;
        let mut p = stp + 16;
        while p + 4 <= end {
            let h = u32_at(b, p);
            if h == 0 {
                break;
            }
            assert!(h >> 31 == 1, "reserved bit");
            let fid = (h & 0x3ff) as u16;
            if fid == 0xff {
                break;
            }
            let size = ((h >> 10) & 0x1fff) as usize;
            let (stp_fmt, cb_fmt, base) = ((h >> 23) & 3, (h >> 25) & 3, (h >> 27) & 0xf);
            let mut q = p + 4;
            let reference = if base == 0 {
                None
            } else {
                let s = match stp_fmt {
                    0 => {
                        q += 8;
                        u64_at(b, q - 8) as usize
                    }
                    1 => {
                        q += 4;
                        u32_at(b, q - 4) as usize
                    }
                    other => panic!("stp format {other}"),
                };
                let c = match cb_fmt {
                    0 => {
                        q += 4;
                        u32_at(b, q - 4) as usize
                    }
                    2 => {
                        q += 1;
                        b[q - 1] as usize * 8
                    }
                    3 => {
                        q += 2;
                        u16::from_le_bytes([b[q - 2], b[q - 1]]) as usize * 8
                    }
                    other => panic!("cb format {other}"),
                };
                Some((s, c))
            };
            out.push((fid, reference, b[q..p + size].to_vec()));
            p += size;
        }
        let next = u64_at(b, end);
        if next == u64::MAX {
            break;
        }
        cb = u32_at(b, end + 8) as usize;
        stp = next as usize;
        seq += 1;
    }
    assert_eq!(
        tx.get(&list_id.unwrap()).copied(),
        Some(out.len() as u32),
        "the transaction commits every node"
    );
    out
}

fn verify_toc(b: &[u8]) {
    // Header: .onetoc2 type, format, version 0x1B, crcName.
    assert_eq!(
        b[0..16],
        [
            0xa1, 0x2f, 0xff, 0x43, 0xd9, 0xef, 0x76, 0x4c, 0x9e, 0xe2, 0x10, 0xea, 0x57, 0x22,
            0x76, 0x5f
        ]
    );
    assert_eq!(
        b[0x30..0x40],
        [
            0x3f, 0xdd, 0x9a, 0x10, 0x1b, 0x91, 0xf5, 0x49, 0xa5, 0xd0, 0x17, 0x91, 0xed, 0xc8,
            0xae, 0xd8
        ]
    );
    for o in [0x40, 0x44, 0x48, 0x4c] {
        assert_eq!(u32_at(b, o), 0x1b);
    }
    let name: Vec<u8> = "Open Notebook.onetoc2"
        .encode_utf16()
        .chain([0])
        .flat_map(u16::to_le_bytes)
        .collect();
    assert_eq!(u32_at(b, 0x90), crc32(&name), "crcName");
    assert_eq!(u64_at(b, 0x94), u64::MAX, "no hashed chunk list");
    assert_eq!(u64_at(b, 0xc4), b.len() as u64);

    // Transaction log: the sentinel holds the MsoCrc32 of the entries.
    let (tstp, tcb) = (u64_at(b, 0xa0) as usize, u32_at(b, 0xa8) as usize);
    let n = (tcb - 12) / 8;
    let mut tx = HashMap::new();
    for k in 0..n - 1 {
        tx.insert(u32_at(b, tstp + 8 * k), u32_at(b, tstp + 8 * k + 4));
    }
    assert_eq!(u32_at(b, tstp + 8 * (n - 1)), 1);
    assert_eq!(
        u32_at(b, tstp + 8 * (n - 1) + 4),
        mso_crc32(&b[tstp..tstp + 8 * (n - 1)]),
        "transaction CRC (MsoCrc32)"
    );

    let root = read_list(b, u64_at(b, 0xac) as usize, u32_at(b, 0xb4) as usize, &tx);
    let ids: Vec<u16> = root.iter().map(|n| n.0).collect();
    assert_eq!(ids, [0x08, 0x04]);
    assert_eq!(root[0].2, root[1].2, "the object space is the root");
    let (s, c) = root[0].1.unwrap();
    let osl = read_list(b, s, c, &tx);
    assert_eq!(osl.iter().map(|n| n.0).collect::<Vec<_>>(), [0x0c, 0x10]);
    let (s, c) = osl[1].1.unwrap();
    let rev = read_list(b, s, c, &tx);
    // RevisionManifestListStart, Start4, the global id table, declarations,
    // the root reference, End.
    let ids: Vec<u16> = rev.iter().map(|n| n.0).collect();
    assert_eq!(&ids[..3], [0x14, 0x1b, 0x21]);
    assert_eq!(
        rev[1].2.len(),
        20 + 20 + 8 + 4 + 2,
        "RevisionManifestStart4FND"
    );
    assert_eq!(u32_at(&rev[1].2, 48), 1, "role 1");
    assert_eq!(rev[2].2, [0], "GlobalIdTableStartFNDX.Reserved");
    let entries = ids[3..].iter().take_while(|&&i| i == 0x24).count();
    let mut p = 3 + entries;
    assert_eq!(ids[p], 0x28);
    p += 1;
    let decls = ids[p..].iter().take_while(|&&i| i == 0x2d).count();
    assert!(decls >= 1);
    for d in &rev[p..p + decls] {
        let body = &d.2;
        assert_eq!(body.len(), 4 + 2 + 4 + 1);
        assert_eq!(u16::from_le_bytes([body[4], body[5]]), 1, "jci 1, odcs 0");
        assert_eq!(body[10], 1, "each object is referenced once");
        assert!(d.1.unwrap().1 > 0);
    }
    p += decls;
    assert_eq!(&ids[p..], [0x59, 0x1c]);
    assert_eq!(u32_at(&rev[p].2, 4), 1, "content root");
    assert_eq!(tx.len(), 3, "root, object space and revision lists logged");
}

#[test]
fn tables_of_contents_verify() {
    let out = write_notebook(&notebook()).unwrap();
    for f in &out.files {
        if f.path.ends_with(".onetoc2") {
            verify_toc(&f.bytes);
        }
    }
}
