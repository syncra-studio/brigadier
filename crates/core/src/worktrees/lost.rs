//! What freeing a session's worktree deletes for good [D180, D1197]: `worktree remove --force`
//! takes its ignored files, and restore copies back only what the include rules select.

pub use super::inner::repo_inside;
use super::{copy, git, inner, live, read};
use crate::{Spec, load, session, share};
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
                // A repository comes as a folder: no file of it is git's to list.
                .filter(|f| !f.is_empty() && !f.ends_with('/') && !built(f))
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
/// archived or goes with them, but one a repository keeps until its last user's delete, and a claim
/// another works in, which an archive keeps. `ids`: the batch's sessions in it; `files` or the
/// `error` that kept them from being listed. A delete's `repos`: each repository in a session's
/// folders, whose work goes whatever becomes of the branch.
pub fn losses(data: &Path, ids: &[String], delete: bool) -> Vec<Value> {
    let (mut seen, mut named, mut out) = (BTreeSet::new(), BTreeSet::new(), vec![]);
    // Read at once, then told in order: a folder two of them share is named once, by the first.
    for (id, claims, holder, mut found) in crate::at_once(ids, |id| one(data, ids, id, delete))
        .into_iter()
        .flatten()
    {
        out.extend(claims);
        if let Some((holder, walked)) = holder
            && seen.insert(holder)
            && let Some((line, repos)) = walked
        {
            out.extend(line);
            found.extend(repos);
        }
        let repos: Vec<String> = (found.into_iter())
            .filter(|(repo, _)| named.insert(repo.clone()))
            .map(|(_, rel)| rel)
            .collect();
        if !repos.is_empty() {
            out.push(json!({"ids": [id], "repos": repos}));
        }
    }
    out
}

/// Repositories found, each with its name as told.
type Repos = Vec<(PathBuf, String)>;
/// A shared folder's holder, and what it loses unless another of the batch named it first.
type Held = Option<(String, Option<(Option<Value>, Repos)>)>;

/// One of `ids`' losses: its claims' lines, its folder's holder's, and a delete's repositories, each
/// with its name as told.
fn one(
    data: &Path,
    ids: &[String],
    id: &String,
    delete: bool,
) -> Option<(String, Vec<Value>, Held, Repos)> {
    let spec = load(data, id).ok()?;
    let picks = session::picks(data, &spec);
    let may = session::guarded(&spec, Guard::Named);
    // Whether the folder `users` share goes. `alone`: only with them all.
    let goes = |users: &[Spec], rec: &Path, alone: bool| {
        let batch = |u: &Spec| ids.contains(&u.id);
        let gone = |u: &Spec| batch(u) || session::lifecycle(&u.dir).0.is_some();
        (delete && users.iter().all(batch))
            || (!(alone && !users.is_empty()) && users.iter().all(gone) && may(rec))
    };
    // Where the delete finds no repository: worktrees' own `.git`, and folders that stay.
    let folder_of = |rec: &Path| super::folder(rec).map(|f| share::key(&f));
    let (mut skip, roots, mut out) = (vec![], session::takes(&spec), vec![]);
    // A folder chat's claims, each its own worktree, named by repo [D494].
    for (name, rec) in crate::folder::claims(&spec.dir) {
        let Some(folder) = folder_of(&rec) else {
            continue;
        };
        if !goes(&share::in_folder(data, &folder, Some(id)), &rec, !delete) {
            skip.push(folder);
            continue;
        }
        skip.push(folder.join(".git"));
        match lost_in(&rec, &picks, &built) {
            Ok(files) if files.is_empty() => {}
            Ok(files) => {
                let files: Vec<String> = files.iter().map(|f| format!("{name}/{f}")).collect();
                out.push(json!({"ids": [id], "files": files}));
            }
            Err(e) => out.push(json!({"ids": [id], "error": e.to_string()})),
        }
    }
    let (dir, cwd) = (share::key(&spec.dir), share::key(Path::new(&spec.cwd)));
    let repos = |roots: &[PathBuf], skip: &[PathBuf]| -> Repos {
        if !delete {
            return vec![];
        }
        (roots.iter().filter_map(|r| fs::canonicalize(r).ok()))
            .flat_map(|root| inner::repos(&root, skip))
            .map(|repo| {
                let rel = repo.strip_prefix(&cwd).or(repo.strip_prefix(&dir));
                let rel = rel.unwrap_or(&repo).display().to_string();
                (repo, rel)
            })
            .collect()
    };
    let users = share::in_folder(data, Path::new(&spec.cwd), None);
    let mut held = None;
    if let Some(holder) = share::holder(data, &spec)
        && let Some(folder) = folder_of(&holder.dir)
    {
        match goes(&users, &holder.dir, false) {
            true => skip.push(folder.join(".git")),
            false => skip.push(folder.clone()),
        }
        let walked = (skip.last() != Some(&folder)).then(|| {
            let ids: Vec<&String> = (users.iter().map(|u| &u.id))
                .filter(|u| ids.contains(u))
                .collect();
            let line = match lost_in(&holder.dir, &picks, &built) {
                Ok(files) if files.is_empty() => None,
                Ok(files) => Some(json!({"ids": ids, "files": files})),
                Err(e) => Some(json!({"ids": ids, "error": e.to_string()})),
            };
            (line, repos(std::slice::from_ref(&folder), &skip))
        });
        held = Some((holder.id.clone(), walked));
    }
    Some((id.clone(), out, held, repos(&roots, &skip)))
}
