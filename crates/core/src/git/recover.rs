//! Replace all's record of a run under way, and putting right a run cut short [D1173].

use super::replace::{Staged, keep_copy, put_back, rename_into};
use super::search::hash;
use super::{Checkout, Target, lock};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;

/// Where a Replace all under way keeps its record: the session's folder, or the project's in the
/// app's data.
pub fn record(data: &Path, target: &Target) -> PathBuf {
    match target {
        Target::Session(id) => crate::session_dir(data, id).join(RECORD),
        Target::Project(id) => data.join("projects").join(id).join(RECORD),
    }
}

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

pub(super) const LEFT: &str =
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
pub(super) fn settle(path: &Path) -> bool {
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
