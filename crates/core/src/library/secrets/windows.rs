//! Windows: the item is a file in the data folder sealed to the signed-in user by DPAPI, as the
//! Keychain binds it on macOS. Credential Manager caps a blob at 2,560 bytes, and one item holds
//! every server's grant (port.md "Secrets"). A hidden instance's BRIGADIER_KEYCHAIN names its own
//! file instead.

use serde_json::{Map, Value};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use windows_sys::Win32::Foundation::LocalFree;
use windows_sys::Win32::Security::Cryptography::{
    CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptProtectData, CryptUnprotectData,
};

use super::{LOCK, walled};

fn file(data: &Path) -> io::Result<PathBuf> {
    if walled() {
        return Err(io::Error::other(
            "Brigadier's secret file: this instance has its own data folder (BRIGADIER_DATA) and no BRIGADIER_KEYCHAIN, so it doesn't use your own.",
        ));
    }
    Ok(
        match std::env::var_os("BRIGADIER_DATA").and(std::env::var_os("BRIGADIER_KEYCHAIN")) {
            Some(file) => file.into(),
            None => data.join("secrets"),
        },
    )
}

fn blob(bytes: &[u8]) -> io::Result<CRYPT_INTEGER_BLOB> {
    Ok(CRYPT_INTEGER_BLOB {
        cbData: u32::try_from(bytes.len()).map_err(io::Error::other)?,
        pbData: bytes.as_ptr().cast_mut(),
    })
}

/// Seals (or opens) `bytes` for this user, never with a prompt.
fn dpapi(bytes: &[u8], seal: bool) -> io::Result<Vec<u8>> {
    let input = blob(bytes)?;
    let mut out = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    let (null, flags) = (std::ptr::null(), CRYPTPROTECT_UI_FORBIDDEN);
    let ok = unsafe {
        match seal {
            true => CryptProtectData(&input, null, null, null, null, flags, &mut out),
            false => CryptUnprotectData(
                &input,
                std::ptr::null_mut(),
                null,
                null,
                null,
                flags,
                &mut out,
            ),
        }
    };
    if ok == 0 {
        return Err(io::Error::other(format!(
            "Brigadier's secret file couldn't be {} ({})",
            if seal { "sealed" } else { "opened" },
            io::Error::last_os_error()
        )));
    }
    let bytes = unsafe { std::slice::from_raw_parts(out.pbData, out.cbData as usize) }.to_vec();
    unsafe { LocalFree(out.pbData.cast()) };
    Ok(bytes)
}

/// The whole payload; empty when there is no file, or none can be read here.
pub fn read(data: &Path) -> io::Result<Map<String, Value>> {
    if walled() {
        return Ok(Map::new());
    }
    match fs::read(file(data)?) {
        Ok(sealed) => serde_json::from_slice(&dpapi(&sealed, false)?)
            .map_err(|_| io::Error::other("Brigadier's secret file isn't readable")),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(Map::new()),
        Err(e) => Err(e),
    }
}

/// Changes the payload under one lock, then reads it back whole before calling it done; the file
/// is made at the first secret and deleted when nothing is left in it [D2043]. A new one replaces
/// the old by rename, so a torn write never loses the last good one.
pub fn update(data: &Path, change: impl FnOnce(&mut Map<String, Value>)) -> io::Result<()> {
    let _held = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let before = read(data)?;
    let mut after = before.clone();
    change(&mut after);
    after.retain(|_, v| v.as_object().is_some_and(|o| !o.is_empty()));
    if after == before {
        return Ok(());
    }
    let path = file(data)?;
    if after.is_empty() {
        match fs::remove_file(&path) {
            Err(e) if e.kind() != io::ErrorKind::NotFound => return Err(e),
            _ => {}
        }
    } else {
        let next = path.with_extension("new");
        fs::write(&next, dpapi(&serde_json::to_vec(&after)?, true)?)?;
        fs::rename(&next, &path)?;
    }
    match read(data)? == after {
        true => Ok(()),
        false => Err(io::Error::other(
            "Brigadier's secret file didn't keep what was written",
        )),
    }
}
