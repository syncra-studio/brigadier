//! What a restore would put back, from the turn snapshots [D384].

use super::repos::Part;
use super::shared::{Lives, sharer};
use super::snap::{Shot, Store};
use crate::Spec;
use crate::fold::{Boundary, Fold};
use std::collections::BTreeSet;
use std::path::Path;

/// What a restore would do: in the session's folder, and in each repo a folder chat claimed.
#[derive(Default)]
pub(super) struct Files {
    pub pre: Option<Shot>,
    pub target: Option<String>,
    /// The target's permissions, as its capture keeps them [D26].
    pub modes: Option<String>,
    pub paths: BTreeSet<String>,
    pub repos: Vec<Part>,
    /// The claimed repos that stay as they are: a turn of theirs has no snapshot [D3105].
    pub stale: Vec<String>,
    pub hand: Vec<String>,
    pub left_out: Vec<String>,
    /// Of `left_out`, the nested repositories; the rest are untracked files too big to keep.
    pub nested: Vec<String>,
    pub commits: bool,
}

/// `Err` says why the folder can't go back. Only what the agent changed in these turns goes, and
/// only where the user hasn't edited the same path since (proposed).
pub(super) fn plan(store: &Store, turns: &[Boundary]) -> Result<Files, &'static str> {
    let unread = |_| "unreadable";
    let shots: Option<Vec<(Shot, Shot)>> = (turns.iter())
        .map(|t| {
            let r = store.load(&t.cid)?;
            Some((r.before, r.end?))
        })
        .collect();
    // No snapshot is ever taken of a folder outside git: said as such [D384].
    let missing = || {
        if store.is_repo() {
            "missing"
        } else {
            "not_git"
        }
    };
    let shots = shots.filter(|s| !s.is_empty()).ok_or_else(missing)?;
    let pre = store.capture().map_err(unread)?;
    let target = shots[0].0.clone();
    let (mut agent, mut gaps) = (BTreeSet::new(), BTreeSet::new());
    // The same for permissions alone.
    let (mut bits, mut since) = (BTreeSet::new(), BTreeSet::new());
    for (i, (before, end)) in shots.iter().enumerate() {
        agent.extend(store.diff(before, end).map_err(unread)?);
        let next = shots.get(i + 1).map_or(&pre, |s| &s.0);
        gaps.extend(store.diff(end, next).map_err(unread)?);
        bits.extend(store.modes_differ(before, end).map_err(unread)?);
        since.extend(store.modes_differ(end, next).map_err(unread)?);
    }
    let alone = bits.difference(&agent).filter(|p| since.contains(*p));
    gaps.extend(alone.cloned());
    agent.extend(bits);
    let all = shots.iter().flat_map(|(b, e)| [b, e]).chain([&pre]);
    let out: BTreeSet<String> = all.flat_map(|s| s.out.keys().cloned()).collect();
    let mut moved = store.diff(&target, &pre).map_err(unread)?;
    moved.extend(store.modes_differ(&target, &pre).map_err(unread)?);
    let mut hand: BTreeSet<String> = agent.intersection(&gaps).cloned().collect();
    // The same file, where the disk has it under another letter case.
    let cased: Vec<String> = hand.iter().filter_map(|p| store.spelled(p)).collect();
    hand.extend(cased);
    let wanted: BTreeSet<String> = (agent.intersection(&moved))
        .filter(|p| !hand.contains(*p) && !out.contains(*p))
        .cloned()
        .collect();
    let blocked: BTreeSet<String> = (wanted.iter())
        .filter(|p| store.blocked(p, &wanted))
        .cloned()
        .collect();
    let paths: BTreeSet<String> = wanted.difference(&blocked).cloned().collect();
    // A file whose permissions alone were changed since goes back no more open than it is now.
    let eased = paths.intersection(&since);
    let modes = store.stricter(&target, eased).map_err(unread)?;
    hand.extend(blocked);
    let left_out: Vec<String> = (out.iter())
        .filter(|p| target.out.get(*p) != pre.out.get(*p))
        .cloned()
        .collect();
    // A big file's stamp is "size:time"; a nested repository's is its commit.
    let nested = (left_out.iter())
        .filter(|p| {
            [target.out.get(*p), pre.out.get(*p)]
                .iter()
                .flatten()
                .any(|v| !v.contains(':'))
        })
        .cloned()
        .collect();
    Ok(Files {
        commits: target.head != pre.head,
        target: Some(target.tree),
        modes,
        pre: Some(pre),
        paths,
        hand: hand.into_iter().collect(),
        left_out,
        nested,
        ..Files::default()
    })
}

/// Why a folder can't go back, and the session holding its files, if one does.
pub(super) type Why = (&'static str, Option<String>);

/// What a restore to `cid` would do, or why it can't.
pub(super) fn plan_for(
    data: &Path,
    spec: &Spec,
    f: &Fold,
    cid: &str,
    live: Lives,
) -> Result<Files, Why> {
    // A project whose folder is gone is said apart from a chat with none [D1247].
    let none = match spec.project.is_some() && !Path::new(&spec.cwd).exists() {
        true => "no_folder",
        false => "no_project",
    };
    let (_, turns) = f.range(cid).ok_or(("missing", None))?;
    // A folder chat's own folder isn't a repo: its claimed ones go back, each by itself [D3105].
    if crate::folder::chat(spec) {
        return super::repos::plan_all(data, spec, &turns, live);
    }
    let store = Store::of(spec).ok_or((none, None))?;
    let files = plan(&store, &turns).map_err(|why| (why, None))?;
    // Only files that would go back are any sharer's business [D481].
    if !files.paths.is_empty()
        && let Some((why, with)) = sharer(data, spec, &store, &turns, live)
    {
        return Err((why, Some(with)));
    }
    Ok(files)
}
