//! Sessions sharing one folder [D1070]: a "here" fork works in its source's folder, a worktree or
//! a Local checkout. Who else uses it, archived sessions too [D1080, D1089], who lands its work
//! [D1082], and the guard our own changes to it take so no other session's turn runs meanwhile.

use crate::rewind::{checkout_lock, turn_paths};
use crate::{Spec, fork, git, ids, load, worktrees};
use serde_json::{Value, json};
use std::fs::{self, File};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;

/// A folder as the same place: canonical while it exists, as recorded while it's freed.
pub fn key(folder: &Path) -> PathBuf {
    fs::canonicalize(folder).unwrap_or_else(|_| folder.into())
}

/// Every other session working in `folder`, archived ones too, oldest first.
pub fn in_folder(data: &Path, folder: &Path, except: Option<&str>) -> Vec<Spec> {
    let mine = key(folder);
    let mut all: Vec<Spec> = (ids(data).iter())
        .filter(|id| Some(id.as_str()) != except)
        .filter_map(|id| load(data, id).ok())
        .filter(|o| key(Path::new(&o.cwd)) == mine)
        .collect();
    all.sort_by(|a, b| (a.created, &a.id).cmp(&(b.created, &b.id)));
    all
}

pub fn others(data: &Path, spec: &Spec) -> Vec<Spec> {
    in_folder(data, Path::new(&spec.cwd), Some(&spec.id))
}

/// The session whose record holds `spec`'s folder as its worktree: its own, or another user's
/// [D263, D1080]. None in a Local checkout.
pub fn holder(data: &Path, spec: &Spec) -> Option<Spec> {
    if worktrees::made(&spec.dir) {
        return Some(spec.clone());
    }
    let folder = key(Path::new(&spec.cwd));
    others(data, spec).into_iter().find(|o| {
        worktrees::made(&o.dir) && worktrees::folder(&o.dir).is_some_and(|f| key(&f) == folder)
    })
}

/// The first session of a line of "here" forks; a session in no line is its own.
pub fn root(spec: &Spec) -> String {
    fork::record(&spec.dir)
        .filter(|r| r["where"] == "folder")
        .and_then(|r| r["root"].as_str().map(String::from))
        .unwrap_or_else(|| spec.id.clone())
}

/// Who lands the folder's work [D1082]: whoever holds its worktree's record, passed on when that
/// session is deleted; in a Local checkout, the oldest of `spec`'s line. Archived ones count.
pub fn owner<'a>(spec: &'a Spec, others: &'a [Spec]) -> &'a Spec {
    let line: Vec<&Spec> = (others.iter())
        .chain([spec])
        .filter(|s| root(s) == root(spec))
        .collect();
    let folder = key(Path::new(&spec.cwd));
    (line.iter())
        .find(|s| worktrees::folder(&s.dir).is_some_and(|f| key(&f) == folder))
        .or_else(|| line.iter().min_by_key(|s| (s.created, &s.id)))
        .copied()
        .unwrap_or(spec)
}

/// The session's name in a sentence.
pub fn title(spec: &Spec) -> String {
    fs::read_to_string(spec.dir.join("title"))
        .ok()
        .filter(|t| !t.trim().is_empty())
        .unwrap_or_else(|| "Another session".into())
}

/// Held through one of our own changes to a shared folder: each turn start holds the checkout
/// lock shared (`session::fence`), so none starts meanwhile, and none may be running now [D1082].
/// None where nobody else uses the folder. `busy` is the session's own test, with no lock of its
/// own: a start that passed its check holds the shared lock until its turn is logged [D172].
pub fn guard(
    data: &Path,
    folder: &Path,
    except: Option<&str>,
    busy: &dyn Fn(&Spec) -> bool,
) -> io::Result<Option<File>> {
    if in_folder(data, folder, except).is_empty() {
        return Ok(None);
    }
    let lock = checkout_lock(data, true)?;
    if let Some(o) = in_folder(data, folder, except).iter().find(|o| busy(o)) {
        return Err(io::Error::other(format!(
            "{} is working in this folder. Wait for its turn to end.",
            title(o)
        )));
    }
    Ok(Some(lock))
}

/// Who lands session `id`'s work instead of it (merge into base, a pull request): the folder's
/// owner's name where that's another session, else None [D1082]. One that can't be read lands its own.
pub fn lands(data: &Path, id: &str) -> Option<String> {
    let spec = load(data, id).ok()?;
    let others = others(data, &spec);
    let owner = owner(&spec, &others);
    (owner.id != spec.id).then(|| title(owner))
}

/// What Source shows of the sharing, by session id; the UI writes the words [D65, D1082]:
/// `with`, the owner where it's another; `busy`, another session working there now; `lands`;
/// `includes`, another session whose turns since the last commit changed files still uncommitted
/// (proposed: its turns that ended on today's HEAD).
pub fn state(data: &Path, spec: &Spec, busy: &dyn Fn(&Spec) -> bool) -> io::Result<Value> {
    let others = others(data, spec);
    let owner = owner(spec, &others);
    let working = others.iter().find(|o| busy(o)).map(|o| o.id.clone());
    let mut includes = None;
    if !others.is_empty()
        && let Ok(checkout) = git::checkout(data, &git::Target::Session(&spec.id))
    {
        let status = git::status(&checkout, &AtomicBool::new(false))?.json();
        let head = status["head"]["head"].as_str().map(String::from);
        let dirty: Vec<&str> = (status["files"].as_array().into_iter().flatten())
            .filter_map(|f| f["path"].as_str())
            .collect();
        includes = (others.iter())
            .find(|o| {
                turn_paths(o, head.as_deref())
                    .iter()
                    .any(|p| dirty.contains(&p.as_str()))
            })
            .map(|o| o.id.clone());
    }
    Ok(json!({"ok": true, "shared": !others.is_empty(),
        "with": (owner.id != spec.id).then(|| owner.id.clone()),
        "busy": working, "lands": owner.id == spec.id, "includes": includes}))
}
