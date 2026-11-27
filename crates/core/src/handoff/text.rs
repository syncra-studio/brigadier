//! The hand-off's text helpers: a section's start, end and lines within its most, and git's word.

use std::path::Path;
use std::process::Command;

/// The first `max` characters, on a character boundary, marked where cut.
pub(super) fn head(s: &str, max: usize) -> String {
    match s.char_indices().nth(max) {
        Some((at, _)) => format!("{}…", &s[..at]),
        None => s.to_string(),
    }
}

/// The last `max` bytes, on a character boundary.
pub(super) fn tail(s: &str, max: usize) -> &str {
    let mut at = s.len().saturating_sub(max);
    while !s.is_char_boundary(at) {
        at += 1;
    }
    &s[at..]
}

/// Lines added while they fit `max`; a last line says how many didn't.
pub(super) fn fill(lines: impl IntoIterator<Item = String>, max: usize, more: &str) -> String {
    let (mut out, mut left) = (String::new(), 0);
    for line in lines {
        if left > 0 || out.len() + line.len() > max {
            left += 1;
        } else {
            out += &line;
        }
    }
    if left > 0 {
        out += &format!("({left} more: {more})\n");
    }
    out
}

/// The most one git call of the hand-off or its check may take: a renewal never waits on it.
pub(super) const GIT_SECS: u64 = 5;

/// Git in the session's folder as the hand-off asks it: no network (a partial clone's missing
/// object isn't fetched), no prompt, no hook, no file monitor, no lock taken.
pub(super) fn git_in(cwd: &str) -> Command {
    let mut command = crate::worktrees::command(Path::new(cwd));
    command
        .args(["-c", "core.fsmonitor=false"])
        .env("GIT_NO_LAZY_FETCH", "1")
        .env("GIT_OPTIONAL_LOCKS", "0");
    command
}

/// A git command's output in the session's folder; empty outside a repository.
pub(super) fn git(cwd: &str, args: &[&str]) -> String {
    let out = Command::new("git").arg("-C").arg(cwd).args(args).output();
    out.ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim_end().to_string())
        .unwrap_or_default()
}
