//! What the Files tree shows of a checkout [D1002]: the files git lists, what it ignores, each
//! changed file's mark and each folder's most severe one, an ignored folder's contents read from
//! disk, and the filename search. Rust works them out; the UI only draws them [D65, D71].

use super::{Checkout, err, inside, lock, read, status};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::sync::atomic::AtomicBool;

/// The tree lists this many files, as the old app did; the filename search finds the rest.
const LISTED: usize = 20_000;
/// The filename search's best this many.
const FOUND: usize = 100;

fn names(out: &[u8]) -> Vec<String> {
    (out.split(|b| *b == 0))
        .filter(|name| !name.is_empty())
        .map(|name| String::from_utf8_lossy(name).into_owned())
        .collect()
}

/// Every file git lists, tracked and untracked but not ignored, in order and each once (a
/// conflicted file is listed once per stage).
pub(super) fn listed(checkout: &Checkout, stop: &AtomicBool) -> io::Result<Vec<String>> {
    let args = [
        "ls-files",
        "--cached",
        "--others",
        "--exclude-standard",
        "-z",
    ];
    let mut files = names(&read(&checkout.root, &args, stop)?);
    files.sort_unstable();
    files.dedup();
    Ok(files)
}

/// Which change a folder holding several shows: the one most in need of a look (the old app's).
fn severity(status: &str) -> u8 {
    match status {
        "conflicted" => 5,
        "deleted" => 4,
        "modified" | "typeChanged" => 3,
        "renamed" | "copied" => 2,
        _ => 1,
    }
}

/// The tree's listing: `{files, truncated, ignored, marks: {files, folders}}`. An ignored folder
/// ends in `/`. A file's mark is its unstaged change, else its staged one.
pub fn list(checkout: &Checkout, stop: &AtomicBool) -> io::Result<Value> {
    let status = status(checkout, stop)?;
    let _shared = lock(checkout, false, stop)?;
    let mut files = listed(checkout, stop)?;
    let truncated = files.len() > LISTED;
    files.truncate(LISTED);
    let args = [
        "ls-files",
        "--others",
        "--ignored",
        "--exclude-standard",
        "--directory",
        "-z",
    ];
    let ignored = names(&read(&checkout.root, &args, stop)?);
    let (mut marks, mut folders) = (BTreeMap::new(), BTreeMap::<String, &str>::new());
    for entry in status.files.values() {
        let (Some(path), Some(mark)) = (
            entry["path"].as_str(),
            entry["changes"].as_str().or(entry["staged"].as_str()),
        ) else {
            continue;
        };
        marks.insert(path, mark);
        let mut folder = path;
        while let Some((up, _)) = folder.rsplit_once('/') {
            folder = up;
            let held = folders.entry(up.to_string()).or_insert(mark);
            if severity(mark) > severity(held) {
                *held = mark;
            }
        }
    }
    Ok(
        json!({"files": files, "truncated": truncated, "ignored": ignored,
              "marks": {"files": marks, "folders": folders}}),
    )
}

/// An ignored folder's entries as they are on disk, read when the tree opens it.
pub fn folder(checkout: &Checkout, rel: &str) -> io::Result<Value> {
    let dir = inside(checkout, rel)?;
    if !fs::symlink_metadata(&dir)?.is_dir() {
        return err(format!("{rel} is not a folder"));
    }
    let mut entries = vec![];
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name != ".git" {
            entries.push(json!({"name": name, "folder": entry.file_type()?.is_dir()}));
        }
    }
    Ok(Value::Array(entries))
}

/// Whether git ignores `rel`: an ignored file's tab isn't read again by the watch, which leaves
/// ignored files out, so the viewer looks again itself.
pub fn ignored(checkout: &Checkout, rel: &str) -> bool {
    let never = AtomicBool::new(false);
    // Not `check-ignore`, which refuses the literal paths `read` asks for.
    let args = [
        "ls-files",
        "--others",
        "--ignored",
        "--exclude-standard",
        "-z",
        "--",
        rel,
    ];
    read(&checkout.root, &args, &never).is_ok_and(|out| !out.is_empty())
}

/// How `text` holds `query`, as the composer's menus match (best first): its start, inside it, or
/// its letters in order. None when it doesn't.
fn rank(text: &str, query: &str) -> Option<u8> {
    let text = text.to_lowercase();
    if text.starts_with(query) {
        return Some(0);
    }
    if text.contains(query) {
        return Some(1);
    }
    let mut letters = text.chars();
    query
        .chars()
        .all(|want| letters.any(|c| c == want))
        .then_some(2)
}

/// The filename search over every listed file, not only the tree's first ones: those whose name
/// (first) or path holds `query`, best first, then shortest.
pub fn find(checkout: &Checkout, query: &str, stop: &AtomicBool) -> io::Result<Value> {
    let query = query.to_lowercase();
    let _shared = lock(checkout, false, stop)?;
    let mut found: Vec<(u8, String)> = (listed(checkout, stop)?.into_iter())
        .filter_map(|path| {
            let name = path.rsplit('/').next().unwrap_or(&path);
            let by_name = rank(name, &query);
            let best = by_name.or_else(|| rank(&path, &query).map(|r| r + 3))?;
            Some((best, path))
        })
        .collect();
    found.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.len().cmp(&b.1.len())));
    found.truncate(FOUND);
    Ok(json!(found.into_iter().map(|(_, p)| p).collect::<Vec<_>>()))
}
