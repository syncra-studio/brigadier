//! A folder chat's claimed repos [D494, D3105]: each has its own snapshots, in its claim's record
//! folder over its copy, taken at the same turn edges as a session's; a restore and its Redo go
//! through each one, its paths named `<repo>/<path>` wherever they're shown.

use super::plan::{Files, Why, plan};
use super::shared::{Lives, sharer};
use super::snap::{Record, Shot, Store};
use crate::fold::Boundary;
use crate::{Spec, folder, worktrees};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::io;
use std::path::Path;

/// One repo's restore: the repo just before it, where its paths go, and which.
#[derive(Serialize, Deserialize, Clone)]
pub struct Part {
    pub name: String,
    pub pre: Shot,
    pub target: String,
    pub paths: BTreeSet<String>,
}

/// Every claimed repo's store.
pub(super) fn stores(spec: &Spec) -> impl Iterator<Item = Store> {
    (folder::claims(&spec.dir).into_iter()).filter_map(|(_, rec)| Store::claim(&rec))
}

/// A claim made during the open turn: the new copy is taken as that turn's start, so a rewind past
/// the claim puts the repo back as it was claimed. The turn, if one is open.
pub fn claimed(spec: &Spec, rec: &Path) -> Option<String> {
    let f = crate::fold(&spec.dir, true).ok()?.fold;
    let turn = f.turns.first()?.id.clone();
    if let Some(store) = Store::claim(rec)
        && let Ok(before) = store.capture()
    {
        let _ = store.save(&turn, &Record { before, end: None });
    }
    Some(turn)
}

/// The turns of `turns` that are the repo's own: from the one that claimed it, every one where
/// that's earlier or unknown.
fn own<'a>(rec: &Path, turns: &'a [Boundary]) -> &'a [Boundary] {
    let at = folder::claimed_in(rec).flatten();
    let at = at.and_then(|c| turns.iter().position(|t| t.cid == c));
    &turns[at.unwrap_or(0)..]
}

/// `spec` as the session working in claim `rec`'s copy, so the shared-folder checks see who else
/// works there, "Existing worktree" sessions too [D1078, D1089].
fn in_copy(spec: &Spec, rec: &Path) -> Option<Spec> {
    let cwd = worktrees::folder(rec)?.display().to_string();
    Some(Spec {
        cwd,
        ..spec.clone()
    })
}

/// Every claimed repo's restore across `turns`, as one. A repo with a turn it has no snapshot of,
/// or none it can read, stays as it is and is named in `stale`, never left out unsaid. A repo whose
/// copy another session works in now, or did during those turns, refuses it all, as a shared
/// folder does.
pub(super) fn plan_all(
    data: &Path,
    spec: &Spec,
    turns: &[Boundary],
    live: Lives,
) -> Result<Files, Why> {
    let mut all = Files::default();
    for (name, rec) in folder::claims(&spec.dir) {
        let (Some(store), Some(me)) = (Store::claim(&rec), in_copy(spec, &rec)) else {
            all.stale.push(name);
            continue;
        };
        let Ok(p) = plan(&store, own(&rec, turns)) else {
            all.stale.push(name);
            continue;
        };
        if !p.paths.is_empty()
            && let Some((why, with)) = sharer(data, &me, &store, own(&rec, turns), live)
        {
            return Err((why, Some(with)));
        }
        let under = |v: &[String]| v.iter().map(|p| format!("{name}/{p}")).collect::<Vec<_>>();
        all.hand.extend(under(&p.hand));
        all.left_out.extend(under(&p.left_out));
        all.nested.extend(under(&p.nested));
        all.commits |= p.commits;
        if let (Some(pre), Some(target), false) = (p.pre, p.target, p.paths.is_empty()) {
            all.repos.push(Part {
                name,
                pre,
                target,
                paths: p.paths,
            });
        }
    }
    Ok(all)
}

/// The session working now in the copy of a repo `parts` would put back, if one is: Redo waits
/// for it, as it does in a shared folder.
pub(super) fn busy(data: &Path, spec: &Spec, parts: &[Part], live: Lives) -> Option<String> {
    let claims = folder::claims(&spec.dir);
    let recs = (parts.iter()).filter_map(|p| claims.iter().find(|(n, _)| *n == p.name));
    recs.filter_map(|(_, rec)| Some((Store::claim(rec)?, in_copy(spec, rec)?)))
        .find_map(|(store, me)| sharer(data, &me, &store, &[], live).map(|(_, with)| with))
}

fn by_name(spec: &Spec, name: &str) -> io::Result<Store> {
    (folder::claims(&spec.dir).into_iter())
        .find(|(n, _)| n == name)
        .and_then(|(_, rec)| Store::claim(&rec))
        .ok_or_else(|| io::Error::other(format!("the copy of {name} is gone")))
}

/// Puts each repo's paths back as its target has them.
pub(super) fn write_back(spec: &Spec, parts: &[Part]) -> io::Result<()> {
    (parts.iter()).try_for_each(|p| by_name(spec, &p.name)?.write_back(&p.target, &p.paths))
}

/// Puts each repo's paths back as they were before the restore, where each is still as it left
/// them; those that stayed, as `<repo>/<path>`.
pub(super) fn put_back(spec: &Spec, parts: &[Part]) -> io::Result<Vec<String>> {
    let mut kept = vec![];
    for p in parts {
        let store = by_name(spec, &p.name)?;
        let left = super::undo::put_back(&store, &p.pre.tree, &p.target, &p.paths)?;
        kept.extend(left.into_iter().map(|k| format!("{}/{k}", p.name)));
    }
    Ok(kept)
}

/// Every part's paths, as `<repo>/<path>`.
pub(super) fn named(parts: &[Part]) -> Vec<String> {
    let each = |p: &Part| {
        p.paths
            .iter()
            .map(|k| format!("{}/{k}", p.name))
            .collect::<Vec<_>>()
    };
    parts.iter().flat_map(each).collect()
}
