//! What a restore would put back, from the turn snapshots [D384].

use super::snap::{Shot, Store};
use crate::fold::Boundary;
use std::collections::BTreeSet;

/// What a restore would do.
pub(super) struct Files {
    pub pre: Shot,
    pub target: String,
    pub paths: BTreeSet<String>,
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
    for (i, (before, end)) in shots.iter().enumerate() {
        agent.extend(store.diff(before, end).map_err(unread)?);
        let next = shots.get(i + 1).map_or(&pre, |s| &s.0);
        gaps.extend(store.diff(end, next).map_err(unread)?);
    }
    let all = shots.iter().flat_map(|(b, e)| [b, e]).chain([&pre]);
    let out: BTreeSet<String> = all.flat_map(|s| s.out.keys().cloned()).collect();
    let moved = store.diff(&target, &pre).map_err(unread)?;
    let mut hand: BTreeSet<String> = agent.intersection(&gaps).cloned().collect();
    let wanted: BTreeSet<String> = (agent.intersection(&moved))
        .filter(|p| !hand.contains(*p) && !out.contains(*p))
        .cloned()
        .collect();
    let blocked: BTreeSet<String> = (wanted.iter())
        .filter(|p| store.blocked(p, &wanted))
        .cloned()
        .collect();
    let paths = wanted.difference(&blocked).cloned().collect();
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
        target: target.tree,
        pre,
        paths,
        hand: hand.into_iter().collect(),
        left_out,
        nested,
    })
}
