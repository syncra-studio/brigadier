//! The hand-off's text helpers: a section's start, end and lines within its most, and git's word.

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

/// A git command's output in the session's folder; empty outside a repository.
pub(super) fn git(cwd: &str, args: &[&str]) -> String {
    let out = Command::new("git").arg("-C").arg(cwd).args(args).output();
    out.ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim_end().to_string())
        .unwrap_or_default()
}
