//! Provider-free pieces shared by every owner of agent processes: the frame log, process facts,
//! the socket protocol and the runner that holds one session's child.

pub mod background;
pub mod forks;
pub mod log;
pub mod procs;
pub mod runner;
pub mod spawn;
#[cfg(windows)]
pub mod win;
pub mod wire;

use std::fs::{File, OpenOptions, TryLockError};
use std::io;
use std::path::Path;

/// Takes the lock that makes its holder the only owner of `path`'s folder. The kernel frees it
/// however the holder dies. None means someone else holds it.
pub fn take_lock(path: &Path) -> io::Result<Option<File>> {
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(path)?;
    match file.try_lock() {
        Ok(()) => Ok(Some(file)),
        Err(TryLockError::WouldBlock) => Ok(None),
        Err(TryLockError::Error(e)) => Err(e),
    }
}

/// True while some process holds the lock. Never takes it for longer than the check.
pub fn lock_held(path: &Path) -> bool {
    let Ok(file) = File::open(path) else {
        return false;
    };
    match file.try_lock_shared() {
        Ok(()) => false,
        Err(TryLockError::WouldBlock) => true,
        Err(TryLockError::Error(_)) => false,
    }
}

/// The system's own curl: /usr/bin's, or Windows' in System32 (Windows 10 1803 on).
pub fn curl() -> std::path::PathBuf {
    #[cfg(windows)]
    return Path::new(&std::env::var_os("SystemRoot").unwrap_or_else(|| r"C:\Windows".into()))
        .join(r"System32\curl.exe");
    #[cfg(unix)]
    return "/usr/bin/curl".into();
}

/// Standard base64 with padding.
pub fn base64(bytes: &[u8]) -> String {
    const A: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut s = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for c in bytes.chunks(3) {
        let n = c.iter().fold(0u32, |n, &b| n << 8 | b as u32) << (8 * (3 - c.len()));
        for i in 0..4 {
            s.push(if i <= c.len() {
                A[(n >> (18 - 6 * i)) as usize & 63] as char
            } else {
                '='
            });
        }
    }
    s
}

/// Standard base64 back to bytes; None for anything else.
pub fn unbase64(s: &str) -> Option<Vec<u8>> {
    let s = s.trim_end_matches('=').as_bytes();
    let six = |c: u8| match c {
        b'A'..=b'Z' => Some(c - b'A'),
        b'a'..=b'z' => Some(c - b'a' + 26),
        b'0'..=b'9' => Some(c - b'0' + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    };
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    for c in s.chunks(4) {
        let n = c
            .iter()
            .try_fold(0u32, |n, &b| Some(n << 6 | six(b)? as u32))?
            << (6 * (4 - c.len()));
        out.extend(&n.to_be_bytes()[1..c.len()]);
    }
    (s.len() % 4 != 1).then_some(out)
}
