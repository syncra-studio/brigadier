//! Import's reading half: one source profile's cookies, read through `brigadier-browser-data` and handed straight
//! to the page; nothing is held here but a browser's key, for its other profiles.

use super::{Record, change_saved, distinct, running};
use brigadier_browser_data::{self as reader, ChromiumKeys, Error, Family, Profile, SecretError};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::io;
use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// How long a browser's key stays for the rest of its profiles: one question per browser.
const KEY_KEPT: Duration = Duration::from_secs(120);

/// A browser's key for its other profiles, by browser key. Gone when it's next looked at, late.
static KEYS: Mutex<Option<HashMap<String, (ChromiumKeys, Instant)>>> = Mutex::new(None);

fn keys_of(browser: &str, profile: &Profile) -> Result<ChromiumKeys, Error> {
    let mut kept = KEYS.lock().unwrap_or_else(|e| e.into_inner());
    let kept = kept.get_or_insert_default();
    kept.retain(|_, (_, at)| at.elapsed() < KEY_KEPT);
    if let Some((keys, _)) = kept.get(browser) {
        return Ok(keys.clone());
    }
    let keys = reader::chromium_keys(profile)?;
    kept.insert(browser.to_owned(), (keys.clone(), Instant::now()));
    Ok(keys)
}

pub(super) fn failed(reason: &str, message: String) -> Value {
    json!({"ok": true, "type": "failed", "reason": reason, "message": message})
}

/// Why `browser`'s cookies couldn't be read, as the page's reason and in plain words.
fn cookie_failure(error: &Error, browser: &str) -> Value {
    let macos = cfg!(target_os = "macos");
    let (reason, message) = match error {
        Error::Secret(SecretError::Denied) if macos => (
            "needsKeychainAccess",
            format!("macOS didn't let Brigadier use {browser}'s cookie key."),
        ),
        Error::Secret(SecretError::NotFound) if macos => (
            "noKeychainKey",
            format!("{browser}'s cookie key isn't in your Keychain."),
        ),
        Error::Secret(secret) => (
            "readFailed",
            match secret {
                SecretError::Locked => format!(
                    "Your keyring is locked, so {browser}'s cookies can't be opened. Unlock it and try again."
                ),
                SecretError::Denied => format!(
                    "{browser}'s cookie key belongs to another user, so Brigadier can't open it."
                ),
                SecretError::NotFound => format!("{browser} has no cookie key yet."),
                SecretError::NoStore => {
                    format!("This machine has no keyring holding {browser}'s cookie key.")
                }
                SecretError::Other(_) => format!("{browser}'s cookie key couldn't be read."),
            },
        ),
        Error::PermissionDenied(_) if macos => (
            "needsFullDiskAccess",
            format!("Brigadier needs Full Disk Access to read {browser}'s cookies."),
        ),
        Error::PermissionDenied(_) => (
            "readFailed",
            format!("Your system won't let Brigadier read {browser}'s cookies."),
        ),
        Error::Locked(_) => ("running", format!("{browser} is still using its cookies.")),
        _ => (
            "readFailed",
            format!("{browser}'s cookies couldn't be read ({error})."),
        ),
    };
    failed(reason, message)
}

/// Reads the cookies of profile `id` of browser `key`, with the record `place` keeps. Refused while that browser
/// is open: its files may be half written.
pub(super) fn read(data: &Path, home: &Path, key: &str, id: &str) -> io::Result<Value> {
    let gone = || failed("gone", "That browser or profile is no longer here.".into());
    let Some(source) = reader::sources(home).into_iter().find(|s| s.key == key) else {
        return Ok(gone());
    };
    let Some(profile) = source.profiles.iter().find(|p| p.id == id) else {
        return Ok(gone());
    };
    let browser = &source.name;
    if running(&source) {
        return Ok(failed(
            "running",
            format!("Quit {browser} first, then import again."),
        ));
    }
    if reader::key_off_limits(profile) {
        return Ok(failed(
            "readFailed",
            format!("{browser}'s cookies are locked with a key Brigadier can't use."),
        ));
    }
    let keys = match profile.family {
        Family::Chromium => keys_of(&source.key, profile),
        Family::Safari => Ok(ChromiumKeys::default()),
    };
    let now_unix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs() as i64);
    let read = keys.and_then(|keys| reader::read_cookies_with_keys(profile, &keys, now_unix));
    let read = match read {
        Ok(read) => read,
        // A profile without a cookie file just brings none.
        Err(Error::NotFound(_)) => Default::default(),
        Err(error) => {
            let failure = cookie_failure(&error, browser);
            if failure["reason"] == "needsKeychainAccess" {
                change_saved(data, |saved| {
                    saved.browsers.entry(key.into()).or_default().denied = true
                })?;
            }
            return Ok(failure);
        }
    };
    // Electron can't set a partitioned cookie, and its copy without the partition would go where the site never meant.
    let left_out: Vec<String> = read
        .read
        .unreadable_domains
        .into_iter()
        .chain(read.read.partitioned_domains)
        .collect();
    let cookies = read.read.cookies;
    if cookies.is_empty() && profile.family == Family::Safari {
        return Ok(failed(
            "readFailed",
            format!("There's nothing to bring from {}.", profile.name),
        ));
    }
    let (skipped_domains, skipped_domain_count) =
        distinct(left_out.iter().chain(&read.app_bound_domains).cloned());
    let record = Record {
        profiles: vec![profile.name.clone()],
        imported: cookies.len(),
        skipped: left_out.len() + read.app_bound_domains.len(),
        skipped_domains,
        skipped_domain_count,
        app_bound_domains: distinct(read.app_bound_domains).0,
        ..Record::default()
    };
    Ok(json!({"ok": true, "type": "ready", "cookies": cookies, "record": record}))
}
