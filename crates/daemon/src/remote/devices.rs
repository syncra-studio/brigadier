//! The Mac's Noise key and the phones it has paired (`data/remote/key`, `data/remote/devices.json`,
//! both in the daemon's own 0700 data folder), and their device sessions, in memory only: a daemon
//! restart ends them all (remote design §4 "Every session"). A device's id is the SHA-256 of the
//! static key its handshake authenticated, never a field it sends.

use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::fs::{self, Permissions};
use std::io;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::time::{Duration, Instant};

/// A device session ends after this long without a request, or this long after its Face ID.
pub(super) const IDLE: Duration = Duration::from_secs(15 * 60);
pub(super) const MOST: Duration = Duration::from_secs(12 * 60 * 60);

pub(super) struct Session {
    pub(super) since: Instant,
    pub(super) last: Instant,
}

impl Session {
    pub(super) fn live(&self) -> bool {
        self.last.elapsed() < IDLE && self.since.elapsed() < MOST
    }
}

pub(super) fn id_of(static_key: &[u8]) -> String {
    hex(&Sha256::digest(static_key))
}

pub(super) fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub(super) fn write_private(path: &Path, bytes: &[u8]) -> io::Result<()> {
    fs::create_dir_all(path.parent().unwrap_or(path))?;
    brigadier_core::write_atomic(path, bytes)?;
    fs::set_permissions(path, Permissions::from_mode(0o600))
}

/// The Mac's X25519 key pair, made the first time: 32 private bytes, then 32 public.
pub(super) fn mac_key(data: &Path) -> io::Result<([u8; 32], [u8; 32])> {
    let path = data.join("remote/key");
    // Only a missing key is made: replacing one would cut off every paired phone.
    let bytes = match fs::read(&path) {
        Ok(bytes) if bytes.len() == 64 => bytes,
        Ok(_) => return Err(io::Error::other("data/remote/key is damaged")),
        Err(e) if e.kind() != io::ErrorKind::NotFound => return Err(e),
        Err(_) => {
            let pair = snow::Builder::new(super::link::PATTERN.parse().map_err(io::Error::other)?)
                .generate_keypair()
                .map_err(io::Error::other)?;
            let bytes = [pair.private, pair.public].concat();
            write_private(&path, &bytes)?;
            bytes
        }
    };
    let (private, public) = bytes.split_at(32);
    Ok((private.try_into().unwrap(), public.try_into().unwrap()))
}

/// Each paired device: `{id, name, model, os, u, psk, paired, seen}`, `u` its Face ID key (SEC1)
/// and `psk` the key its sign-ins mix in, both base64. A file that can't be read is an error, so
/// no change is ever saved over the phones it holds.
pub(super) fn list(data: &Path) -> io::Result<Vec<Value>> {
    match fs::read(data.join("remote/devices.json")) {
        Ok(bytes) => Ok(serde_json::from_slice(&bytes)?),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(vec![]),
        Err(e) => Err(e),
    }
}

pub(super) fn save(data: &Path, devices: &[Value]) -> io::Result<()> {
    let bytes = serde_json::to_vec(devices)?;
    write_private(&data.join("remote/devices.json"), &bytes)
}

pub(super) fn find(data: &Path, id: &str) -> Option<Value> {
    list(data).ok()?.into_iter().find(|d| d["id"] == id)
}

/// Settings › Connections' row of a device: never its keys.
pub(super) fn shown(device: &Value, seen: Option<u64>) -> Value {
    json!({"id": device["id"], "name": device["name"], "model": device["model"], "os": device["os"],
        "paired": device["paired"], "seen": seen.map_or(device["seen"].clone(), Value::from), "powers": super::powers::shown(device)})
}
