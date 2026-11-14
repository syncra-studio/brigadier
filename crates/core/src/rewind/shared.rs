//! A folder other sessions share [D1070]: whether their turns keep a restore from putting files
//! back [D1078, D1089].

use super::snap::Store;
use crate::fold::{Boundary, Fold, Live};
use crate::{Spec, session};
use brigadier_frames::log::now_ms;
use std::path::Path;

/// Reads a session's host and its background work [D172].
pub(super) type Lives<'a> = &'a dyn Fn(&Spec, &Fold) -> Live;

/// Why the folder can't go back because another session works in it, archived ones too [D1078,
/// D1089]: one with a turn or background work running now (`busy`), or one whose turn ran during any of `turns`
/// (`overlap`), with its id. Its turn runs from its first capture to its end's, else to its next
/// record's or now; a time missing, from before this rule, overlaps, and a turn with no record
/// runs between its neighbours'. Read under the checkout lock.
pub(super) fn sharer(
    data: &Path,
    spec: &Spec,
    store: &Store,
    turns: &[Boundary],
    live: Lives,
) -> Option<(&'static str, String)> {
    let now = now_ms();
    let mine: Vec<Option<(u64, u64)>> = (turns.iter())
        .map(|t| {
            store
                .load(&t.cid)
                .and_then(|r| Some((r.before.at?, r.end.as_ref()?.at?)))
        })
        .collect();
    let meets = |window: Option<(u64, u64)>| {
        mine.iter().any(|m| match (m, window) {
            (Some((a0, a1)), Some((b0, b1))) => *a0 < b1 && b0 < *a1,
            _ => true,
        })
    };
    for other in crate::share::others(data, spec) {
        let f = crate::fold(&other.dir, true).ok();
        if f.as_ref()
            .is_some_and(|f| session::busy(&f.fold, &live(&other, &f.fold)))
        {
            return Some(("busy", other.id));
        }
        let store = Store::of(&other);
        let theirs = store.as_ref().map(|s| s.records()).unwrap_or_default();
        for (i, r) in theirs.iter().enumerate() {
            let end = match &r.end {
                Some(end) => end.at,
                None => theirs.get(i + 1).map_or(Some(now), |n| n.before.at),
            };
            if meets(r.before.at.zip(end)) {
                return Some(("overlap", other.id));
            }
        }
        let logged = f.iter().flat_map(|f| &f.fold.boundaries);
        let loaded: Vec<_> = (logged.filter(|b| b.origin != "fork"))
            .map(|b| store.as_ref().and_then(|s| s.load(&b.cid)))
            .collect();
        for (i, _) in loaded.iter().enumerate().filter(|(_, r)| r.is_none()) {
            let from = (loaded[..i].iter().rev().flatten())
                .find_map(|p| p.end.as_ref().and_then(|e| e.at).or(p.before.at));
            let to = loaded[i + 1..].iter().flatten().find_map(|n| n.before.at);
            if meets(Some((from.unwrap_or(0), to.unwrap_or(now)))) {
                return Some(("overlap", other.id));
            }
        }
    }
    None
}
