use std::path::PathBuf;

use serde::{Deserialize, Serialize};

/// The engine family a browser belongs to; it decides the file formats a profile uses.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Family {
    /// Chrome, Edge, Brave, Arc, Dia, Vivaldi, Opera and other Chromium builds.
    Chromium,
    /// Safari.
    Safari,
}

/// One browser profile found on disk.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Profile {
    /// Stable id, `<browser key>/<profile dir name>`, e.g. `dia/Default` or `safari/default`, so
    /// the app can remember which profile a user picked across launches.
    pub id: String,
    /// The browser's display name, e.g. "Google Chrome".
    pub browser: String,
    /// The profile's display name, e.g. "Person 1" or "default-release".
    pub name: String,
    /// The engine family, which decides how the files are read.
    pub family: Family,
    /// The profile directory.
    pub dir: PathBuf,
    /// The browser's app (a bundle on macOS, an executable or launcher elsewhere) when known;
    /// [`crate::running`] uses it to tell whether it is open.
    pub app_path: Option<PathBuf>,
    /// Chromium on macOS only: the Keychain service holding the cookie encryption password.
    pub keychain_service: Option<String>,
    /// Chromium on macOS only: the Keychain account of that password.
    pub keychain_account: Option<String>,
    /// Chromium only: the browser's `Local State`, which on Windows holds its sealed master key.
    pub local_state: Option<PathBuf>,
    /// Chromium on Linux only: the `application` attribute of its keyring password.
    pub linux_secret_application: Option<String>,
    /// Whether the profile has a cookie store.
    pub has_cookies: bool,
    /// Whether the profile has a history database.
    pub has_history: bool,
    /// False when the cookie or history files exist but can't be opened, which for Safari means
    /// Brigadier lacks Full Disk Access.
    pub readable: bool,
    /// The profile the browser itself opens by default, so the app can preselect it.
    pub is_default: bool,
}

/// A cookie as a browser stored it, in the shape WebKit needs to set it again.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Cookie {
    /// The cookie's name.
    pub name: String,
    /// The cookie's value, decrypted.
    pub value: String,
    /// `.example.com` for a domain cookie, `example.com` for a host-only one.
    pub domain: String,
    /// True when the cookie is sent only to the exact host that set it.
    pub host_only: bool,
    /// The cookie's path.
    pub path: String,
    /// Expiry in Unix seconds; `None` for a session cookie.
    pub expires_unix: Option<i64>,
    /// Sent only over HTTPS.
    pub secure: bool,
    /// Hidden from page scripts.
    pub http_only: bool,
    /// The SameSite attribute; `None` when the browser recorded it as unspecified.
    pub same_site: Option<SameSite>,
    /// The browser recorded that plain http set it, which a store binding cookies to their scheme
    /// has to know; false when it recorded https or nothing.
    #[serde(default)]
    pub source_insecure: bool,
}

/// A cookie's SameSite attribute.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum SameSite {
    /// Sent on cross-site requests too.
    None,
    /// Sent on top-level cross-site navigations only.
    Lax,
    /// Never sent cross-site.
    Strict,
}

/// The cookies read from one profile, plus counts of the ones left out and why, so the app
/// can tell the user what didn't come across.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Cookies {
    /// The cookies to import.
    pub cookies: Vec<Cookie>,
    /// Skipped because they had already expired.
    pub expired: usize,
    /// Skipped because they were partitioned (per top-level site),
    /// an isolation WebKit's cookie store can't keep.
    pub partitioned: usize,
    /// Skipped because they could not be decrypted, failed their integrity check or were
    /// malformed.
    pub unreadable: usize,
    /// Chromium's partitioned cookies that could be opened, which a Chromium target can keep as
    /// they were. They are counted in `partitioned` too.
    pub partitioned_cookies: Vec<PartitionedCookie>,
}

/// A cookie kept per top-level site (CHIPS), with what makes up its partition in Chromium.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PartitionedCookie {
    pub cookie: Cookie,
    /// The top-level site it belongs to.
    pub top_frame_site_key: String,
    /// The other half of Chromium's partition key.
    pub has_cross_site_ancestor: bool,
}

/// Why a browser's cookie key couldn't be fetched, on any OS.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum SecretError {
    /// The store holding the key is locked, and the user can unlock it and try again (Linux).
    Locked,
    /// The store refused: the user declined (macOS), or the key is sealed for another user
    /// (Windows).
    Denied,
    /// The store has no key for this browser.
    NotFound,
    /// This machine has no store to ask (Linux with no keyring or no session bus).
    NoStore,
    /// Any other failure, with its message.
    Other(String),
}

impl std::fmt::Display for SecretError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Locked => f.write_str("the store holding it is locked"),
            Self::Denied => f.write_str("access denied"),
            Self::NotFound => f.write_str("key not found"),
            Self::NoStore => f.write_str("no key store on this machine"),
            Self::Other(message) => f.write_str(message),
        }
    }
}

impl From<KeychainError> for SecretError {
    fn from(err: KeychainError) -> Self {
        match err {
            KeychainError::Denied => Self::Denied,
            KeychainError::NotFound => Self::NotFound,
            KeychainError::Other(message) => Self::Other(message),
        }
    }
}

/// Why the Keychain refused to hand over a browser's password.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KeychainError {
    /// The user declined the prompt, or access is not allowed right now.
    Denied,
    /// No such Keychain item.
    NotFound,
    /// Any other Keychain failure, with its message.
    Other(String),
}

impl std::fmt::Display for KeychainError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Denied => f.write_str("access denied"),
            Self::NotFound => f.write_str("item not found"),
            Self::Other(message) => f.write_str(message),
        }
    }
}

/// What can go wrong reading a profile.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// The file is missing.
    #[error("not found: {}", .0.display())]
    NotFound(PathBuf),
    /// The OS refused to open the file (EPERM/EACCES); for Safari on macOS this means Brigadier
    /// needs Full Disk Access.
    #[error("permission denied: {}", .0.display())]
    PermissionDenied(PathBuf),
    /// The file is busy or locked, usually because the browser is still running (on Windows,
    /// Chromium holds its files shut to others while it runs).
    #[error("database is locked: {}", .0.display())]
    Locked(PathBuf),
    /// Any other SQLite failure.
    #[error("sqlite: {0}")]
    Sqlite(#[from] rusqlite::Error),
    /// Any other I/O failure.
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    /// [`crate::chromium_password`] only: the Keychain refused or had no such password.
    #[error("keychain: {0}")]
    Keychain(KeychainError),
    /// [`crate::chromium_keys`] on any OS: the browser's cookie key couldn't be fetched.
    #[error("cookie key: {0}")]
    Secret(SecretError),
    /// The file is not in the shape this crate understands.
    #[error("unexpected format: {0}")]
    Format(String),
    /// This browser keeps this data where no other app can read it (Safari's passwords).
    #[error("not readable by other apps: {0}")]
    NotReadable(&'static str),
    /// A folder isn't one a Chromium target can use as a profile.
    #[error("not a usable profile folder: {}", .0.display())]
    BadTarget(PathBuf),
}
