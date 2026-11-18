//! Chromium-family browsers: Chrome, Edge, Brave, Arc, Dia, Vivaldi, Opera and unknown builds.
//!
//! Formats follow Chromium's sources: `Local State` lists profiles under `profile.info_cache`;
//! `Cookies` is a SQLite store whose values are encrypted with a key that depends on the OS (see
//! the `keys` module and components/os_crypt/sync); and since cookie store version 24 the
//! plaintext starts with the SHA-256 of the cookie's domain
//! (net/extras/sqlite/sqlite_persistent_cookie_store.cc).

use std::path::{Path, PathBuf};

use aes::cipher::block_padding::Pkcs7;
use aes::cipher::{BlockModeDecrypt, KeyIvInit};
use aes_gcm::aead::Aead;
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use rusqlite::Connection;
use sha2::{Digest, Sha256};

use crate::sqlite::{columns, open_copy};
use crate::{
    ChromiumKeys, Cookie, Cookies, Error, PartitionedCookie, SameSite, WEBKIT_EPOCH_OFFSET_SECS,
};

mod catalog;
mod discovery;
pub(crate) use discovery::{discover, discover_other};

/// AES-CBC IV Chromium uses on macOS and Linux: sixteen spaces.
const IV: [u8; 16] = [b' '; 16];
/// AES-GCM nonce length Chromium uses on Windows.
const GCM_NONCE: usize = 12;
/// Cookie store version from which plaintexts carry a SHA-256 of the domain.
const DOMAIN_HASH_VERSION: i64 = 24;

/// Newer Chromium keeps cookies in `Network/Cookies`; older builds in the profile root.
fn cookies_path(dir: &Path) -> PathBuf {
    let network = dir.join("Network/Cookies");
    if network.exists() {
        network
    } else {
        dir.join("Cookies")
    }
}

/// Decrypts an AES-128-CBC payload, or `None` when the padding is wrong (which is what a wrong
/// password looks like).
fn decrypt_cbc(key: &[u8; 16], ciphertext: &[u8]) -> Option<Vec<u8>> {
    let decryptor = cbc::Decryptor::<aes::Aes128>::new(key.into(), &IV.into());
    decryptor.decrypt_padded_vec::<Pkcs7>(ciphertext).ok()
}

/// Decrypts an AES-256-GCM payload (nonce, then ciphertext and tag), or `None` when it fails its
/// integrity check.
fn decrypt_gcm(key: &[u8; 32], payload: &[u8]) -> Option<Vec<u8>> {
    let (nonce, sealed) = payload.split_at_checked(GCM_NONCE)?;
    Aes256Gcm::new(key.into())
        .decrypt(&Nonce::try_from(nonce).ok()?, sealed)
        .ok()
}

/// The value inside a decrypted plaintext, checking and stripping the domain hash when the store
/// has one.
fn plaintext_value(mut bytes: Vec<u8>, host: &str, version: i64) -> Option<String> {
    if version >= DOMAIN_HASH_VERSION {
        let hash = Sha256::digest(host.as_bytes());
        if bytes.len() < hash.len() || bytes[..hash.len()] != hash[..] {
            return None;
        }
        bytes.drain(..hash.len());
    }
    String::from_utf8(bytes).ok()
}

/// What a cookie's stored value turned out to be.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Opened {
    Value(String),
    Unreadable,
}

/// Opens a stored `vNN` value with `keys`, passing each decrypted plaintext through `decode`,
/// which also judges whether the key was right.
pub(crate) fn open_sealed(
    encrypted: &[u8],
    keys: &ChromiumKeys,
    decode: &dyn Fn(Vec<u8>) -> Option<String>,
) -> Opened {
    let Some((prefix, payload)) = encrypted.split_at_checked(3) else {
        return Opened::Unreadable;
    };
    let cbc = |primary: Option<[u8; 16]>| {
        // Each key is tried through `decode` too: bad padding isn't the only sign of a wrong key.
        // The empty password is what Chromium on Linux seals with when no keyring answered, which
        // also covers a keyring that has gone since.
        [primary, keys.cbc_empty]
            .iter()
            .flatten()
            .find_map(|key| decode(decrypt_cbc(key, payload)?))
    };
    let value = match prefix {
        // Chrome's `v20`: locked to the browser, so never tried.
        b"v20" => return Opened::Unreadable,
        b"v10" => match &keys.gcm_v10 {
            Some(key) => decrypt_gcm(key, payload).and_then(decode),
            None => cbc(keys.cbc_v10),
        },
        b"v11" => cbc(keys.cbc_v11),
        _ => None,
    };
    value.map_or(Opened::Unreadable, Opened::Value)
}

/// The cookie's value, decrypted if it needs it.
fn cookie_value(
    plain: String,
    encrypted: &[u8],
    host: &str,
    keys: &ChromiumKeys,
    version: i64,
) -> Opened {
    if !plain.is_empty() || encrypted.is_empty() {
        return Opened::Value(plain);
    }
    open_sealed(encrypted, keys, &|bytes| {
        plaintext_value(bytes, host, version)
    })
}

pub(crate) fn read_cookies(
    dir: &Path,
    keys: &ChromiumKeys,
    now_unix: i64,
) -> Result<Cookies, Error> {
    let conn = open_copy(&cookies_path(dir))?;
    let cols = columns(&conn, "cookies")?;
    if !cols.contains("host_key") || !cols.contains("name") {
        return Err(Error::Format("no Chromium cookies table".to_owned()));
    }
    let pick = |names: &[&str], fallback: &str| -> String {
        names
            .iter()
            .find(|name| cols.contains(**name))
            .map_or_else(|| fallback.to_owned(), |name| (*name).to_owned())
    };
    let sql = format!(
        "SELECT host_key, name, {value}, {encrypted}, {path}, {expires}, {secure}, {http_only},
                {same_site}, {persistent}, {top_frame}, {cross_site}, {source_scheme} FROM cookies",
        value = pick(&["value"], "''"),
        encrypted = pick(&["encrypted_value"], "X''"),
        path = pick(&["path"], "'/'"),
        expires = pick(&["expires_utc"], "0"),
        secure = pick(&["is_secure", "secure"], "0"),
        http_only = pick(&["is_httponly", "httponly"], "0"),
        same_site = pick(&["samesite"], "-1"),
        persistent = pick(&["is_persistent", "has_expires"], "1"),
        top_frame = pick(&["top_frame_site_key"], "''"),
        source_scheme = pick(&["source_scheme"], "0"),
        cross_site = pick(&["has_cross_site_ancestor"], "1"),
    );
    let version = meta_version(&conn);

    let mut out = Cookies::default();
    let mut stmt = conn.prepare(&sql)?;
    let mut rows = stmt.query([])?;
    while let Some(row) = rows.next()? {
        let host: String = row.get(0)?;
        let expires_utc: i64 = row.get::<_, Option<i64>>(5)?.unwrap_or(0);
        let persistent: i64 = row.get::<_, Option<i64>>(9)?.unwrap_or(1);
        let expires_unix = (persistent != 0 && expires_utc != 0)
            .then(|| expires_utc.div_euclid(1_000_000) - WEBKIT_EPOCH_OFFSET_SECS);
        if expires_unix.is_some_and(|expires| expires < now_unix) {
            out.expired += 1;
            continue;
        }
        let top_frame = row
            .get::<_, Option<String>>(10)?
            .filter(|key| !key.is_empty());
        if top_frame.is_some() {
            out.partitioned += 1;
        }
        let name: String = row.get(1)?;
        let plain: Option<String> = row.get(2).ok().flatten();
        let encrypted: Option<Vec<u8>> = row.get(3)?;
        let value = match cookie_value(
            plain.unwrap_or_default(),
            encrypted.as_deref().unwrap_or_default(),
            &host,
            keys,
            version,
        ) {
            Opened::Value(value) => value,
            // A partitioned cookie is already counted as that.
            _ if top_frame.is_some() => continue,
            Opened::Unreadable => {
                out.unreadable += 1;
                continue;
            }
        };
        let same_site = match row.get::<_, Option<i64>>(8)?.unwrap_or(-1) {
            0 => Some(SameSite::None),
            1 => Some(SameSite::Lax),
            2 => Some(SameSite::Strict),
            _ => None,
        };
        let cookie = Cookie {
            name,
            value,
            host_only: !host.starts_with('.'),
            domain: host,
            path: row
                .get::<_, Option<String>>(4)?
                .unwrap_or_else(|| "/".to_owned()),
            expires_unix,
            secure: row.get::<_, Option<i64>>(6)?.unwrap_or(0) != 0,
            http_only: row.get::<_, Option<i64>>(7)?.unwrap_or(0) != 0,
            same_site,
            // net::CookieSourceScheme: 0 unset, 1 non-secure, 2 secure.
            source_insecure: row.get::<_, Option<i64>>(12)?.unwrap_or(0) == 1,
        };
        match top_frame {
            Some(top_frame_site_key) => out.partitioned_cookies.push(PartitionedCookie {
                cookie,
                top_frame_site_key,
                has_cross_site_ancestor: row.get::<_, Option<i64>>(11)?.unwrap_or(1) != 0,
            }),
            None => out.cookies.push(cookie),
        }
    }
    Ok(out)
}

/// How many cookies a profile's store holds, without decrypting any.
pub(crate) fn count_cookies(dir: &Path) -> Result<usize, Error> {
    let conn = open_copy(&cookies_path(dir))?;
    let count: i64 = conn.query_row("SELECT COUNT(*) FROM cookies", [], |row| row.get(0))?;
    Ok(usize::try_from(count).unwrap_or(0))
}

/// The cookie store's schema version from its `meta` table, 0 when absent.
fn meta_version(conn: &Connection) -> i64 {
    conn.query_row(
        "SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'version'",
        [],
        |row| row.get::<_, Option<i64>>(0),
    )
    .ok()
    .flatten()
    .unwrap_or(0)
}
