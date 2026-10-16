//! The CRC-32 that `.one` files use ([MS-ONESTORE] §2.1.2): the RFC 3309 /
//! IEEE 802.3 polynomial 0x04C11DB7, reflected, register initialised to all
//! ones and inverted at the end (zlib's `crc32`).
//!
//! It covers `Header.crcName` (the file name as UTF-16 plus a NUL), the
//! sentinel `TransactionEntry` (every entry of the transaction log so far) and
//! `ObjectInfoDependencyOverrideData.crc` (the reference counts of the object
//! group it follows). All three were checked against OneNote's own files.
//!
//! `.onetoc2` files use MsoCrc32 ([MS-OSHARED] §2.4.3.2) for their
//! transaction log instead: polynomial 0x000000AF, most significant bit
//! first, no reflection or inversion (the CRC catalogue's CRC-32/XFER).
//! `crcName` keeps the `.one` algorithm in both kinds of file.

const TABLE: [u32; 256] = {
    let mut table = [0u32; 256];
    let mut i = 0;
    while i < 256 {
        let mut c = i as u32;
        let mut k = 0;
        while k < 8 {
            c = if c & 1 != 0 {
                0xedb8_8320 ^ (c >> 1)
            } else {
                c >> 1
            };
            k += 1;
        }
        table[i] = c;
        i += 1;
    }
    table
};

/// Continue a CRC-32 over more bytes (`crc` is a previous result, or 0).
pub fn update(crc: u32, data: &[u8]) -> u32 {
    let mut c = !crc;
    for &b in data {
        c = TABLE[((c ^ u32::from(b)) & 0xff) as usize] ^ (c >> 8);
    }
    !c
}

/// CRC-32 of `data`.
pub fn crc32(data: &[u8]) -> u32 {
    update(0, data)
}

const MSO_TABLE: [u32; 256] = {
    let mut table = [0u32; 256];
    let mut i = 0;
    while i < 256 {
        let mut c = (i as u32) << 24;
        let mut k = 0;
        while k < 8 {
            c = if c & 0x8000_0000 != 0 {
                (c << 1) ^ 0xaf
            } else {
                c << 1
            };
            k += 1;
        }
        table[i] = c;
        i += 1;
    }
    table
};

/// MsoCrc32Compute: continue an MsoCrc32 over more bytes (`crc` is a
/// previous result, or 0 to start).
pub fn mso_update(crc: u32, data: &[u8]) -> u32 {
    let mut c = crc;
    for &b in data {
        c = (c << 8) ^ MSO_TABLE[(((c >> 24) ^ u32::from(b)) & 0xff) as usize];
    }
    c
}

/// `Header.crcName`: CRC-32 of the file name in UTF-16LE with a terminating NUL.
pub fn file_name_crc(name: &str) -> u32 {
    let mut bytes: Vec<u8> = name.encode_utf16().flat_map(u16::to_le_bytes).collect();
    bytes.extend_from_slice(&[0, 0]);
    crc32(&bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn standard_check_value() {
        assert_eq!(crc32(b"123456789"), 0xcbf4_3926);
        assert_eq!(update(crc32(b"1234"), b"56789"), 0xcbf4_3926);
        assert_eq!(crc32(&[]), 0);
    }

    #[test]
    fn mso_crc_check_value() {
        // CRC-32/XFER (poly 0xAF, init 0, no reflection, no final XOR).
        assert_eq!(mso_update(0, b"123456789"), 0xbd0b_e338);
        assert_eq!(mso_update(mso_update(0, b"1234"), b"56789"), 0xbd0b_e338);
    }

    #[test]
    fn spec_example_file_name() {
        // [MS-ONESTORE] §3.1: crcName 0xCEBE8422 for "Example.one".
        assert_eq!(file_name_crc("Example.one"), 0xcebe_8422);
    }
}
