//! An archived worktree's permissions, which its branch can't keep: taken as it's freed and put
//! back as it's restored, so no file comes back more open than it was [D26].

use super::{GIT_SECS, command};
use crate::adapters::setup;
use crate::rewind::modes::{Modes, again, stand_out};
use crate::write_atomic;
use std::io;
use std::path::Path;
use std::{fs, str};

pub(super) const FILE: &str = "worktree-modes.json";
/// The same while a restore puts them back: one cut short hasn't set them all.
const BACK: &str = "worktree-modes.back.json";

fn gone(e: io::Error) -> io::Result<()> {
    match e.kind() {
        io::ErrorKind::NotFound => Ok(()),
        _ => Err(e),
    }
}

/// The index's entries, each its mode, its file and its path. One that isn't UTF-8 is left out.
fn entries(path: &Path) -> io::Result<Vec<String>> {
    let mut list = command(path);
    list.args(["ls-files", "-s", "-z"]);
    let out = setup::run(&mut list, GIT_SECS).map_err(io::Error::other)?;
    if !out.status.success() {
        return super::err(String::from_utf8_lossy(&out.stderr).trim().into());
    }
    let all = out.stdout.split(|b| *b == 0);
    Ok(all
        .filter_map(|e| str::from_utf8(e).ok().map(String::from))
        .collect())
}

/// Keeps the permissions of the worktree at `path`, everything in its index.
pub(super) fn keep(dir: &Path, path: &Path) -> io::Result<()> {
    if dir.join(BACK).exists() {
        return fs::rename(dir.join(BACK), dir.join(FILE));
    }
    let all = stand_out(path, &entries(path)?);
    match all.is_empty() {
        true => fs::remove_file(dir.join(FILE)).or_else(gone),
        false => write_atomic(&dir.join(FILE), &serde_json::to_vec(&all)?),
    }
}

/// Said before anything is put back.
pub(super) fn begin(dir: &Path) -> io::Result<()> {
    fs::rename(dir.join(FILE), dir.join(BACK)).or_else(gone)
}

/// Sets what was kept on the worktree at `path`, just put back. What wasn't kept is as git gives it.
pub(super) fn put(dir: &Path, path: &Path) -> io::Result<()> {
    let bytes = match fs::read(dir.join(BACK)) {
        Err(e) => return gone(e),
        Ok(bytes) => bytes,
    };
    let all: Modes = serde_json::from_slice(&bytes)?;
    again(path, &entries(path)?, &all)?;
    fs::remove_file(dir.join(BACK))
}
