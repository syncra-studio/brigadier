//! What the kernel says about a session's processes: its owner, its child and their groups.

use super::{Fold, Owner};
use brigadier_frames::{log, procs};
use std::collections::BTreeSet;

pub struct Live {
    pub owner: Owner,
    pub child: Option<procs::Proc>,
    pub running_below: usize,
    pub jobs: usize,
    pub orphans: usize,
    pub disk_full: bool,
    pub now: u64,
}

/// Every recorded group that still has a live member, checked by start time. A set of live group
/// ids first, so a session with thousands of spawns costs a lookup per group.
pub fn live_groups(fold: &Fold, all: &[procs::Proc]) -> Vec<(i32, u64)> {
    let pgids: BTreeSet<i32> = all.iter().map(|p| p.pgid).collect();
    fold.groups
        .iter()
        .filter(|&&(g, s)| pgids.contains(&g) && !procs::group(all, g, s).is_empty())
        .copied()
        .collect()
}

pub fn live(fold: &Fold, owner: Owner, data_dir: &std::path::Path, all: &[procs::Proc]) -> Live {
    let child = fold
        .child
        .as_ref()
        .filter(|c| !c.exited)
        .and_then(|c| procs::same(c.pid, c.start_us));
    let running_below = child.map_or(0, |c| {
        procs::descendants(all, c.pid)
            .iter()
            .filter(|p| !p.stopped)
            .count()
    });
    let members: usize = live_groups(fold, all)
        .iter()
        .map(|&(g, s)| procs::group(all, g, s).len())
        .sum();
    let jobs = members.saturating_sub(child.is_some() as usize + running_below);
    let orphans = if owner == Owner::Dead { members } else { 0 };
    Live {
        owner,
        child,
        running_below,
        jobs,
        orphans,
        disk_full: free_bytes(data_dir) < (2 << 20),
        now: log::now_ms(),
    }
}

fn free_bytes(path: &std::path::Path) -> u64 {
    let Ok(c) = std::ffi::CString::new(path.as_os_str().as_encoded_bytes()) else {
        return u64::MAX;
    };
    let mut s = std::mem::MaybeUninit::<libc::statvfs>::zeroed();
    if unsafe { libc::statvfs(c.as_ptr(), s.as_mut_ptr()) } != 0 {
        return u64::MAX;
    }
    let s = unsafe { s.assume_init() };
    s.f_bavail as u64 * s.f_frsize
}
