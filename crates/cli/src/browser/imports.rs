//! Settings › Import Browser Data (the old app's browserImport.ts and shell-native's browser_import.rs): which
//! browsers are on this computer and where each stands, and one of their profiles read into a Brigadier profile.
//! History, bookmarks and passwords are written here and never leave Rust; cookies go to main, which sets them in
//! the profile's session. `brigadier-browser-data` reads and never writes a source's files.

mod read;

use super::{Store, bookmarks, now, vault, web_address};
use brigadier_browser_data::{self as reader, Cookie, Error, Family, Source};
use brigadier_core as core;
use read::{Login, reads};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::{fs, io};

/// Linux has no password import, by the user's decision: it holds for every browser there.
const PASSWORDS_HERE: bool = !cfg!(target_os = "linux");

/// What one source profile's import brought.
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Record {
    at_ms: i64,
    profiles: Vec<String>,
    imported: usize,
    skipped: usize,
    skipped_domains: Vec<String>,
    skipped_domain_count: usize,
    app_bound_domains: Vec<String>,
    history: usize,
    bookmarks: usize,
    passwords: usize,
    passwords_skipped: usize,
    /// Importing over this profile found no usable password, so the ones it had were left alone.
    passwords_kept: bool,
    google_left_out: usize,
}

/// What's kept of imports: each browser's last per source profile, each source profile's place here, the notice seen.
#[derive(Default, Serialize, Deserialize)]
#[serde(default)]
struct Saved {
    browsers: BTreeMap<String, Browser>,
    /// By source profile id (`<browser key>/<profile>`).
    sources: BTreeMap<String, Place>,
    noticed: bool,
}

#[derive(Default, Serialize, Deserialize)]
#[serde(default)]
struct Browser {
    records: BTreeMap<String, Record>,
    denied: bool,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Place {
    into: String,
    at_ms: i64,
    browser: String,
}

fn saved_file(data: &Path) -> PathBuf {
    data.join("browser").join("browser-imports.json")
}

fn read_saved(data: &Path) -> Saved {
    fs::read(saved_file(data))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

fn change_saved(data: &Path, change: impl FnOnce(&mut Saved)) -> io::Result<()> {
    let mut saved = read_saved(data);
    change(&mut saved);
    core::write_atomic(&saved_file(data), &serde_json::to_vec(&saved)?)
}

/// The distinct domains among `domains`, without a leading dot: the first 20, and how many in all.
fn distinct(domains: impl IntoIterator<Item = String>) -> (Vec<String>, usize) {
    let mut seen: Vec<String> = Vec::new();
    for domain in domains {
        let domain = domain.trim_start_matches('.').to_lowercase();
        if !domain.is_empty() && !seen.contains(&domain) {
            seen.push(domain);
        }
    }
    let count = seen.len();
    seen.truncate(20);
    (seen, count)
}

/// A browser's row: its source profiles' last imports summed up, naming each. None with none.
fn merged(records: &[&Record]) -> Option<Record> {
    let sum = |field: fn(&Record) -> usize| records.iter().map(|r| field(r)).sum();
    let (skipped_domains, count) = distinct(records.iter().flat_map(|r| r.skipped_domains.clone()));
    Some(Record {
        at_ms: records.iter().map(|r| r.at_ms).max()?,
        profiles: records.iter().flat_map(|r| r.profiles.clone()).collect(),
        imported: sum(|r| r.imported),
        skipped: sum(|r| r.skipped),
        skipped_domains,
        // Each record keeps only its first domains, so the same site may count once in each: at least this many.
        skipped_domain_count: records
            .iter()
            .map(|r| r.skipped_domain_count)
            .max()
            .unwrap_or(0)
            .max(count),
        app_bound_domains: distinct(records.iter().flat_map(|r| r.app_bound_domains.clone())).0,
        history: sum(|r| r.history),
        bookmarks: sum(|r| r.bookmarks),
        passwords: sum(|r| r.passwords),
        passwords_skipped: sum(|r| r.passwords_skipped),
        passwords_kept: records.iter().any(|r| r.passwords_kept),
        google_left_out: sum(|r| r.google_left_out),
    })
}

/// Whether a browser is open. Safari's cookie file is read whole and its history through a snapshot, so it can stay open.
fn running(source: &Source) -> bool {
    source.family != Family::Safari && source.profiles.first().is_some_and(reader::running)
}

/// Whether the browser's key can be asked for, without asking: only macOS has a question to ask.
fn key_state(source: &Source) -> Option<&'static str> {
    let profile = source.profiles.first()?;
    if !cfg!(target_os = "macos")
        || source.family != Family::Chromium
        || reader::key_off_limits(profile)
    {
        return None;
    }
    match reader::chromium_password_exists(
        profile.keychain_service.as_deref()?,
        profile.keychain_account.as_deref(),
    ) {
        Ok(true) => None,
        Ok(false) => Some("noKeychainKey"),
        Err(_) => Some("unavailable"),
    }
}

/// One browser as the page lists it.
fn listed(source: Source, saved: &Saved) -> Value {
    let browser = saved.browsers.get(&source.key);
    let mut state = if running(&source) {
        "running"
    } else if source.profiles.iter().any(|p| !p.readable) {
        "needsFullDiskAccess"
    } else {
        key_state(&source).unwrap_or(if browser.is_some_and(|b| b.denied) {
            "needsKeychainAccess"
        } else {
            "ready"
        })
    };
    let off_limits = source.profiles.iter().any(reader::key_off_limits);
    let (mut profiles, mut empty) = (vec![], vec![]);
    if state == "ready" || state == "needsKeychainAccess" {
        for profile in &source.profiles {
            if reader::profile_is_empty(profile) {
                empty.push(profile.name.clone());
                continue;
            }
            let cookies = match reader::count_cookies(profile) {
                Ok(n) => Some(n),
                Err(Error::PermissionDenied(_)) => {
                    state = "needsFullDiskAccess";
                    (profiles, empty) = (vec![], vec![]);
                    break;
                }
                Err(_) => None,
            };
            profiles.push(json!({"id": profile.id, "name": profile.name, "cookies": cookies, "isDefault": profile.is_default}));
        }
    }
    let records: Vec<&Record> = browser
        .map(|b| b.records.values().collect())
        .unwrap_or_default();
    json!({
        "key": source.key, "name": source.name, "appPath": source.app_path,
        "family": match source.family { Family::Chromium => "chromium", Family::Gecko => "gecko", Family::Safari => "safari" },
        "state": state, "profiles": profiles, "emptyProfiles": empty,
        "signIns": !off_limits, "passwords": PASSWORDS_HERE && !off_limits,
        "record": merged(&records), "imports": saved.sources, "firstImport": !saved.noticed,
    })
}

/// A cookie of google.com or a subdomain: Google binds these to the browser that made them. Orca (MIT) leaves them out too.
fn google(domain: &str) -> bool {
    let host = domain.trim_start_matches('.').to_lowercase();
    host == "google.com" || host.ends_with(".google.com")
}

/// The sign-ins half, before main sets the cookies: site storage goes into the profile's partition now, or when
/// the app next starts if its session is `open` (Chromium holds the folders), and the cookies go back to the page.
fn write(data: &Path, token: u64, profile: &str, open: bool) -> io::Result<Value> {
    let (cookies, storage) = reads(|held| {
        let read = held
            .get_mut(&token)
            .filter(|r| r.written.is_none())
            .ok_or_else(|| io::Error::other("That read has expired. Import again."))?;
        let all = std::mem::take(&mut read.cookies);
        let google_left_out = all.iter().filter(|c| google(&c.domain)).count();
        let cookies: Vec<Cookie> = all.into_iter().filter(|c| !google(&c.domain)).collect();
        read.cookies = cookies.clone();
        let storage = read
            .site_storage_from
            .clone()
            .filter(|_| read.sign_ins_read);
        read.written = Some((profile.into(), google_left_out, None));
        io::Result::Ok((cookies, storage))
    })?;
    let site_storage = match storage {
        Some(from) => {
            let place = if open {
                "browser-import-staged"
            } else {
                "Partitions"
            };
            reader::copy_site_storage(
                &from,
                &data
                    .join("chromium")
                    .join(place)
                    .join(format!("browser-profile-{profile}")),
            )
            .map_err(io::Error::other)?;
            Some(if open { "nextStart" } else { "copied" })
        }
        None => None,
    };
    let sign_ins = reads(|held| {
        held.get_mut(&token).map(|r| {
            if let Some(w) = r.written.as_mut() {
                w.2 = site_storage;
            }
            r.sign_ins_read
        })
    });
    Ok(
        json!({"ok": true, "signIns": sign_ins == Some(true), "cookies": cookies, "siteStorage": site_storage}),
    )
}

/// The rest, once main set the cookies (`refused`: the domains it wouldn't take): history, bookmarks and passwords
/// into the profile, and the record kept.
fn finish(
    data: &Path,
    folder: &Path,
    token: u64,
    profile: &str,
    replace: bool,
    refused: Vec<String>,
) -> io::Result<Value> {
    let read = reads(|held| held.remove(&token))
        .filter(|r| r.written.as_ref().is_some_and(|w| w.0 == profile));
    let read = read.ok_or_else(|| io::Error::other("That read has expired. Import again."))?;
    let (_, google_left_out, site_storage) = read.written.clone().unwrap_or_default();
    let mut history_error = read.history_error.clone();
    let mut history = 0;
    if !read.history.is_empty() {
        let visits = read
            .history
            .iter()
            .filter(|v| web_address(&v.url).is_ok())
            .map(|v| (v.url.as_str(), v.title.as_str(), v.visited_at_ms));
        match Store::open(&folder.join("browser.sqlite"))
            .and_then(|mut store| store.import_visits(visits).map_err(io::Error::other))
        {
            Ok(added) => history = added,
            Err(error) => history_error = Some(format!("History couldn't be added ({error}).")),
        }
    }
    let mut bookmarks_error = read.bookmarks_error.clone();
    let mut bookmarks = 0;
    if !read.bookmarks.is_empty() {
        let items: Vec<Value> = (read.bookmarks.iter())
            .map(|b| json!({"url": b.url, "title": b.title, "folders": b.folders, "addedMs": b.added_at_ms}))
            .collect();
        match bookmarks::run(folder, &["import".into(), serde_json::to_string(&items)?]) {
            Ok(added) => bookmarks = added["added"].as_u64().unwrap_or(0) as usize,
            Err(error) => bookmarks_error = Some(format!("Bookmarks couldn't be added ({error}).")),
        }
    }
    let mut passwords_error = read.passwords_error.clone();
    let (mut passwords, mut passwords_skipped) = (0, read.logins_left_out);
    // Replacing with nothing usable would empty the profile, so that swap doesn't happen.
    let usable = |l: &Login| !l.password.is_empty() && vault::login_site(&l.url).is_some();
    let passwords_kept = replace && read.passwords_read && !read.logins.iter().any(usable);
    if passwords_kept {
        passwords_skipped += read.logins.len();
    } else if !read.logins.is_empty() {
        let op = if replace { "replace" } else { "import" };
        match vault::run(
            data,
            folder,
            &[op.into(), serde_json::to_string(&read.logins)?],
        ) {
            Ok(counts) => {
                let n = |k: &str| counts["counts"][k].as_u64().unwrap_or(0) as usize;
                passwords = n("added") + n("updated") + n("unchanged");
                passwords_skipped += n("skipped");
            }
            // Not the error's text: nothing about a password's store needs repeating.
            Err(_) => passwords_error = Some("Passwords couldn't be saved.".into()),
        }
    }
    let (skipped_domains, skipped_domain_count) = distinct(
        read.left_out_domains
            .iter()
            .chain(&read.app_bound_domains)
            .chain(&refused)
            .cloned(),
    );
    let record = Record {
        at_ms: now(),
        profiles: vec![read.profile_name.clone()],
        imported: read.cookies.len() - refused.len().min(read.cookies.len()),
        skipped: read.left_out_domains.len() + read.app_bound_domains.len() + refused.len(),
        skipped_domains,
        skipped_domain_count,
        app_bound_domains: distinct(read.app_bound_domains.iter().cloned()).0,
        history,
        bookmarks,
        passwords,
        passwords_skipped,
        passwords_kept,
        google_left_out,
    };
    change_saved(data, |saved| {
        saved.noticed = true;
        saved.sources.insert(
            read.id.clone(),
            Place {
                into: profile.into(),
                at_ms: record.at_ms,
                browser: read.browser.clone(),
            },
        );
        // A try at another part says nothing of what the import brought.
        if read.sign_ins_read {
            let browser = saved.browsers.entry(read.key.clone()).or_default();
            browser.denied = false;
            browser.records.insert(read.id.clone(), record.clone());
        }
    })?;
    Ok(json!({
        "ok": true, "type": "done", "record": record, "historyError": history_error, "siteStorage": site_storage,
        "passwordsError": passwords_error, "bookmarksError": bookmarks_error,
    }))
}

/// `imports sources | origins | read <browser> <profile> <parts> | write <token> [--open] | finish <token> <refused> [--replace]`.
pub(super) fn run(data: &Path, folder: &Path, profile: &str, args: &[String]) -> io::Result<Value> {
    let get = |i| crate::arg(args, i);
    let token = || get(1)?.parse::<u64>().map_err(io::Error::other);
    // A hidden instance's throwaway HOME is where it looks, so it never reads the user's browsers.
    let home = || {
        std::env::var_os("HOME")
            .map(PathBuf::from)
            .ok_or_else(|| io::Error::other("No home folder"))
    };
    match get(0)? {
        "sources" => {
            let saved = read_saved(data);
            let sources: Vec<Value> = reader::sources(&home()?)
                .into_iter()
                .map(|s| listed(s, &saved))
                .collect();
            Ok(json!({"ok": true, "sources": sources}))
        }
        // The browser each Brigadier profile last had an import from, by profile.
        "origins" => {
            let mut latest: BTreeMap<String, &Place> = BTreeMap::new();
            let saved = read_saved(data);
            for place in saved.sources.values() {
                if latest
                    .get(&place.into)
                    .is_none_or(|p| p.at_ms <= place.at_ms)
                {
                    latest.insert(place.into.clone(), place);
                }
            }
            let origins: BTreeMap<_, _> = latest
                .into_iter()
                .map(|(p, place)| (p, place.browser.clone()))
                .collect();
            Ok(json!({"ok": true, "origins": origins}))
        }
        "read" => read::read(
            data,
            &home()?,
            get(1)?,
            get(2)?,
            &serde_json::from_str(get(3)?)?,
        ),
        "write" => write(data, token()?, profile, args.iter().any(|a| a == "--open")),
        "finish" => finish(
            data,
            folder,
            token()?,
            profile,
            args.iter().any(|a| a == "--replace"),
            serde_json::from_str(get(2)?)?,
        ),
        _ => Err(io::Error::other("Unknown browser imports operation")),
    }
}
