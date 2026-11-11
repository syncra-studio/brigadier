//! Replace all's record of a run under way, and putting right a run cut short [D1173].

use super::{Checkout, lock};
use serde::{Deserialize, Serialize};
use std::fs;
use std::hash::{DefaultHasher, Hasher};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;

const RECORD: &str = "replacing.json";

/// A run's record: its files, and whether all were placed (left: only removing their old copies).
#[derive(Serialize, Deserialize)]
struct Record {
    root: PathBuf,
    git_dir: PathBuf,
    keep: Option<PathBuf>,
    placed: bool,
    files: Vec<Staged>,
}

/// At the daemon's start: each Replace all cut short is put right under its checkout's lock.
pub fn sweep(data: &Path) {
    let projects = fs::read_dir(data.join("projects"))
        .into_iter()
        .flatten()
        .flatten();
    let records = crate::ids(data)
        .into_iter()
        .map(|id| crate::session_dir(data, &id).join(RECORD))
        .chain(projects.map(|dir| dir.path().join(RECORD)));
    for path in records {
        locked(&path);
    }
}

/// Before a session's archive or delete takes its folder and the record in it [D35].
pub fn settled(data: &Path, id: &str) -> io::Result<()> {
    match locked(&crate::session_dir(data, id).join(RECORD)) {
        true => Ok(()),
        false => Err(io::Error::other(LEFT)),
    }
}

const LEFT: &str =
    "An earlier Replace all left files it couldn't put back; Brigadier tries again when it starts.";

/// `settle` under the checkout's lock: a run still going holds it, and settles its record itself.
/// A checkout gone has nothing left to put back.
fn locked(path: &Path) -> bool {
    let Some(run) = read(path) else {
        return true;
    };
    let checkout = Checkout {
        root: run.root,
        git_dir: run.git_dir,
        // Only its lock is taken here, which doesn't read this.
        worktree: false,
    };
    let _exclusive = lock(&checkout, true, &AtomicBool::new(false));
    settle(path)
}

fn read(path: &Path) -> Option<Record> {
    serde_json::from_slice(&fs::read(path).ok()?).ok()
}

/// Puts right the run recorded at `path`, under its checkout's lock. Cut short while placing,
/// every file goes back as it was; once all were placed, only their old copies go. A file
/// something else changed stays, and the log says where its text from before is. One still
/// missing with its text aside stays recorded, to try again; then this answers false.
fn settle(path: &Path) -> bool {
    let Some(mut run) = read(path) else {
        return true;
    };
    for file in &run.files {
        // Kept away only where its place holds something: a file still missing keeps its copy beside it.
        let kept = |f: &Staged, copy: &Path| match fs::symlink_metadata(&f.full).is_ok() {
            true => keep_copy(copy, &f.full, run.keep.as_deref()),
            false => copy.to_path_buf(),
        };
        if let Err(why) = recover(file, run.placed, &kept) {
            eprintln!("brigadier: replace {}: {why}", file.full.display());
        }
    }
    // Left to try again: a file still missing, a rollback whose rewrite is still in place, or an
    // old copy not yet removed. A copy kept because something else changed the file is done. One
    // that can't be looked at is kept too.
    let gone =
        |p: &Path| matches!(fs::symlink_metadata(p), Err(e) if e.kind() == io::ErrorKind::NotFound);
    let unsure = |p: &Path| fs::symlink_metadata(p).is_err() && !gone(p);
    let holds = |p: &Path, h: &str| fs::read(p).is_ok_and(|bytes| hash(&bytes) == h);
    let placed = run.placed;
    run.files.retain(|f| {
        unsure(&f.full)
            || unsure(&f.aside)
            || !gone(&f.aside)
                && (gone(&f.full)
                    || (!placed && holds(&f.full, &f.new_hash))
                    || (placed && holds(&f.aside, &f.hash)))
    });
    if !run.files.is_empty() {
        let _ = serde_json::to_vec(&run).map(|bytes| crate::write_atomic(path, &bytes));
        return false;
    }
    let _ = fs::remove_file(path);
    // A project's folder holds nothing else.
    let _ = path.parent().map(fs::remove_dir);
    true
}

/// Puts one file of a run cut short right, only while what's there is this run's own.
fn recover(
    file: &Staged,
    placed: bool,
    kept: &impl Fn(&Staged, &Path) -> PathBuf,
) -> Result<(), String> {
    let _ = fs::remove_file(&file.temp);
    // A rollback cut short while it checked what was in the file's place: that comes back first.
    let mut newer = None;
    if fs::symlink_metadata(&file.undone).is_ok() {
        if fs::read(&file.undone).is_ok_and(|bytes| hash(&bytes) == file.new_hash) {
            let _ = fs::remove_file(&file.undone);
        } else if rename_into(&file.undone, &file.full).is_err() {
            // Yet another save took the place: this one goes where the session's delete takes it.
            let undone = kept(file, &file.undone);
            newer = Some(format!("a newer save of it is in {}", undone.display()));
        }
    }
    match (aside(file, placed, kept), newer) {
        (result, None) => result,
        (Ok(()), Some(newer)) => Err(newer),
        (Err(why), Some(newer)) => Err(format!("{why}; {newer}")),
    }
}

/// The file's copy from before: back in its place, or gone once its rewrite is in.
fn aside(
    file: &Staged,
    placed: bool,
    kept: &impl Fn(&Staged, &Path) -> PathBuf,
) -> Result<(), String> {
    if fs::symlink_metadata(&file.aside).is_err() {
        return Ok(());
    }
    let original = |path: &Path| fs::read(path).is_ok_and(|bytes| hash(&bytes) == file.hash);
    if !placed && !original(&file.full) {
        return put_back(file, kept);
    }
    match original(&file.aside) {
        true => {
            fs::remove_file(&file.aside).map_err(|e| format!("couldn't remove its old copy: {e}"))
        }
        false => Err(format!(
            "it was written while it was replaced; that save is in {}",
            kept(file, &file.aside).display()
        )),
    }
}

/// One listed file's rewrite, ready to go: its new text written beside it, not yet in place.
#[derive(Serialize, Deserialize)]
struct Staged {
    path: String,
    full: PathBuf,
    /// What the search found in it, and what the rewrite holds.
    hash: String,
    new_hash: String,
    matches: u64,
    temp: PathBuf,
    /// Where the file is moved aside while the rewrite takes its place, until all are in.
    aside: PathBuf,
    /// Where what's in its place goes while a rollback checks it.
    undone: PathBuf,
    /// Whether its folder takes hard links, probed before any original is moved.
    hard_links: bool,
}

/// Moves a rewrite or original into an empty path, refusing a concurrent writer atomically.
#[cfg(target_os = "macos")]
fn rename_into(from: &Path, to: &Path) -> io::Result<()> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let from = CString::new(from.as_os_str().as_bytes()).map_err(io::Error::other)?;
    let to = CString::new(to.as_os_str().as_bytes()).map_err(io::Error::other)?;
    // SAFETY: both paths are NUL-terminated and live for the whole call.
    match unsafe { libc::renamex_np(from.as_ptr(), to.as_ptr(), libc::RENAME_EXCL) } {
        0 => Ok(()),
        _ => Err(io::Error::last_os_error()),
    }
}

#[cfg(target_os = "linux")]
fn rename_into(from: &Path, to: &Path) -> io::Result<()> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let from = CString::new(from.as_os_str().as_bytes()).map_err(io::Error::other)?;
    let to = CString::new(to.as_os_str().as_bytes()).map_err(io::Error::other)?;
    // SAFETY: both paths are NUL-terminated and live for the whole call.
    let done = unsafe {
        libc::renameat2(
            libc::AT_FDCWD,
            from.as_ptr(),
            libc::AT_FDCWD,
            to.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    match done {
        0 => Ok(()),
        _ => Err(io::Error::last_os_error()),
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn rename_into(_: &Path, _: &Path) -> io::Result<()> {
    // Without an exclusive rename, the probe fails before an original moves.
    Err(io::ErrorKind::Unsupported.into())
}

/// Puts back a file `place` placed: its rewrite (if still as written) goes, and the file from
/// before comes back. What's in its place is moved off first and checked there, so a save that
/// lands meanwhile is never deleted: when something else is in its place, both stay, and the
/// reason says where the text from before is.
fn put_back(file: &Staged, kept: &impl Fn(&Staged, &Path) -> PathBuf) -> Result<(), String> {
    let changed = || {
        format!(
            "it changed while the files were being replaced; its text from before is in {}",
            kept(file, &file.aside).display()
        )
    };
    let off = &file.undone;
    // Exclusive: a save a rollback cut short left there is never written over.
    match rename_into(&file.full, off) {
        Ok(()) if fs::read(off).is_ok_and(|bytes| hash(&bytes) == file.new_hash) => {
            let _ = fs::remove_file(off);
        }
        // Someone else's save: it goes back where it was, unless yet another took the place.
        Ok(()) => {
            return Err(match rename_into(off, &file.full) {
                Ok(()) => changed(),
                Err(_) => {
                    let off = kept(file, off);
                    format!("{}; a newer save of it is in {}", changed(), off.display())
                }
            });
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("couldn't undo it: {e}")),
    }
    restore(file, kept)
}

/// Moves a file moved aside back into its place, refusing anything that took the place.
fn restore(file: &Staged, kept: &impl Fn(&Staged, &Path) -> PathBuf) -> Result<(), String> {
    let restored = match file.hard_links {
        true => fs::hard_link(&file.aside, &file.full).and_then(|()| fs::remove_file(&file.aside)),
        false => rename_into(&file.aside, &file.full),
    };
    restored.map_err(|e| {
        let kept = kept(file, &file.aside);
        format!(
            "couldn't undo it ({e}); its text from before is in {}",
            kept.display()
        )
    })
}

/// Where a copy of the file at `of` stays when it can't go back: moved into `keep` (the session's
/// folder, so delete takes it [D35]), else beside it.
// shortcut: when the session's own folder can't take the copy, it stays beside the file, named in
// the reason but recorded nowhere, as no record could be written there either.
fn keep_copy(copy: &Path, of: &Path, keep: Option<&Path>) -> PathBuf {
    let Some(keep) = keep else {
        return copy.to_path_buf();
    };
    let name = of.file_name().unwrap_or_default().to_string_lossy();
    let to = keep.join(format!("{}-{name}", crate::adapters::uuid()));
    let moved = fs::create_dir_all(keep)
        .and_then(|()| fs::copy(copy, &to))
        .and_then(|_| fs::remove_file(copy));
    match moved {
        Ok(()) => to,
        Err(_) => {
            let _ = fs::remove_file(&to);
            copy.to_path_buf()
        }
    }
}

/// Tells one version of a file from another, within this build.
fn hash(bytes: &[u8]) -> String {
    let mut hasher = DefaultHasher::new();
    hasher.write(bytes);
    format!("{:016x}-{}", hasher.finish(), bytes.len())
}
