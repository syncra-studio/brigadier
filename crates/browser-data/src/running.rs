//! Whether a profile's browser is open, so the app can ask the user to quit it first.

use std::path::Path;

use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};

use crate::{Os, Profile};

/// Executable names that identify a browser regardless of where or under which bundle it is
/// installed; Firefox's Developer Edition and Nightly share Firefox's profiles.
const PROCESS_NAMES: &[(&str, &[&str])] = &[
    ("Firefox", &["firefox"]),
    ("Zen", &["zen"]),
    ("LibreWolf", &["librewolf"]),
    ("Waterfox", &["waterfox"]),
    ("Floorp", &["floorp"]),
    ("Safari", &["Safari"]),
];

/// On Linux the launcher on `$PATH` is often a script or a symlink, so a Chromium browser's
/// process is recognised by its executable's name. Channels share a name, which at worst asks the
/// user to quit a browser they didn't need to.
const LINUX_PROCESS_NAMES: &[(&str, &[&str])] = &[
    ("Google Chrome", &["chrome"]),
    ("Google Chrome Beta", &["chrome"]),
    ("Google Chrome Dev", &["chrome"]),
    ("Chromium", &["chromium", "chrome"]),
    ("Microsoft Edge", &["msedge"]),
    ("Microsoft Edge Beta", &["msedge"]),
    ("Microsoft Edge Dev", &["msedge"]),
    ("Brave", &["brave"]),
    ("Brave Beta", &["brave"]),
    ("Brave Nightly", &["brave"]),
    ("Vivaldi", &["vivaldi-bin", "vivaldi"]),
    ("Opera", &["opera"]),
    ("Firefox", &["firefox-bin", "firefox-esr"]),
];

/// On Windows, Opera's launcher is not the process that runs: that lives in a folder per version.
/// A running Chromium browser also holds its files shut, which reads as [`crate::Error::Locked`].
const WINDOWS_PROCESS_NAMES: &[(&str, &[&str])] =
    &[("Opera", &["opera"]), ("Opera GX", &["opera"])];

/// Whether the browser that owns `profile` is running: any process inside its app bundle
/// (wherever that bundle was moved), running its executable, or with one of its known executable
/// names.
pub fn running(profile: &Profile) -> bool {
    let Ok(mut system) = System::new() else {
        // A failed process lookup must not allow copying a possibly live store.
        return true;
    };
    system.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing().with_exe(UpdateKind::Always),
    );
    system.processes().values().any(|process| {
        matches(
            Os::current(),
            profile,
            process.exe(),
            &process.name().to_string_lossy(),
        )
    })
}

/// Whether one process, by its executable path and name, belongs to `profile`'s browser.
fn matches(os: Os, profile: &Profile, exe: Option<&Path>, name: &str) -> bool {
    if let (Some(exe), Some(app)) = (exe, profile.app_path.as_deref()) {
        if exe.starts_with(app) {
            return true;
        }
        // Windows paths don't care about case, and the two here come from different places.
        if os == Os::Windows
            && exe
                .to_string_lossy()
                .eq_ignore_ascii_case(&app.to_string_lossy())
        {
            return true;
        }
        if let Some(bundle) = app.file_name() {
            let inside = exe.ancestors().any(|dir| {
                dir.file_name() == Some(bundle) && exe.starts_with(dir.join("Contents/MacOS"))
            });
            if inside {
                return true;
            }
        }
    }
    let lowered;
    let name = if os == Os::Windows {
        lowered = name.to_ascii_lowercase();
        lowered.strip_suffix(".exe").unwrap_or(&lowered)
    } else {
        name
    };
    // A Linux browser's Snap and Flatpak installs run under the same names.
    let browser = profile
        .browser
        .strip_suffix(" (Snap)")
        .or_else(|| profile.browser.strip_suffix(" (Flatpak)"))
        .unwrap_or(&profile.browser);
    let for_os: &[(&str, &[&str])] = match os {
        Os::Macos => &[],
        Os::Windows => WINDOWS_PROCESS_NAMES,
        Os::Linux => LINUX_PROCESS_NAMES,
    };
    PROCESS_NAMES
        .iter()
        .chain(for_os)
        .filter(|(known, _)| *known == browser)
        .any(|(_, names)| names.contains(&name))
}
