//! OneNote for Mac's local cache store: .../OneNote/15.0/cache (docs/file-format.md §11).
//!
//! ```text
//!   header             72 bytes: format mode, last allocated FileID, root references.
//!   <FileID>.bin|.enc  one file per FileID. A FileID is a 40-bit counter written as
//!                      8 base-32 digits (0-9, A-V), most significant first.
//!   tmp/               staging: new files are created here and moved into place
//!                      when their transaction commits.
//! ```
//!
//! Two kinds of file share the FileID namespace:
//!   - allocator files: memory-mapped pages of OneNote's transactional object
//!     store (revisions, object groups, property sets, dictionaries). Not decoded.
//!   - file data objects (FDOs): one standard-I/O file per downloaded image or
//!     attachment, holding the downloaded bytes. OneNote fetches FDOs on demand,
//!     so a cache can hold a notebook's whole graph and none of its pictures.
//!
//! FDOs are matched to images by content: an ImageNode's 20-byte UnverifiedHash
//! is compared with the SHA-1 of every readable cache file. A match is conclusive;
//! a miss is not, because the algorithm behind UnverifiedHash is not confirmed in
//! OneNote's code.

use std::cell::OnceCell;
use std::collections::HashMap;
use std::fmt;
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};

use serde::Serialize;
use sha1::{Digest, Sha1};

use crate::notebook::{sniff_media_type, FileDataQuery, ResolvedFileData};
use crate::reader::hex;

pub const CACHE_HEADER_SIZE: usize = 0x48;
const FILE_ID_DIGITS: &[u8; 32] = b"0123456789ABCDEFGHIJKLMNOPQRSTUV";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CacheError(pub String);

impl fmt::Display for CacheError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for CacheError {}

/// File name for a FileID (FUN_1000716ec + FUN_100071664).
pub fn file_id_to_name(id: u64, encrypted: bool) -> Result<String, CacheError> {
    if id >= 1 << 40 {
        return Err(CacheError(format!("FileID {id} is not a 40-bit value")));
    }
    let mut s = [0u8; 8];
    let mut v = id;
    for slot in s.iter_mut().rev() {
        *slot = FILE_ID_DIGITS[(v % 32) as usize];
        v /= 32;
    }
    Ok(format!(
        "{}{}",
        String::from_utf8_lossy(&s),
        if encrypted { ".enc" } else { ".bin" }
    ))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FileIdName {
    pub file_id: u64,
    pub encrypted: bool,
}

/// Parses `^([0-9A-V]{8})\.(bin|enc)$`.
pub fn parse_file_id_name(name: &str) -> Option<FileIdName> {
    let (digits, ext) = name.split_at_checked(8)?;
    let encrypted = match ext {
        ".bin" => false,
        ".enc" => true,
        _ => return None,
    };
    let mut id = 0u64;
    for c in digits.bytes() {
        let d = FILE_ID_DIGITS.iter().position(|&x| x == c)?;
        id = id * 32 + d as u64;
    }
    Some(FileIdName {
        file_id: id,
        encrypted,
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CacheHeader {
    /// u32 @0x00. 0 on an unencrypted store; the initializer can also write 4 or 5.
    pub format_mode: u32,
    /// u32 @0x04, written once when the store is created.
    pub creation_tag: u32,
    /// u64 @0x24: the last FileID handed out (new IDs are pre-incremented).
    pub last_file_id: u64,
    /// All 18 little-endian u32 words, including the reference fields not decoded yet.
    pub words: Vec<u32>,
}

pub fn parse_cache_header(buf: &[u8]) -> Result<CacheHeader, CacheError> {
    if buf.len() < CACHE_HEADER_SIZE {
        return Err(CacheError(format!(
            "cache header is {} bytes, expected {CACHE_HEADER_SIZE}",
            buf.len()
        )));
    }
    let words: Vec<u32> = buf[..CACHE_HEADER_SIZE]
        .as_chunks::<4>()
        .0
        .iter()
        .map(|w| u32::from_le_bytes(*w))
        .collect();
    let mut last = [0u8; 8];
    last.copy_from_slice(&buf[0x24..0x2c]);
    Ok(CacheHeader {
        format_mode: words[0],
        creation_tag: words[1],
        last_file_id: u64::from_le_bytes(last),
        words,
    })
}

/// "fileData": the bytes start with a known media signature (an FDO).
/// "encrypted": a .enc file, written when OneNote's cache-encryption gate is on.
/// "store": anything else, normally an allocator file. An FDO of an unrecognised
/// type also lands here; hash matching still covers it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CacheFileKind {
    FileData,
    Encrypted,
    Store,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheFile {
    pub file_id: u64,
    pub name: String,
    pub size: u64,
    pub kind: CacheFileKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub media_type: Option<String>,
}

fn signature_type(head: &[u8], size: u64) -> Option<String> {
    let t = sniff_media_type(head, None);
    if t == "application/octet-stream" {
        return None;
    }
    // "BM" alone is too weak against allocator pages; a real BMP repeats its size.
    if t == "image/bmp"
        && (head.len() < 6
            || u64::from(u32::from_le_bytes([head[2], head[3], head[4], head[5]])) != size)
    {
        return None;
    }
    Some(t)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheStats {
    pub dir: String,
    pub files: usize,
    pub file_data: usize,
    pub encrypted: usize,
    pub store: usize,
    pub staged: usize,
    pub last_file_id: Option<u64>,
}

pub struct OneNoteCache {
    pub dir: PathBuf,
    pub header: Option<CacheHeader>,
    pub files: Vec<CacheFile>,
    /// Files left in tmp/ by an uncommitted transaction.
    pub staged_files: usize,
    hashes: OnceCell<HashMap<String, usize>>,
}

impl OneNoteCache {
    pub fn new(dir: impl AsRef<Path>) -> io::Result<OneNoteCache> {
        let dir = dir.as_ref().to_path_buf();
        let header_path = dir.join("header");
        let header = if header_path.exists() {
            Some(
                parse_cache_header(&fs::read(&header_path)?)
                    .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?,
            )
        } else {
            None
        };
        let mut names: Vec<String> = fs::read_dir(&dir)?
            .filter_map(|e| e.ok())
            .filter_map(|e| e.file_name().into_string().ok())
            .collect();
        names.sort();
        let mut files = Vec::new();
        for name in names {
            let Some(id) = parse_file_id_name(&name) else {
                continue;
            };
            let path = dir.join(&name);
            let size = fs::metadata(&path)?.len();
            let mut file = CacheFile {
                file_id: id.file_id,
                name,
                size,
                kind: if id.encrypted {
                    CacheFileKind::Encrypted
                } else {
                    CacheFileKind::Store
                },
                media_type: None,
            };
            if !id.encrypted {
                if let Some(media_type) = signature_type(&head(&path, 64)?, size) {
                    file.kind = CacheFileKind::FileData;
                    file.media_type = Some(media_type);
                }
            }
            files.push(file);
        }
        let tmp = dir.join("tmp");
        let staged_files = if tmp.exists() {
            fs::read_dir(&tmp)?
                .filter_map(|e| e.ok())
                .filter(|e| {
                    e.file_name()
                        .to_str()
                        .is_some_and(|n| parse_file_id_name(n).is_some())
                })
                .count()
        } else {
            0
        };
        Ok(OneNoteCache {
            dir,
            header,
            files,
            staged_files,
            hashes: OnceCell::new(),
        })
    }

    /// The cache folder that belongs to a OneNote backup or data path: the
    /// `cache` sibling of the nearest `15.0`-style ancestor that has a header.
    pub fn find_for(path: impl AsRef<Path>) -> Option<PathBuf> {
        let mut d = path.as_ref().to_string_lossy().into_owned();
        loop {
            let parent = posix_dirname(&d);
            if parent == d {
                return None;
            }
            // path.join normalizes the candidate ("a/../b" -> "b"); the walk itself does not.
            let candidate = PathBuf::from(posix_normalize(&format!("{d}/cache")));
            if candidate.join("header").exists() {
                return Some(candidate);
            }
            d = parent;
        }
    }

    pub fn read(&self, file: &CacheFile) -> io::Result<Vec<u8>> {
        fs::read(self.dir.join(&file.name))
    }

    /// The cache file whose SHA-1 is `hex`. Encrypted files cannot be hashed and are skipped.
    pub fn find_by_sha1(&self, hex_digest: &str) -> Option<&CacheFile> {
        let hashes = self.hashes.get_or_init(|| {
            let mut m = HashMap::new();
            for (i, f) in self.files.iter().enumerate() {
                if f.kind == CacheFileKind::Encrypted {
                    continue;
                }
                if let Ok(bytes) = self.read(f) {
                    m.insert(hex(&Sha1::digest(&bytes)), i);
                }
            }
            m
        });
        hashes
            .get(&hex_digest.to_lowercase())
            .map(|&i| &self.files[i])
    }

    /// Plugs the cache into [`crate::ConvertOptions::resolve_file_data`].
    pub fn resolver(&self) -> impl Fn(&FileDataQuery) -> Option<ResolvedFileData> + '_ {
        move |q: &FileDataQuery| {
            let f = self.find_by_sha1(q.unverified_hash.as_deref().filter(|h| !h.is_empty())?)?;
            let bytes = self.read(f).ok()?;
            Some(ResolvedFileData {
                bytes,
                source: format!("cache/{}", f.name),
            })
        }
    }

    pub fn stats(&self) -> CacheStats {
        let count = |k: CacheFileKind| self.files.iter().filter(|f| f.kind == k).count();
        CacheStats {
            dir: self.dir.to_string_lossy().into_owned(),
            files: self.files.len(),
            file_data: count(CacheFileKind::FileData),
            encrypted: count(CacheFileKind::Encrypted),
            store: count(CacheFileKind::Store),
            staged: self.staged_files,
            last_file_id: self.header.as_ref().map(|h| h.last_file_id),
        }
    }
}

fn head(path: &Path, n: usize) -> io::Result<Vec<u8>> {
    let mut b = Vec::with_capacity(n);
    fs::File::open(path)?.take(n as u64).read_to_end(&mut b)?;
    Ok(b)
}

/// Node's `path.posix.dirname`.
fn posix_dirname(p: &str) -> String {
    if p.is_empty() {
        return ".".into();
    }
    let has_root = p.starts_with('/');
    let trimmed = p.trim_end_matches('/');
    if trimmed.is_empty() {
        return "/".into();
    }
    match trimmed.rfind('/') {
        None => ".".into(),
        Some(i) => {
            let parent = trimmed[..i].trim_end_matches('/');
            if parent.is_empty() {
                if has_root {
                    "/".into()
                } else {
                    ".".into()
                }
            } else {
                parent.to_string()
            }
        }
    }
}

/// Node's `path.posix.normalize` (lexical: resolves "." and "..", folds slashes).
fn posix_normalize(p: &str) -> String {
    let absolute = p.starts_with('/');
    let mut parts: Vec<&str> = Vec::new();
    for part in p.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                if parts.last().is_some_and(|l| *l != "..") {
                    parts.pop();
                } else if !absolute {
                    parts.push("..");
                }
            }
            _ => parts.push(part),
        }
    }
    let body = parts.join("/");
    match (absolute, body.is_empty()) {
        (true, _) => format!("/{body}"),
        (false, true) => ".".into(),
        (false, false) => body,
    }
}

#[cfg(test)]
mod tests {
    use super::{posix_dirname, posix_normalize};

    #[test]
    fn normalize_matches_node() {
        assert_eq!(posix_normalize("/a/b/../c/./d/cache"), "/a/c/d/cache");
        assert_eq!(posix_normalize("/../a"), "/a");
        assert_eq!(posix_normalize("a/../../b"), "../b");
        assert_eq!(posix_normalize("a/.."), ".");
    }

    #[test]
    fn dirname_matches_node() {
        assert_eq!(posix_dirname("/a/b/c.one"), "/a/b");
        assert_eq!(posix_dirname("/a"), "/");
        assert_eq!(posix_dirname("/"), "/");
        assert_eq!(posix_dirname("a/b"), "a");
        assert_eq!(posix_dirname("a"), ".");
        assert_eq!(posix_dirname("."), ".");
        assert_eq!(posix_dirname("/a//b/"), "/a");
    }
}
