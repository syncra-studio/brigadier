//! Reads other browsers' sign-ins (cookies and site storage) so Brigadier's built-in browser can
//! import them, on macOS, Windows and Linux.
//!
//! - **Discovery.** [`discover`] lists the profiles of the Chromium-family and Safari browsers
//!   installed for one user, from the folders those browsers keep on this OS (see [`Layout`]).
//!   Known browsers get their display name, app path and where their cookie key is kept; on macOS,
//!   unknown Chromium browsers are found by the shape of their folders.
//! - **Reading.** [`read_cookies`] turns a profile's cookie store into plain structs. Source databases are opened read-only and copied into memory with
//!   SQLite's online backup before any query runs, so a browser's own files are never written.
//! - **Keys.** [`chromium_keys`] fetches what opens Chromium's encrypted cookies on this OS, and
//!   [`read_cookies_with_keys`] uses it. Chrome's `v20` App-Bound cookies are never opened: see
//!   the `keys` module.
//! - **The source is never written.** The app imports the results itself; the one thing this
//!   crate writes is a copy of a source's site storage into a folder the app names.
//!
//! Imports are expected to run with the source browser quit ([`running`] says when it is not),
//! because a running browser holds its databases open and may not have flushed them.

mod chromium;
mod icons;
mod keys;
mod layout;
mod running;
mod safari;
mod site_storage;
mod sources;
mod sqlite;

use std::path::{Path, PathBuf};

mod types;
pub use types::*;

pub use icons::app_icon_file;
pub use keys::{ChromiumKeys, chromium_keys};
pub use layout::{Layout, Os};
pub use running::running;
pub use site_storage::{SITE_STORAGE_FOLDERS, copy_site_storage};
pub use sources::{Source, browser_rank, sources, sources_in, sources_layout};

/// Seconds between 1601-01-01 (the Windows/WebKit epoch Chromium uses) and the Unix epoch.
pub const WEBKIT_EPOCH_OFFSET_SECS: i64 = 11_644_473_600;
/// Seconds between 2001-01-01 (Apple's Core Data epoch Safari uses) and the Unix epoch.
pub const APPLE_EPOCH_OFFSET_SECS: i64 = 978_307_200;

/// Where macOS keeps apps: the shared and the user's Applications folders, then the system's
/// (Safari lives in the last).
pub fn app_dirs(home: &Path) -> Vec<PathBuf> {
    vec![
        PathBuf::from("/Applications"),
        home.join("Applications"),
        PathBuf::from("/System/Applications"),
        PathBuf::from("/System/Cryptexes/App/System/Applications"),
    ]
}

/// Lists the browser profiles found for the user whose home directory is `home`, on this OS,
/// sorted by browser then profile name.
pub fn discover(home: &Path) -> Vec<Profile> {
    discover_layout(&Layout::current(home))
}

/// [`discover`] over macOS's folders, whichever OS this runs on, with explicit folders to look
/// for app bundles in, so tests and callers with unusual layouts don't depend on what is
/// installed in `/Applications`.
pub fn discover_in(home: &Path, app_dirs: &[&Path]) -> Vec<Profile> {
    discover_layout(&Layout::Macos {
        home: home.to_owned(),
        app_dirs: app_dirs.iter().map(|dir| dir.to_path_buf()).collect(),
    })
}

/// [`discover`] over the folders of `layout`, whichever OS this runs on.
pub fn discover_layout(layout: &Layout) -> Vec<Profile> {
    let mut profiles = Vec::new();
    match layout {
        Layout::Macos { home, app_dirs } => {
            let app_dirs: Vec<&Path> = app_dirs.iter().map(PathBuf::as_path).collect();
            profiles.extend(chromium::discover(home, &app_dirs));
            profiles.extend(safari::discover(home, &app_dirs));
        }
        Layout::Windows { .. } | Layout::Linux { .. } => {
            profiles.extend(chromium::discover_other(layout));
        }
    }
    profiles.sort_by(|a, b| {
        (a.browser.to_lowercase(), a.name.to_lowercase(), &a.id).cmp(&(
            b.browser.to_lowercase(),
            b.name.to_lowercase(),
            &b.id,
        ))
    });
    profiles
}

/// Reads a profile's cookies, skipping expired and partitioned ones. `chromium_password` is the
/// macOS Keychain password from [`chromium_password`]; without it, encrypted Chromium cookies
/// count as unreadable. `now_unix` decides what has expired. For any OS, use
/// [`read_cookies_with_keys`].
pub fn read_cookies(
    profile: &Profile,
    chromium_password: Option<&[u8]>,
    now_unix: i64,
) -> Result<Cookies, Error> {
    match profile.family {
        Family::Chromium => {
            let keys = chromium_password
                .map(ChromiumKeys::from_macos_password)
                .unwrap_or_default();
            chromium::read_cookies(&profile.dir, &keys, now_unix)
        }
        Family::Safari => safari::read_cookies(profile, now_unix),
    }
}

/// Reads a profile's cookies on any OS, skipping expired and partitioned ones. `keys` comes from
/// [`chromium_keys`] and is ignored for other browser families, which don't encrypt cookies;
/// without the right one, encrypted Chromium cookies count as unreadable.
pub fn read_cookies_with_keys(
    profile: &Profile,
    keys: &ChromiumKeys,
    now_unix: i64,
) -> Result<Cookies, Error> {
    match profile.family {
        Family::Chromium => chromium::read_cookies(&profile.dir, keys, now_unix),
        Family::Safari => read_cookies(profile, None, now_unix),
    }
}

/// How many cookies a profile keeps, read without decrypting them (and so without asking the
/// Keychain). A running browser's store is read as it stands, unflushed changes included.
pub fn count_cookies(profile: &Profile) -> Result<usize, Error> {
    match profile.family {
        Family::Chromium => chromium::count_cookies(&profile.dir),
        Family::Safari => safari::count_cookies(profile),
    }
}

/// Fetches a Chromium browser's cookie encryption password (`"<Browser> Safe Storage"`) from the
/// login Keychain. macOS asks the user to allow it; a refusal is [`KeychainError::Denied`].
#[cfg(target_os = "macos")]
pub fn chromium_password(service: &str, account: Option<&str>) -> Result<Vec<u8>, Error> {
    if service == OFF_LIMITS_KEY {
        return Err(Error::Keychain(KeychainError::NotFound));
    }
    use security_framework::item::{ItemClass, ItemSearchOptions, SearchResult};
    use security_framework::passwords;

    // Security framework status codes (SecBase.h).
    const ERR_SEC_ITEM_NOT_FOUND: i32 = -25300;
    const ERR_SEC_USER_CANCELED: i32 = -128;
    const ERR_SEC_AUTH_FAILED: i32 = -25293;
    const ERR_SEC_INTERACTION_NOT_ALLOWED: i32 = -25308;

    let map = |err: security_framework::base::Error| {
        Error::Keychain(match err.code() {
            ERR_SEC_ITEM_NOT_FOUND => KeychainError::NotFound,
            ERR_SEC_USER_CANCELED | ERR_SEC_AUTH_FAILED | ERR_SEC_INTERACTION_NOT_ALLOWED => {
                KeychainError::Denied
            }
            _ => KeychainError::Other(err.to_string()),
        })
    };
    if let Some(account) = account {
        return passwords::get_generic_password(service, account).map_err(map);
    }
    let results = ItemSearchOptions::new()
        .class(ItemClass::generic_password())
        .service(service)
        .load_data(true)
        .limit(1i64)
        .search()
        .map_err(map)?;
    results
        .into_iter()
        .find_map(|result| match result {
            SearchResult::Data(data) => Some(data),
            _ => None,
        })
        .ok_or(Error::Keychain(KeychainError::NotFound))
}

/// Whether the login Keychain holds a Chromium browser's cookie encryption password, looked up
/// by its attributes only, so macOS never asks the user. `Ok(false)` when it isn't there.
#[cfg(target_os = "macos")]
pub fn chromium_password_exists(service: &str, account: Option<&str>) -> Result<bool, Error> {
    if service == OFF_LIMITS_KEY {
        return Ok(false);
    }
    use security_framework::item::{ItemClass, ItemSearchOptions};

    const ERR_SEC_ITEM_NOT_FOUND: i32 = -25300;
    let mut search = ItemSearchOptions::new();
    search
        .class(ItemClass::generic_password())
        .service(service)
        .load_attributes(true)
        .limit(1i64);
    if let Some(account) = account {
        search.account(account);
    }
    match search.search() {
        Ok(found) => Ok(!found.is_empty()),
        Err(err) if err.code() == ERR_SEC_ITEM_NOT_FOUND => Ok(false),
        Err(err) => Err(Error::Keychain(KeychainError::Other(err.to_string()))),
    }
}

/// The one secret this crate never asks for, even to see whether it exists: Brigadier's own engine
/// is Chromium too, and this item isn't another browser's to give. A Chromium-branded source
/// therefore brings no cookies where the item is what locks them (macOS and Linux).
pub const OFF_LIMITS_KEY: &str = "Chromium Safe Storage";

/// Whether `profile`'s cookies are locked with [`OFF_LIMITS_KEY`].
pub fn key_off_limits(profile: &Profile) -> bool {
    profile.keychain_service.as_deref() == Some(OFF_LIMITS_KEY)
        || (cfg!(target_os = "linux")
            && profile.linux_secret_application.as_deref() == Some("chromium"))
}

/// Whether a profile has no cookies to bring. Reads no secret. A store that can't be read counts as
/// having some, so a problem shows when importing rather than as an empty profile.
pub fn profile_is_empty(profile: &Profile) -> bool {
    !profile.has_cookies || matches!(count_cookies(profile), Ok(0))
}

/// Whether a file exists, and whether it can be opened. A file whose metadata the OS refuses
/// (as macOS does for Safari's folders without Full Disk Access) counts as existing but
/// unreadable.
fn probe(path: &Path) -> (bool, bool) {
    match std::fs::File::open(path) {
        Ok(file) => (file.metadata().map(|m| m.is_file()).unwrap_or(false), true),
        Err(err) if err.kind() == std::io::ErrorKind::PermissionDenied => (true, false),
        Err(_) => match std::fs::metadata(path) {
            Ok(meta) => (meta.is_file(), false),
            Err(err) => (err.kind() == std::io::ErrorKind::PermissionDenied, false),
        },
    }
}

/// The first of `bundles` found in `app_dirs`, else the first in the first folder, since the
/// path still names the bundle [`running`] looks for. A bundle may be a `/`-separated path.
fn app_path(app_dirs: &[&Path], bundles: &[&str]) -> Option<PathBuf> {
    for bundle in bundles {
        for dir in app_dirs {
            let path = layout::join_rel(dir, bundle);
            if path.exists() {
                return Some(path);
            }
        }
    }
    let (dir, bundle) = (app_dirs.first()?, bundles.first()?);
    Some(layout::join_rel(dir, bundle))
}

/// Whether the app bundle at `app` says it opens web links (`http`/`https` among its
/// `CFBundleURLSchemes`), as every browser does and apps built on Chromium (Electron) don't.
fn opens_web_links(app: &Path) -> bool {
    let Ok(info) = plist::Value::from_file(app.join("Contents/Info.plist")) else {
        return false;
    };
    let types = info
        .as_dictionary()
        .and_then(|info| info.get("CFBundleURLTypes"))
        .and_then(plist::Value::as_array);
    types.into_iter().flatten().any(|kind| {
        kind.as_dictionary()
            .and_then(|kind| kind.get("CFBundleURLSchemes"))
            .and_then(plist::Value::as_array)
            .is_some_and(|schemes| {
                schemes
                    .iter()
                    .any(|scheme| matches!(scheme.as_string(), Some("http" | "https")))
            })
    })
}

/// The app bundle in `app_dirs` named `bundle`, only if it exists.
fn existing_app(app_dirs: &[&Path], bundle: &str) -> Option<PathBuf> {
    app_dirs
        .iter()
        .map(|dir| dir.join(bundle))
        .find(|path| path.exists())
}

/// Lowercase ASCII key for a browser id, e.g. "Google Chrome Beta" → "google-chrome-beta".
fn key_for(name: &str) -> String {
    let mut key = String::new();
    for c in name.chars() {
        if c.is_ascii_alphanumeric() {
            key.push(c.to_ascii_lowercase());
        } else if !key.ends_with('-') && !key.is_empty() {
            key.push('-');
        }
    }
    key.trim_end_matches('-').to_owned()
}
