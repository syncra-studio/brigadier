//! Brigadier's one Keychain item [D2043, D416]: service "Brigadier", account the data folder, a
//! JSON object keyed by library item key, each value an object (`{"env": {..}}`, 4.13's `oauth`).
//! Written through the Security framework, never argv or `security -i`, which cuts at 4096 bytes.
//! Only the daemon calls it.

use security_framework::os::macos::keychain::SecKeychain;
use serde_json::{Map, Value};
use std::io;
use std::path::Path;
use std::sync::Mutex;

const SERVICE: &str = "Brigadier";
/// errSecItemNotFound.
const NONE: i32 = -25300;
/// One read-modify-write at a time in this process.
static LOCK: Mutex<()> = Mutex::new(());

fn fail(what: &str) -> impl Fn(security_framework::base::Error) -> io::Error {
    move |e| {
        io::Error::other(format!(
            "Brigadier's Keychain item: {what} failed ({})",
            e.code()
        ))
    }
}

/// An instance on another data folder without BRIGADIER_KEYCHAIN: it never reaches the login
/// keychain, so it can't put up a prompt there [D449]. It reads no secrets and can't write one.
pub fn walled() -> bool {
    std::env::var_os("BRIGADIER_KEYCHAIN").is_none()
        && std::env::var_os("BRIGADIER_DATA")
            .is_some_and(|d| Path::new(&d) != crate::default_data_dir())
}

/// The login keychain; a hidden instance's throwaway file instead, never on the default data folder
/// [D416].
fn keychain() -> io::Result<SecKeychain> {
    if walled() {
        return Err(io::Error::other(
            "Brigadier's Keychain item: this instance has its own data folder (BRIGADIER_DATA) and no BRIGADIER_KEYCHAIN, so it doesn't use your login keychain.",
        ));
    }
    match std::env::var_os("BRIGADIER_DATA").and(std::env::var_os("BRIGADIER_KEYCHAIN")) {
        Some(file) => SecKeychain::open(file),
        None => SecKeychain::default(),
    }
    .map_err(fail("open"))
}

/// The whole payload; empty when there is no item, or none can be read here.
pub fn read(data: &Path) -> io::Result<Map<String, Value>> {
    if walled() {
        return Ok(Map::new());
    }
    match keychain()?.find_generic_password(SERVICE, &data.display().to_string()) {
        Ok((bytes, _)) => serde_json::from_slice(&bytes)
            .map_err(|_| io::Error::other("Brigadier's Keychain item isn't readable")),
        Err(e) if e.code() == NONE => Ok(Map::new()),
        Err(e) => Err(fail("read")(e)),
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
    let (chain, account) = (keychain()?, data.display().to_string());
    let found = chain.find_generic_password(SERVICE, &account).map(|f| f.1);
    match (found, after.is_empty()) {
        (Ok(item), true) => item.delete(),
        (Err(_), true) => {}
        (Ok(mut item), false) => item
            .set_password(&serde_json::to_vec(&after)?)
            .map_err(fail("write"))?,
        (Err(_), false) => {
            (chain.add_generic_password(SERVICE, &account, &serde_json::to_vec(&after)?))
                .map_err(fail("write"))?
        }
    }
    match read(data)? == after {
        true => Ok(()),
        false => Err(io::Error::other(
            "Brigadier's Keychain item didn't keep what was written",
        )),
    }
}
