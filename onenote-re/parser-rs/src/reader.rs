//! Little-endian cursor over a byte buffer. Every structure in the revision
//! store is little-endian and byte-packed (no implicit alignment).

use std::fmt;

use crate::js;

/// A structural error with the file offset it happened at, formatted like the
/// TypeScript `ParseError`: `"<message> (at 0x<offset>)"`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParseError {
    message: String,
}

impl ParseError {
    pub fn at(message: impl fmt::Display, offset: i64) -> Self {
        ParseError {
            message: format!("{message} (at 0x{})", js::hex_signed(offset)),
        }
    }

    /// An error without an offset (the TypeScript side throws a plain Error there).
    pub fn plain(message: impl Into<String>) -> Self {
        ParseError {
            message: message.into(),
        }
    }

    pub fn message(&self) -> &str {
        &self.message
    }
}

impl fmt::Display for ParseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for ParseError {}

pub type Result<T> = std::result::Result<T, ParseError>;

/// Cursor over `[start, end)` of a buffer. Positions are signed because the
/// reference implementation can seek before `start` (see the transaction log);
/// every read is bounds-checked against `end` first, as in TypeScript, and
/// against the buffer itself.
#[derive(Clone)]
pub struct Reader<'a> {
    buf: &'a [u8],
    pub start: i64,
    pub end: i64,
    pub pos: i64,
}

impl<'a> Reader<'a> {
    pub fn new(buf: &'a [u8], start: i64, end: i64) -> Result<Self> {
        let len = buf.len() as i64;
        if start < 0 || end > len || start > end {
            // `${start}` / `${end}`: JS numbers, so sums past 2^53 print rounded.
            return Err(ParseError::at(
                format!(
                    "range [{}, {}) outside buffer of {len}",
                    js::number_to_string(start as f64),
                    js::number_to_string(end as f64)
                ),
                start,
            ));
        }
        Ok(Reader {
            buf,
            start,
            end,
            pos: start,
        })
    }

    /// Reader over `[offset, offset + length)` of the same underlying buffer.
    pub fn sub(&self, offset: i64, length: i64) -> Result<Reader<'a>> {
        Reader::new(self.buf, offset, offset.saturating_add(length))
    }

    pub fn remaining(&self) -> i64 {
        self.end - self.pos
    }

    fn need(&self, n: i64) -> Result<usize> {
        if self.pos.saturating_add(n) > self.end {
            return Err(ParseError::at(
                format!("need {n} bytes, {} left", self.remaining()),
                self.pos,
            ));
        }
        if self.pos < 0 {
            // DataView throws a RangeError for a negative offset.
            return Err(ParseError::plain(
                "Offset is outside the bounds of the DataView",
            ));
        }
        Ok(self.pos as usize)
    }

    fn take<const N: usize>(&mut self) -> Result<[u8; N]> {
        let at = self.need(N as i64)?;
        let mut out = [0u8; N];
        out.copy_from_slice(&self.buf[at..at + N]);
        self.pos += N as i64;
        Ok(out)
    }

    pub fn skip(&mut self, n: i64) -> Result<()> {
        self.need(n)?;
        self.pos += n;
        Ok(())
    }

    pub fn u8(&mut self) -> Result<u8> {
        Ok(self.take::<1>()?[0])
    }

    pub fn u16(&mut self) -> Result<u16> {
        Ok(u16::from_le_bytes(self.take()?))
    }

    pub fn u32(&mut self) -> Result<u32> {
        Ok(u32::from_le_bytes(self.take()?))
    }

    pub fn peek_u32(&self) -> Result<u32> {
        let at = self.need(4)?;
        Ok(u32::from_le_bytes([
            self.buf[at],
            self.buf[at + 1],
            self.buf[at + 2],
            self.buf[at + 3],
        ]))
    }

    pub fn u64(&mut self) -> Result<u64> {
        Ok(u64::from_le_bytes(self.take()?))
    }

    /// u64 that must fit in a JS number (file offsets and sizes): clamped to 2^53 - 1.
    pub fn u64n(&mut self) -> Result<u64> {
        Ok(self.u64()?.min(MAX_SAFE_INTEGER))
    }

    /// float32, widened exactly as `DataView.getFloat32` does.
    pub fn f32(&mut self) -> Result<f64> {
        Ok(f64::from(f32::from_le_bytes(self.take()?)))
    }

    pub fn bytes(&mut self, n: i64) -> Result<&'a [u8]> {
        if n < 0 {
            return Err(ParseError::at(format!("negative length {n}"), self.pos));
        }
        let at = self.need(n)?;
        let out = &self.buf[at..at + n as usize];
        self.pos += n;
        Ok(out)
    }

    pub fn guid(&mut self) -> Result<Guid> {
        Ok(Guid(self.take()?))
    }
}

pub const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;

/// A 16-byte GUID as stored (first three fields little-endian).
#[derive(Clone, Copy, PartialEq, Eq, Hash, Default, PartialOrd, Ord)]
pub struct Guid(pub [u8; 16]);

impl Guid {
    pub const NIL: Guid = Guid([0; 16]);

    pub fn is_nil(&self) -> bool {
        self.0 == [0; 16]
    }
}

impl Guid {
    /// `{XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX}`, upper case, as ASCII bytes.
    pub fn to_ascii(&self) -> [u8; 38] {
        const HEX: &[u8; 16] = b"0123456789ABCDEF";
        // Byte order of the textual form: the first three fields are little-endian.
        const ORDER: [usize; 16] = [3, 2, 1, 0, 5, 4, 7, 6, 8, 9, 10, 11, 12, 13, 14, 15];
        let mut out = [0u8; 38];
        out[0] = b'{';
        let mut at = 1;
        for (i, &src) in ORDER.iter().enumerate() {
            if matches!(i, 4 | 6 | 8 | 10) {
                out[at] = b'-';
                at += 1;
            }
            out[at] = HEX[usize::from(self.0[src] >> 4)];
            out[at + 1] = HEX[usize::from(self.0[src] & 0xf)];
            at += 2;
        }
        out[37] = b'}';
        out
    }
}

impl fmt::Display for Guid {
    /// `{XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX}`, upper case.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(std::str::from_utf8(&self.to_ascii()).unwrap_or_default())
    }
}

impl fmt::Debug for Guid {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Display::fmt(self, f)
    }
}

/// Format a 16-byte little-endian GUID as {XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX}.
/// Panics only if `b` is shorter than 16 bytes; callers slice exactly 16.
pub fn format_guid(b: &[u8]) -> String {
    let mut g = [0u8; 16];
    g.copy_from_slice(&b[..16]);
    Guid(g).to_string()
}

pub const NIL_GUID: &str = "{00000000-0000-0000-0000-000000000000}";

/// UTF-16LE decoded as `new TextDecoder("utf-16le").decode(bytes)` does (WHATWG):
/// a leading BOM is dropped, unpaired surrogates and a dangling odd byte become
/// U+FFFD. Trailing NULs are stripped (strings are frequently stored with one).
/// Returns UTF-16 code units, which is what JS string indices count.
pub fn utf16le_units(bytes: &[u8]) -> Vec<u16> {
    let mut out: Vec<u16> = Vec::with_capacity(bytes.len() / 2 + 1);
    let mut lead: Option<u16> = None;
    let (pairs, rest) = bytes.as_chunks::<2>();
    for pair in pairs {
        let unit = u16::from_le_bytes(*pair);
        if let Some(l) = lead.take() {
            if (0xdc00..=0xdfff).contains(&unit) {
                out.push(l);
                out.push(unit);
                continue;
            }
            out.push(0xfffd);
        }
        match unit {
            0xd800..=0xdbff => lead = Some(unit),
            0xdc00..=0xdfff => out.push(0xfffd),
            _ => out.push(unit),
        }
    }
    // End of input with a pending lead surrogate and/or odd byte: one U+FFFD.
    if lead.is_some() || !rest.is_empty() {
        out.push(0xfffd);
    }
    if out.first() == Some(&0xfeff) {
        out.remove(0);
    }
    while out.last() == Some(&0) {
        out.pop();
    }
    out
}

/// [`utf16le_units`] as a Rust string (always well-formed, so lossless).
pub fn utf16le(bytes: &[u8]) -> String {
    String::from_utf16_lossy(&utf16le_units(bytes))
}

/// windows-1252 bytes 0x80–0x9F (what the WHATWG "latin1" label decodes to).
const CP1252_HIGH: [u16; 32] = [
    0x20ac, 0x0081, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039,
    0x0152, 0x008d, 0x017d, 0x008f, 0x0090, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014,
    0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x009d, 0x017e, 0x0178,
];

/// `new TextDecoder("latin1").decode(bytes)`, i.e. windows-1252, with trailing NULs stripped.
pub fn latin1_units(bytes: &[u8]) -> Vec<u16> {
    let mut out: Vec<u16> = bytes
        .iter()
        .map(|&b| {
            if (0x80..0xa0).contains(&b) {
                CP1252_HIGH[(b - 0x80) as usize]
            } else {
                u16::from(b)
            }
        })
        .collect();
    while out.last() == Some(&0) {
        out.pop();
    }
    out
}

pub fn latin1(bytes: &[u8]) -> String {
    String::from_utf16_lossy(&latin1_units(bytes))
}

/// Lower-case hex of every byte.
pub fn hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push(char::from_digit(u32::from(b >> 4), 16).unwrap_or('0'));
        s.push(char::from_digit(u32::from(b & 0xf), 16).unwrap_or('0'));
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    fn units(b: &[u8]) -> Vec<u16> {
        utf16le_units(b)
    }

    #[test]
    fn utf16_matches_textdecoder() {
        assert_eq!(units(&[0xff, 0xfe, 0x41, 0]), [0x41]);
        assert_eq!(units(&[0xff, 0xfe, 0xff, 0xfe, 0x41, 0]), [0xfeff, 0x41]);
        assert_eq!(units(&[0x41, 0, 0x42]), [0x41, 0xfffd]);
        assert_eq!(units(&[0x41, 0, 0x3d, 0xd8]), [0x41, 0xfffd]);
        assert_eq!(units(&[0x41, 0, 0x3d, 0xd8, 0x42]), [0x41, 0xfffd]);
        assert_eq!(units(&[0x3d, 0xd8, 0x41, 0]), [0xfffd, 0x41]);
        assert_eq!(units(&[0x00, 0xdc, 0x41, 0]), [0xfffd, 0x41]);
        assert_eq!(units(&[0x3d, 0xd8, 0x00, 0xde]), [0xd83d, 0xde00]);
        assert_eq!(
            units(&[0x3d, 0xd8, 0x3d, 0xd8, 0x00, 0xde]),
            [0xfffd, 0xd83d, 0xde00]
        );
        assert_eq!(units(&[0x42]), [0xfffd]);
        assert_eq!(units(&[0x41, 0, 0, 0, 0, 0]), [0x41]);
        assert!(units(&[]).is_empty());
    }

    #[test]
    fn latin1_is_windows_1252() {
        assert_eq!(
            latin1(&[0x80, 0x81, 0x92, 0xe9, 0]),
            "\u{20ac}\u{81}\u{2019}\u{e9}"
        );
    }

    #[test]
    fn guid_format() {
        let b: Vec<u8> = (0u8..16).collect();
        assert_eq!(format_guid(&b), "{03020100-0504-0706-0809-0A0B0C0D0E0F}");
        assert_eq!(Guid::NIL.to_string(), NIL_GUID);
    }

    #[test]
    fn reads_are_bounds_checked() {
        let buf = [1u8, 0, 0, 0, 2];
        let mut r = Reader::new(&buf, 0, 5).unwrap();
        assert_eq!(r.u32().unwrap(), 1);
        assert_eq!(
            r.u32().unwrap_err().to_string(),
            "need 4 bytes, 1 left (at 0x4)"
        );
        assert_eq!(
            Reader::new(&buf, 2, 9).err().unwrap().to_string(),
            "range [2, 9) outside buffer of 5 (at 0x2)"
        );
    }
}
