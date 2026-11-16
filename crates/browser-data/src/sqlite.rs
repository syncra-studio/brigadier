//! Opening a browser's database without touching it.
//!
//! The source is opened read-only and copied page by page into an in-memory database with
//! SQLite's online backup; every query then runs on the copy. When the source has no `-wal` or
//! `-journal` beside it, it is opened `immutable=1`, so SQLite takes no locks and creates no
//! `-shm` file in the browser's profile. When one is there, the browser may have unflushed
//! writes (or is still running), so it is opened with normal read-only locking to see them.

use std::collections::HashSet;
use std::path::Path;
use std::time::Duration;

use rusqlite::backup::{Backup, StepResult};
use rusqlite::{Connection, ErrorCode, OpenFlags};

use crate::Error;

/// Pages copied per backup step.
const PAGES_PER_STEP: i32 = 256;
/// How many busy/locked steps in a row are retried before giving up.
const BUSY_RETRIES: u32 = 20;
/// Pause between retries of a busy step.
const BUSY_PAUSE: Duration = Duration::from_millis(50);

/// Copies the database at `path` into memory and returns the copy.
pub(crate) fn open_copy(path: &Path) -> Result<Connection, Error> {
    // Opening the file first gives the precise OS error (SQLite reports any failure to open as
    // CANTOPEN), so a missing file and a Full Disk Access refusal can be told apart.
    match std::fs::File::open(path) {
        Ok(_) => {}
        Err(err) => return Err(io_error(path, err)),
    }
    let journaled = ["-wal", "-journal"].iter().any(|suffix| {
        let mut sidecar = path.as_os_str().to_owned();
        sidecar.push(suffix);
        Path::new(&sidecar).exists()
    });
    let uri = format!(
        "file:{}?{}",
        uri_path(path),
        if journaled {
            "mode=ro"
        } else {
            "mode=ro&immutable=1"
        }
    );
    let flags = OpenFlags::SQLITE_OPEN_READ_ONLY
        | OpenFlags::SQLITE_OPEN_NO_MUTEX
        | OpenFlags::SQLITE_OPEN_URI;
    let source = Connection::open_with_flags(&uri, flags).map_err(|err| sqlite_error(path, err))?;
    let mut copy = Connection::open_in_memory()?;
    {
        let backup = Backup::new(&source, &mut copy).map_err(|err| sqlite_error(path, err))?;
        let mut busy = 0;
        loop {
            match backup
                .step(PAGES_PER_STEP)
                .map_err(|err| sqlite_error(path, err))?
            {
                StepResult::Done => break,
                StepResult::More => busy = 0,
                StepResult::Busy | StepResult::Locked => {
                    busy += 1;
                    if busy > BUSY_RETRIES {
                        return Err(Error::Locked(path.to_owned()));
                    }
                    std::thread::sleep(BUSY_PAUSE);
                }
                _ => return Err(Error::Format("unknown backup step result".to_owned())),
            }
        }
    }
    Ok(copy)
}

/// The column names of `table`, empty when the table doesn't exist. Browsers add and rename
/// columns across versions, so queries are built from what is actually there.
pub(crate) fn columns(conn: &Connection, table: &str) -> Result<HashSet<String>, Error> {
    let mut stmt = conn.prepare("SELECT name FROM pragma_table_info(?1)")?;
    let names = stmt
        .query_map([table], |row| row.get::<_, String>(0))?
        .collect::<Result<HashSet<_>, _>>()?;
    Ok(names)
}

/// Maps an I/O error opening `path` to the crate's error.
pub(crate) fn io_error(path: &Path, err: std::io::Error) -> Error {
    match err.kind() {
        std::io::ErrorKind::NotFound => Error::NotFound(path.to_owned()),
        std::io::ErrorKind::PermissionDenied => Error::PermissionDenied(path.to_owned()),
        // ERROR_SHARING_VIOLATION and ERROR_LOCK_VIOLATION: a running browser holds it shut.
        _ if cfg!(windows) && matches!(err.raw_os_error(), Some(32 | 33)) => {
            Error::Locked(path.to_owned())
        }
        _ => Error::Io(err),
    }
}

/// Maps a SQLite error on `path` to the crate's error.
pub(crate) fn sqlite_error(path: &Path, err: rusqlite::Error) -> Error {
    match err.sqlite_error_code() {
        Some(ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked) => Error::Locked(path.to_owned()),
        Some(ErrorCode::PermissionDenied) => Error::PermissionDenied(path.to_owned()),
        _ => Error::Sqlite(err),
    }
}

/// Percent-encodes a path for a `file:` URI, leaving `/` and unreserved characters alone.
fn uri_path(path: &Path) -> String {
    let mut out = String::new();
    for byte in path.as_os_str().as_encoded_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' | b'/' => {
                out.push(char::from(*byte));
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}
