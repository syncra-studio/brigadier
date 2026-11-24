//! Which processes are one session's: what was seen under its agent, through reparenting, a group
//! or session of their own, the agent's exit and the host's. Always a pid with its start time.

use crate::procs::{self, Proc};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::Path;

/// Shared servers an agent only happened to start, never a session's. This list only excludes.
const SHARED: [&str; 8] = [
    "tmux",
    "screen",
    "zellij",
    "ssh-agent",
    "gpg-agent",
    "watchman",
    "sccache",
    "adb",
];

/// The groups and sessions proven processes were in, each with the earliest proven start in it.
#[derive(Default)]
pub struct Links {
    groups: BTreeMap<i32, u64>,
    sids: BTreeMap<i32, u64>,
}

impl Links {
    pub fn add(&mut self, p: &Proc) {
        for (map, id) in [(&mut self.groups, p.pgid), (&mut self.sids, p.sid)] {
            let first = map.entry(id).or_insert(p.start_us);
            *first = p.start_us.min(*first);
        }
    }

    /// Those with no member left go: their ids can name a stranger's next.
    pub fn prune(&mut self, all: &[Proc]) {
        let groups: BTreeSet<i32> = all.iter().map(|p| p.pgid).collect();
        let sids: BTreeSet<i32> = all.iter().map(|p| p.sid).collect();
        self.groups.retain(|g, _| groups.contains(g));
        self.sids.retain(|s, _| sids.contains(s));
    }
}

/// Never a session's, nor what runs under it: the installed build's and this data folder's own
/// daemon, hosts and helper, and the shared servers.
pub fn shared(dir: &Path, p: &Proc) -> bool {
    let Some(exe) = procs::exe(p.pid) else {
        return false;
    };
    let name = exe.file_name().and_then(|n| n.to_str()).unwrap_or("");
    if SHARED.contains(&name) {
        return true;
    }
    if exe
        .components()
        .any(|c| c.as_os_str() == "Brigadier Computer Use.app")
    {
        return true;
    }
    if !matches!(name, "brigadierd" | "brigadier-host") {
        return false;
    }
    let data = dir.parent().and_then(Path::parent).unwrap_or(dir);
    let beside = std::env::current_exe().ok();
    let build = exe.parent();
    if exe.starts_with(data.join("bin"))
        || beside.as_deref().and_then(Path::parent) == build
        || build.is_some_and(|b| b.ends_with("Contents/Resources/bin"))
    {
        return true;
    }
    let (argv, env) = procs::args(p.pid).unwrap_or_default();
    argv.get(1).is_some_and(|a| Path::new(a).starts_with(data))
        || (env.iter().filter_map(|v| v.strip_prefix("BRIGADIER_DATA=")))
            .any(|d| Path::new(d) == data)
}

/// The session's own host: its process session holds only what it started.
fn own_host(dir: &Path, pid: i32) -> bool {
    procs::args(pid)
        .and_then(|a| a.0.get(1).cloned())
        .is_some_and(|a| {
            let real = |p: &Path| std::fs::canonicalize(p).unwrap_or_else(|_| p.into());
            real(Path::new(&a)) == real(dir)
        })
}

/// `seeds` still alive and what they prove: their descendants, and what started after them in a
/// group or session of theirs. A live leader that isn't proven makes a group no proof: the id was
/// reused, or the group is someone else's.
/// shortcut: a group emptied, its id taken by a stranger's whose leader died too, still passes if
/// all that happens between two looks of `links`' keeper: a host's 250 ms after the last member's
/// exit, an archive's or delete's two-second grace. Its members' starts would have to be kept to tell.
pub fn grow(dir: &Path, all: &[Proc], seeds: &[(i32, u64)], links: &mut Links) -> Vec<Proc> {
    let at: HashMap<i32, &Proc> = all.iter().map(|p| (p.pid, p)).collect();
    let seeds: BTreeSet<(i32, u64)> = seeds.iter().copied().collect();
    let mut mine: BTreeMap<i32, Proc> = BTreeMap::new();
    let mut not: BTreeSet<i32> = BTreeSet::new();
    for (pid, start) in &seeds {
        if let Some(p) = at.get(pid).filter(|p| p.start_us == *start) {
            match shared(dir, p) {
                true => drop(not.insert(*pid)),
                false => {
                    links.add(p);
                    mine.insert(*pid, **p);
                }
            }
        }
    }
    let mut hosts: BTreeMap<i32, bool> = BTreeMap::new();
    loop {
        // A shared process's own group and session are never proof.
        for pid in &not {
            links.groups.remove(pid);
            if !*hosts.entry(*pid).or_insert_with(|| own_host(dir, *pid)) {
                links.sids.remove(pid);
            }
        }
        let mut leads = |id: i32, first: u64, p: &Proc| {
            id > 1
                && p.start_us >= first
                && match at.get(&id) {
                    None => true,
                    Some(_) if mine.contains_key(&id) => true,
                    // What the host itself started is its own.
                    Some(_) => {
                        p.ppid != id && *hosts.entry(id).or_insert_with(|| own_host(dir, id))
                    }
                }
        };
        let found: Vec<Proc> = (all.iter())
            .filter(|p| !mine.contains_key(&p.pid) && !not.contains(&p.pid))
            .filter(|p| {
                mine.get(&p.ppid).is_some_and(|q| q.start_us <= p.start_us)
                    || (links.groups.get(&p.pgid)).is_some_and(|f| leads(p.pgid, *f, p))
                    || (links.sids.get(&p.sid)).is_some_and(|f| leads(p.sid, *f, p))
            })
            .copied()
            .collect();
        if found.is_empty() {
            return mine.into_values().collect();
        }
        for p in found {
            match shared(dir, &p) {
                true => drop(not.insert(p.pid)),
                false => {
                    links.add(&p);
                    mine.insert(p.pid, p);
                }
            }
        }
    }
}
