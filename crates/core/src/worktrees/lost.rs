//! What freeing a session's worktree deletes for good [D180, D1197]: `worktree remove --force`
//! takes its ignored files, and restore copies back only what the include rules select.

use super::{copy, git, live, read};
use crate::{Spec, load, projects, session, share};
use serde_json::{Value, json};
use std::collections::BTreeSet;
use std::fs;
use std::io;
use std::path::Path;

// shortcut: a fixed list of common build output (proposed); widen it when a tool's output is named as lost.
const BUILT: &[&str] = &[
    "node_modules",
    "target",
    "dist",
    "build",
    "out",
    ".next",
    ".nuxt",
    ".svelte-kit",
    ".turbo",
    ".parcel-cache",
    ".cache",
    "coverage",
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
    ".venv",
    "venv",
    ".gradle",
    ".DS_Store",
];

/// Whether `rel` is the same in both folders: a link to the same place, or a file with the same bytes.
fn same(a: &Path, b: &Path, rel: &str) -> bool {
    let (a, b) = (a.join(rel), b.join(rel));
    match (fs::symlink_metadata(&a), fs::symlink_metadata(&b)) {
        (Ok(x), Ok(y)) if x.is_symlink() && y.is_symlink() => fs::read_link(&a)
            .ok()
            .is_some_and(|l| fs::read_link(&b).ok() == Some(l)),
        (Ok(x), Ok(y)) if x.is_file() && y.is_file() && x.len() == y.len() => fs::read(&a)
            .ok()
            .is_some_and(|bytes| fs::read(&b).ok() == Some(bytes)),
        _ => false,
    }
}

/// The ignored files, one by one, in the worktree `dir`'s record holds, that freeing it deletes and
/// restore won't bring back: not common build output, and not a file the include rules copy back
/// that still matches its source. None when the worktree isn't there.
fn lost_in(dir: &Path, picks: &[String]) -> io::Result<Vec<String>> {
    let Some(owned) = read(dir)? else {
        return Ok(vec![]);
    };
    let Some(path) = live(&owned) else {
        return Ok(vec![]);
    };
    let repo = Path::new(&owned.repo);
    let ignored = [
        "ls-files",
        "-z",
        "--others",
        "--ignored",
        "--exclude-standard",
    ];
    let built = |rel: &str| rel.split('/').any(|part| BUILT.contains(&part));
    // A wholly ignored folder comes as one entry first, so build output isn't walked; any other
    // is listed again file by file.
    let mut left = vec![];
    for rel in git(path, &[&ignored[..], &["--directory"]].concat())?.split('\0') {
        if rel.is_empty() || built(rel.trim_end_matches('/')) {
            continue;
        }
        if !rel.ends_with('/') {
            left.push(rel.to_string());
            continue;
        }
        let inside = format!(":(literal){rel}");
        let files = git(path, &[&ignored[..], &["--", &inside]].concat())?;
        left.extend(
            (files.split('\0'))
                .filter(|f| !f.is_empty() && !built(f))
                .map(String::from),
        );
    }
    if left.is_empty() {
        return Ok(vec![]);
    }
    let copied: BTreeSet<String> = copy::selected(repo, picks)?.into_iter().collect();
    left.retain(|rel| !(copied.contains(rel) && same(repo, path, rel)));
    Ok(left)
}

/// What the confirm names before `ids` are archived or deleted together [D180, D185, D1080,
/// D1197]: once per folder the batch frees, which is each worktree whose every other user is
/// archived or goes with them. `ids`: the batch's sessions in it; `files` or the `error` that kept
/// them from being listed.
pub fn losses(data: &Path, ids: &[String]) -> Vec<Value> {
    let (mut seen, mut out) = (BTreeSet::new(), vec![]);
    for id in ids {
        let Ok(spec) = load(data, id) else { continue };
        let Some(holder) = share::holder(data, &spec) else {
            continue;
        };
        if !seen.insert(holder.id.clone()) {
            continue;
        }
        let users: Vec<Spec> = share::in_folder(data, Path::new(&spec.cwd), None);
        let gone = |u: &Spec| ids.contains(&u.id) || session::lifecycle(&u.dir).0.is_some();
        if !users.iter().all(gone) {
            continue;
        }
        let picks = (holder.project.as_deref())
            .and_then(|p| projects::get(data, p).ok())
            .map(|p| p.include)
            .unwrap_or_default();
        let ids: Vec<&String> = (users.iter().map(|u| &u.id))
            .filter(|u| ids.contains(u))
            .collect();
        match lost_in(&holder.dir, &picks) {
            Ok(files) if files.is_empty() => {}
            Ok(files) => out.push(json!({"ids": ids, "files": files})),
            Err(e) => out.push(json!({"ids": ids, "error": e.to_string()})),
        }
    }
    out
}
