use std::collections::HashSet;
use std::path::{Path, PathBuf};

use crate::layout::join_rel;
use crate::{Family, Layout, Profile, app_path, existing_app, key_for, probe};

/// A Gecko browser whose folder and app are known.
struct Known {
    /// Folder under `~/Library/Application Support` holding `profiles.ini`.
    folder: &'static str,
    browser: &'static str,
    key: &'static str,
    /// App bundles sharing this root, most common first.
    bundles: &'static [&'static str],
}

const KNOWN: &[Known] = &[
    Known {
        folder: "Firefox",
        browser: "Firefox",
        key: "firefox",
        // Developer Edition and Nightly share Firefox's profiles.ini.
        bundles: &[
            "Firefox.app",
            "Firefox Developer Edition.app",
            "Firefox Nightly.app",
        ],
    },
    // Zen keeps its root in a lowercase `zen` folder on macOS.
    Known {
        folder: "zen",
        browser: "Zen",
        key: "zen",
        bundles: &["Zen.app", "Zen Browser.app"],
    },
    Known {
        folder: "librewolf",
        browser: "LibreWolf",
        key: "librewolf",
        bundles: &["LibreWolf.app"],
    },
    Known {
        folder: "Waterfox",
        browser: "Waterfox",
        key: "waterfox",
        bundles: &["Waterfox.app"],
    },
    Known {
        folder: "Floorp",
        browser: "Floorp",
        key: "floorp",
        bundles: &["Floorp.app"],
    },
];

/// A Gecko browser's roots and executables on Windows, under `%APPDATA%`.
struct WindowsKnown {
    folder: &'static str,
    browser: &'static str,
    key: &'static str,
    /// Under the Program Files or per-user folders in [`Layout::Windows`].
    apps: &'static [&'static str],
}

const WINDOWS_KNOWN: &[WindowsKnown] = &[
    WindowsKnown {
        folder: "Mozilla/Firefox",
        browser: "Firefox",
        key: "firefox",
        // Developer Edition and Nightly share Firefox's profiles.ini.
        apps: &[
            "Mozilla Firefox/firefox.exe",
            "Firefox Developer Edition/firefox.exe",
            "Firefox Nightly/firefox.exe",
        ],
    },
    WindowsKnown {
        folder: "zen",
        browser: "Zen",
        key: "zen",
        apps: &["Zen Browser/zen.exe"],
    },
    WindowsKnown {
        folder: "librewolf",
        browser: "LibreWolf",
        key: "librewolf",
        apps: &["LibreWolf/librewolf.exe"],
    },
    WindowsKnown {
        folder: "Waterfox",
        browser: "Waterfox",
        key: "waterfox",
        apps: &["Waterfox/waterfox.exe"],
    },
    WindowsKnown {
        folder: "Floorp",
        browser: "Floorp",
        key: "floorp",
        apps: &["Ablaze Floorp/floorp.exe", "Floorp/floorp.exe"],
    },
];

/// A Gecko browser's roots and launchers on Linux.
struct LinuxKnown {
    browser: &'static str,
    key: &'static str,
    /// Launchers on `$PATH`.
    bins: &'static [&'static str],
    /// Roots under the home, then under `$XDG_CONFIG_HOME`, in the order the browser prefers:
    /// Firefox keeps using `~/.mozilla` when it is there, and new installs use the XDG folder.
    homes: &'static [&'static str],
    configs: &'static [&'static str],
    /// The snap's name and its root under `~/snap/<name>`.
    snap: Option<(&'static str, &'static str)>,
    /// The Flatpak app id and its roots under `~/.var/app/<id>`.
    flatpak: Option<(&'static str, &'static [&'static str])>,
}

// Firefox's classic and Snap folders agree with bb's `sources.ts`. The XDG and Flatpak folders and
// the forks are the projects' usual defaults, recalled rather than checked against a real machine.
const LINUX_KNOWN: &[LinuxKnown] = &[
    LinuxKnown {
        browser: "Firefox",
        key: "firefox",
        bins: &["firefox", "firefox-esr", "firefox-developer-edition"],
        homes: &[".mozilla/firefox"],
        configs: &["mozilla/firefox"],
        snap: Some(("firefox", "common/.mozilla/firefox")),
        flatpak: Some((
            "org.mozilla.firefox",
            &[".mozilla/firefox", "config/mozilla/firefox"],
        )),
    },
    LinuxKnown {
        browser: "Zen",
        key: "zen",
        bins: &["zen", "zen-browser"],
        homes: &[".zen"],
        configs: &[],
        snap: None,
        flatpak: Some(("app.zen_browser.zen", &[".zen"])),
    },
    LinuxKnown {
        browser: "LibreWolf",
        key: "librewolf",
        bins: &["librewolf"],
        homes: &[".librewolf"],
        configs: &["librewolf/librewolf"],
        snap: None,
        flatpak: Some(("io.gitlab.librewolf-community", &[".librewolf"])),
    },
    LinuxKnown {
        browser: "Waterfox",
        key: "waterfox",
        bins: &["waterfox"],
        homes: &[".waterfox"],
        configs: &[],
        snap: None,
        flatpak: Some(("net.waterfox.waterfox", &[".waterfox"])),
    },
    LinuxKnown {
        browser: "Floorp",
        key: "floorp",
        bins: &["floorp"],
        homes: &[".floorp"],
        configs: &[],
        snap: None,
        flatpak: Some(("one.ablaze.floorp", &[".floorp"])),
    },
];

pub(crate) fn discover(home: &Path, app_dirs: &[&Path]) -> Vec<Profile> {
    let support = home.join("Library/Application Support");
    let mut handled = HashSet::new();
    let mut profiles = Vec::new();
    for known in KNOWN {
        let root = support.join(known.folder);
        // APFS is usually case-insensitive, so compare lowercased names when deduplicating.
        if !handled.insert(known.folder.to_lowercase()) || !root.join("profiles.ini").is_file() {
            continue;
        }
        let app = app_path(app_dirs, known.bundles);
        profiles.extend(root_profiles(&root, known.browser, known.key, app));
    }
    // Unknown forks: any folder with a profiles.ini.
    if let Ok(entries) = std::fs::read_dir(&support) {
        let mut folders: Vec<String> = entries
            .flatten()
            .filter_map(|entry| entry.file_name().into_string().ok())
            .filter(|name| !handled.contains(&name.to_lowercase()))
            .filter(|name| support.join(name).join("profiles.ini").is_file())
            .collect();
        folders.sort();
        for folder in folders {
            let app = existing_app(app_dirs, &format!("{folder}.app"));
            let mut key = key_for(&folder);
            if KNOWN.iter().any(|known| known.key == key) {
                key.push_str("-firefox");
            }
            profiles.extend(root_profiles(
                &support.join(&folder),
                &format!("{folder} (Firefox)"),
                &key,
                app,
            ));
        }
    }
    profiles
}

/// The profiles of the known browsers on Windows or Linux. Each browser's install uses the first
/// of its roots that has a profiles.ini. Unknown forks are left out, as on these OSes nothing says
/// whether an app is a browser.
pub(crate) fn discover_other(layout: &Layout) -> Vec<Profile> {
    let first_root = |roots: Vec<PathBuf>| {
        roots
            .into_iter()
            .find(|root| root.join("profiles.ini").is_file())
    };
    let mut profiles = Vec::new();
    match layout {
        Layout::Windows {
            roaming_app_data,
            app_dirs,
            ..
        } => {
            let app_dirs: Vec<&Path> = app_dirs.iter().map(PathBuf::as_path).collect();
            for known in WINDOWS_KNOWN {
                if let Some(root) = first_root(vec![join_rel(roaming_app_data, known.folder)]) {
                    let app = app_path(&app_dirs, known.apps);
                    profiles.extend(root_profiles(&root, known.browser, known.key, app));
                }
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
                let native = known
                    .homes
                    .iter()
                    .map(|root| join_rel(home, root))
                    .chain(known.configs.iter().map(|root| join_rel(config_home, root)))
                    .collect();
                if let Some(root) = first_root(native) {
                    let app = app(path_dirs, known.bins);
                    profiles.extend(root_profiles(&root, known.browser, known.key, app));
                }
                if let Some((snap, data)) = known.snap
                    && let Some(root) =
                        first_root(vec![join_rel(&home.join("snap").join(snap), data)])
                {
                    profiles.extend(root_profiles(
                        &root,
                        &format!("{} (Snap)", known.browser),
                        &format!("{}-snap", known.key),
                        app(snap_bin, &[snap]),
                    ));
                }
                if let Some((id, roots)) = known.flatpak {
                    let base = home.join(".var/app").join(id);
                    if let Some(root) =
                        first_root(roots.iter().map(|root| join_rel(&base, root)).collect())
                    {
                        profiles.extend(root_profiles(
                            &root,
                            &format!("{} (Flatpak)", known.browser),
                            &format!("{}-flatpak", known.key),
                            app(flatpak_bin, &[id]),
                        ));
                    }
                }
            }
        }
        Layout::Macos { .. } => {}
    }
    profiles
}

/// One `[ProfileN]` section of profiles.ini.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct IniProfile {
    pub(crate) name: String,
    pub(crate) path: String,
    pub(crate) relative: bool,
    pub(crate) default: bool,
}

/// Parses profiles.ini into its profiles and the install default (the `Default=` of an
/// `[Install…]` section, which newer Firefox uses instead of `Default=1`).
pub(crate) fn parse_profiles_ini(text: &str) -> (Vec<IniProfile>, Option<String>) {
    let mut profiles = Vec::new();
    let mut install_default = None;
    let mut section = String::new();
    let mut current: Option<IniProfile> = None;
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with(';') || line.starts_with('#') {
            continue;
        }
        if let Some(name) = line.strip_prefix('[').and_then(|l| l.strip_suffix(']')) {
            profiles.extend(current.take().filter(|p| !p.path.is_empty()));
            section = name.to_owned();
            if section.starts_with("Profile") {
                current = Some(IniProfile {
                    relative: true,
                    ..IniProfile::default()
                });
            }
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let (key, value) = (key.trim(), value.trim());
        if let Some(profile) = current.as_mut() {
            match key {
                "Name" => profile.name = value.to_owned(),
                "Path" => profile.path = value.to_owned(),
                "IsRelative" => profile.relative = value == "1",
                "Default" => profile.default = value == "1",
                _ => {}
            }
        } else if section.starts_with("Install") && key == "Default" && install_default.is_none() {
            install_default = Some(value.to_owned());
        }
    }
    profiles.extend(current.take().filter(|p| !p.path.is_empty()));
    (profiles, install_default)
}

fn root_profiles(root: &Path, browser: &str, key: &str, app: Option<PathBuf>) -> Vec<Profile> {
    let text = match std::fs::read_to_string(root.join("profiles.ini")) {
        Ok(text) => text,
        // macOS may keep a browser's folder from other apps (Firefox's, on macOS 27): the file
        // is there but can't be read. The browser is still listed, unreadable, so the import
        // asks for Full Disk Access instead of leaving it out.
        Err(err) if err.kind() == std::io::ErrorKind::PermissionDenied => {
            return vec![Profile {
                id: format!("{key}/locked"),
                browser: browser.to_owned(),
                name: "Default".to_owned(),
                family: Family::Gecko,
                app_path: app,
                keychain_service: None,
                keychain_account: None,
                local_state: None,
                linux_secret_application: None,
                has_cookies: true,
                has_history: true,
                has_bookmarks: true,
                readable: false,
                is_default: true,
                dir: root.to_owned(),
            }];
        }
        Err(_) => return Vec::new(),
    };
    let (entries, install_default) = parse_profiles_ini(&text);
    let mut profiles = Vec::new();
    for entry in entries {
        let dir = if entry.relative {
            root.join(&entry.path)
        } else {
            PathBuf::from(&entry.path)
        };
        let (has_cookies, cookies_readable) = probe(&dir.join("cookies.sqlite"));
        let (has_history, history_readable) = probe(&dir.join("places.sqlite"));
        if !has_cookies && !has_history {
            continue;
        }
        let dir_name = dir.file_name().map_or_else(
            || entry.path.clone(),
            |name| name.to_string_lossy().into_owned(),
        );
        let is_default = match &install_default {
            Some(path) => *path == entry.path,
            None => entry.default,
        };
        profiles.push(Profile {
            id: format!("{key}/{dir_name}"),
            browser: browser.to_owned(),
            name: if entry.name.is_empty() {
                dir_name.clone()
            } else {
                entry.name
            },
            family: Family::Gecko,
            app_path: app.clone(),
            keychain_service: None,
            keychain_account: None,
            local_state: None,
            linux_secret_application: None,
            has_cookies,
            has_history,
            // places.sqlite holds both.
            has_bookmarks: has_history,
            readable: (!has_cookies || cookies_readable) && (!has_history || history_readable),
            is_default,
            dir,
        });
    }
    profiles
}
