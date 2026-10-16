//! Binary payloads: `data:` URLs decoded into the file data store
//! (FileDataStoreObjects referenced as `<ifndf>{GUID}`, [MS-ONESTORE]
//! §2.5.27), and the icon an attachment needs for its PictureContainer
//! ([MS-ONE] §2.2.32).
//!
//! Identical payloads are stored once: the FileDataStoreObject GUID is named
//! after the SHA-1 of the bytes.

use std::collections::HashMap;

use base64::engine::general_purpose::{GeneralPurpose, GeneralPurposeConfig};
use base64::engine::DecodePaddingMode;
use base64::{alphabet, Engine};
use sha1::{Digest, Sha1};

use crate::crc;
use crate::guid::Guid;

/// The file data store being built: payloads in first-use order.
#[derive(Default)]
pub(crate) struct FileStore {
    pub files: Vec<Vec<u8>>,
    pub guids: Vec<Guid>,
    by_hash: HashMap<[u8; 20], usize>,
}

impl FileStore {
    /// Add a payload (or find the identical one) and return its index.
    pub fn add(&mut self, ns: Guid, bytes: Vec<u8>) -> usize {
        let hash: [u8; 20] = Sha1::digest(&bytes).into();
        if let Some(&i) = self.by_hash.get(&hash) {
            return i;
        }
        let hex: String = hash.iter().map(|b| format!("{b:02x}")).collect();
        self.guids
            .push(Guid::name_based(ns, &format!("file-data:{hex}")));
        self.files.push(bytes);
        self.by_hash.insert(hash, self.files.len() - 1);
        self.files.len() - 1
    }

    /// `FileDataReference` of payload `i`.
    pub fn reference(&self, i: usize) -> String {
        format!("<ifndf>{}", self.guids[i])
    }
}

/// A decoded `data:` URL.
pub(crate) struct DataUrl {
    pub media_type: String,
    pub bytes: Vec<u8>,
}

fn percent_decode(s: &str) -> Vec<u8> {
    let b = s.as_bytes();
    let hex = |c: u8| (c as char).to_digit(16).map(|d| d as u8);
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let (Some(h), Some(l)) = (hex(b[i + 1]), hex(b[i + 2])) {
                out.push(h << 4 | l);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    out
}

/// Decode `data:[<media type>][;base64],<data>`. Lenient about whitespace,
/// missing padding and the URL-safe base64 alphabet.
pub(crate) fn decode_data_url(src: &str) -> Option<DataUrl> {
    let rest = src
        .trim()
        .strip_prefix("data:")
        .or_else(|| src.trim().strip_prefix("DATA:"))?;
    let comma = rest.find(',')?;
    let (meta, payload) = (&rest[..comma], &rest[comma + 1..]);
    let mut parts = meta.split(';');
    let media_type = parts.next().unwrap_or("").trim().to_ascii_lowercase();
    let base64 = parts.any(|p| p.trim().eq_ignore_ascii_case("base64"));
    let bytes = if base64 {
        let cleaned: String = payload
            .chars()
            .filter(|c| !c.is_ascii_whitespace())
            .map(|c| match c {
                '-' => '+',
                '_' => '/',
                c => c,
            })
            .collect();
        let cleaned = if cleaned.contains('%') {
            String::from_utf8(percent_decode(&cleaned)).ok()?
        } else {
            cleaned
        };
        let engine = GeneralPurpose::new(
            &alphabet::STANDARD,
            GeneralPurposeConfig::new()
                .with_decode_padding_mode(DecodePaddingMode::Indifferent)
                .with_decode_allow_trailing_bits(true),
        );
        engine.decode(cleaned.trim_end_matches('=')).ok()?
    } else {
        percent_decode(payload)
    };
    Some(DataUrl { media_type, bytes })
}

/// Media type from the leading bytes.
pub(crate) fn sniff(b: &[u8]) -> Option<&'static str> {
    let starts = |sig: &[u8]| b.starts_with(sig);
    Some(if starts(&[0x89, b'P', b'N', b'G']) {
        "image/png"
    } else if starts(&[0xff, 0xd8, 0xff]) {
        "image/jpeg"
    } else if starts(b"GIF8") {
        "image/gif"
    } else if starts(b"BM") {
        "image/bmp"
    } else if starts(&[0x49, 0x49, 0x2a, 0x00]) || starts(&[0x4d, 0x4d, 0x00, 0x2a]) {
        "image/tiff"
    } else if starts(&[0xd7, 0xcd, 0xc6, 0x9a]) {
        "image/wmf"
    } else if starts(&[1, 0, 0, 0]) && b.get(40..44) == Some(b" EMF") {
        "image/emf"
    } else if starts(b"RIFF") && b.get(8..12) == Some(b"WEBP") {
        "image/webp"
    } else if starts(b"%PDF") {
        "application/pdf"
    } else {
        return None;
    })
}

/// Picture formats a PictureContainer14 may hold ([MS-ONE] §2.2.36).
pub(crate) fn is_onenote_picture(media_type: &str) -> bool {
    matches!(
        media_type,
        "image/png" | "image/jpeg" | "image/bmp" | "image/tiff" | "image/wmf" | "image/emf"
    )
}

/// File extension with its period, from a file name or else a media type.
pub(crate) fn extension(file_name: Option<&str>, media_type: &str) -> String {
    if let Some(ext) = file_name
        .and_then(|n| n.rsplit_once('.'))
        .map(|(_, e)| e)
        .filter(|e| !e.is_empty() && e.len() <= 12 && e.chars().all(|c| c.is_ascii_alphanumeric()))
    {
        return format!(".{}", ext.to_ascii_lowercase());
    }
    let ext = match media_type {
        "image/png" => "png",
        "image/jpeg" | "image/jpg" => "jpg",
        "image/gif" => "gif",
        "image/bmp" => "bmp",
        "image/tiff" => "tif",
        "image/wmf" => "wmf",
        "image/emf" => "emf",
        "image/webp" => "webp",
        "image/svg+xml" => "svg",
        "application/pdf" => "pdf",
        "text/plain" => "txt",
        _ => "bin",
    };
    format!(".{ext}")
}

// --- the attachment icon ----------------------------------------------------------

fn adler32(data: &[u8]) -> u32 {
    let (mut a, mut b) = (1u32, 0u32);
    for chunk in data.chunks(5552) {
        for &x in chunk {
            a += u32::from(x);
            b += a;
        }
        a %= 65_521;
        b %= 65_521;
    }
    b << 16 | a
}

/// A minimal PNG: 8-bit RGBA, stored (uncompressed) deflate blocks.
pub(crate) fn png(width: u32, height: u32, rgba: &[u8]) -> Vec<u8> {
    let mut raw = Vec::with_capacity((width as usize * 4 + 1) * height as usize);
    for row in rgba.chunks(width as usize * 4) {
        raw.push(0); // filter: none
        raw.extend_from_slice(row);
    }
    let mut z = vec![0x78, 0x01];
    let mut blocks = raw.chunks(65_535).peekable();
    while let Some(block) = blocks.next() {
        z.push(u8::from(blocks.peek().is_none()));
        z.extend_from_slice(&(block.len() as u16).to_le_bytes());
        z.extend_from_slice(&(!(block.len() as u16)).to_le_bytes());
        z.extend_from_slice(block);
    }
    z.extend_from_slice(&adler32(&raw).to_be_bytes());

    let mut out = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
    let mut chunk = |kind: &[u8; 4], data: &[u8]| {
        out.extend_from_slice(&(data.len() as u32).to_be_bytes());
        let start = out.len();
        out.extend_from_slice(kind);
        out.extend_from_slice(data);
        let c = crc::crc32(&out[start..]);
        out.extend_from_slice(&c.to_be_bytes());
    };
    let mut ihdr = Vec::with_capacity(13);
    ihdr.extend_from_slice(&width.to_be_bytes());
    ihdr.extend_from_slice(&height.to_be_bytes());
    ihdr.extend_from_slice(&[8, 6, 0, 0, 0]); // 8-bit RGBA, no interlace
    chunk(b"IHDR", &ihdr);
    chunk(b"IDAT", &z);
    chunk(b"IEND", &[]);
    out
}

/// Icon size in pixels; shown at 96 dpi (24 × 30 pt).
pub(crate) const ICON_W: u32 = 32;
pub(crate) const ICON_H: u32 = 40;

/// A document icon with a folded corner, for embedded files.
pub(crate) fn file_icon() -> Vec<u8> {
    let (w, h) = (ICON_W as i32, ICON_H as i32);
    let (l, r, t, b, fold) = (3, w - 4, 1, h - 2, 10);
    let mut px = vec![0u8; (w * h * 4) as usize];
    for y in t..=b {
        for x in l..=r {
            // Past the diagonal of the top-right corner: cut away.
            let corner = x - (r - fold) - (y - t);
            if corner > 0 {
                continue;
            }
            let edge = x == l || x == r || y == t || y == b || corner == 0;
            let fold_edge = (x == r - fold && y < t + fold) || (y == t + fold && x > r - fold);
            let line = y - t > 14 && (y - t) % 5 == 0 && x > l + 4 && x < r - 4;
            let c: [u8; 4] = if edge || fold_edge {
                [0x6b, 0x6f, 0x80, 0xff]
            } else if line {
                [0xb8, 0xc0, 0xd0, 0xff]
            } else {
                [0xff, 0xff, 0xff, 0xff]
            };
            let i = ((y * w + x) * 4) as usize;
            px[i..i + 4].copy_from_slice(&c);
        }
    }
    png(ICON_W, ICON_H, &px)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn data_urls() {
        let d = decode_data_url("data:image/png;base64,iVBORw0KGgo=").unwrap();
        assert_eq!(d.media_type, "image/png");
        assert_eq!(d.bytes, [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]);
        // No padding, line breaks.
        let d = decode_data_url("data:;base64,aGVs\nbG8").unwrap();
        assert_eq!(d.bytes, b"hello");
        let d = decode_data_url("data:text/plain,a%20b").unwrap();
        assert_eq!(d.bytes, b"a b");
        assert!(decode_data_url("notecraft-blob:abc").is_none());
    }

    #[test]
    fn icon_is_a_png() {
        let p = file_icon();
        assert_eq!(sniff(&p), Some("image/png"));
        assert_eq!(&p[12..16], b"IHDR");
    }

    #[test]
    fn extensions() {
        assert_eq!(
            extension(Some("Report.PDF"), "application/octet-stream"),
            ".pdf"
        );
        assert_eq!(extension(None, "image/jpeg"), ".jpg");
        assert_eq!(extension(Some("noext"), "x/y"), ".bin");
    }
}
