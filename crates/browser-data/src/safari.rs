//! Safari: `Cookies.binarycookies`; `History.db` only marks where a profile is.
//!
//! Apple doesn't document the binarycookies format; the layout here is the widely
//! reverse-engineered one (a big-endian file header listing page sizes, little-endian pages of
//! cookie records). It is parsed defensively: anything out of bounds is counted as unreadable,
//! never trusted.
//!
//! Safari 17 added profiles. Each keeps its history in
//! `Containers/com.apple.Safari/Data/Library/Safari/Profiles/<UUID>/History.db`; its cookies
//! are expected in that container's `WebKit/WebsiteDataStore/<UUID>/Cookies/` (the per-profile
//! WebKit data store named by the same UUID). That cookie location is a best understanding,
//! not confirmed, so a profile only claims cookies when the file is actually there. Profile
//! names come from `SafariTabs.db` (the `bookmarks` row whose `external_uuid` is the profile's
//! UUID) when it can be read, else "Profile N".

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use crate::sqlite::{io_error, open_copy};
use crate::{
    APPLE_EPOCH_OFFSET_SECS, Cookie, Cookies, Error, Family, Profile, existing_app, probe,
};

/// The default profile's id.
const DEFAULT_ID: &str = "safari/default";
/// Size of a cookie record's fixed header, before its strings.
const RECORD_HEADER: usize = 56;
/// Cookie flag: Secure.
const FLAG_SECURE: u32 = 1;
/// Cookie flag: HttpOnly.
const FLAG_HTTP_ONLY: u32 = 4;

/// `~/Library/Containers/com.apple.Safari/Data/Library`.
fn container(home: &Path) -> PathBuf {
    home.join("Library/Containers/com.apple.Safari/Data/Library")
}

/// Whether a path exists, counting a refusal to look (no Full Disk Access) as existing.
fn exists(path: &Path) -> bool {
    match std::fs::metadata(path) {
        Ok(_) => true,
        Err(err) => err.kind() == std::io::ErrorKind::PermissionDenied,
    }
}

pub(crate) fn discover(home: &Path, app_dirs: &[&Path]) -> Vec<Profile> {
    let safari_dir = home.join("Library/Safari");
    let container = container(home);
    let app = existing_app(app_dirs, "Safari.app");
    if app.is_none() && !exists(&safari_dir) && !exists(&container) {
        return Vec::new();
    }
    let mut profiles = Vec::new();

    let cookie_file = default_cookie_files(home)
        .into_iter()
        .find(|path| exists(path));
    let (has_cookies, cookies_readable) = cookie_file.as_deref().map_or((false, true), probe);
    let (has_history, history_readable) = probe(&safari_dir.join("History.db"));
    profiles.push(Profile {
        id: DEFAULT_ID.to_owned(),
        browser: "Safari".to_owned(),
        name: "Default".to_owned(),
        family: Family::Safari,
        dir: safari_dir,
        app_path: app.clone(),
        keychain_service: None,
        keychain_account: None,
        local_state: None,
        linux_secret_application: None,
        has_cookies,
        has_history,
        readable: (!has_cookies || cookies_readable) && (!has_history || history_readable),
        is_default: true,
    });

    let Ok(entries) = std::fs::read_dir(container.join("Safari/Profiles")) else {
        return profiles;
    };
    let mut uuids: Vec<String> = entries
        .flatten()
        .filter(|entry| entry.path().join("History.db").exists())
        .filter_map(|entry| entry.file_name().into_string().ok())
        .collect();
    uuids.sort();
    let names = profile_names(&container);
    for (index, uuid) in uuids.into_iter().enumerate() {
        let dir = container.join("Safari/Profiles").join(&uuid);
        let (has_cookies, cookies_readable) = probe(&profile_cookie_file(&dir));
        let (has_history, history_readable) = probe(&dir.join("History.db"));
        profiles.push(Profile {
            id: format!("safari/{uuid}"),
            browser: "Safari".to_owned(),
            name: names
                .get(&uuid.to_uppercase())
                .cloned()
                .unwrap_or_else(|| format!("Profile {}", index + 1)),
            family: Family::Safari,
            app_path: app.clone(),
            keychain_service: None,
            keychain_account: None,
            local_state: None,
            linux_secret_application: None,
            has_cookies,
            has_history,
            readable: (!has_cookies || cookies_readable) && (!has_history || history_readable),
            is_default: false,
            dir,
        });
    }
    profiles
}

/// Safari profile names by uppercased UUID, best effort.
fn profile_names(container: &Path) -> HashMap<String, String> {
    let read = || -> Result<HashMap<String, String>, Error> {
        let conn = open_copy(&container.join("Safari/SafariTabs.db"))?;
        let mut stmt = conn.prepare(
            "SELECT external_uuid, title FROM bookmarks
             WHERE external_uuid IS NOT NULL AND title IS NOT NULL AND title != ''",
        )?;
        let rows = stmt.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get(1)?)))?;
        Ok(rows
            .flatten()
            .map(|(uuid, title)| (uuid.to_uppercase(), title))
            .collect())
    };
    read()
        .inspect_err(|err| tracing::debug!(%err, "Safari profile names unavailable"))
        .unwrap_or_default()
}

/// The default profile's cookie files, current location first: sandboxed Safari keeps them in
/// its container; older versions used `~/Library/Cookies`.
fn default_cookie_files(home: &Path) -> [PathBuf; 2] {
    [
        container(home).join("Cookies/Cookies.binarycookies"),
        home.join("Library/Cookies/Cookies.binarycookies"),
    ]
}

/// A Safari 17 profile's cookie file, from its `…/Data/Library/Safari/Profiles/<UUID>` dir.
fn profile_cookie_file(dir: &Path) -> PathBuf {
    let uuid = dir.file_name().unwrap_or_default();
    let library = dir.ancestors().nth(3).unwrap_or(dir);
    library
        .join("WebKit/WebsiteDataStore")
        .join(uuid)
        .join("Cookies/Cookies.binarycookies")
}

/// The cookie file a profile reads: for the default one, the first that exists.
fn cookie_file(profile: &Profile) -> PathBuf {
    if profile.id == DEFAULT_ID {
        // dir = <home>/Library/Safari
        let home = profile.dir.ancestors().nth(2).unwrap_or(&profile.dir);
        let files = default_cookie_files(home);
        let found = files.iter().find(|path| exists(path)).cloned();
        found.unwrap_or_else(|| files[0].clone())
    } else {
        profile_cookie_file(&profile.dir)
    }
}

pub(crate) fn read_cookies(profile: &Profile, now_unix: i64) -> Result<Cookies, Error> {
    let path = cookie_file(profile);
    let data = std::fs::read(&path).map_err(|err| io_error(&path, err))?;
    parse_binarycookies(&data, now_unix)
}

/// How many cookies a profile's file holds, expired ones included.
pub(crate) fn count_cookies(profile: &Profile) -> Result<usize, Error> {
    let read = read_cookies(profile, i64::MIN)?;
    Ok(read.cookies.len() + read.expired)
}

fn u32_be(data: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_be_bytes(
        data.get(at..at.checked_add(4)?)?.try_into().ok()?,
    ))
}

fn u32_le(data: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_le_bytes(
        data.get(at..at.checked_add(4)?)?.try_into().ok()?,
    ))
}

fn f64_le(data: &[u8], at: usize) -> Option<f64> {
    Some(f64::from_le_bytes(
        data.get(at..at.checked_add(8)?)?.try_into().ok()?,
    ))
}

/// The NUL-terminated UTF-8 string at `at` in `record`.
fn c_str(record: &[u8], at: u32) -> Option<String> {
    let bytes = record.get(usize::try_from(at).ok()?..)?;
    let end = bytes.iter().position(|b| *b == 0)?;
    String::from_utf8(bytes[..end].to_vec()).ok()
}

/// Parses a `Cookies.binarycookies` file. A bad file header is an error; a bad page or record
/// is counted as unreadable and the rest is still read.
pub(crate) fn parse_binarycookies(data: &[u8], now_unix: i64) -> Result<Cookies, Error> {
    let bad = |what: &str| Error::Format(format!("binarycookies: {what}"));
    if data.get(..4) != Some(b"cook".as_slice()) {
        return Err(bad("missing magic"));
    }
    let pages = u32_be(data, 4).ok_or_else(|| bad("truncated header"))?;
    let pages = usize::try_from(pages).map_err(|_| bad("page count"))?;
    let sizes_end = pages.checked_mul(4).and_then(|n| n.checked_add(8));
    if sizes_end.is_none_or(|end| end > data.len()) {
        return Err(bad("page table out of bounds"));
    }
    let mut out = Cookies::default();
    let mut offset = sizes_end.unwrap_or(data.len());
    for index in 0..pages {
        let size = u32_be(data, 8 + index * 4).and_then(|s| usize::try_from(s).ok());
        let page = size
            .and_then(|size| Some((size, offset.checked_add(size)?)))
            .and_then(|(size, end)| Some((size, data.get(offset..end)?)));
        let Some((size, page)) = page else {
            // The page table promises more than the file holds; nothing after this is aligned.
            out.unreadable += 1;
            break;
        };
        offset += size;
        parse_page(page, now_unix, &mut out);
    }
    Ok(out)
}

fn parse_page(page: &[u8], now_unix: i64, out: &mut Cookies) {
    if u32_be(page, 0) != Some(0x0000_0100) {
        out.unreadable += 1;
        return;
    }
    let Some(count) = u32_le(page, 4).and_then(|c| usize::try_from(c).ok()) else {
        out.unreadable += 1;
        return;
    };
    for index in 0..count {
        let record = index
            .checked_mul(4)
            .and_then(|at| u32_le(page, at.checked_add(8)?))
            .and_then(|start| usize::try_from(start).ok())
            .and_then(|start| {
                let size = usize::try_from(u32_le(page, start)?).ok()?;
                page.get(start..start.checked_add(size)?)
            });
        let Some(record) = record else {
            // Offsets past the page: the count itself is untrustworthy, stop here.
            out.unreadable += count - index;
            return;
        };
        match parse_record(record) {
            Some(cookie) if cookie.expires_unix.is_some_and(|e| e < now_unix) => out.expired += 1,
            Some(cookie) => out.cookies.push(cookie),
            None => out.unreadable += 1,
        }
    }
}

fn parse_record(record: &[u8]) -> Option<Cookie> {
    if record.len() < RECORD_HEADER {
        return None;
    }
    let flags = u32_le(record, 8)?;
    let domain = c_str(record, u32_le(record, 16)?)?;
    let name = c_str(record, u32_le(record, 20)?)?;
    let path = c_str(record, u32_le(record, 24)?)?;
    let value = c_str(record, u32_le(record, 28)?)?;
    let expiry = f64_le(record, 40)?;
    if !expiry.is_finite() || domain.is_empty() {
        return None;
    }
    // Saturating float-to-int conversion; any real expiry fits.
    let expires_unix = expiry.floor() as i64 + APPLE_EPOCH_OFFSET_SECS;
    Some(Cookie {
        name,
        value,
        host_only: !domain.starts_with('.'),
        domain,
        path,
        // Safari stores only persistent cookies here.
        expires_unix: Some(expires_unix),
        secure: flags & FLAG_SECURE != 0,
        http_only: flags & FLAG_HTTP_ONLY != 0,
        // The classic layout records no SameSite.
        same_site: None,
        source_insecure: false,
    })
}
