//! Whether a worker is still working: the one answer for its row, Keep or Stop, archive and
//! delete. A turn held for its background work counts [D105, D118].

use super::Link;
use crate::owner;
use brigadier_core::{
    self as core,
    fold::{self, Fold},
};
use brigadier_frames::procs;
use std::borrow::Borrow;
use std::io;
use std::path::Path;

/// Whether worker `id` is still working: being made, a task it reports back on not ended, or a
/// turn, the user's own too, held for its background work, though its row may not show it yet. One
/// whose host died (`interrupted`) isn't, whatever this says.
pub fn busy(data: &Path, id: &str) -> bool {
    let f = || core::fold(&core::session_dir(data, id), true).map(|r| r.fold);
    super::link(data, id).is_some_and(|l| busy_in(data, id, &l, f, true))
}

/// The same, but for the user's own turns in it, which its parent never waits on: for a wait, its
/// parent's row and a Brigade's.
pub fn owes(data: &Path, id: &str) -> bool {
    let f = || core::fold(&core::session_dir(data, id), true).map(|r| r.fold);
    super::link(data, id).is_some_and(|l| busy_in(data, id, &l, f, false))
}

/// Whether it's at work for a Stop or a delete: `busy`, or whatever else its live host runs.
pub(crate) fn at_work(data: &Path, id: &str, all: &[procs::Proc]) -> bool {
    crate::sessions::working(data, id, all)
        || (owner::state(data, id) == fold::Owner::Alive && busy(data, id))
}

/// `busy`, for its row, which has its fold at hand; `direct`: the user's own turns in it count.
pub(super) fn busy_in<F: Borrow<Fold>>(
    data: &Path,
    id: &str,
    l: &Link,
    f: impl FnOnce() -> io::Result<F>,
    direct: bool,
) -> bool {
    // A paused one isn't waited on, and (proposed) doesn't count toward Workers at once [D3042].
    if l.paused {
        return false;
    }
    let r = super::record(data, &l.parent, id);
    // A start that failed or was stopped before its brief went has nothing left to wait for.
    if r.as_ref()
        .is_some_and(|r| matches!(r.state.as_str(), "failed" | "stopped"))
    {
        return false;
    }
    let made = r.is_some_and(|r| r.state != "starting");
    let Ok(f) = f() else {
        return !made;
    };
    !made
        || (l.session && super::brigade::leading(data, id))
        || l.review["state"] == "running"
        || super::result::going(data, id, l, f.borrow(), direct)
}
