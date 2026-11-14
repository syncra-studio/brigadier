//! Sessions sharing one folder [D1070]: a "here" fork works in its source's folder, a worktree or
//! a Local checkout. Who else uses it, archived sessions too [D1080, D1089], and who lands its work
//! [D1082].

use crate::projects::Project;
use crate::{Spec, fork, ids, load, worktrees};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

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

/// Refuses new session `spec` in its project's own folder while another unarchived session works
/// there: one Local checkout session at a time [D306].
pub fn one_local(data: &Path, project: Option<&Project>, spec: &Spec) -> io::Result<()> {
    let Some(folder) = project.map(|p| Path::new(&p.folder)) else {
        return Ok(());
    };
    if key(folder) != key(Path::new(&spec.cwd)) {
        return Ok(());
    }
    let mut others = in_folder(data, folder, Some(&spec.id)).into_iter();
    match others.find(|o| crate::session::lifecycle(&o.dir).0.is_none()) {
        Some(o) => Err(io::Error::other(format!(
            "\"{}\" ({}) works in this project's local checkout. Start in a new worktree, or archive it first.",
            title(&o),
            o.id
        ))),
        None => Ok(()),
    }
}

/// Whether `spec` holds its project's own folder, unarchived, so no other session may start there
/// [D306].
pub fn holds_local(spec: Option<&Spec>, projects: &[Project]) -> bool {
    spec.is_some_and(|s| {
        (projects.iter())
            .any(|p| s.project.as_ref() == Some(&p.id) && Path::new(&p.folder) == Path::new(&s.cwd))
            && crate::session::lifecycle(&s.dir).0.is_none()
    })
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

/// The base its worktree started from: its folder's holder's for a "here" fork [D1082].
pub fn base(data: &Path, spec: &Spec) -> Option<String> {
    worktrees::base(&holder(data, spec).map_or_else(|| spec.dir.clone(), |h| h.dir))
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

/// The session's name in a sentence: as its row's, the name given, else its first message's.
pub fn title(spec: &Spec) -> String {
    fs::read_to_string(spec.dir.join("title"))
        .ok()
        .filter(|t| !t.trim().is_empty())
        .or_else(|| {
            let all = crate::archive::read(&spec.dir).ok()?;
            let first = all.into_iter().find(|e| e.from == "user")?;
            Some(crate::title::from(&first.text)).filter(|t| !t.is_empty())
        })
        .unwrap_or_else(|| "Another session".into())
}

/// Who lands session `id`'s work instead of it (merge into base, a pull request): the folder's
/// owner's name where that's another session, else None [D1082]. One that can't be read lands its own.
pub fn lands(data: &Path, id: &str) -> Option<String> {
    let spec = load(data, id).ok()?;
    let others = others(data, &spec);
    let owner = owner(&spec, &others);
    (owner.id != spec.id).then(|| title(owner))
}
