/// A Chromium browser whose folder, name and Keychain entry are known.
pub(super) struct Known {
    /// Folder under `~/Library/Application Support` holding `Local State`.
    pub(super) folder: &'static str,
    pub(super) browser: &'static str,
    pub(super) key: &'static str,
    pub(super) service: &'static str,
    pub(super) account: &'static str,
    pub(super) bundle: &'static str,
}

/// Every channel of a product shares its Keychain entry: Chromium names it after the brand,
/// not the channel.
pub(super) const KNOWN: &[Known] = &[
    known(
        "Google/Chrome",
        "Google Chrome",
        "chrome",
        "Chrome",
        "Google Chrome.app",
    ),
    known(
        "Google/Chrome Beta",
        "Google Chrome Beta",
        "chrome-beta",
        "Chrome",
        "Google Chrome Beta.app",
    ),
    known(
        "Google/Chrome Dev",
        "Google Chrome Dev",
        "chrome-dev",
        "Chrome",
        "Google Chrome Dev.app",
    ),
    known(
        "Google/Chrome Canary",
        "Google Chrome Canary",
        "chrome-canary",
        "Chrome",
        "Google Chrome Canary.app",
    ),
    known(
        "Chromium",
        "Chromium",
        "chromium",
        "Chromium",
        "Chromium.app",
    ),
    known(
        "net.imput.helium",
        "Helium",
        "helium",
        "Helium",
        "Helium.app",
    ),
    known("Arc/User Data", "Arc", "arc", "Arc", "Arc.app"),
    known("Dia/User Data", "Dia", "dia", "Dia", "Dia.app"),
    known(
        "BraveSoftware/Brave-Browser",
        "Brave",
        "brave",
        "Brave",
        "Brave Browser.app",
    ),
    known(
        "BraveSoftware/Brave-Browser-Beta",
        "Brave Beta",
        "brave-beta",
        "Brave",
        "Brave Browser Beta.app",
    ),
    known(
        "BraveSoftware/Brave-Browser-Nightly",
        "Brave Nightly",
        "brave-nightly",
        "Brave",
        "Brave Browser Nightly.app",
    ),
    known(
        "Microsoft Edge",
        "Microsoft Edge",
        "edge",
        "Microsoft Edge",
        "Microsoft Edge.app",
    ),
    known(
        "Microsoft Edge Beta",
        "Microsoft Edge Beta",
        "edge-beta",
        "Microsoft Edge",
        "Microsoft Edge Beta.app",
    ),
    known(
        "Microsoft Edge Dev",
        "Microsoft Edge Dev",
        "edge-dev",
        "Microsoft Edge",
        "Microsoft Edge Dev.app",
    ),
    known(
        "Microsoft Edge Canary",
        "Microsoft Edge Canary",
        "edge-canary",
        "Microsoft Edge",
        "Microsoft Edge Canary.app",
    ),
    known("Vivaldi", "Vivaldi", "vivaldi", "Vivaldi", "Vivaldi.app"),
    known(
        "com.operasoftware.Opera",
        "Opera",
        "opera",
        "Opera",
        "Opera.app",
    ),
    // A best guess: a Chromium-based browser whose layout isn't confirmed. The generic scan
    // below finds it too if it keeps its data elsewhere.
    known("Thor", "Thor", "thor", "Thor", "Thor.app"),
];

const fn known(
    folder: &'static str,
    browser: &'static str,
    key: &'static str,
    account: &'static str,
    bundle: &'static str,
) -> Known {
    let service = match account.as_bytes() {
        b"Chrome" => "Chrome Safe Storage",
        b"Chromium" => "Chromium Safe Storage",
        b"Arc" => "Arc Safe Storage",
        b"Dia" => "Dia Safe Storage",
        b"Brave" => "Brave Safe Storage",
        b"Microsoft Edge" => "Microsoft Edge Safe Storage",
        b"Vivaldi" => "Vivaldi Safe Storage",
        b"Opera" => "Opera Safe Storage",
        b"Thor" => "Thor Safe Storage",
        // Helium names its entry differently from the other Chromium builds.
        b"Helium" => "Helium Storage Key",
        _ => panic!("add the Keychain service for this account"),
    };
    Known {
        folder,
        browser,
        key,
        service,
        account,
        bundle,
    }
}

/// Where a Windows browser keeps its data.
#[derive(Clone, Copy)]
pub(super) enum WindowsBase {
    Local,
    Roaming,
}

/// A Chromium browser's data folder and executables on Windows.
pub(super) struct WindowsKnown {
    pub(super) base: WindowsBase,
    pub(super) folder: &'static str,
    pub(super) browser: &'static str,
    pub(super) key: &'static str,
    /// Under the Program Files or per-user folders in [`crate::Layout::Windows`].
    pub(super) apps: &'static [&'static str],
}

const fn windows(
    base: WindowsBase,
    folder: &'static str,
    browser: &'static str,
    key: &'static str,
    apps: &'static [&'static str],
) -> WindowsKnown {
    WindowsKnown {
        base,
        folder,
        browser,
        key,
        apps,
    }
}

// Keys match macOS's, so a browser is one source on any OS. Paths are the vendors' usual defaults,
// recalled rather than checked against a real Windows machine.
pub(super) const WINDOWS_KNOWN: &[WindowsKnown] = {
    use WindowsBase::{Local, Roaming};
    &[
        windows(
            Local,
            "Google/Chrome/User Data",
            "Google Chrome",
            "chrome",
            &["Google/Chrome/Application/chrome.exe"],
        ),
        windows(
            Local,
            "Google/Chrome Beta/User Data",
            "Google Chrome Beta",
            "chrome-beta",
            &["Google/Chrome Beta/Application/chrome.exe"],
        ),
        windows(
            Local,
            "Google/Chrome Dev/User Data",
            "Google Chrome Dev",
            "chrome-dev",
            &["Google/Chrome Dev/Application/chrome.exe"],
        ),
        windows(
            Local,
            "Google/Chrome SxS/User Data",
            "Google Chrome Canary",
            "chrome-canary",
            &["Google/Chrome SxS/Application/chrome.exe"],
        ),
        windows(
            Local,
            "Chromium/User Data",
            "Chromium",
            "chromium",
            &["Chromium/Application/chrome.exe"],
        ),
        windows(
            Local,
            "Microsoft/Edge/User Data",
            "Microsoft Edge",
            "edge",
            &["Microsoft/Edge/Application/msedge.exe"],
        ),
        windows(
            Local,
            "Microsoft/Edge Beta/User Data",
            "Microsoft Edge Beta",
            "edge-beta",
            &["Microsoft/Edge Beta/Application/msedge.exe"],
        ),
        windows(
            Local,
            "Microsoft/Edge Dev/User Data",
            "Microsoft Edge Dev",
            "edge-dev",
            &["Microsoft/Edge Dev/Application/msedge.exe"],
        ),
        windows(
            Local,
            "Microsoft/Edge SxS/User Data",
            "Microsoft Edge Canary",
            "edge-canary",
            &["Microsoft/Edge SxS/Application/msedge.exe"],
        ),
        windows(
            Local,
            "BraveSoftware/Brave-Browser/User Data",
            "Brave",
            "brave",
            &["BraveSoftware/Brave-Browser/Application/brave.exe"],
        ),
        windows(
            Local,
            "BraveSoftware/Brave-Browser-Beta/User Data",
            "Brave Beta",
            "brave-beta",
            &["BraveSoftware/Brave-Browser-Beta/Application/brave.exe"],
        ),
        windows(
            Local,
            "BraveSoftware/Brave-Browser-Nightly/User Data",
            "Brave Nightly",
            "brave-nightly",
            &["BraveSoftware/Brave-Browser-Nightly/Application/brave.exe"],
        ),
        windows(
            Local,
            "Vivaldi/User Data",
            "Vivaldi",
            "vivaldi",
            &["Vivaldi/Application/vivaldi.exe"],
        ),
        // Opera keeps its data under Roaming, with its single profile often in the root.
        windows(
            Roaming,
            "Opera Software/Opera Stable",
            "Opera",
            "opera",
            &["Opera/launcher.exe", "Opera/opera.exe"],
        ),
        windows(
            Roaming,
            "Opera Software/Opera GX Stable",
            "Opera GX",
            "opera-gx",
            &["Opera GX/launcher.exe", "Opera GX/opera.exe"],
        ),
    ]
};

/// A Chromium browser's folders and launchers on Linux.
pub(super) struct LinuxKnown {
    /// Under `$XDG_CONFIG_HOME`, and under `config` in its Flatpak's data.
    pub(super) folder: &'static str,
    pub(super) browser: &'static str,
    pub(super) key: &'static str,
    /// The `application` attribute of its keyring password, shared across channels.
    pub(super) secret: &'static str,
    /// Launchers on `$PATH`.
    pub(super) bins: &'static [&'static str],
    /// The snap's name and its data folder under `~/snap/<name>`.
    pub(super) snap: Option<(&'static str, &'static str)>,
    /// The Flatpak app id.
    pub(super) flatpak: Option<&'static str>,
}

// The folders and `secret` names of the stable channels agree with bb's `sources.ts`. The other
// channels, Snap and Flatpak paths are the vendors' usual defaults, recalled rather than checked
// against a real machine.
pub(super) const LINUX_KNOWN: &[LinuxKnown] = &[
    LinuxKnown {
        folder: "google-chrome",
        browser: "Google Chrome",
        key: "chrome",
        secret: "chrome",
        bins: &["google-chrome", "google-chrome-stable"],
        snap: None,
        flatpak: Some("com.google.Chrome"),
    },
    LinuxKnown {
        folder: "google-chrome-beta",
        browser: "Google Chrome Beta",
        key: "chrome-beta",
        secret: "chrome",
        bins: &["google-chrome-beta"],
        snap: None,
        flatpak: None,
    },
    LinuxKnown {
        folder: "google-chrome-unstable",
        browser: "Google Chrome Dev",
        key: "chrome-dev",
        secret: "chrome",
        bins: &["google-chrome-unstable"],
        snap: None,
        flatpak: None,
    },
    LinuxKnown {
        folder: "chromium",
        browser: "Chromium",
        key: "chromium",
        secret: "chromium",
        bins: &["chromium", "chromium-browser"],
        snap: Some(("chromium", "common/chromium")),
        flatpak: Some("org.chromium.Chromium"),
    },
    LinuxKnown {
        folder: "microsoft-edge",
        browser: "Microsoft Edge",
        key: "edge",
        secret: "msedge",
        bins: &["microsoft-edge", "microsoft-edge-stable"],
        snap: None,
        flatpak: Some("com.microsoft.Edge"),
    },
    LinuxKnown {
        folder: "microsoft-edge-beta",
        browser: "Microsoft Edge Beta",
        key: "edge-beta",
        secret: "msedge",
        bins: &["microsoft-edge-beta"],
        snap: None,
        flatpak: None,
    },
    LinuxKnown {
        folder: "microsoft-edge-dev",
        browser: "Microsoft Edge Dev",
        key: "edge-dev",
        secret: "msedge",
        bins: &["microsoft-edge-dev"],
        snap: None,
        flatpak: None,
    },
    LinuxKnown {
        folder: "BraveSoftware/Brave-Browser",
        browser: "Brave",
        key: "brave",
        secret: "brave",
        bins: &["brave-browser", "brave", "brave-browser-stable"],
        snap: Some(("brave", "current/.config/BraveSoftware/Brave-Browser")),
        flatpak: Some("com.brave.Browser"),
    },
    LinuxKnown {
        folder: "BraveSoftware/Brave-Browser-Beta",
        browser: "Brave Beta",
        key: "brave-beta",
        secret: "brave",
        bins: &["brave-browser-beta"],
        snap: None,
        flatpak: None,
    },
    LinuxKnown {
        folder: "BraveSoftware/Brave-Browser-Nightly",
        browser: "Brave Nightly",
        key: "brave-nightly",
        secret: "brave",
        bins: &["brave-browser-nightly"],
        snap: None,
        flatpak: None,
    },
    LinuxKnown {
        folder: "vivaldi",
        browser: "Vivaldi",
        key: "vivaldi",
        secret: "vivaldi",
        bins: &["vivaldi", "vivaldi-stable"],
        snap: None,
        flatpak: Some("com.vivaldi.Vivaldi"),
    },
    LinuxKnown {
        folder: "opera",
        browser: "Opera",
        key: "opera",
        secret: "opera",
        bins: &["opera"],
        snap: Some(("opera", "current/.config/opera")),
        flatpak: Some("com.opera.Opera"),
    },
];
