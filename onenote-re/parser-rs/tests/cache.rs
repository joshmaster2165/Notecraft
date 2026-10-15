//! Port of parser/src/cache.test.ts.
#![cfg(not(target_arch = "wasm32"))]

use std::fs;
use std::path::{Path, PathBuf};

use onenote_re::cache::{
    file_id_to_name, parse_cache_header, parse_file_id_name, CacheFileKind, CacheStats, FileIdName,
    OneNoteCache, CACHE_HEADER_SIZE,
};
use onenote_re::reader::hex;
use onenote_re::FileDataQuery;
use sha1::{Digest, Sha1};

#[test]
fn file_ids_are_8_big_endian_base_32_digits() {
    assert_eq!(file_id_to_name(0, false).unwrap(), "00000000.bin");
    assert_eq!(file_id_to_name(230, false).unwrap(), "00000076.bin");
    assert_eq!(file_id_to_name(0x7a, true).unwrap(), "0000003Q.enc");
    assert_eq!(
        file_id_to_name((1 << 40) - 1, false).unwrap(),
        "VVVVVVVV.bin"
    );
    assert!(file_id_to_name(1 << 40, false).is_err());
    assert_eq!(
        parse_file_id_name("0000004P.bin"),
        Some(FileIdName {
            file_id: 4 * 32 + 25,
            encrypted: false
        })
    );
    assert_eq!(parse_file_id_name("header"), None);
    assert_eq!(parse_file_id_name("0000004W.bin"), None);
    assert_eq!(parse_file_id_name("0000004p.bin"), None);
    for id in [1, 31, 32, 1023, 123_456_789] {
        assert_eq!(
            parse_file_id_name(&file_id_to_name(id, false).unwrap())
                .unwrap()
                .file_id,
            id
        );
    }
}

fn header(last_file_id: u64) -> Vec<u8> {
    let mut b = vec![0u8; CACHE_HEADER_SIZE];
    b[4..8].copy_from_slice(&0x062c_0f27u32.to_le_bytes());
    b[0x24..0x2c].copy_from_slice(&last_file_id.to_le_bytes());
    b
}

#[test]
fn header_fields() {
    let h = parse_cache_header(&header(230)).unwrap();
    assert_eq!(h.format_mode, 0);
    assert_eq!(h.creation_tag, 0x062c_0f27);
    assert_eq!(h.last_file_id, 230);
    assert_eq!(h.words.len(), 18);
    assert!(parse_cache_header(&[0u8; 10]).is_err());
}

/// A fresh directory under the system temp dir, removed on drop.
struct TempDir(PathBuf);

impl TempDir {
    fn new(tag: &str) -> TempDir {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let p =
            std::env::temp_dir().join(format!("onenote-re-{tag}-{}-{nanos}", std::process::id()));
        fs::create_dir_all(&p).unwrap();
        TempDir(p)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn indexes_a_cache_folder_and_resolves_file_data_by_sha1() {
    let tmp = TempDir::new("cache");
    let dir = tmp.path();
    let png = [0x89u8, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4];
    let mut page = vec![0u8; 4096];
    page[..6].copy_from_slice(&[0x42, 0x4d, 0x32, 0x00, 0x00, 0xc0]); // "BM" whose size field is wrong: not a BMP
    fs::write(dir.join("header"), header(3)).unwrap();
    fs::write(dir.join("00000000.bin"), &page).unwrap();
    fs::write(dir.join("00000002.bin"), png).unwrap();
    fs::write(dir.join("00000003.enc"), [0u8; 16]).unwrap();
    fs::write(dir.join("notes.txt"), "ignored").unwrap();
    fs::create_dir(dir.join("tmp")).unwrap();
    fs::write(dir.join("tmp").join("00000004.bin"), [0u8; 1]).unwrap();

    let cache = OneNoteCache::new(dir).unwrap();
    let files: Vec<(&str, CacheFileKind, Option<&str>)> = cache
        .files
        .iter()
        .map(|f| (f.name.as_str(), f.kind, f.media_type.as_deref()))
        .collect();
    assert_eq!(
        files,
        [
            ("00000000.bin", CacheFileKind::Store, None),
            ("00000002.bin", CacheFileKind::FileData, Some("image/png")),
            ("00000003.enc", CacheFileKind::Encrypted, None),
        ]
    );
    assert_eq!(
        cache.stats(),
        CacheStats {
            dir: dir.to_string_lossy().into_owned(),
            files: 3,
            file_data: 1,
            encrypted: 1,
            store: 1,
            staged: 1,
            last_file_id: Some(3),
        }
    );

    let sha1 = hex(&Sha1::digest(png));
    assert_eq!(
        cache
            .find_by_sha1(&sha1.to_uppercase())
            .map(|f| f.name.as_str()),
        Some("00000002.bin")
    );
    let resolve = cache.resolver();
    let query = |hash: Option<String>| FileDataQuery {
        container_id: "{X}#1".into(),
        unverified_hash: hash,
        extension: None,
    };
    let hit = resolve(&query(Some(sha1.clone()))).unwrap();
    assert_eq!(hit.bytes, png);
    assert_eq!(hit.source, "cache/00000002.bin");
    assert_eq!(resolve(&query(Some("00".repeat(20)))), None);
    assert_eq!(resolve(&query(None)), None);

    let s_one = |root: &Path| root.join("Backup").join("nb").join("s.one");
    assert_eq!(OneNoteCache::find_for(s_one(&dir.join(".."))), None);
    let root = TempDir::new("15.0");
    fs::create_dir(root.path().join("cache")).unwrap();
    fs::write(root.path().join("cache").join("header"), header(0)).unwrap();
    assert_eq!(
        OneNoteCache::find_for(s_one(root.path())),
        Some(root.path().join("cache"))
    );
}
