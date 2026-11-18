//! The browsers an import can copy from, one per installed browser, in the order Settings lists
//! them.

use std::path::{Path, PathBuf};

use crate::{Family, Layout, Profile, discover_layout};

/// The browsers listed first, by key, in this order; every other browser follows by name, and
/// the stores found only by their shape ("‹App› (Chromium)") come last.
const ORDER: &[&str] = &[
    "chrome", "chromium", "helium", "edge", "brave", "vivaldi", "opera", "arc", "dia", "safari",
];

/// One installed browser and the profiles found for it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Source {
    /// The browser's key, the part of its profiles' ids before the `/`, e.g. `dia`.
    pub key: String,
    /// Its display name, e.g. "Google Chrome" or "Comet (Chromium)".
    pub name: String,
    pub family: Family,
    /// Its app (a bundle on macOS, an executable or launcher elsewhere), which exists.
    pub app_path: PathBuf,
    /// Its profiles, the browser's default one first.
    pub profiles: Vec<Profile>,
}

/// Where a browser sorts: its place in the fixed order, then other known browsers, then the
/// ones found by shape.
pub fn browser_rank(key: &str, name: &str) -> (usize, String) {
    // A Linux browser's Snap and Flatpak installs sort with the browser.
    let base = key
        .strip_suffix("-snap")
        .or_else(|| key.strip_suffix("-flatpak"))
        .unwrap_or(key);
    let rank = match ORDER.iter().position(|known| *known == base) {
        Some(at) => at,
        None if name.ends_with(" (Chromium)") => ORDER.len() + 1,
        None => ORDER.len(),
    };
    (rank, name.to_lowercase())
}

/// The installed browsers with profiles for the user whose home is `home`, on this OS, in
/// Settings' order. A browser whose app isn't installed is left out even when its folders remain.
pub fn sources(home: &Path) -> Vec<Source> {
    sources_layout(&Layout::current(home))
}

/// [`sources`] over macOS's folders, whichever OS this runs on, with explicit folders to look for
/// app bundles in.
pub fn sources_in(home: &Path, app_dirs: &[&Path]) -> Vec<Source> {
    sources_layout(&Layout::Macos {
        home: home.to_owned(),
        app_dirs: app_dirs.iter().map(|dir| dir.to_path_buf()).collect(),
    })
}

/// [`sources`] over the folders of `layout`, whichever OS this runs on.
pub fn sources_layout(layout: &Layout) -> Vec<Source> {
    let mut sources: Vec<Source> = Vec::new();
    for profile in discover_layout(layout) {
        let Some(app) = profile.app_path.clone().filter(|app| app.exists()) else {
            continue;
        };
        let key = profile.id.split('/').next().unwrap_or_default().to_owned();
        match sources.iter_mut().find(|source| source.key == key) {
            Some(source) => source.profiles.push(profile),
            None => sources.push(Source {
                key,
                name: profile.browser.clone(),
                family: profile.family,
                app_path: app,
                profiles: vec![profile],
            }),
        }
    }
    for source in &mut sources {
        // Stable: the rest keep discovery's order by name.
        source.profiles.sort_by_key(|profile| !profile.is_default);
    }
    sources.sort_by_cached_key(|source| browser_rank(&source.key, &source.name));
    sources
}
