//! The folder at the two edges of an Overnight night, beside the turns' own captures: what Review
//! shows of it, fixed once it's over.

use super::repos;
use super::snap::{Record, Store};
use crate::{Spec, session};
use brigadier_frames::log::now_ms;
use std::path::Path;

/// How long after a night ended its folder still counts as its result (proposed): its agent and
/// workers are stopped first.
const NIGHT_MS: u64 = 60_000;

/// Takes the folder, and each repo of a folder chat's, as the night that began at `since` starts:
/// edits made before that click aren't the night's, a turn's still running too.
pub fn night_starts(data: &Path, spec: &Spec, since: u64) {
    let Ok(_fence) = session::fence(data, spec) else {
        return;
    };
    for store in Store::of(spec).into_iter().chain(repos::stores(spec)) {
        if let Ok(before) = store.capture() {
            let _ = store.save_night(since, &Record { before, end: None });
        }
    }
}

/// Takes them as that night ended, at `at`, once, so what it did stays what it was.
pub fn night_ends(data: &Path, spec: &Spec, since: u64, at: u64) {
    let Ok(_fence) = session::fence(data, spec) else {
        return;
    };
    for store in Store::of(spec).into_iter().chain(repos::stores(spec)) {
        // A repo claimed in the night starts with its first turn there.
        let first = || (store.turns_in(since, at).into_iter()).next();
        let Some(mut record) = store.night(since).or_else(first) else {
            continue;
        };
        if store.night(since).is_some_and(|r| r.end.is_some()) {
            continue;
        }
        if now_ms().saturating_sub(at) <= NIGHT_MS
            && let Ok(end) = store.capture()
        {
            record.end = Some(end);
        } else {
            // Too late: what came since may be the user's. Its last turn's end is the night's.
            record.end = (store.turns_in(since, at).into_iter())
                .filter_map(|r| r.end)
                .next_back();
        }
        let _ = store.save_night(since, &record);
    }
}
