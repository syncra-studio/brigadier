//! Import's reading half: one source profile read through `brigadier-browser-data` and held by token until it is
//! written, its passwords with it, never longer than two minutes.

use super::{PASSWORDS_HERE, change_saved, running};
use brigadier_browser_data::{
    self as reader, ChromiumKeys, Cookie, Error, Family, Profile, SecretError, Source,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// The most visits one profile's import brings over, newest first.
const HISTORY_LIMIT: usize = 50_000;
/// How long a browser's key stays for the rest of its profiles: one question per browser.
const KEY_KEPT: Duration = Duration::from_secs(120);
/// How long a read waits to be written before its passwords are let go of.
const READ_KEPT: Duration = Duration::from_secs(120);

/// One saved password on its way to the profile's vault.
#[derive(Serialize)]
pub(super) struct Login {
    pub(super) url: String,
    pub(super) username: String,
    pub(super) password: String,
}

/// One source profile read, held by token until it is written.
#[derive(Default)]
pub(super) struct Read {
    pub(super) key: String,
    pub(super) browser: String,
    pub(super) id: String,
    pub(super) profile_name: String,
    /// The source's sign-ins were read, even if there are none: importing over a profile swaps them.
    pub(super) sign_ins_read: bool,
    pub(super) cookies: Vec<Cookie>,
    pub(super) left_out_domains: Vec<String>,
    pub(super) app_bound_domains: Vec<String>,
    pub(super) site_storage_from: Option<PathBuf>,
    pub(super) history: Vec<reader::Visit>,
    pub(super) history_error: Option<String>,
    pub(super) bookmarks: Vec<reader::Bookmark>,
    pub(super) bookmarks_error: Option<String>,
    pub(super) passwords_read: bool,
    pub(super) logins: Vec<Login>,
    pub(super) logins_left_out: usize,
    pub(super) passwords_error: Option<String>,
    /// Set by `write`: the profile it goes into, cookies left out as Google's, and where site storage went.
    pub(super) written: Option<(String, usize, Option<&'static str>)>,
    pub(super) at: Option<Instant>,
}

static NEXT: AtomicU64 = AtomicU64::new(1);
static READS: Mutex<Option<HashMap<u64, Read>>> = Mutex::new(None);
/// A browser's key for its other profiles, by browser key. Gone when it's next looked at, late.
static KEYS: Mutex<Option<HashMap<String, (ChromiumKeys, Instant)>>> = Mutex::new(None);

pub(super) fn reads<T>(with: impl FnOnce(&mut HashMap<u64, Read>) -> T) -> T {
    let mut held = READS.lock().unwrap_or_else(|e| e.into_inner());
    let held = held.get_or_insert_default();
    held.retain(|_, r| r.at.is_some_and(|at| at.elapsed() < READ_KEPT));
    with(held)
}

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

fn password_failure(error: &Error, browser: &str) -> String {
    match error {
        Error::NotReadable(_) => format!(
            "{browser} keeps its passwords in iCloud Keychain, which other apps can't read."
        ),
        Error::Secret(SecretError::Locked) => {
            format!("{browser}'s passwords are locked with a Primary Password.")
        }
        Error::PermissionDenied(_) => {
            format!("Your system won't let Brigadier read {browser}'s passwords.")
        }
        // Not the error's text: nothing about a password's store needs repeating.
        _ => format!("{browser}'s passwords couldn't be read."),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Parts {
    sign_ins: bool,
    history: bool,
    bookmarks: bool,
    passwords: bool,
}

fn read_profile(source: &Source, profile: &Profile, what: &Parts) -> Result<Read, Value> {
    let browser = &source.name;
    let mut out = Read {
        profile_name: profile.name.clone(),
        ..Read::default()
    };
    let chromium = profile.family == Family::Chromium;
    let off_limits = reader::key_off_limits(profile);
    let keys =
        match chromium && !off_limits && (what.sign_ins || (what.passwords && PASSWORDS_HERE)) {
            true => keys_of(&source.key, profile).map_err(|e| cookie_failure(&e, browser))?,
            false => ChromiumKeys::default(),
        };
    let now_unix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs() as i64);
    if what.sign_ins && !off_limits {
        match reader::read_cookies_with_keys(profile, &keys, now_unix) {
            Ok(read) => {
                out.left_out_domains = read.read.unreadable_domains;
                // Electron can't set a partitioned cookie, and its copy without the partition would go where the site never meant.
                out.left_out_domains.extend(read.read.partitioned_domains);
                out.app_bound_domains = read.app_bound_domains;
                out.cookies = read.read.cookies;
            }
            // A profile without a cookie file just brings none.
            Err(Error::NotFound(_)) => {}
            Err(error) => return Err(cookie_failure(&error, browser)),
        }
        out.sign_ins_read = true;
        out.site_storage_from = chromium.then(|| profile.dir.clone());
    }
    if what.history && profile.has_history {
        match reader::read_history(profile, HISTORY_LIMIT) {
            Ok(visits) => out.history = visits,
            Err(Error::PermissionDenied(_)) => {
                out.history_error = Some(format!(
                    "Brigadier needs permission to read {browser}'s history."
                ))
            }
            Err(error) => {
                out.history_error = Some(format!("{browser}'s history couldn't be read ({error})."))
            }
        }
    }
    if what.bookmarks && profile.has_bookmarks {
        match reader::read_bookmarks(profile) {
            Ok(found) => out.bookmarks = found.bookmarks,
            Err(error) => {
                out.bookmarks_error =
                    Some(format!("{browser}'s bookmarks couldn't be read ({error})."))
            }
        }
    }
    if what.passwords && PASSWORDS_HERE && !off_limits {
        match reader::read_passwords(profile, &keys) {
            Ok(found) => {
                out.logins_left_out = found.unreadable;
                out.logins = (found.credentials.into_iter())
                    .map(|c| Login {
                        password: c.password.reveal().to_owned(),
                        url: c.origin_url,
                        username: c.username,
                    })
                    .collect();
                out.passwords_read = true;
            }
            Err(Error::NotFound(_)) => out.passwords_read = true,
            Err(error) => out.passwords_error = Some(password_failure(&error, browser)),
        }
    }
    Ok(out)
}

/// Reads profile `id` of browser `key` and holds it by token. Refused while that browser is open: its files may be half written.
pub(super) fn read(
    data: &Path,
    home: &Path,
    key: &str,
    id: &str,
    what: &Parts,
) -> io::Result<Value> {
    let gone = || failed("gone", "That browser or profile is no longer here.".into());
    let Some(source) = reader::sources(home).into_iter().find(|s| s.key == key) else {
        return Ok(gone());
    };
    let Some(profile) = source.profiles.iter().find(|p| p.id == id) else {
        return Ok(gone());
    };
    if running(&source) {
        return Ok(failed(
            "running",
            format!("Quit {} first, then import again.", source.name),
        ));
    }
    let mut read = match read_profile(&source, profile, what) {
        Ok(read) => read,
        Err(failure) => {
            if failure["reason"] == "needsKeychainAccess" {
                change_saved(data, |saved| {
                    saved.browsers.entry(key.into()).or_default().denied = true
                })?;
            }
            return Ok(failure);
        }
    };
    let nothing = read.cookies.len()
        + read.left_out_domains.len()
        + read.app_bound_domains.len()
        + read.history.len()
        + read.bookmarks.len()
        + read.logins.len()
        + read.logins_left_out
        == 0;
    if nothing
        && read.site_storage_from.is_none()
        && read.history_error.is_none()
        && read.bookmarks_error.is_none()
        && read.passwords_error.is_none()
    {
        return Ok(failed(
            "readFailed",
            format!("There's nothing to bring from {}.", read.profile_name),
        ));
    }
    (read.key, read.browser, read.id, read.at) = (
        key.into(),
        source.name.clone(),
        id.into(),
        Some(Instant::now()),
    );
    let token = reads(|held| {
        let token = NEXT.fetch_add(1, Ordering::Relaxed);
        held.insert(token, read);
        token
    });
    Ok(json!({"ok": true, "type": "ready", "token": token}))
}
