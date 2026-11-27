//! Linux: the item is in the Secret Service's default collection (GNOME Keyring, KWallet), found by
//! its service and account (the data folder), with no plaintext fallback; a hidden instance's
//! BRIGADIER_KEYCHAIN names a throwaway file instead, mode 0600 (proposed).

use secret_service::EncryptionType;
use secret_service::blocking::SecretService;
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::io::{self, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;

use super::{LOCK, walled};

const SERVICE: &str = "Brigadier";

/// A hidden instance's throwaway store, never on the default data folder [D416].
fn throwaway() -> Option<std::ffi::OsString> {
    std::env::var_os("BRIGADIER_DATA").and(std::env::var_os("BRIGADIER_KEYCHAIN"))
}

/// The whole payload; empty when there is no item, or none can be read here.
pub fn read(data: &Path) -> io::Result<Map<String, Value>> {
    if walled() {
        return Ok(Map::new());
    }
    match get(&data.display().to_string())? {
        Some(bytes) => serde_json::from_slice(&bytes)
            .map_err(|_| io::Error::other("Brigadier's secret item isn't readable")),
        None => Ok(Map::new()),
    }
}

/// Changes the payload under one lock, then reads it back whole before calling it done; the item
/// is made at the first secret and deleted when nothing is left in it [D2043].
pub fn update(data: &Path, change: impl FnOnce(&mut Map<String, Value>)) -> io::Result<()> {
    let _held = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let before = read(data)?;
    let mut after = before.clone();
    change(&mut after);
    after.retain(|_, v| v.as_object().is_some_and(|o| !o.is_empty()));
    if after == before {
        return Ok(());
    }
    if walled() {
        return Err(io::Error::other(
            "Brigadier's secret item: this instance has its own data folder (BRIGADIER_DATA) and no BRIGADIER_KEYCHAIN, so it doesn't use your own.",
        ));
    }
    let bytes = (!after.is_empty())
        .then(|| serde_json::to_vec(&after))
        .transpose()?;
    put(&data.display().to_string(), bytes.as_deref())?;
    match read(data)? == after {
        true => Ok(()),
        false => Err(io::Error::other(
            "Brigadier's secret item didn't keep what was written",
        )),
    }
}

fn fail(what: &str) -> impl Fn(secret_service::Error) -> io::Error {
    move |e| {
        io::Error::other(format!(
            "Brigadier's secret item: {what} failed ({e}). Brigadier keeps it in your desktop's keyring (the Secret Service: GNOME Keyring or KWallet), and doesn't save it in plain text."
        ))
    }
}

fn service() -> io::Result<SecretService<'static>> {
    SecretService::connect(EncryptionType::Dh).map_err(fail("connect"))
}

fn attrs(account: &str) -> HashMap<&str, &str> {
    HashMap::from([("service", SERVICE), ("account", account)])
}

fn get(account: &str) -> io::Result<Option<Vec<u8>>> {
    if let Some(file) = throwaway() {
        return match std::fs::read(file) {
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
            read => read.map(Some),
        };
    }
    let ss = service()?;
    let found = ss.search_items(attrs(account)).map_err(fail("read"))?;
    let Some(item) = found.unlocked.first().or(found.locked.first()) else {
        return Ok(None);
    };
    item.ensure_unlocked().map_err(fail("unlock"))?;
    item.get_secret().map(Some).map_err(fail("read"))
}

/// None deletes the item.
fn put(account: &str, bytes: Option<&[u8]>) -> io::Result<()> {
    if let Some(file) = throwaway() {
        return match bytes {
            None => std::fs::remove_file(file).or_else(|e| match e.kind() {
                io::ErrorKind::NotFound => Ok(()),
                _ => Err(e),
            }),
            Some(b) => (std::fs::OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(true))
            .mode(0o600)
            .open(file)
            .and_then(|mut f| f.write_all(b)),
        };
    }
    let ss = service()?;
    let Some(b) = bytes else {
        let found = ss.search_items(attrs(account)).map_err(fail("read"))?;
        for item in found.unlocked.iter().chain(&found.locked) {
            item.delete().map_err(fail("delete"))?;
        }
        return Ok(());
    };
    let collection = ss.get_default_collection().map_err(fail("open"))?;
    collection.ensure_unlocked().map_err(fail("unlock"))?;
    collection
        .create_item(SERVICE, attrs(account), b, true, "application/json")
        .map(drop)
        .map_err(fail("write"))
}
