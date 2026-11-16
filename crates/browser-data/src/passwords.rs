//! Saved passwords, read once so an import can seal them into Brigadier's own store.
//!
//! A [`Password`] has no `Serialize`, and its `Debug` hides it, so no log line or derived reply can
//! carry one by accident. [`Password::reveal`] is the one way out, for the shell's import to hand
//! it to the profile's vault.
//!
//! - **Chromium** keeps them in `Login Data` and `Login Data For Account`, sealed as its cookies
//!   are. `v20` values stay closed, as for cookies.
//! - **Firefox** keeps them in `logins.json`, sealed with a key in `key4.db`, itself sealed with
//!   the user's Primary Password. With one set this crate can't open them and says so; it never
//!   asks for it or guesses it.
//! - **Safari** keeps them in iCloud Keychain, which no other app can read.

use std::collections::HashSet;
use std::path::Path;

use aes::cipher::block_padding::Pkcs7;
use aes::cipher::{BlockModeDecrypt, KeyIvInit};
use base64::Engine;
use hmac::{Hmac, KeyInit, Mac};
use rusqlite::Connection;
use sha1::{Digest, Sha1};
use sha2::Sha256;

use crate::chromium::{Opened, open_sealed};
use crate::sqlite::{columns, io_error, open_copy};
use crate::{
    ChromiumKeys, Error, Family, Profile, SecretError, WEBKIT_EPOCH_OFFSET_SECS, is_web_url,
};

/// A saved password. Its value stays inside this crate; see the module's notes.
#[derive(Clone, PartialEq, Eq)]
pub struct Password(String);

impl Password {
    pub(crate) fn new(value: String) -> Self {
        Self(value)
    }

    /// The value itself, for the vault it is going into and nothing else.
    pub fn reveal(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Debug for Password {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Password(hidden)")
    }
}

/// One saved sign-in, in Chromium's terms, which any engine's can be put into.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Credential {
    /// The sign-in page, e.g. `https://example.com/login`.
    pub origin_url: String,
    /// Where the form posts; empty when unknown.
    pub action_url: String,
    /// What the password is for: `https://example.com/`, plus a realm for HTTP auth.
    pub signon_realm: String,
    pub username_element: String,
    pub username: String,
    pub password_element: String,
    pub password: Password,
    /// Chromium's scheme: 0 for a web form, 1 for HTTP basic and 2 for digest.
    pub scheme: i64,
    pub created_at_ms: Option<i64>,
    pub last_used_at_ms: Option<i64>,
}

/// The passwords read from one profile, plus what was left out and why.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Passwords {
    pub credentials: Vec<Credential>,
    /// Couldn't be opened, or malformed.
    pub unreadable: usize,
    /// The sites of those, one per password, when known. Never a username or a value.
    pub unreadable_sites: Vec<String>,
    /// Chrome's `v20` values among the unreadable, which only that browser can open.
    pub app_bound: usize,
    /// Not for a web page (`android://`, an extension's), or a site the user said never to save.
    pub skipped: usize,
}

/// Whether a profile has any saved password, opening nothing sealed.
pub(crate) fn has_saved(profile: &Profile) -> bool {
    match profile.family {
        Family::Chromium => ["Login Data", "Login Data For Account"].iter().any(|file| {
            open_copy(&profile.dir.join(file)).is_ok_and(|conn| {
                conn.query_row("SELECT 1 FROM logins LIMIT 1", [], |_| Ok(()))
                    .is_ok()
            })
        }),
        Family::Gecko => std::fs::read(profile.dir.join("logins.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
            .and_then(|logins| logins.get("logins")?.as_array().map(|all| !all.is_empty()))
            .unwrap_or(false),
        Family::Safari => false,
    }
}

/// Reads a profile's saved passwords, http and https sites only. `keys` come from
/// [`crate::chromium_keys`] and are only used for Chromium.
pub fn read_passwords(profile: &Profile, keys: &ChromiumKeys) -> Result<Passwords, Error> {
    match profile.family {
        Family::Chromium => read_chromium(&profile.dir, keys),
        Family::Gecko => read_gecko(&profile.dir),
        Family::Safari => Err(Error::NotReadable(
            "Safari keeps passwords in iCloud Keychain",
        )),
    }
}

fn read_chromium(dir: &Path, keys: &ChromiumKeys) -> Result<Passwords, Error> {
    let mut out = Passwords::default();
    let mut found = false;
    for file in ["Login Data", "Login Data For Account"] {
        match open_copy(&dir.join(file)) {
            Ok(conn) => {
                found = true;
                read_login_db(&conn, keys, &mut out)?;
            }
            Err(Error::NotFound(_)) => {}
            Err(error) => return Err(error),
        }
    }
    if !found {
        return Err(Error::NotFound(dir.join("Login Data")));
    }
    // The same sign-in in both stores counts once; the first store wins.
    let mut seen = HashSet::new();
    out.credentials.retain(|c| {
        seen.insert((
            c.origin_url.clone(),
            c.username_element.clone(),
            c.username.clone(),
            c.password_element.clone(),
            c.signon_realm.clone(),
        ))
    });
    Ok(out)
}

fn read_login_db(conn: &Connection, keys: &ChromiumKeys, out: &mut Passwords) -> Result<(), Error> {
    let cols = columns(conn, "logins")?;
    if !cols.contains("signon_realm") || !cols.contains("password_value") {
        return Err(Error::Format("no Chromium logins table".to_owned()));
    }
    let optional = |name: &str, fallback: &str| {
        if cols.contains(name) {
            name.to_owned()
        } else {
            fallback.to_owned()
        }
    };
    let sql = format!(
        "SELECT origin_url, {action}, signon_realm, {user_element}, {user}, {pass_element},
                password_value, {scheme}, {created}, {used}, {blocked} FROM logins",
        action = optional("action_url", "''"),
        user_element = optional("username_element", "''"),
        user = optional("username_value", "''"),
        pass_element = optional("password_element", "''"),
        scheme = optional("scheme", "0"),
        created = optional("date_created", "0"),
        used = optional("date_last_used", "0"),
        blocked = optional("blacklisted_by_user", "0"),
    );
    let mut stmt = conn.prepare(&sql)?;
    let mut rows = stmt.query([])?;
    while let Some(row) = rows.next()? {
        let origin_url: String = row.get::<_, Option<String>>(0)?.unwrap_or_default();
        let signon_realm: String = row.get::<_, Option<String>>(2)?.unwrap_or_default();
        let blocked = row.get::<_, Option<i64>>(10)?.unwrap_or(0) != 0;
        if blocked || !is_web_url(&signon_realm) {
            out.skipped += 1;
            continue;
        }
        let sealed: Vec<u8> = row.get::<_, Option<Vec<u8>>>(6)?.unwrap_or_default();
        let password = match open_sealed(&sealed, keys, &|bytes| String::from_utf8(bytes).ok()) {
            Opened::Value(password) => password,
            Opened::AppBound => {
                out.unreadable += 1;
                out.app_bound += 1;
                out.unreadable_sites.push(signon_realm);
                continue;
            }
            Opened::Unreadable => {
                out.unreadable += 1;
                out.unreadable_sites.push(signon_realm);
                continue;
            }
        };
        out.credentials.push(Credential {
            origin_url,
            action_url: row.get::<_, Option<String>>(1)?.unwrap_or_default(),
            signon_realm,
            username_element: row.get::<_, Option<String>>(3)?.unwrap_or_default(),
            username: row.get::<_, Option<String>>(4)?.unwrap_or_default(),
            password_element: row.get::<_, Option<String>>(5)?.unwrap_or_default(),
            password: Password::new(password),
            scheme: row.get::<_, Option<i64>>(7)?.unwrap_or(0),
            created_at_ms: chromium_ms(row.get::<_, Option<i64>>(8)?),
            last_used_at_ms: chromium_ms(row.get::<_, Option<i64>>(9)?),
        });
    }
    Ok(())
}

/// Chromium's microseconds since 1601 in Unix milliseconds; 0 means unrecorded.
fn chromium_ms(micros: Option<i64>) -> Option<i64> {
    micros
        .filter(|micros| *micros > 0)
        .map(|micros| micros.div_euclid(1000) - WEBKIT_EPOCH_OFFSET_SECS * 1000)
}

const OID_PBES2: &[u8] = &[0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x05, 0x0D];
const OID_PBE_SHA1_3DES: &[u8] = &[
    0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x0C, 0x05, 0x01, 0x03,
];
const OID_HMAC_SHA256: &[u8] = &[0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x02, 0x09];
const OID_3DES_CBC: &[u8] = &[0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x03, 0x07];
const OID_AES256_CBC: &[u8] = &[0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x01, 0x2A];
/// What key4.db's check value opens to when the password is right (here, empty).
const PASSWORD_CHECK: &[u8] = b"password-check";

/// One DER value: its tag, its contents, and what follows it.
fn der(data: &[u8]) -> Option<(u8, &[u8], &[u8])> {
    let (&tag, rest) = data.split_first()?;
    let (&first, rest) = rest.split_first()?;
    let (len, rest) = if first < 0x80 {
        (usize::from(first), rest)
    } else {
        let count = usize::from(first & 0x7F);
        if count == 0 || count > 4 {
            return None;
        }
        let (bytes, rest) = rest.split_at_checked(count)?;
        let len = bytes.iter().fold(0usize, |n, b| (n << 8) | usize::from(*b));
        (len, rest)
    };
    let (content, rest) = rest.split_at_checked(len)?;
    Some((tag, content, rest))
}

/// The next DER value if it has `tag`, and what follows it.
fn take(data: &[u8], tag: u8) -> Option<(&[u8], &[u8])> {
    let (found, content, rest) = der(data)?;
    (found == tag).then_some((content, rest))
}

fn der_uint(content: &[u8]) -> Option<u32> {
    if content.len() > 4 {
        return None;
    }
    Some(content.iter().fold(0u32, |n, b| (n << 8) | u32::from(*b)))
}

const SEQUENCE: u8 = 0x30;
const OCTETS: u8 = 0x04;
const OID: u8 = 0x06;
const INTEGER: u8 = 0x02;

fn aes256_cbc(key: &[u8], iv: &[u8], data: &[u8]) -> Option<Vec<u8>> {
    let decryptor = cbc::Decryptor::<aes::Aes256>::new_from_slices(key, iv).ok()?;
    decryptor.decrypt_padded_vec::<Pkcs7>(data).ok()
}

fn des3_cbc(key: &[u8], iv: &[u8], data: &[u8]) -> Option<Vec<u8>> {
    let decryptor = cbc::Decryptor::<des::TdesEde3>::new_from_slices(key, iv).ok()?;
    decryptor.decrypt_padded_vec::<Pkcs7>(data).ok()
}

/// Opens a value of key4.db, sealed with a key from the global salt and the empty password.
fn open_nss_pbe(blob: &[u8], global_salt: &[u8]) -> Option<Vec<u8>> {
    let (outer, _) = take(blob, SEQUENCE)?;
    let (algorithm, rest) = take(outer, SEQUENCE)?;
    let (sealed, _) = take(rest, OCTETS)?;
    let (oid, params) = take(algorithm, OID)?;
    // The password is empty: Firefox only uses one when the user has set a Primary Password.
    let password_hash = Sha1::digest(global_salt);
    if oid == OID_PBES2 {
        let (params, _) = take(params, SEQUENCE)?;
        let (kdf, cipher) = take(params, SEQUENCE)?;
        let (_, kdf) = take(kdf, OID)?;
        let (kdf, _) = take(kdf, SEQUENCE)?;
        let (salt, kdf) = take(kdf, OCTETS)?;
        let (iterations, kdf) = take(kdf, INTEGER)?;
        let (_, kdf) = take(kdf, INTEGER)?;
        let (hash, _) = take(kdf, SEQUENCE)?;
        let (hash, _) = take(hash, OID)?;
        if hash != OID_HMAC_SHA256 {
            return None;
        }
        let (cipher, _) = take(cipher, SEQUENCE)?;
        let (_, cipher) = take(cipher, OID)?;
        let (iv_tail, _) = take(cipher, OCTETS)?;
        let key = pbkdf2::pbkdf2_hmac_array::<Sha256, 32>(
            password_hash.as_slice(),
            salt,
            der_uint(iterations)?,
        );
        // NSS stores only the IV's last 14 bytes, the first two being its own DER header.
        let iv = [&[0x04, 0x0E], iv_tail].concat();
        return aes256_cbc(&key, &iv, sealed);
    }
    if oid == OID_PBE_SHA1_3DES {
        let (params, _) = take(params, SEQUENCE)?;
        let (salt, _) = take(params, OCTETS)?;
        let chp = Sha1::digest([password_hash.as_slice(), salt].concat());
        let mut padded = salt.to_vec();
        padded.resize(20.max(salt.len()), 0);
        let hmac = |parts: &[&[u8]]| -> Option<Vec<u8>> {
            let mut mac = <Hmac<Sha1> as KeyInit>::new_from_slice(chp.as_slice()).ok()?;
            for part in parts {
                mac.update(part);
            }
            Some(mac.finalize().into_bytes().to_vec())
        };
        let k1 = hmac(&[&padded, salt])?;
        let tk = hmac(&[&padded])?;
        let k2 = hmac(&[&tk, salt])?;
        let k = [k1, k2].concat();
        return des3_cbc(k.get(..24)?, k.get(k.len() - 8..)?, sealed);
    }
    None
}

/// The keys that open logins.json, each with the id its logins name it by.
type GeckoKeys = Vec<(Vec<u8>, Vec<u8>)>;

fn gecko_keys(conn: &Connection) -> Result<GeckoKeys, Error> {
    let bad = || Error::Format("key4.db".to_owned());
    let (global_salt, check): (Vec<u8>, Vec<u8>) = conn
        .query_row(
            "SELECT item1, item2 FROM metaData WHERE id = 'password'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|_| bad())?;
    let opened = open_nss_pbe(&check, &global_salt);
    if !opened.is_some_and(|plain| plain.starts_with(PASSWORD_CHECK)) {
        // Only a Primary Password makes the empty one fail.
        return Err(Error::Secret(SecretError::Locked));
    }
    let mut stmt = conn.prepare("SELECT a102, a11 FROM nssPrivate")?;
    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, Option<Vec<u8>>>(0)?,
            row.get::<_, Option<Vec<u8>>>(1)?,
        ))
    })?;
    let mut keys = Vec::new();
    for row in rows {
        let (id, sealed) = row?;
        let Some(sealed) = sealed else { continue };
        if let Some(key) = open_nss_pbe(&sealed, &global_salt) {
            keys.push((id.unwrap_or_default(), key));
        }
    }
    if keys.is_empty() {
        return Err(bad());
    }
    Ok(keys)
}

/// Opens one of logins.json's fields: base64 of a key id, a cipher and its IV, and the sealed text.
fn open_login_field(field: &str, keys: &GeckoKeys) -> Option<String> {
    let blob = base64::engine::general_purpose::STANDARD
        .decode(field)
        .ok()?;
    let (outer, _) = take(&blob, SEQUENCE)?;
    let (key_id, rest) = take(outer, OCTETS)?;
    let (cipher, rest) = take(rest, SEQUENCE)?;
    let (sealed, _) = take(rest, OCTETS)?;
    let (oid, cipher) = take(cipher, OID)?;
    let (iv, _) = take(cipher, OCTETS)?;
    let key = keys
        .iter()
        .find(|(id, _)| id == key_id)
        .or_else(|| keys.first())
        .map(|(_, key)| key)?;
    let plain = if oid == OID_3DES_CBC {
        des3_cbc(key.get(..24)?, iv, sealed)?
    } else if oid == OID_AES256_CBC {
        aes256_cbc(key.get(..32)?, iv, sealed)?
    } else {
        return None;
    };
    String::from_utf8(plain).ok()
}

fn read_gecko(dir: &Path) -> Result<Passwords, Error> {
    let path = dir.join("logins.json");
    let text = std::fs::read(&path).map_err(|err| io_error(&path, err))?;
    let logins: serde_json::Value = serde_json::from_slice(&text)
        .map_err(|err| Error::Format(format!("logins.json: {err}")))?;
    let keys = gecko_keys(&open_copy(&dir.join("key4.db"))?)?;
    let text_at = |login: &serde_json::Value, name: &str| {
        login
            .get(name)
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_owned()
    };
    let ms_at = |login: &serde_json::Value, name: &str| {
        login
            .get(name)
            .and_then(serde_json::Value::as_i64)
            .filter(|ms| *ms > 0)
    };
    let mut out = Passwords::default();
    let entries = logins.get("logins").and_then(serde_json::Value::as_array);
    for login in entries.into_iter().flatten() {
        let hostname = text_at(login, "hostname");
        if !is_web_url(&hostname) {
            out.skipped += 1;
            continue;
        }
        let opened = (
            open_login_field(&text_at(login, "encryptedUsername"), &keys),
            open_login_field(&text_at(login, "encryptedPassword"), &keys),
        );
        let (Some(username), Some(password)) = opened else {
            out.unreadable += 1;
            out.unreadable_sites.push(hostname);
            continue;
        };
        let realm = text_at(login, "httpRealm");
        let origin = hostname.trim_end_matches('/');
        let signon_realm = if realm.is_empty() {
            format!("{origin}/")
        } else {
            format!("{origin}/{realm}")
        };
        out.credentials.push(Credential {
            origin_url: format!("{origin}/"),
            action_url: text_at(login, "formSubmitURL"),
            signon_realm,
            username_element: text_at(login, "usernameField"),
            username,
            password_element: text_at(login, "passwordField"),
            password: Password::new(password),
            // Firefox doesn't record which HTTP scheme; Chromium's basic works for matching.
            scheme: i64::from(!realm.is_empty()),
            created_at_ms: ms_at(login, "timeCreated"),
            last_used_at_ms: ms_at(login, "timeLastUsed"),
        });
    }
    Ok(out)
}
