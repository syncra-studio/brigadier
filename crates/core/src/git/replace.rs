//! Replace all [D1003], ported from the old app's `manager/search.rs`: it rewrites the files a
//! search listed only if every one is still as the search found it, all of them or none, and never
//! writes over a save that lands meanwhile.

use super::search::{Matcher, hash, searchable};
use super::{Checkout, files::listed, lock};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashSet;
use std::fs;
use std::io::{self, Write as _};
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;

/// One listed file's rewrite, ready to go: its new text written beside it, not yet in place.
#[derive(Serialize, Deserialize)]
pub(super) struct Staged {
    pub(super) path: String,
    pub(super) full: PathBuf,
    /// What the search found in it, and what the rewrite holds.
    pub(super) hash: String,
    pub(super) new_hash: String,
    matches: u64,
    pub(super) temp: PathBuf,
    /// Where the file is moved aside while the rewrite takes its place, until all are in.
    pub(super) aside: PathBuf,
    /// Where what's in its place goes while a rollback checks it.
    pub(super) undone: PathBuf,
    /// Whether its folder takes hard links, probed before any original is moved.
    hard_links: bool,
}

/// Rewrites the files listed (`[{path, hash, matches}]`), all of them or
/// none, under the checkout's lock [D1060]. Each is checked against what the search found and its
/// rewrite is written beside it; any that changed, can't be searched or written stops it all
/// before a byte moves. Then each in turn is moved aside, checked once more (it may have changed
/// since: an agent's save takes no lock of ours), and its rewrite linked or exclusively renamed into
/// its place, refusing anything that took the place meanwhile. A failure puts back every file
/// already rewritten; one that something else changed meanwhile stays as it is, and its text from
/// before is kept in `keep` (the session's folder [D35]), or beside it for a project, and listed in
/// `unrestored`. With a regular expression, `$1` or `${name}` stand for what a group matched.
/// Answers `{files, matches, skipped: [{path, reason}], unrestored: [{path, reason}]}`.
pub fn replace(
    checkout: &Checkout,
    matcher: &Matcher,
    replacement: &str,
    files: &[Value],
    keep: Option<&Path>,
    record: &Path,
    stop: &AtomicBool,
) -> io::Result<Value> {
    let _exclusive = lock(checkout, true, stop)?;
    // A run cut short before this one is put right first: its record is about to be reused.
    if !super::recover::settle(record) {
        return Err(io::Error::other(
            "An earlier Replace all left files it couldn't put back; Brigadier tries again when it starts.",
        ));
    }
    let eligible: HashSet<String> = listed(checkout, stop)?.into_iter().collect();
    let (mut skipped, mut unrestored) = (vec![], vec![]);
    let skip = |path: &str, reason: String| json!({"path": path, "reason": reason});
    let mut staged: Vec<Staged> = vec![];
    for file in files {
        let path = file["path"].as_str().unwrap_or("");
        let result = match eligible.contains(path) && matcher.wants(path) {
            false => Err("it is not one of the checkout's searchable files".into()),
            true => stage_file(checkout, matcher, replacement, file),
        };
        match result {
            Ok(file) => staged.push(file),
            Err(reason) => skipped.push(skip(path, reason)),
        }
    }
    let discard = |staged: &[Staged]| {
        for file in staged {
            let _ = fs::remove_file(&file.temp);
        }
    };
    let outcome = |files: u64, matches: u64, skipped: Vec<Value>, unrestored: Vec<Value>| json!({"files": files, "matches": matches, "skipped": skipped, "unrestored": unrestored});
    if !skipped.is_empty() {
        discard(&staged);
        return Ok(outcome(0, 0, skipped, unrestored));
    }
    let mut probed: Vec<(PathBuf, Result<bool, String>)> = vec![];
    for file in &mut staged {
        let parent = file.full.parent().unwrap_or(&checkout.root).to_path_buf();
        let known = probed
            .iter()
            .find(|(dir, _)| *dir == parent)
            .map(|(_, r)| r.clone());
        let result = known.unwrap_or_else(|| {
            let result = probe(file).map_err(|e| format!("couldn't prepare to replace it: {e}"));
            probed.push((parent, result.clone()));
            result
        });
        match result {
            Ok(hard_links) => file.hard_links = hard_links,
            Err(reason) => {
                skipped.push(skip(&file.path, reason));
                discard(&staged);
                return Ok(outcome(0, 0, skipped, unrestored));
            }
        }
    }
    let note = |placed: bool| {
        let note = json!({"root": checkout.root, "git_dir": checkout.git_dir, "keep": keep,
            "placed": placed, "files": &staged});
        fs::create_dir_all(record.parent().unwrap_or(Path::new(".")))?;
        crate::write_atomic(record, &serde_json::to_vec(&note)?)
    };
    // Before the first file moves aside, so a crash from here on is put right at the next start.
    if let Err(e) = note(false) {
        discard(&staged);
        return Err(e);
    }
    let forget = || {
        let _ = fs::remove_file(record);
        // A project's folder holds nothing else.
        let _ = record.parent().map(fs::remove_dir);
    };
    let kept = |file: &Staged| keep_aside(file, keep);
    let mut placed = 0;
    for file in &staged {
        let Err((reason, moved)) = place(file) else {
            placed += 1;
            continue;
        };
        // Moved aside but not replaced: it goes back first, only where nothing took its place.
        if moved && let Err(why) = undo_place(file, &kept) {
            unrestored.push(skip(&file.path, why));
        }
        for done in staged[..placed].iter().rev() {
            if let Err(why) = put_back(done, &kept) {
                unrestored.push(skip(&done.path, why));
            }
        }
        skipped.push(skip(&file.path, reason));
        discard(&staged);
        forget();
        return Ok(outcome(0, 0, skipped, unrestored));
    }
    // All in: a crash now only leaves old copies, never a run half undone. Unrecorded, it leaves them.
    if note(true).is_err() {
        forget();
    }
    for file in &staged {
        // A writer that had the file open before it moved aside wrote into the old copy: kept.
        match fs::read(&file.aside).is_ok_and(|bytes| hash(&bytes) == file.hash) {
            true => drop(fs::remove_file(&file.aside)),
            false => {
                let why = "it was written while it was replaced; that save is in";
                unrestored.push(skip(&file.path, format!("{why} {}", kept(file).display())));
            }
        }
        let _ = fs::remove_file(&file.temp);
    }
    forget();
    let matches = staged.iter().map(|f| f.matches).sum();
    Ok(outcome(staged.len() as u64, matches, skipped, unrestored))
}

/// Checks a listed file against its search and writes its rewrite beside it.
fn stage_file(
    checkout: &Checkout,
    matcher: &Matcher,
    replacement: &str,
    file: &Value,
) -> Result<Staged, String> {
    let path = file["path"].as_str().unwrap_or("");
    let full = checkout_file(checkout, path)?;
    let (hash, text) = searchable(&full).ok_or("it can't be searched any more")?;
    if Some(hash.as_str()) != file["hash"].as_str() {
        return Err("it changed since the search".into());
    }
    let mut out = String::with_capacity(text.len());
    let (mut last, mut count) = (0, 0u64);
    for captures in matcher.regex.captures_iter(&text) {
        let Some(whole) = captures.get(0).filter(|whole| !whole.is_empty()) else {
            continue;
        };
        count += 1;
        out.push_str(&text[last..whole.start()]);
        match matcher.literal {
            true => out.push_str(replacement),
            false => captures.expand(replacement, &mut out),
        }
        last = whole.end();
    }
    out.push_str(&text[last..]);
    if Some(count) != file["matches"].as_u64() {
        return Err("its matches changed since the search".into());
    }
    let temp =
        write_beside(&full, out.as_bytes()).map_err(|e| format!("couldn't write it: {e}"))?;
    Ok(Staged {
        path: path.to_string(),
        aside: sibling(&full, "replaced"),
        undone: sibling(&full, "undone"),
        full,
        hash,
        new_hash: self::hash(out.as_bytes()),
        matches: count,
        temp,
        hard_links: true,
    })
}

/// Probes a folder before any original moves: a hard link, or else an exclusive rename using only
/// the rewrite. A failed probe leaves every original untouched.
fn probe(file: &Staged) -> io::Result<bool> {
    let probe = sibling(&file.full, "replace-probe");
    if fs::hard_link(&file.temp, &probe).is_ok() {
        fs::remove_file(&probe)?;
        return Ok(true);
    }
    rename_into(&file.temp, &probe)?;
    let result = fs::rename(&probe, &file.temp);
    if result.is_err() {
        let _ = fs::remove_file(&probe);
    }
    result.map(|()| false)
}

/// Moves a rewrite or original into an empty path, refusing a concurrent writer atomically.
#[cfg(target_os = "macos")]
pub(super) fn rename_into(from: &Path, to: &Path) -> io::Result<()> {
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
pub(super) fn rename_into(from: &Path, to: &Path) -> io::Result<()> {
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
pub(super) fn rename_into(_: &Path, _: &Path) -> io::Result<()> {
    // Without an exclusive rename, the probe fails before an original moves.
    Err(io::ErrorKind::Unsupported.into())
}

/// Puts a staged rewrite in its file's place: the file moved aside, checked unchanged, and the
/// rewrite placed where nothing may have appeared meanwhile. On failure, whether the file was
/// moved aside (and so needs putting back).
fn place(file: &Staged) -> Result<(), (String, bool)> {
    fs::rename(&file.full, &file.aside).map_err(|e| (format!("couldn't move it: {e}"), false))?;
    let unchanged = fs::read(&file.aside).is_ok_and(|bytes| hash(&bytes) == file.hash);
    if !unchanged {
        let why = "it changed while the files were being replaced";
        return Err((why.into(), true));
    }
    // Both ways refuse a file that took the place meanwhile.
    let placed = match file.hard_links {
        true => fs::hard_link(&file.temp, &file.full),
        false => rename_into(&file.temp, &file.full),
    };
    placed.map_err(|e| {
        let reason = match e.kind() {
            io::ErrorKind::AlreadyExists => {
                "it was written again while the files were being replaced".into()
            }
            _ => format!("couldn't write it: {e}"),
        };
        (reason, true)
    })
}

/// Undoes a `place` that failed after moving the file aside. Nothing in its place now is this
/// write's: the file from before goes back only where nothing is. Where a newer save took its
/// place, that stays; the text from before goes too when it's just what was checked.
fn undo_place(file: &Staged, kept: &impl Fn(&Staged) -> PathBuf) -> Result<(), String> {
    let Err(undo) = restore(file, kept) else {
        return Ok(());
    };
    let taken = fs::symlink_metadata(&file.full).is_ok();
    if taken && fs::read(&file.aside).is_ok_and(|bytes| hash(&bytes) == file.hash) {
        let _ = fs::remove_file(&file.aside);
        return Ok(());
    }
    Err(undo)
}

/// Puts back a file `place` placed: its rewrite (if still as written) goes, and the file from
/// before comes back. What's in its place is moved off first and checked there, so a save that
/// lands meanwhile is never deleted: when something else is in its place, both stay, and the
/// reason says where the text from before is.
pub(super) fn put_back(file: &Staged, kept: &impl Fn(&Staged) -> PathBuf) -> Result<(), String> {
    let changed = || {
        format!(
            "it changed while the files were being replaced; its text from before is in {}",
            kept(file).display()
        )
    };
    let off = &file.undone;
    match fs::rename(&file.full, off) {
        Ok(()) if fs::read(off).is_ok_and(|bytes| hash(&bytes) == file.new_hash) => {
            let _ = fs::remove_file(off);
        }
        // Someone else's save: it goes back where it was, unless yet another took the place.
        Ok(()) => {
            return Err(match rename_into(off, &file.full) {
                Ok(()) => changed(),
                Err(_) => format!("{}; a newer save of it is in {}", changed(), off.display()),
            });
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("couldn't undo it: {e}")),
    }
    restore(file, kept)
}

/// Moves a file moved aside back into its place, refusing anything that took the place.
fn restore(file: &Staged, kept: &impl Fn(&Staged) -> PathBuf) -> Result<(), String> {
    let restored = match file.hard_links {
        true => fs::hard_link(&file.aside, &file.full).and_then(|()| fs::remove_file(&file.aside)),
        false => rename_into(&file.aside, &file.full),
    };
    restored.map_err(|e| {
        let kept = kept(file);
        format!(
            "couldn't undo it ({e}); its text from before is in {}",
            kept.display()
        )
    })
}

/// Where a file's text from before stays when it can't go back: moved into `keep` (the session's
/// folder, so delete takes it [D35]), else beside it.
// shortcut: when the session's own folder can't take the copy, it stays beside the file, named in
// the reason but recorded nowhere, as no record could be written there either.
pub(super) fn keep_aside(file: &Staged, keep: Option<&Path>) -> PathBuf {
    let Some(keep) = keep else {
        return file.aside.clone();
    };
    let name = file.full.file_name().unwrap_or_default().to_string_lossy();
    let to = keep.join(format!("{}-{name}", crate::adapters::uuid()));
    let moved = fs::create_dir_all(keep)
        .and_then(|()| fs::copy(&file.aside, &to))
        .and_then(|_| fs::remove_file(&file.aside));
    match moved {
        Ok(()) => to,
        Err(_) => {
            let _ = fs::remove_file(&to);
            file.aside.clone()
        }
    }
}

/// The checkout file at `path`, refused unless it's a plain file there: a listed link isn't
/// followed into a write to its target.
fn checkout_file(checkout: &Checkout, path: &str) -> Result<PathBuf, String> {
    let outside = || "it is not a file in the checkout".to_owned();
    let full = super::inside(checkout, path).map_err(|_| outside())?;
    // No link on the way either: resolved, it's the same path.
    match fs::canonicalize(&full) {
        Ok(real) if real == full && real.is_file() => Ok(full),
        _ => Err(outside()),
    }
}

/// A new hidden name beside `path` that no one else will guess.
fn sibling(path: &Path, what: &str) -> PathBuf {
    let name = path.file_name().unwrap_or_default().to_string_lossy();
    path.with_file_name(format!(".{name}.{what}-{}", crate::adapters::uuid()))
}

/// Writes `bytes` to a new file beside `path`, with its permissions.
fn write_beside(path: &Path, bytes: &[u8]) -> io::Result<PathBuf> {
    let temp = sibling(path, "replace");
    // Exclusive creation refuses existing files and links, even if a name is guessed.
    let mut out = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp)?;
    let result = (|| {
        out.write_all(bytes)?;
        out.sync_all()?;
        fs::set_permissions(&temp, fs::metadata(path)?.permissions())
    })();
    match result {
        Ok(()) => Ok(temp),
        Err(e) => {
            let _ = fs::remove_file(&temp);
            Err(e)
        }
    }
}
