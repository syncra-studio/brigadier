//! What freeing a session's worktree deletes for good [D180, D1197]: `worktree remove --force`
//! takes its ignored files, and restore copies back only what the include rules select.

use super::{copy, git, live, read};
use crate::{Spec, load, projects, session, share};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeSet;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

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

/// Those a build or an install makes again by itself, which a finished worker's worktree loses. The
/// rest may hold something made or put there by hand: a release in `dist`, a package in `.venv`.
const REBUILT: &[&str] = &[
    "node_modules",
    "target",
    ".next",
    ".nuxt",
    ".svelte-kit",
    ".turbo",
    ".parcel-cache",
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
    ".gradle",
];

/// Whether `dir` holds a repository below it, not in `skip`, whose work git doesn't list from
/// outside. A folder that can't be read counts as one.
pub fn repo_inside(dir: &Path, skip: &[PathBuf]) -> bool {
    let mut stack = vec![dir.to_path_buf()];
    while let Some(next) = stack.pop() {
        let entries = match fs::read_dir(&next) {
            Ok(entries) => entries,
            Err(e) if e.kind() == io::ErrorKind::NotFound => continue,
            Err(_) => return true,
        };
        // A bare one has no `.git`.
        if next.join("HEAD").is_file() && next.join("objects").is_dir() {
            return true;
        }
        for entry in entries {
            let Ok(entry) = entry else { return true };
            let path = entry.path();
            if skip.contains(&path) {
                continue;
            }
            if entry.file_name() == ".git" {
                return true;
            }
            if entry.file_type().map_or(true, |t| t.is_dir()) {
                stack.push(path);
            }
        }
    }
    false
}

/// The rebuildable build output in `dir`'s worktree: folders git ignores and tracks nothing in, none
/// holding a repository, none behind a link, and none the include rules copied in, which nothing
/// would copy again.
pub fn rebuilt(dir: &Path, picks: &[String]) -> io::Result<Vec<PathBuf>> {
    let Some(owned) = read(dir)? else {
        return Ok(vec![]);
    };
    let Some(path) = live(&owned) else {
        return Ok(vec![]);
    };
    let ignored = git(
        path,
        &[
            "ls-files",
            "-z",
            "--others",
            "--ignored",
            "--exclude-standard",
            "--directory",
        ],
    )?;
    let mut found: Vec<&str> = (ignored.split('\0'))
        // A link has no slash of its own at its end.
        .filter_map(|rel| rel.strip_suffix('/'))
        .filter(|rel| rel.rsplit('/').next().is_some_and(|n| REBUILT.contains(&n)))
        .filter(|rel| !repo_inside(&path.join(rel), &[]))
        .collect();
    if !found.is_empty() {
        let copied = copy::selected(Path::new(&owned.repo), picks)?;
        found.retain(|rel| !copied.iter().any(|c| Path::new(c).starts_with(rel)));
    }
    let top = fs::canonicalize(path)?;
    Ok((found.into_iter().map(|rel| path.join(rel)))
        .filter(|p| !p.is_symlink() && fs::canonicalize(p).is_ok_and(|p| p.starts_with(&top)))
        .collect())
}

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

/// The tracked files git is told not to look at (assume-unchanged, skip-worktree) that hold an edit:
/// neither its status nor a checkpoint has it.
fn hidden(path: &Path) -> io::Result<Vec<String>> {
    let all = git(path, &["ls-files", "-v", "-z"])?;
    Ok((all.split('\0').filter_map(|line| line.split_once(' ')))
        .filter(|(tag, _)| *tag == "S" || tag.chars().all(char::is_lowercase))
        .map(|(_, rel)| rel)
        .filter(|rel| path.join(rel).symlink_metadata().is_ok())
        .filter(|rel| {
            let literal = format!(":(literal){rel}");
            let kept = git(path, &["ls-files", "-s", "-z", "--", &literal]);
            let now = git(path, &["hash-object", "--", rel]);
            !matches!((kept, now), (Ok(k), Ok(n)) if k.split(' ').nth(1) == Some(n.as_str()))
        })
        .map(String::from)
        .collect())
}

/// What freeing a worktree may take beyond what is made again; its record, so one cut short keeps to it.
#[derive(Clone, Copy, PartialEq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Guard {
    /// What the archive's confirm names, and what git holds: no repository inside.
    Named,
    /// Nothing: nobody was asked.
    Lossless,
}

/// Whether `guard` lets `dir`'s worktree be freed; one that can't be told stays.
pub fn may_go(dir: &Path, picks: &[String], guard: Guard) -> bool {
    match guard {
        Guard::Named => keeps_none(dir, picks, false).unwrap_or(false),
        Guard::Lossless => keeps_none(dir, picks, true).unwrap_or(false),
    }
}

/// Whether the worktree holds no repository, whose work git here doesn't see, and, `all`, nothing
/// else freeing it loses that isn't made again: stricter than the confirm's list, which the user
/// reads, as `dist` may hold a release.
fn keeps_none(dir: &Path, picks: &[String], all: bool) -> io::Result<bool> {
    let Some(path) = read(dir)?.and_then(|o| live(&o).map(Path::to_path_buf)) else {
        return Ok(true);
    };
    let mut made = rebuilt(dir, picks)?;
    let again = |rel: &str| {
        let at = path.join(rel);
        at.ends_with(".DS_Store") || made.iter().any(|m| at.starts_with(m))
    };
    if all && !lost_in(dir, picks, &again)?.is_empty() {
        return Ok(false);
    }
    made.push(path.join(".git"));
    Ok(!repo_inside(&path, &made))
}

/// Common build output, which the confirm doesn't name.
fn built(rel: &str) -> bool {
    rel.split('/').any(|part| BUILT.contains(&part))
}

/// The files, one by one, in the worktree `dir`'s record holds, that freeing it deletes and restore
/// won't bring back: edits hidden from git, and ignored files but what is `built` and what the
/// include rules copy back that still matches its source. None when the worktree isn't there.
fn lost_in(dir: &Path, picks: &[String], built: &dyn Fn(&str) -> bool) -> io::Result<Vec<String>> {
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
    if !left.is_empty() {
        let copied: BTreeSet<String> = copy::selected(repo, picks)?.into_iter().collect();
        left.retain(|rel| !(copied.contains(rel) && same(repo, path, rel)));
    }
    left.extend(hidden(path)?);
    Ok(left)
}

/// What the confirm names before `ids` are archived, or deleted, together [D180, D185, D1080,
/// D1197]: once per folder the batch frees, which is each worktree whose every other user is
/// archived or goes with them, but one a repository keeps until its last user's delete. `ids`: the
/// batch's sessions in it; `files` or the `error` that kept them from being listed.
pub fn losses(data: &Path, ids: &[String], delete: bool) -> Vec<Value> {
    let (mut seen, mut out) = (BTreeSet::new(), vec![]);
    for id in ids {
        let Ok(spec) = load(data, id) else { continue };
        let may = session::guarded(&spec, Guard::Named);
        // A folder chat's claims, each its own worktree, named by repo [D494].
        for (name, rec) in crate::folder::claims(&spec.dir) {
            match lost_in(&rec, &[], &built) {
                Ok(files) if files.is_empty() || !(delete || may(&rec)) => {}
                Ok(files) => {
                    let files: Vec<String> = files.iter().map(|f| format!("{name}/{f}")).collect();
                    out.push(json!({"ids": [id], "files": files}));
                }
                Err(e) => out.push(json!({"ids": [id], "error": e.to_string()})),
            }
        }
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
        let goes = (delete && users.iter().all(|u| ids.contains(&u.id))) || may(&holder.dir);
        let ids: Vec<&String> = (users.iter().map(|u| &u.id))
            .filter(|u| ids.contains(u))
            .collect();
        match lost_in(&holder.dir, &picks, &built) {
            Ok(files) if files.is_empty() || !goes => {}
            Ok(files) => out.push(json!({"ids": ids, "files": files})),
            Err(e) => out.push(json!({"ids": ids, "error": e.to_string()})),
        }
    }
    out
}
