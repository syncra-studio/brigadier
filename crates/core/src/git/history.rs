//! A session's commits since its base, and one commit's diff, from git alone [D1035, D1041]: what
//! the History tab and Source's History menu list, and what a commit's Review tab draws. Rust reads
//! and parses; the UI writes the words [D65, D71].

use super::diff::{LARGE_LINES, side};
use super::{Checkout, err, lock, read};
use crate::worktrees;
use serde_json::{Value, json};
use std::io;
use std::path::Path;
use std::sync::atomic::AtomicBool;

/// The session's commits since its base, newest first, each its full id, subject, time and counts.
/// First parent only (proposed), so catching up with the base is one merge row, not the base's
/// commits. `dir` is the session's folder, where its base is recorded. None without a base: a Local checkout or a project chat [D1041, D1111].
// shortcut: a base branch deleted since the session began fails the read; fall back to the
// recorded base commit if that shows up.
pub fn history(checkout: &Checkout, dir: &Path, stop: &AtomicBool) -> io::Result<Value> {
    let Some(base) = worktrees::base(dir) else {
        return Ok(json!({"base": null, "commits": []}));
    };
    let _shared = lock(checkout, false, stop)?;
    let range = format!("{base}..HEAD");
    let out = read(
        &checkout.root,
        &[
            "log",
            "--first-parent",
            "--numstat",
            "--format=%x1e%H%x1f%ct%x1f%s",
            &range,
            "--",
        ],
        stop,
    )?;
    let text = String::from_utf8_lossy(&out);
    let mut commits = vec![];
    for record in text.split('\x1e').filter(|r| !r.is_empty()) {
        let mut lines = record.lines();
        let head: Vec<&str> = lines.next().unwrap_or("").splitn(3, '\x1f').collect();
        let [sha, at, subject] = head[..] else {
            return err(format!("unexpected git log record {record:?}"));
        };
        let (mut added, mut removed) = (0u64, 0u64);
        for line in lines {
            let mut counts = line.split('\t').map(|n| n.parse::<u64>().unwrap_or(0));
            added += counts.next().unwrap_or(0);
            removed += counts.next().unwrap_or(0);
        }
        let at_ms = at.parse::<u64>().unwrap_or(0) * 1000;
        commits.push(json!({"sha": sha, "subject": subject, "atMs": at_ms, "added": added, "removed": removed}));
    }
    Ok(json!({"base": base, "commits": commits}))
}

/// `sha` as the commit it names, refused unless it's a full id of a commit in this repository: any
/// commit of the session's, not only those still since its base, so an open tab stays readable.
fn commit_of(checkout: &Checkout, sha: &str, stop: &AtomicBool) -> io::Result<()> {
    let hex = matches!(sha.len(), 40 | 64)
        && sha
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase());
    let found = hex
        && read(
            &checkout.root,
            &[
                "rev-parse",
                "--verify",
                "--quiet",
                &format!("{sha}^{{commit}}"),
            ],
            stop,
        )
        .is_ok_and(|out| out.trim_ascii() == sha.as_bytes());
    if found {
        Ok(())
    } else {
        err(format!("no commit {sha} in this checkout"))
    }
}

/// The commit's first parent, or the empty tree for a first commit, so both diff the same way.
fn parent(checkout: &Checkout, sha: &str, stop: &AtomicBool) -> io::Result<String> {
    let out = read(&checkout.root, &["rev-list", "--parents", "-n1", sha], stop)?;
    let text = String::from_utf8_lossy(&out);
    match text.split_whitespace().nth(1) {
        Some(first) => Ok(first.to_string()),
        None => {
            let empty = read(
                &checkout.root,
                &["hash-object", "-t", "tree", "/dev/null"],
                stop,
            )?;
            Ok(String::from_utf8_lossy(&empty).trim().to_string())
        }
    }
}

/// One changed file of a commit, as the Review tab lists it.
struct Change {
    path: String,
    from: Option<String>,
    status: &'static str,
    added: u64,
    removed: u64,
    binary: bool,
}

fn changes(
    checkout: &Checkout,
    parent: &str,
    sha: &str,
    stop: &AtomicBool,
) -> io::Result<Vec<Change>> {
    let diff = |how: &str| {
        read(
            &checkout.root,
            &["diff-tree", "-r", "-z", "-M", how, parent, sha, "--"],
            stop,
        )
    };
    let (names, counts) = (diff("--name-status")?, diff("--numstat")?);
    let bad = || io::Error::other("unexpected git diff-tree output");
    let mut list = vec![];
    let mut names = names
        .split(|b| *b == 0)
        .map(|s| String::from_utf8_lossy(s).into_owned());
    while let Some(code) = names.next().filter(|c| !c.is_empty()) {
        let first = names.next().ok_or_else(bad)?;
        let (status, from, path) = match code.as_bytes()[0] {
            b'R' => ("renamed", Some(first), names.next().ok_or_else(bad)?),
            b'C' => ("copied", Some(first), names.next().ok_or_else(bad)?),
            b'A' => ("added", None, first),
            b'D' => ("deleted", None, first),
            b'T' => ("typeChanged", None, first),
            _ => ("modified", None, first),
        };
        list.push(Change {
            path,
            from,
            status,
            added: 0,
            removed: 0,
            binary: false,
        });
    }
    // `--numstat -z`: "a\tr\tpath\0", or "a\tr\t\0old\0new\0" for a rename, in the same order.
    let mut counts = counts
        .split(|b| *b == 0)
        .map(|s| String::from_utf8_lossy(s).into_owned());
    for change in &mut list {
        let line = counts.next().ok_or_else(bad)?;
        let mut parts = line.splitn(3, '\t');
        let (a, r) = (parts.next().unwrap_or("-"), parts.next().unwrap_or("-"));
        if parts.next() == Some("") {
            counts.next();
            counts.next();
        }
        change.binary = a == "-";
        change.added = a.parse().unwrap_or(0);
        change.removed = r.parse().unwrap_or(0);
    }
    Ok(list)
}

/// A commit's diff as the Review tab takes it: its subject, then its files with counts; their
/// contents come one by one, through `contents` [D1035, D1036, D1041].
pub fn commit(checkout: &Checkout, sha: &str, stop: &AtomicBool) -> io::Result<Value> {
    let _shared = lock(checkout, false, stop)?;
    commit_of(checkout, sha, stop)?;
    let head = read(
        &checkout.root,
        &["show", "-s", "--format=%ct%x1f%s", sha],
        stop,
    )?;
    let head = String::from_utf8_lossy(&head);
    let (at, subject) = head.trim_end().split_once('\x1f').unwrap_or(("0", ""));
    let parent = parent(checkout, sha, stop)?;
    let list = changes(checkout, &parent, sha, stop)?;
    let files: Vec<Value> = (list.iter())
        .map(|c| {
            json!({"path": c.path, "from": c.from, "status": c.status, "insertions": c.added,
                "deletions": c.removed, "binary": c.binary, "staged": false,
                "large": c.added + c.removed > LARGE_LINES})
        })
        .collect();
    Ok(json!({
        "scope": "commit", "base": null,
        "commit": {"sha": sha, "subject": subject, "atMs": at.parse::<u64>().unwrap_or(0) * 1000},
        "insertions": list.iter().map(|c| c.added).sum::<u64>(),
        "deletions": list.iter().map(|c| c.removed).sum::<u64>(),
        "files": files,
    }))
}

/// One of the commit's files whole on both sides, an absent side (added, deleted) empty; no hunks,
/// as a commit has no actions [D1041]. `from` is a rename's old path, from the list. Each file is
/// read alone, so a wide commit isn't diffed again per file.
pub fn contents(
    checkout: &Checkout,
    sha: &str,
    path: &str,
    from: Option<&str>,
    stop: &AtomicBool,
) -> io::Result<Value> {
    let _shared = lock(checkout, false, stop)?;
    commit_of(checkout, sha, stop)?;
    let parent = parent(checkout, sha, stop)?;
    // A side git doesn't hold (an added or deleted file) is empty; one too big says why, as Review's do.
    let before = side(
        checkout,
        Some(format!("{parent}:{}", from.unwrap_or(path))),
        path,
        stop,
    )?;
    let after = side(checkout, Some(format!("{sha}:{path}")), path, stop)?;
    let (before, after) = match (before, after) {
        (Ok(before), Ok(after)) => (before, after),
        (Err(why), _) | (_, Err(why)) => return Ok(json!({"error": why})),
    };
    Ok(json!({"before": before, "after": after, "hunks": []}))
}

/// Where the session's branch left `base`, the commit Branch since base starts from [D1035].
pub fn since(checkout: &Checkout, base: &str, stop: &AtomicBool) -> io::Result<String> {
    let out = read(&checkout.root, &["merge-base", base, "HEAD"], stop)?;
    Ok(String::from_utf8_lossy(&out).trim().to_string())
}
