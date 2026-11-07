//! Provider-free pieces shared by every owner of agent processes: the frame log, process facts,
//! the socket protocol and the runner that holds one session's child.

pub mod log;
pub mod procs;
pub mod runner;
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
