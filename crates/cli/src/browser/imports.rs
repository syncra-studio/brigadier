//! Settings › Import Browser Data: which browsers are on this computer and where each stands, and one profile's
//! sign-ins brought into a Brigadier profile [D725, D729]. `read` hands the cookies to the page, which has main set
//! them; `place` puts the site storage in and keeps the record. Nothing is held between the two.
//! `brigadier-browser-data` reads and never writes a source's files.

mod read;

use super::now;
use brigadier_browser_data::{self as reader, Error, Family, Source};
use brigadier_core::{self as core, library::secrets};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::{fs, io};

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

/// Whether a cookie named `name` holds a sign-in, by the names sites give them: GitHub's `user_session`, Google's
/// `SID`, Rails' `remember_user_token`, `PHPSESSID`. A name it doesn't know counts as not one: a site listed to sign in
/// to again for nothing is worse than one missed.
fn signs_in(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    let sid = name
        .match_indices("sid")
        .any(|(at, _)| !name[at + 3..].starts_with(|c: char| c.is_ascii_alphabetic()));
    !name.contains("csrf")
        && !name.contains("xsrf")
        && (sid
            || [
                "sess", "auth", "token", "login", "logged", "remember", "jwt",
            ]
            .iter()
            .any(|word| name.contains(word)))
}

/// The sites among `cookies` (domain, name) whose sign-in didn't come across, as `distinct` gives them.
fn lost_sign_ins(cookies: impl IntoIterator<Item = (String, String)>) -> (Vec<String>, usize) {
    distinct(
        cookies
            .into_iter()
            .filter(|(_, name)| signs_in(name))
            .map(|(domain, _)| domain),
    )
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
    })
}

/// Whether a browser is open. Safari's cookie file is read whole, so it can stay open.
fn running(source: &Source) -> bool {
    source.family != Family::Safari && source.profiles.first().is_some_and(reader::running)
}

/// Whether the browser's key can be asked for, without asking: only macOS has a question to ask.
fn key_state(source: &Source) -> Option<&'static str> {
    let profile = source.profiles.first()?;
    // A hidden instance never asks the login keychain [D449, D736].
    if !cfg!(target_os = "macos")
        || source.family != Family::Chromium
        || reader::key_off_limits(profile)
        || secrets::walled()
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
        "family": match source.family { Family::Chromium => "chromium", Family::Safari => "safari" },
        "state": state, "profiles": profiles, "emptyProfiles": empty,
        "signIns": !off_limits,
        "record": merged(&records), "imports": saved.sources, "firstImport": !saved.noticed,
    })
}

/// After `read`, into Brigadier profile `profile`: the source's site storage goes into its partition now, or at the
/// app's next start if its session is `open` (Chromium holds the folders then), and the import is kept as `record`.
fn place(
    data: &Path,
    key: &str,
    id: &str,
    profile: &str,
    open: bool,
    record: Record,
) -> io::Result<Value> {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| io::Error::other("No home folder"))?;
    let source = reader::sources(&home).into_iter().find(|s| s.key == key);
    let dir = source
        .as_ref()
        .and_then(|s| s.profiles.iter().find(|p| p.id == id));
    let site_storage =
        match dir.filter(|p| p.family == Family::Chromium && !reader::key_off_limits(p)) {
            Some(from) => {
                let place = if open {
                    "browser-import-staged"
                } else {
                    "Partitions"
                };
                let into = data
                    .join("chromium")
                    .join(place)
                    .join(format!("browser-profile-{profile}"));
                reader::copy_site_storage(&from.dir, &into).map_err(io::Error::other)?;
                Some(if open { "nextStart" } else { "copied" })
            }
            None => None,
        };
    let record = Record {
        at_ms: now(),
        ..record
    };
    let browser = source.map_or_else(|| key.to_owned(), |s| s.name);
    change_saved(data, |saved| {
        saved.noticed = true;
        saved.sources.insert(
            id.into(),
            Place {
                into: profile.into(),
                at_ms: record.at_ms,
                browser,
            },
        );
        let kept = saved.browsers.entry(key.into()).or_default();
        kept.denied = false;
        kept.records.insert(id.into(), record.clone());
    })?;
    Ok(json!({"ok": true, "type": "done", "record": record, "siteStorage": site_storage}))
}

/// After `place`, the cookies main's store refused, as (domain, name): the kept record counts them as skipped, and
/// lists their sites when they held a sign-in.
fn refused(data: &Path, key: &str, id: &str, cookies: Vec<(String, String)>) -> io::Result<Value> {
    let mut kept = None;
    change_saved(data, |saved| {
        let Some(record) = saved
            .browsers
            .get_mut(key)
            .and_then(|b| b.records.get_mut(id))
        else {
            return;
        };
        record.imported = record.imported.saturating_sub(cookies.len());
        record.skipped += cookies.len();
        let listed = record.skipped_domains.len();
        let (sites, _) = lost_sign_ins(cookies);
        let (list, count) = distinct(record.skipped_domains.drain(..).chain(sites));
        record.skipped_domain_count += count.saturating_sub(listed);
        record.skipped_domains = list;
        kept = Some(record.clone());
    })?;
    let record = kept.ok_or_else(|| io::Error::other("No import kept for that profile"))?;
    Ok(json!({"ok": true, "record": record}))
}

/// `imports sources | origins | read <browser> <profile> | place <browser> <profile> <record> [--open]
/// | refused <browser> <profile> <cookies>`.
pub(super) fn run(data: &Path, profile: &str, args: &[String]) -> io::Result<Value> {
    let get = |i| crate::arg(args, i);
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
        "read" => read::read(data, &home()?, get(1)?, get(2)?),
        "place" => place(
            data,
            get(1)?,
            get(2)?,
            profile,
            args.iter().any(|a| a == "--open"),
            serde_json::from_str(get(3)?)?,
        ),
        "refused" => refused(data, get(1)?, get(2)?, serde_json::from_str(get(3)?)?),
        _ => Err(io::Error::other("Unknown browser imports operation")),
    }
}
