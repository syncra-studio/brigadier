//! Replace all's record of a run under way, and putting right a run cut short [D1173].

use super::replace::{Staged, keep_aside, put_back, rename_into};
use super::search::hash;
use super::{Checkout, Target, lock};
use serde::{Deserialize, Serialize};
use std::fs;
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
    let never = AtomicBool::new(false);
    for path in records {
        let Some(run) = read(&path) else { continue };
        let checkout = Checkout {
            root: run.root,
            git_dir: run.git_dir,
        };
        // A run still going from the CLI holds it, and settles or removes its record itself.
        if let Ok(_exclusive) = lock(&checkout, true, &never) {
            settle(&path);
        }
    }
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
        let kept = |f: &Staged| match fs::symlink_metadata(&f.full).is_ok() {
            true => keep_aside(f, run.keep.as_deref()),
            false => f.aside.clone(),
        };
        if let Err(why) = recover(file, run.placed, &kept) {
            eprintln!("brigadier: replace {}: {why}", file.full.display());
        }
    }
    let gone = |p: &Path| fs::symlink_metadata(p).is_err();
    run.files.retain(|f| gone(&f.full) && !gone(&f.aside));
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
fn recover(file: &Staged, placed: bool, kept: &impl Fn(&Staged) -> PathBuf) -> Result<(), String> {
    let _ = fs::remove_file(&file.temp);
    // A rollback cut short while it checked what was in the file's place: that comes back first.
    if fs::symlink_metadata(&file.undone).is_ok() {
        if fs::read(&file.undone).is_ok_and(|bytes| hash(&bytes) == file.new_hash) {
            let _ = fs::remove_file(&file.undone);
        } else if rename_into(&file.undone, &file.full).is_err() {
            let undone = file.undone.display();
            return Err(format!("a newer save of it is in {undone}"));
        }
    }
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
            kept(file).display()
        )),
    }
}
