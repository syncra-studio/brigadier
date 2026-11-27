//! Brigadier's one secret item [D2043, D416]: a JSON object keyed by library item key, each value an
//! object (`{"env": {..}}`, 4.13's `oauth`), kept where each system keeps a user's secrets. Only the
//! daemon calls it.

use std::path::Path;
use std::sync::Mutex;

#[cfg(target_os = "macos")]
mod mac;
#[cfg(target_os = "macos")]
pub use mac::*;
#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub use windows::*;

/// One read-modify-write at a time in this process.
static LOCK: Mutex<()> = Mutex::new(());

/// An instance on another data folder without BRIGADIER_KEYCHAIN: it never reaches the user's own
/// store, so it can't put up a prompt there [D449]. It reads no secrets and can't write one.
pub fn walled() -> bool {
    std::env::var_os("BRIGADIER_KEYCHAIN").is_none()
        && std::env::var_os("BRIGADIER_DATA")
            .is_some_and(|d| Path::new(&d) != crate::default_data_dir())
}
