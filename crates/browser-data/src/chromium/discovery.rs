use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};

use super::catalog::*;
use super::cookies_path;
use crate::layout::join_rel;
use crate::{Family, Layout, Profile, app_path, existing_app, key_for, opens_web_links, probe};

/// Folders never treated as a browser even if they look like one.
const SKIP: &[&str] = &["Google/Chrome for Testing"];

/// One browser install: its data root and how to label its profiles.
struct Root {
    dir: PathBuf,
    browser: String,
    key: String,
    service: Option<String>,
    account: Option<String>,
    linux_secret_application: Option<String>,
    app_path: Option<PathBuf>,
}

/// The profiles of the known browsers on Windows or Linux. Unlike macOS, whose bundles say whether
/// they open web links, these OSes give no cheap way to tell an unknown browser from an Electron
/// app, so only known browsers are listed.
pub(crate) fn discover_other(layout: &Layout) -> Vec<Profile> {
    let mut profiles = Vec::new();
    let mut add =
        |dir: PathBuf, browser: String, key: String, secret: Option<&str>, app: Option<PathBuf>| {
            if dir.is_dir() {
                profiles.extend(root_profiles(&Root {
                    dir,
                    browser,
                    key,
                    service: None,
                    account: None,
                    linux_secret_application: secret.map(str::to_owned),
                    app_path: app,
                }));
            }
        };
    match layout {
        Layout::Windows {
            local_app_data,
            roaming_app_data,
            app_dirs,
        } => {
            let app_dirs: Vec<&Path> = app_dirs.iter().map(PathBuf::as_path).collect();
            for known in WINDOWS_KNOWN {
                let base = match known.base {
                    WindowsBase::Local => local_app_data,
                    WindowsBase::Roaming => roaming_app_data,
                };
                add(
                    join_rel(base, known.folder),
                    known.browser.to_owned(),
                    known.key.to_owned(),
                    None,
                    app_path(&app_dirs, known.apps),
                );
            }
        }
        Layout::Linux {
            home,
            config_home,
            path_dirs,
            snap_bin,
            flatpak_bin,
            ..
        } => {
            let app = |dirs: &[PathBuf], names: &[&str]| {
                let dirs: Vec<&Path> = dirs.iter().map(PathBuf::as_path).collect();
                app_path(&dirs, names)
            };
            for known in LINUX_KNOWN {
                let secret = Some(known.secret);
                add(
                    join_rel(config_home, known.folder),
                    known.browser.to_owned(),
                    known.key.to_owned(),
                    secret,
                    app(path_dirs, known.bins),
                );
                if let Some((snap, data)) = known.snap {
                    add(
                        join_rel(&home.join("snap").join(snap), data),
                        format!("{} (Snap)", known.browser),
                        format!("{}-snap", known.key),
                        secret,
                        app(snap_bin, &[snap]),
                    );
                }
                if let Some(id) = known.flatpak {
                    let config = home.join(".var/app").join(id).join("config");
                    add(
                        join_rel(&config, known.folder),
                        format!("{} (Flatpak)", known.browser),
                        format!("{}-flatpak", known.key),
                        secret,
                        app(flatpak_bin, &[id]),
                    );
                }
            }
        }
        Layout::Macos { .. } => {}
    }
    profiles
}

pub(crate) fn discover(home: &Path, app_dirs: &[&Path]) -> Vec<Profile> {
    let support = home.join("Library/Application Support");
    let mut handled: HashSet<String> = SKIP
        .iter()
        .map(|folder| support.join(folder).to_string_lossy().to_lowercase())
        .collect();
    let mut profiles = Vec::new();

    for known in KNOWN {
        let dir = support.join(known.folder);
        // APFS is usually case-insensitive, so compare lowercased paths when deduplicating.
        if !handled.insert(dir.to_string_lossy().to_lowercase()) || !dir.is_dir() {
            continue;
        }
        let root = Root {
            dir,
            browser: known.browser.to_owned(),
            key: known.key.to_owned(),
            service: Some(known.service.to_owned()),
            account: Some(known.account.to_owned()),
            linux_secret_application: None,
            app_path: app_path(app_dirs, &[known.bundle]),
        };
        profiles.extend(root_profiles(&root));
    }

    // Unknown Chromium builds: `<X>` or `<X>/User Data` with a `Local State` and a profile
    // that has a History file, whose `<X>.app` is installed and opens web links. Apps built on
    // Chromium (Electron) keep a `Local State`, `Cookies` and sometimes a History too, but
    // don't open web links; neither does a folder whose app is gone.
    let Ok(entries) = std::fs::read_dir(&support) else {
        return profiles;
    };
    let mut folders: Vec<String> = entries
        .flatten()
        .filter(|entry| entry.file_type().is_ok_and(|t| t.is_dir()))
        .filter_map(|entry| entry.file_name().into_string().ok())
        .collect();
    folders.sort();
    for folder in folders {
        for dir in [
            support.join(&folder),
            support.join(&folder).join("User Data"),
        ] {
            if handled.contains(&dir.to_string_lossy().to_lowercase())
                || !dir.join("Local State").is_file()
            {
                continue;
            }
            let Some(app) =
                existing_app(app_dirs, &format!("{folder}.app")).filter(|app| opens_web_links(app))
            else {
                continue;
            };
            // Named for its folder and engine, and keyed apart from a known browser of the
            // same name.
            let mut key = key_for(&folder);
            if KNOWN.iter().any(|known| known.key == key) {
                key.push_str("-chromium");
            }
            let root = Root {
                dir: dir.clone(),
                browser: format!("{folder} (Chromium)"),
                key,
                service: Some(format!("{folder} Safe Storage")),
                account: Some(folder.clone()),
                linux_secret_application: None,
                app_path: Some(app),
            };
            let found = root_profiles(&root);
            if found.iter().any(|profile| profile.has_history) {
                handled.insert(dir.to_string_lossy().to_lowercase());
                profiles.extend(found);
            }
        }
    }
    profiles
}

/// The profiles under one browser root that have cookies or history.
fn root_profiles(root: &Root) -> Vec<Profile> {
    let state = std::fs::read(root.dir.join("Local State"))
        .ok()
        .and_then(|bytes| {
            serde_json::from_slice::<serde_json::Value>(&bytes)
                .inspect_err(|err| {
                    tracing::debug!(dir = %root.dir.display(), %err, "unreadable Local State");
                })
                .ok()
        });
    let mut names = BTreeMap::new();
    let mut last_used = None;
    if let Some(profile) = state.as_ref().and_then(|state| state.get("profile")) {
        if let Some(cache) = profile
            .get("info_cache")
            .and_then(|cache| cache.as_object())
        {
            for (dir, info) in cache {
                let name = info
                    .get("name")
                    .and_then(|name| name.as_str())
                    .unwrap_or(dir);
                names.insert(dir.clone(), name.to_owned());
            }
        }
        last_used = profile
            .get("last_used")
            .and_then(|v| v.as_str())
            .map(str::to_owned);
    }

    // Profile folders: everything Local State names, plus `Default` and `Profile N` in case it
    // is missing or stale.
    let mut dirs: Vec<String> = names.keys().cloned().collect();
    dirs.push("Default".to_owned());
    if let Ok(entries) = std::fs::read_dir(&root.dir) {
        for entry in entries.flatten() {
            if let Ok(name) = entry.file_name().into_string()
                && name
                    .strip_prefix("Profile ")
                    .is_some_and(|n| n.parse::<u32>().is_ok())
            {
                dirs.push(name);
            }
        }
    }
    dirs.sort();
    dirs.dedup();

    let mut profiles = Vec::new();
    for dir_name in &dirs {
        let dir = root.dir.join(dir_name);
        let is_default = match &last_used {
            Some(last) => last == dir_name,
            None => dir_name == "Default",
        };
        let name = names
            .get(dir_name)
            .cloned()
            .unwrap_or_else(|| dir_name.clone());
        if let Some(profile) = profile(root, dir, dir_name, name, is_default) {
            profiles.push(profile);
        }
    }
    // Opera keeps its single profile in the root itself.
    if profiles.is_empty()
        && let Some(profile) = profile(
            root,
            root.dir.clone(),
            "Default",
            "Default".to_owned(),
            true,
        )
    {
        profiles.push(profile);
    }
    profiles
}

fn profile(
    root: &Root,
    dir: PathBuf,
    dir_name: &str,
    name: String,
    is_default: bool,
) -> Option<Profile> {
    let (has_cookies, cookies_readable) = probe(&cookies_path(&dir));
    let (has_history, history_readable) = probe(&dir.join("History"));
    if !has_cookies && !has_history {
        return None;
    }
    Some(Profile {
        id: format!("{}/{dir_name}", root.key),
        browser: root.browser.clone(),
        name,
        family: Family::Chromium,
        app_path: root.app_path.clone(),
        keychain_service: root.service.clone(),
        keychain_account: root.account.clone(),
        local_state: Some(root.dir.join("Local State")),
        linux_secret_application: root.linux_secret_application.clone(),
        has_cookies,
        has_history,
        readable: (!has_cookies || cookies_readable) && (!has_history || history_readable),
        is_default,
        dir,
    })
}
