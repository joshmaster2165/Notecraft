#![recursion_limit = "512"]
//! Structural self-checks with a verifier written here, independently of the
//! writer: header fields and crcName, the transaction log and its CRC, every
//! FileNodeList fragment, FileNode headers, reference counts and their CRC,
//! read-only MD5s; plus determinism, empty sections and large pictures.

mod common;

use std::collections::{HashMap, HashSet};
use std::io::Read;

use md5::{Digest, Md5};
use serde_json::{json, Value};

use common::*;

/// Bitwise CRC-32 (IEEE, reflected), unrelated to the writer's table.
fn crc32(data: &[u8]) -> u32 {
    let mut c = 0xffff_ffffu32;
    for &b in data {
        c ^= u32::from(b);
        for _ in 0..8 {
            c = if c & 1 != 0 {
                (c >> 1) ^ 0xedb8_8320
            } else {
                c >> 1
            };
        }
    }
    !c
}

fn u16_at(b: &[u8], o: usize) -> u16 {
    u16::from_le_bytes(b[o..o + 2].try_into().unwrap())
}
fn u32_at(b: &[u8], o: usize) -> u32 {
    u32::from_le_bytes(b[o..o + 4].try_into().unwrap())
}
fn u64_at(b: &[u8], o: usize) -> u64 {
    u64::from_le_bytes(b[o..o + 8].try_into().unwrap())
}

struct Node {
    id: u32,
    reference: Option<(usize, usize)>,
    body: Vec<u8>,
}

#[derive(Default)]
struct Report {
    lists: HashMap<u32, usize>,
    fragments: usize,
    nodes: usize,
    declarations: usize,
    read_only: usize,
    large: usize,
    groups: usize,
}

struct Verifier<'a> {
    b: &'a [u8],
    read_only_blobs: HashSet<(usize, usize)>,
    tx: HashMap<u32, u32>,
    seen_fragments: HashSet<(u32, u32)>,
    r: Report,
}

impl Verifier<'_> {
    fn list(&mut self, mut stp: usize, mut cb: usize) -> Vec<Node> {
        let b = self.b;
        let mut nodes = Vec::new();
        let mut id = None;
        let mut seq = 0;
        loop {
            assert_eq!(stp % 8, 0, "fragment alignment");
            assert!(stp + cb <= b.len());
            assert_eq!(
                u64_at(b, stp),
                0xa456_7ab1_f5f7_f4c4,
                "fragment header magic"
            );
            let list_id = u32_at(b, stp + 8);
            assert!(list_id >= 0x10);
            assert_eq!(*id.get_or_insert(list_id), list_id);
            assert_eq!(u32_at(b, stp + 12), seq, "nFragmentSequence");
            assert!(self.seen_fragments.insert((list_id, seq)));
            assert_eq!(
                u64_at(b, stp + cb - 8),
                0x8bc2_15c3_8233_ba4b,
                "fragment footer"
            );
            self.r.fragments += 1;
            let end = stp + cb - 20;
            let mut p = stp + 16;
            let mut terminated = false;
            while p + 4 <= end {
                let h = u32_at(b, p);
                if h == 0 {
                    break;
                }
                assert_eq!(h >> 31, 1, "FileNode reserved bit");
                let nid = h & 0x3ff;
                let size = ((h >> 10) & 0x1fff) as usize;
                if nid == 0xff {
                    assert_eq!(size, 4);
                    terminated = true;
                    break;
                }
                let (stp_f, cb_f, base) = ((h >> 23) & 3, (h >> 25) & 3, (h >> 27) & 0xf);
                let mut q = p + 4;
                let reference = if base == 1 || base == 2 {
                    let s = match stp_f {
                        0 => {
                            q += 8;
                            u64_at(b, q - 8) as usize
                        }
                        1 => {
                            q += 4;
                            u32_at(b, q - 4) as usize
                        }
                        2 => {
                            q += 2;
                            u16_at(b, q - 2) as usize * 8
                        }
                        _ => {
                            q += 4;
                            u32_at(b, q - 4) as usize * 8
                        }
                    };
                    let c = match cb_f {
                        0 => {
                            q += 4;
                            u32_at(b, q - 4) as usize
                        }
                        1 => {
                            q += 8;
                            u64_at(b, q - 8) as usize
                        }
                        2 => {
                            q += 1;
                            b[q - 1] as usize * 8
                        }
                        _ => {
                            q += 2;
                            u16_at(b, q - 2) as usize * 8
                        }
                    };
                    (c != 0).then_some((s, c))
                } else {
                    assert_eq!((stp_f, cb_f), (1, 0), "OneNote's formats for plain nodes");
                    None
                };
                if let Some((s, c)) = reference {
                    assert!(s + c <= b.len() && s % 8 == 0, "reference inside the file");
                }
                nodes.push(Node {
                    id: nid,
                    reference,
                    body: b[q..p + size].to_vec(),
                });
                p += size;
            }
            assert!(p <= end);
            let next = u64_at(b, end);
            if next == u64::MAX {
                assert!(
                    !terminated,
                    "ChunkTerminatorFND only before another fragment"
                );
                break;
            }
            assert!(
                terminated,
                "non-final fragments end with ChunkTerminatorFND"
            );
            stp = next as usize;
            cb = u32_at(b, end + 8) as usize;
            seq += 1;
        }
        let id = id.unwrap();
        assert_eq!(
            self.tx.get(&id).copied(),
            Some(nodes.len() as u32),
            "committed count of list {id:#x}"
        );
        self.r.lists.insert(id, nodes.len());
        self.r.nodes += nodes.len();
        nodes
    }

    fn object_group(&mut self, nodes: &[Node]) -> Vec<u32> {
        self.r.groups += 1;
        assert_eq!(nodes[0].id, 0xb4);
        assert_eq!(nodes[1].id, 0x22);
        let mut table = HashMap::new();
        let mut i = 2;
        while nodes[i].id == 0x24 {
            let idx = u32_at(&nodes[i].body, 0);
            assert!(table.insert(idx, nodes[i].body[4..20].to_vec()).is_none());
            i += 1;
        }
        assert_eq!(nodes[i].id, 0x28);
        assert_eq!(nodes.last().unwrap().id, 0xb8);
        let mut crefs = Vec::new();
        for n in &nodes[i + 1..nodes.len() - 1] {
            self.r.declarations += 1;
            let cid = u32_at(&n.body, 0);
            assert!(
                table.contains_key(&(cid >> 8)),
                "object id in the global id table"
            );
            let jcid = u32_at(&n.body, 4);
            match n.id {
                0xa4 | 0xa5 | 0xc4 | 0xc5 => {
                    let large = n.id & 1 == 1;
                    let cref = if large {
                        u32_at(&n.body, 9)
                    } else {
                        u32::from(n.body[9])
                    };
                    assert!(large == (cref > 255));
                    self.r.large += usize::from(large);
                    let (s, c) = n.reference.expect("property set");
                    assert_eq!(c % 8, 0, "property sets are padded to 8");
                    let read_only = jcid & 0x10_0000 != 0;
                    assert_eq!(
                        read_only,
                        n.id >= 0xc4,
                        "read-only JCIDs use ReadOnlyObjectDeclaration2*"
                    );
                    if read_only {
                        self.r.read_only += 1;
                        self.read_only_blobs.insert((s, c));
                        let at = if large { 13 } else { 10 };
                        let md5 = Md5::digest(&self.b[s..s + c]);
                        assert_eq!(&n.body[at..at + 16], md5.as_slice(), "md5Hash");
                    }
                    // Every CompactID in the OID stream resolves.
                    let h = u32_at(self.b, s);
                    for k in 0..(h & 0xff_ffff) as usize {
                        let id = u32_at(self.b, s + 4 + 4 * k);
                        assert!(table.contains_key(&(id >> 8)));
                    }
                    crefs.push(cref);
                }
                0x72 | 0x73 => {
                    assert_eq!(jcid & 0x8_0000, 0x8_0000);
                    crefs.push(if n.id == 0x72 {
                        u32::from(n.body[8])
                    } else {
                        u32_at(&n.body, 8)
                    });
                }
                other => panic!("unexpected node {other:#x} in an object group"),
            }
        }
        crefs
    }

    fn space(&mut self, osl: (usize, usize)) {
        let nodes = self.list(osl.0, osl.1);
        assert_eq!(nodes.iter().map(|n| n.id).collect::<Vec<_>>(), [0x0c, 0x10]);
        let (s, c) = nodes[1].reference.unwrap();
        let rev = self.list(s, c);
        let ids: Vec<u32> = rev.iter().map(|n| n.id).collect();
        assert_eq!(&ids[..4], [0x14, 0x1e, 0xb0, 0x84]);
        assert_eq!(*ids.last().unwrap(), 0x1c);
        assert!(ids[4..ids.len() - 1].iter().all(|&i| i == 0x5a));
        assert_eq!(u32_at(&rev[1].body, 40), 1, "revision role 1");
        let (gs, gc) = rev[2].reference.unwrap();
        let group = self.list(gs, gc);
        let crefs = self.object_group(&group);
        // ObjectInfoDependencyOverridesFND: fcrNil reference, no overrides,
        // CRC of the group's reference counts.
        let over = &rev[3];
        assert!(over.reference.is_none());
        assert_eq!(u32_at(&over.body, 0), 0);
        assert_eq!(u32_at(&over.body, 4), 0);
        let data: Vec<u8> = crefs.iter().flat_map(|c| c.to_le_bytes()).collect();
        assert_eq!(u32_at(&over.body, 8), crc32(&data), "reference count CRC");
    }
}

fn verify(bytes: &[u8], file_name: &str) -> Report {
    let b = bytes;
    assert!(b.len() > 1024);
    let guid = |o: usize| b[o..o + 16].to_vec();
    assert_eq!(
        guid(0),
        [
            0xe4, 0x52, 0x5c, 0x7b, 0x8c, 0xd8, 0xa7, 0x4d, 0xae, 0xb1, 0x53, 0x78, 0xd0, 0x29,
            0x96, 0xd3
        ]
    );
    assert_eq!(guid(0x20), [0; 16]);
    assert_eq!(
        guid(0x30),
        [
            0x3f, 0xdd, 0x9a, 0x10, 0x1b, 0x91, 0xf5, 0x49, 0xa5, 0xd0, 0x17, 0x91, 0xed, 0xc8,
            0xae, 0xd8
        ]
    );
    for o in [0x40, 0x44, 0x48, 0x4c] {
        assert_eq!(u32_at(b, o), 0x2a);
    }
    assert_eq!(u64_at(b, 0x50), 0, "fcrLegacyFreeChunkList fcrZero");
    assert_eq!(
        (u32_at(b, 0x58), u32_at(b, 0x5c)),
        (u32::MAX, 0),
        "fcrLegacyTransactionLog fcrNil"
    );
    assert_eq!(u32_at(b, 0x60), 1, "cTransactionsInLog");
    assert_eq!(
        (u32_at(b, 0x70), u32_at(b, 0x74)),
        (u32::MAX, 0),
        "fcrLegacyFileNodeListRoot fcrNil"
    );
    let name: Vec<u8> = file_name
        .encode_utf16()
        .chain([0])
        .flat_map(u16::to_le_bytes)
        .collect();
    assert_eq!(u32_at(b, 0x90), crc32(&name), "crcName");
    assert_eq!(u64_at(b, 0xc4), b.len() as u64, "cbExpectedFileLength");
    assert!(b[0x128..0x400].iter().all(|&x| x == 0), "rgbReserved");

    // Transaction log: one transaction, sentinel CRC over the entries.
    let (tstp, tcb) = (u64_at(b, 0xa0) as usize, u32_at(b, 0xa8) as usize);
    let n = (tcb - 12) / 8;
    let mut tx = HashMap::new();
    for k in 0..n - 1 {
        let (src, count) = (u32_at(b, tstp + 8 * k), u32_at(b, tstp + 8 * k + 4));
        assert_ne!(src, 1);
        assert!(count > 0);
        assert!(tx.insert(src, count).is_none());
    }
    assert_eq!(u32_at(b, tstp + 8 * (n - 1)), 1, "sentinel");
    assert_eq!(
        u32_at(b, tstp + 8 * (n - 1) + 4),
        crc32(&b[tstp..tstp + 8 * (n - 1)]),
        "transaction CRC"
    );

    let mut v = Verifier {
        b,
        read_only_blobs: HashSet::new(),
        tx,
        seen_fragments: HashSet::new(),
        r: Report::default(),
    };
    let root = v.list(u64_at(b, 0xac) as usize, u32_at(b, 0xb4) as usize);
    assert_eq!(root[0].id, 0x08);
    assert_eq!(root[1].id, 0x04);
    assert_eq!(
        root[0].body, root[1].body,
        "the first object space is the root"
    );
    for n in &root {
        match n.id {
            0x08 => v.space(n.reference.unwrap()),
            0x04 => {}
            0x90 => {
                let (s, c) = n.reference.unwrap();
                for f in v.list(s, c) {
                    assert_eq!(f.id, 0x94);
                    let (fs, fc) = f.reference.unwrap();
                    assert_eq!(fc % 8, 0);
                    assert_eq!(
                        b[fs..fs + 16],
                        [
                            0xe7, 0x16, 0xe3, 0xbd, 0x65, 0x26, 0x11, 0x45, 0xa4, 0xc4, 0x8d, 0x4d,
                            0x0b, 0x7a, 0x9e, 0xac
                        ]
                    );
                    let len = u64_at(b, fs + 16) as usize;
                    assert!(36 + len + 16 <= fc && fc - (36 + len + 16) < 8);
                    assert_eq!(
                        b[fs + fc - 16..fs + fc],
                        [
                            0x22, 0xa7, 0xfb, 0x71, 0x79, 0x0f, 0x0b, 0x4a, 0xbb, 0x13, 0x89, 0x92,
                            0x56, 0x42, 0x6b, 0x24
                        ]
                    );
                }
            }
            other => panic!("unexpected root node {other:#x}"),
        }
    }
    // Hashed chunk list: an MD5 for every read-only property set.
    let (hstp, hcb) = (u64_at(b, 0x94) as usize, u32_at(b, 0x9c) as usize);
    if v.r.read_only > 0 {
        let hashed = v.list(hstp, hcb);
        assert_eq!(hashed.len(), v.r.read_only);
        for n in &hashed {
            assert_eq!(n.id, 0xc2);
            let (s, c) = n.reference.unwrap();
            assert!(
                v.read_only_blobs.contains(&(s, c)),
                "descriptor points at a read-only property set"
            );
            assert_eq!(n.body, Md5::digest(&b[s..s + c]).as_slice());
        }
    } else {
        assert_eq!((hstp, hcb), (u64::MAX as usize, 0));
    }
    assert_eq!(
        v.r.lists.len(),
        v.tx.len(),
        "every logged list is reachable"
    );
    v.r
}

#[test]
fn structure_and_checksums_verify() {
    let out = onenote_writer::write_section(&sample()).unwrap();
    let r = verify(&out, &onenote_writer::suggested_file_name(&sample()));
    assert_eq!(
        onenote_writer::suggested_file_name(&sample()),
        "Writer Test.one"
    );
    assert!(r.read_only > 0 && r.declarations > 100 && r.groups == 5);
    // The file name in crcName follows the option.
    let named = onenote_writer::write_section_with(
        &sample(),
        &onenote_writer::WriteOptions {
            file_name: Some("Elsewhere.one".into()),
        },
    )
    .unwrap();
    verify(&named.bytes, "Elsewhere.one");
}

#[test]
fn output_is_deterministic() {
    let a = onenote_writer::write_section(&sample()).unwrap();
    let b = onenote_writer::write_section(&sample()).unwrap();
    assert_eq!(a, b);
    // Same section, other content: same file identity, new file version.
    let mut changed = sample();
    changed["pages"][0]["title"] = json!("Renamed");
    let c = onenote_writer::write_section(&changed).unwrap();
    assert_ne!(a, c);
    assert_eq!(a[0x10..0x20], c[0x10..0x20], "guidFile");
    assert_ne!(a[0xd4..0xe4], c[0xd4..0xe4], "guidFileVersion");
    // Another section id: another identity.
    let mut other = sample();
    other["id"] = json!("sec-2");
    let d = onenote_writer::write_section(&other).unwrap();
    assert_ne!(a[0x10..0x20], d[0x10..0x20]);
}

#[test]
fn empty_sections_and_pages() {
    for (section, pages) in [
        (json!({ "id": "e", "name": "Empty", "pages": [] }), 0),
        (
            json!({ "id": "e", "name": "One blank page", "pages": [{ "id": "p" }] }),
            1,
        ),
        (json!({}), 0),
    ] {
        let bytes = onenote_writer::write_section(&section).unwrap();
        verify(&bytes, &onenote_writer::suggested_file_name(&section));
        let json = onenote_re::parse_one_note(&bytes, Default::default()).unwrap();
        assert!(
            json.diagnostics.warnings.is_empty(),
            "{:?}",
            json.diagnostics.warnings
        );
        assert_eq!(json.section.pages.len(), pages);
    }
    assert_eq!(
        onenote_writer::suggested_file_name(&json!({ "name": "a/b:c?" })),
        "a_b_c_.one"
    );
    assert_eq!(
        onenote_writer::suggested_file_name(&json!({})),
        "Section.one"
    );
}

#[test]
fn rejects_non_objects() {
    for v in [json!(null), json!([1, 2]), json!("section")] {
        assert!(matches!(
            onenote_writer::write_section(&v),
            Err(onenote_writer::WriteError::InvalidInput(_))
        ));
    }
}

fn big_section(picture: &[u8], second: &[u8]) -> Value {
    json!({
        "id": "big", "name": "Big",
        "pages": [{
            "id": "p", "title": "Pictures",
            "outlines": [{ "id": "o", "x": 54, "y": 90, "width": 600, "elements": [
                { "id": "a", "kind": "image", "depth": 0, "image": { "src": data_url("image/png", picture), "width": 800, "height": 600 } },
                { "id": "b", "kind": "image", "depth": 0, "image": { "src": data_url("image/png", picture), "width": 400, "height": 300 } },
                { "id": "c", "kind": "file", "depth": 0, "name": "big.bin", "src": data_url("application/octet-stream", second) }
            ]}],
            "images": []
        }]
    })
}

#[test]
fn large_pictures() {
    let picture = big_png_like(6 * 1024 * 1024 + 3, 11);
    let second = big_png_like(3 * 1024 * 1024 + 5, 12);
    let bytes = onenote_writer::write_section(&big_section(&picture, &second)).unwrap();
    verify(&bytes, "Big.one");
    // The same picture twice is stored once.
    assert!(
        bytes.len() < picture.len() + second.len() + 200_000,
        "{}",
        bytes.len()
    );

    let store = onenote_re::OneStore::new(&bytes).unwrap();
    let mut found: Vec<usize> = store
        .file_data
        .values()
        .map(|f| f.length as usize)
        .collect();
    found.sort_unstable();
    assert!(found.contains(&picture.len()) && found.contains(&second.len()));

    let mut seen = Vec::new();
    let opts = onenote_re::ConvertOptions {
        on_asset: Some(Box::new(|a: onenote_re::Asset<'_>| {
            seen.push(a.bytes.to_vec());
            None
        })),
        ..Default::default()
    };
    let json = onenote_re::parse_one_note(&bytes, opts).unwrap();
    assert!(json.diagnostics.warnings.is_empty());
    drop(json);
    assert!(seen.iter().filter(|b| **b == picture).count() == 2);
    assert!(seen.contains(&second));

    let s = onenote_parser::Parser::new()
        .parse_section_buffer(&bytes, typed_path::TypedPath::derive("Big.one"))
        .unwrap();
    let page = &s.page_series()[0].pages()[0];
    let outline = page.contents()[0].outline().unwrap();
    let mut buf = Vec::new();
    let image = outline.items()[0].element().unwrap().contents()[0]
        .image()
        .unwrap();
    image.read().unwrap().read_to_end(&mut buf).unwrap();
    assert_eq!(buf, picture);
}

#[test]
fn many_objects_split_lists_and_large_reference_counts() {
    // 3000 paragraphs share one paragraph style and one author: reference
    // counts above 255 (the Large declarations) and object groups that span
    // several fragments.
    let elements: Vec<Value> = (0..3000)
        .map(|i| json!({ "id": format!("e{i}"), "kind": "text", "depth": i % 3, "runs": [{ "text": format!("Line {i}") }] }))
        .collect();
    let section = json!({
        "id": "many", "name": "Many",
        "pages": [{ "id": "p", "title": "Many lines", "outlines": [{ "id": "o", "x": 54, "y": 90, "width": 400, "elements": elements }] }]
    });
    let bytes = onenote_writer::write_section(&section).unwrap();
    let r = verify(&bytes, "Many.one");
    assert!(r.large >= 2, "{}", r.large);
    assert!(r.fragments > r.lists.len(), "lists were split");

    let json = onenote_re::parse_one_note(&bytes, Default::default()).unwrap();
    assert!(json.diagnostics.warnings.is_empty());
    let s = onenote_parser::Parser::new()
        .parse_section_buffer(&bytes, typed_path::TypedPath::derive("Many.one"))
        .unwrap();
    assert!(s.report().warnings().is_empty());
    let page = &s.page_series()[0].pages()[0];
    let mut count = 0;
    fn walk(items: &[onenote_parser::contents::OutlineItem], count: &mut usize) {
        for i in items {
            if let Some(e) = i.element() {
                *count += 1;
                walk(e.children(), count);
            }
        }
    }
    walk(page.contents()[0].outline().unwrap().items(), &mut count);
    assert_eq!(count, 3000);
}

#[test]
fn notebook_sections_verify() {
    let mut first = sample();
    first["id"] = json!("nb-s1");
    let mut second = sample();
    second["id"] = json!("nb-s2");
    second["name"] = json!("Second: copy");
    second["groupId"] = json!("g");
    let notebook = json!({
        "id": "nb", "name": "Checked", "color": "#336699",
        "sections": [first, second],
        "groups": [{ "id": "g", "name": "Group" }]
    });
    let out = onenote_writer::write_notebook(&notebook).unwrap();
    let mut sections = 0;
    for f in out.files.iter().filter(|f| f.path.ends_with(".one")) {
        let name = f.path.rsplit('/').next().unwrap();
        verify(&f.bytes, name);
        assert_ne!(f.bytes[0x80..0x90], [0; 16], "guidAncestor names the TOC");
        sections += 1;
    }
    assert_eq!(sections, 2);
}
