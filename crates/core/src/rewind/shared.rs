//! A folder other sessions share [D1070]: whether their turns keep a restore from putting files
//! back [D1078, D1089], and what their turns changed, for Source [D1082].

use super::snap::Store;
use crate::Spec;
use crate::fold::Boundary;
use brigadier_frames::log::now_ms;
use std::collections::BTreeSet;
use std::path::Path;

/// Why the folder can't go back because another session works in it, archived ones too [D1078,
/// D1089]: one with a turn open now (`busy`), or one whose turn ran during any of `turns`
/// (`overlap`), with its id. Its turn runs from its first capture to its end's, else to its next
/// record's or now; a time missing, from before this rule, overlaps. Read under the checkout lock.
pub(super) fn sharer(
    data: &Path,
    spec: &Spec,
    store: &Store,
    turns: &[Boundary],
) -> Option<(&'static str, String)> {
    let now = now_ms();
    let mine: Vec<Option<(u64, u64)>> = (turns.iter())
        .map(|t| {
            store
                .load(&t.cid)
                .and_then(|r| Some((r.before.at?, r.end.as_ref()?.at?)))
        })
        .collect();
    for other in crate::share::others(data, spec) {
        if crate::fold(&other.dir, true).is_ok_and(|f| !f.fold.turns.is_empty()) {
            return Some(("busy", other.id));
        }
        let theirs = Store::of(&other).map(|s| s.records()).unwrap_or_default();
        for (i, r) in theirs.iter().enumerate() {
            let end = match &r.end {
                Some(end) => end.at,
                None => theirs.get(i + 1).map_or(Some(now), |n| n.before.at),
            };
            let window = r.before.at.zip(end);
            let meets = |m: &Option<(u64, u64)>| match (m, window) {
                (Some((a0, a1)), Some((b0, b1))) => *a0 < b1 && b0 < *a1,
                _ => true,
            };
            if mine.iter().any(meets) {
                return Some(("overlap", other.id));
            }
        }
    }
    None
}

/// The paths `spec`'s turns that ended on commit `head` changed, from the newest back: what it
/// added since that commit, for Source's note [D1082] (proposed).
pub fn turn_paths(spec: &Spec, head: Option<&str>) -> BTreeSet<String> {
    let mut paths = BTreeSet::new();
    let Some(store) = Store::of(spec).filter(|_| head.is_some()) else {
        return paths;
    };
    for r in store.records().iter().rev() {
        let Some(end) = r.end.as_ref().filter(|e| e.head.as_deref() == head) else {
            break;
        };
        paths.extend(store.diff(&r.before, end).unwrap_or_default());
    }
    paths
}
