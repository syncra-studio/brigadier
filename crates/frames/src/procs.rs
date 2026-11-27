//! Process facts from the kernel. A pid is only trusted together with its start time, so a reused
//! pid is never mistaken for our child. Start times are microseconds since 1970 on every system.

use std::path::Path;

#[cfg(target_os = "macos")]
mod mac;
#[cfg(target_os = "macos")]
pub use mac::*;
#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
pub use linux::*;
#[cfg(unix)]
mod unix;
#[cfg(unix)]
pub use unix::*;
#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub use windows::*;

#[derive(Clone, Copy, Debug)]
pub struct Proc {
    pub pid: i32,
    pub ppid: i32,
    pub pgid: i32,
    pub sid: i32,
    pub start_us: u64,
    pub stopped: bool,
    pub zombie: bool,
}

/// A program's name from its path, as `ps` shows it; on Windows without its `.exe`.
pub fn program_name(path: &str) -> &str {
    let seps: &[char] = if cfg!(windows) { &['/', '\\'] } else { &['/'] };
    let name = path.rsplit(seps).next().unwrap_or(path);
    match cfg!(windows) && name.to_ascii_lowercase().ends_with(".exe") {
        true => &name[..name.len() - 4],
        false => name,
    }
}

/// The process, if `pid` is still the one that started at `start_us`.
pub fn same(pid: i32, start_us: u64) -> Option<Proc> {
    info(pid).filter(|p| p.start_us == start_us && !p.zombie)
}

/// Live members of a process group that started no earlier than its leader did. The start check
/// keeps a recycled group id from making us signal a stranger, and so does the leader check: a
/// live leader that isn't ours means the id now names someone else's group.
/// shortcut: a stranger group whose own leader has also exited still passes; record member pids
/// as well if that ever shows up.
pub fn group(procs: &[Proc], pgid: i32, not_before_us: u64) -> Vec<Proc> {
    if procs
        .iter()
        .any(|p| p.pid == pgid && p.start_us != not_before_us)
    {
        return vec![];
    }
    procs
        .iter()
        .filter(|p| p.pgid == pgid && p.start_us >= not_before_us)
        .copied()
        .collect()
}

pub fn descendants(procs: &[Proc], pid: i32) -> Vec<Proc> {
    let mut found = vec![];
    let mut frontier = vec![pid];
    // Windows never reparents, and MSYS's fork leaves a parent that's gone: such an orphan is still
    // in its group's job, every member of which descends from the job's leader.
    if cfg!(windows) && procs.iter().any(|p| p.pid == pid && p.pgid == pid) {
        let orphan = |p: &Proc| {
            !procs
                .iter()
                .any(|q| q.pid == p.ppid && q.start_us <= p.start_us)
        };
        for p in procs
            .iter()
            .filter(|p| p.pgid == pid && p.pid != pid && orphan(p))
        {
            found.push(*p);
            frontier.push(p.pid);
        }
    }
    while let Some(parent) = frontier.pop() {
        for p in procs.iter().filter(|p| p.ppid == parent) {
            found.push(*p);
            frontier.push(p.pid);
        }
    }
    found
}

/// Why nothing can run in `dir`: it is gone (deleted, moved, its drive out), so the user is told
/// at once, never left waiting on a child that can't start.
pub fn gone(dir: &str) -> Option<String> {
    (!Path::new(dir).is_dir())
        .then(|| format!("This folder is gone. Remove the project, or put it back. ({dir})"))
}
