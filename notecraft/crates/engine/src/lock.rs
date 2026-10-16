//! Password Protect This Section.
//!
//! OneNote marks protected content with `IsEncrypted` (0x08001DC6) and stores
//! the section's object data encrypted under a key derived from the password
//! (the revision store's `ObjectDataEncryptionKeyV2FNDX`, see
//! file-format.md §15.5). Notecraft's own locked sections use authenticated
//! encryption: AES-256-GCM with a key from PBKDF2-HMAC-SHA256. The sealed
//! payload is self-describing, so the parameters can be raised later.

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::Engine;
use rand_core::{OsRng, RngCore};
use serde::{Deserialize, Serialize};
use sha2::Sha256;

pub const ITERATIONS: u32 = 600_000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Sealed {
    pub version: u32,
    pub kdf: String,
    pub iterations: u32,
    pub salt: String,
    pub nonce: String,
    /// Ciphertext with the GCM tag, base64.
    pub data: String,
}

#[derive(Debug, PartialEq)]
pub enum LockError {
    WrongPassword,
    Corrupt(String),
}

impl std::fmt::Display for LockError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LockError::WrongPassword => f.write_str("That password isn't right."),
            LockError::Corrupt(why) => write!(f, "The locked section is damaged: {why}"),
        }
    }
}

fn b64() -> base64::engine::GeneralPurpose {
    base64::engine::general_purpose::STANDARD
}

fn key(password: &str, salt: &[u8], iterations: u32) -> [u8; 32] {
    let mut k = [0u8; 32];
    pbkdf2::pbkdf2_hmac::<Sha256>(password.as_bytes(), salt, iterations, &mut k);
    k
}

/// Encrypt `plaintext` (the section's pages as JSON) with a password.
pub fn seal(plaintext: &[u8], password: &str) -> Sealed {
    seal_with(plaintext, password, ITERATIONS)
}

pub fn seal_with(plaintext: &[u8], password: &str, iterations: u32) -> Sealed {
    protect_with(plaintext, password, iterations).sealed
}

/// A sealed section plus the key it was sealed with. While a section is
/// unlocked the app keeps the key in memory, so each save re-seals with
/// [`reseal`] instead of running the password through PBKDF2 again.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Keyed {
    pub sealed: Sealed,
    /// The AES-256 key, base64.
    pub key: String,
}

/// Opened contents plus the key, for keeping the section unlocked.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Unlocked {
    pub plaintext: Vec<u8>,
    pub key: String,
}

/// Seal with a new password (fresh salt), returning the key too.
pub fn protect(plaintext: &[u8], password: &str) -> Keyed {
    protect_with(plaintext, password, ITERATIONS)
}

pub fn protect_with(plaintext: &[u8], password: &str, iterations: u32) -> Keyed {
    let mut salt = [0u8; 16];
    OsRng.fill_bytes(&mut salt);
    let k = key(password, &salt, iterations);
    let like = Sealed { version: 1, kdf: "pbkdf2-sha256".into(), iterations, salt: b64().encode(salt), nonce: String::new(), data: String::new() };
    Keyed { sealed: encrypt(plaintext, &k, &like), key: b64().encode(k) }
}

/// Seal again under the key of an unlocked section: same salt and KDF
/// parameters as `like`, fresh nonce.
pub fn reseal(plaintext: &[u8], key_b64: &str, like: &Sealed) -> Result<Sealed, LockError> {
    let k = key_bytes(key_b64)?;
    Ok(encrypt(plaintext, &k, like))
}

pub fn open(sealed: &Sealed, password: &str) -> Result<Vec<u8>, LockError> {
    unlock(sealed, password).map(|u| u.plaintext)
}

/// Open with the password and hand back the key for [`reseal`] and [`open_with_key`].
pub fn unlock(sealed: &Sealed, password: &str) -> Result<Unlocked, LockError> {
    check_format(sealed)?;
    let salt = b64().decode(&sealed.salt).map_err(|e| LockError::Corrupt(e.to_string()))?;
    let k = key(password, &salt, sealed.iterations.clamp(1, 10_000_000));
    Ok(Unlocked { plaintext: decrypt(sealed, &k)?, key: b64().encode(k) })
}

pub fn open_with_key(sealed: &Sealed, key_b64: &str) -> Result<Vec<u8>, LockError> {
    check_format(sealed)?;
    decrypt(sealed, &key_bytes(key_b64)?)
}

fn check_format(sealed: &Sealed) -> Result<(), LockError> {
    if sealed.version != 1 || sealed.kdf != "pbkdf2-sha256" {
        return Err(LockError::Corrupt(format!("unknown format {} {}", sealed.version, sealed.kdf)));
    }
    Ok(())
}

fn key_bytes(key_b64: &str) -> Result<[u8; 32], LockError> {
    b64().decode(key_b64).ok().and_then(|k| <[u8; 32]>::try_from(k).ok()).ok_or_else(|| LockError::Corrupt("bad key".into()))
}

fn encrypt(plaintext: &[u8], k: &[u8; 32], like: &Sealed) -> Sealed {
    let mut nonce = [0u8; 12];
    OsRng.fill_bytes(&mut nonce);
    let cipher = Aes256Gcm::new(k.into());
    let data = cipher.encrypt(Nonce::from_slice(&nonce), plaintext).unwrap_or_default();
    Sealed { version: 1, kdf: like.kdf.clone(), iterations: like.iterations, salt: like.salt.clone(), nonce: b64().encode(nonce), data: b64().encode(data) }
}

fn decrypt(sealed: &Sealed, k: &[u8; 32]) -> Result<Vec<u8>, LockError> {
    let nonce = b64().decode(&sealed.nonce).map_err(|e| LockError::Corrupt(e.to_string()))?;
    let data = b64().decode(&sealed.data).map_err(|e| LockError::Corrupt(e.to_string()))?;
    if nonce.len() != 12 {
        return Err(LockError::Corrupt("bad nonce".into()));
    }
    Aes256Gcm::new(k.into()).decrypt(Nonce::from_slice(&nonce), data.as_slice()).map_err(|_| LockError::WrongPassword)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_and_wrong_password() {
        let sealed = seal_with(b"{\"pages\":[]}", "correct horse", 1000);
        assert_eq!(open(&sealed, "correct horse").unwrap(), b"{\"pages\":[]}");
        assert_eq!(open(&sealed, "wrong"), Err(LockError::WrongPassword));
        let mut tampered = sealed.clone();
        tampered.data = b64().encode(b"not the ciphertext at all");
        assert_eq!(open(&tampered, "correct horse"), Err(LockError::WrongPassword));
        // Every seal uses a fresh salt and nonce.
        assert_ne!(seal_with(b"x", "p", 1000).salt, seal_with(b"x", "p", 1000).salt);
    }

    #[test]
    fn unlocked_sections_reseal_with_the_cached_key() {
        let Keyed { sealed, key: k } = protect_with(b"v1", "pw", 1000);
        let opened = unlock(&sealed, "pw").unwrap();
        assert_eq!((opened.plaintext.as_slice(), opened.key.as_str()), (&b"v1"[..], k.as_str()));
        let next = reseal(b"v2", &k, &sealed).unwrap();
        // Same password and salt, new nonce: the password still opens it.
        assert_eq!((next.salt.as_str(), next.iterations), (sealed.salt.as_str(), 1000));
        assert_ne!(next.nonce, sealed.nonce);
        assert_eq!(open(&next, "pw").unwrap(), b"v2");
        assert_eq!(open_with_key(&next, &k).unwrap(), b"v2");
        assert_eq!(unlock(&next, "nope").unwrap_err(), LockError::WrongPassword);
        assert!(matches!(reseal(b"x", "not a key", &sealed), Err(LockError::Corrupt(_))));
    }
}
