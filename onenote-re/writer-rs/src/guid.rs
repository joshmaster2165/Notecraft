//! GUIDs and ExtendedGUIDs ([MS-ONESTORE] §2.2.1), and the name-based GUIDs
//! that make the output deterministic.
//!
//! Every identity in a written file (the file, object spaces, revisions,
//! object groups, objects, file data) is a version 5 (SHA-1, name-based)
//! UUID of a name built from Notecraft ids, so the same section always
//! produces the same bytes.

use std::fmt;

use sha1::{Digest, Sha1};

/// A GUID in its on-disk byte order ([MS-DTYP]: Data1–Data3 little-endian,
/// Data4 as is).
#[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Default)]
pub struct Guid(pub [u8; 16]);

impl Guid {
    pub const NIL: Guid = Guid([0; 16]);

    /// Parse `{XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX}` (braces optional) at
    /// compile time. Panics on malformed input, so only use it for constants.
    pub const fn parse(s: &str) -> Guid {
        let s = s.as_bytes();
        let mut hex = [0u8; 32];
        let mut n = 0;
        let mut i = 0;
        while i < s.len() {
            let c = s[i];
            let v = match c {
                b'0'..=b'9' => Some(c - b'0'),
                b'a'..=b'f' => Some(c - b'a' + 10),
                b'A'..=b'F' => Some(c - b'A' + 10),
                b'{' | b'}' | b'-' => None,
                _ => panic!("bad GUID character"),
            };
            if let Some(v) = v {
                assert!(n < 32, "GUID too long");
                hex[n] = v;
                n += 1;
            }
            i += 1;
        }
        assert!(n == 32, "GUID too short");
        let mut be = [0u8; 16];
        let mut k = 0;
        while k < 16 {
            be[k] = hex[2 * k] << 4 | hex[2 * k + 1];
            k += 1;
        }
        Guid::from_uuid_bytes(be)
    }

    /// From RFC 4122 (big-endian) byte order.
    pub const fn from_uuid_bytes(b: [u8; 16]) -> Guid {
        Guid([
            b[3], b[2], b[1], b[0], b[5], b[4], b[7], b[6], b[8], b[9], b[10], b[11], b[12], b[13],
            b[14], b[15],
        ])
    }

    /// To RFC 4122 (big-endian) byte order.
    pub const fn to_uuid_bytes(self) -> [u8; 16] {
        let b = self.0;
        [
            b[3], b[2], b[1], b[0], b[5], b[4], b[7], b[6], b[8], b[9], b[10], b[11], b[12], b[13],
            b[14], b[15],
        ]
    }

    /// RFC 4122 version 5 UUID of `name` in `namespace`.
    pub fn name_based(namespace: Guid, name: &str) -> Guid {
        let mut h = Sha1::new();
        h.update(namespace.to_uuid_bytes());
        h.update(name.as_bytes());
        let digest = h.finalize();
        let mut b = [0u8; 16];
        b.copy_from_slice(&digest[..16]);
        b[6] = (b[6] & 0x0f) | 0x50;
        b[8] = (b[8] & 0x3f) | 0x80;
        Guid::from_uuid_bytes(b)
    }

    pub fn xor(self, other: Guid) -> Guid {
        let mut out = [0u8; 16];
        for (i, o) in out.iter_mut().enumerate() {
            *o = self.0[i] ^ other.0[i];
        }
        Guid(out)
    }

    pub fn is_nil(self) -> bool {
        self.0 == [0; 16]
    }
}

impl fmt::Display for Guid {
    /// `{XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX}`, upper case.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let b = self.to_uuid_bytes();
        write!(f, "{{")?;
        for (i, byte) in b.iter().enumerate() {
            if matches!(i, 4 | 6 | 8 | 10) {
                write!(f, "-")?;
            }
            write!(f, "{byte:02X}")?;
        }
        write!(f, "}}")
    }
}

impl fmt::Debug for Guid {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Display::fmt(self, f)
    }
}

/// ExtendedGUID: a GUID plus a 32-bit sequence number.
#[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Default, Debug)]
pub struct ExGuid {
    pub guid: Guid,
    pub n: u32,
}

impl ExGuid {
    pub const NIL: ExGuid = ExGuid {
        guid: Guid::NIL,
        n: 0,
    };

    pub const fn new(guid: Guid, n: u32) -> ExGuid {
        ExGuid { guid, n }
    }

    /// The 20 bytes of an ExtendedGUID structure.
    pub fn bytes(self) -> [u8; 20] {
        let mut out = [0u8; 20];
        out[..16].copy_from_slice(&self.guid.0);
        out[16..].copy_from_slice(&self.n.to_le_bytes());
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_and_display_round_trip() {
        let s = "{109ADD3F-911B-49F5-A5D0-1791EDC8AED8}";
        let g = Guid::parse(s);
        assert_eq!(g.to_string(), s);
        // Data1 is stored little-endian.
        assert_eq!(&g.0[..4], &[0x3f, 0xdd, 0x9a, 0x10]);
    }

    #[test]
    fn version_5_matches_rfc_4122() {
        // uuid5(NAMESPACE_DNS, "www.example.com") = 2ed6657d-e927-568b-95e1-2665a8aea6a2
        let dns = Guid::parse("{6BA7B810-9DAD-11D1-80B4-00C04FD430C8}");
        assert_eq!(
            Guid::name_based(dns, "www.example.com").to_string(),
            "{2ED6657D-E927-568B-95E1-2665A8AEA6A2}"
        );
    }

    #[test]
    fn metadata_salt_xor_matches_the_spec_example() {
        // [MS-ONESTORE] §3.4: page space {418BCA1D-…} → PageMetaData {63230A2C-…}.
        let page = Guid::parse("{418BCA1D-C31E-4342-966B-B7949DA56A9F}");
        let salt = Guid::parse("{22A8C031-3600-42EE-B714-D7ACDA2435E8}");
        assert_eq!(
            page.xor(salt).to_string(),
            "{63230A2C-F51E-01AC-217F-603847815F77}"
        );
    }
}
