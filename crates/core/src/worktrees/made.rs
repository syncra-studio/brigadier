//! Which branch a create made [D35]: its name is recorded before git makes it, so a create cut
//! short in between is undone in full, and git makes it only if it isn't there, its reflog line a
//! token of this create's own, for undo to know it by and leave any other branch of that name.

use super::{err, git};
use std::io;
use std::path::Path;

/// A token git keeps as written (it folds whitespace in a reflog line), unique to one create.
pub(super) fn token() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    format!("brigadier:made:{nanos:x}.{:x}", std::process::id())
}

/// Makes `branch` at `commit`, refused if it's already there, its reflog line `token`.
pub(super) fn make(repo: &Path, branch: &str, commit: &str, token: &str) -> io::Result<()> {
    let full = format!("refs/heads/{branch}");
    let args = [
        "update-ref",
        "--create-reflog",
        "-m",
        token,
        &full,
        commit,
        "",
    ];
    git(repo, &args).map(drop)
}

/// Whether the create that recorded `made` made `branch`: its newest reflog line is that token
/// (a failed create's branch never moves; an attempt cut short may have left an older line). No
/// `made`: an older build's record, which named its branch only once made. No line to tell by (a
/// reflog unread or expired) is an error, so the record stays for the next sweep.
pub(super) fn ours(repo: &Path, branch: &str, made: Option<&str>) -> io::Result<bool> {
    let Some(made) = made else {
        return Ok(true);
    };
    let at = format!("refs/heads/{branch}");
    let log = ["reflog", "show", "--no-show-signature", "--format=%gs", &at];
    match git(repo, &log)?.lines().next() {
        Some(newest) => Ok(newest == made),
        None => err(format!(
            "Brigadier couldn't tell whether it made the branch {branch}."
        )),
    }
}
