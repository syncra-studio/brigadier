//! Process facts from the kernel. A pid is only trusted together with its start time, so a reused
//! pid is never mistaken for our child.

use std::ffi::CString;
use std::io;
use std::mem::{MaybeUninit, size_of};
use std::os::unix::ffi::OsStrExt;
use std::path::Path;

#[derive(Clone, Copy, Debug)]
pub struct Proc {
    pub pid: i32,
    pub ppid: i32,
    pub pgid: i32,
    pub start_us: u64,
    pub stopped: bool,
    pub zombie: bool,
}

pub fn info(pid: i32) -> Option<Proc> {
    let mut bsd = MaybeUninit::<libc::proc_bsdinfo>::zeroed();
    let size = size_of::<libc::proc_bsdinfo>() as i32;
    let n = unsafe {
        libc::proc_pidinfo(
            pid,
            libc::PROC_PIDTBSDINFO,
            0,
            bsd.as_mut_ptr().cast(),
            size,
        )
    };
    if n != size {
        return None;
    }
    let b = unsafe { bsd.assume_init() };
    Some(Proc {
        pid,
        ppid: b.pbi_ppid as i32,
        pgid: b.pbi_pgid as i32,
        start_us: b.pbi_start_tvsec * 1_000_000 + b.pbi_start_tvusec,
        stopped: b.pbi_status == libc::SSTOP,
        zombie: b.pbi_status == libc::SZOMB,
    })
}

/// The process, if `pid` is still the one that started at `start_us`.
pub fn same(pid: i32, start_us: u64) -> Option<Proc> {
    info(pid).filter(|p| p.start_us == start_us && !p.zombie)
}

pub fn all() -> Vec<Proc> {
    let n = unsafe { libc::proc_listallpids(std::ptr::null_mut(), 0) };
    let mut pids = vec![0i32; n.max(0) as usize + 64];
    let bytes = (pids.len() * size_of::<i32>()) as i32;
    let n = unsafe { libc::proc_listallpids(pids.as_mut_ptr().cast(), bytes) };
    pids.truncate(n.max(0) as usize);
    pids.into_iter()
        .filter(|&p| p > 0)
        .filter_map(info)
        .filter(|p| !p.zombie)
        .collect()
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
    while let Some(parent) = frontier.pop() {
        for p in procs.iter().filter(|p| p.ppid == parent) {
            found.push(*p);
            frontier.push(p.pid);
        }
    }
    found
}

/// Signals every checked member of the group, one by one. Returns how many were signalled.
pub fn signal_group(pgid: i32, not_before_us: u64, sig: i32) -> usize {
    let members = group(&all(), pgid, not_before_us);
    for p in &members {
        unsafe { libc::kill(p.pid, sig) };
    }
    members.len()
}

/// Physical footprint in bytes, the figure Activity Monitor shows as Memory.
pub fn footprint(pid: i32) -> Option<u64> {
    let mut info = MaybeUninit::<libc::rusage_info_v4>::zeroed();
    let r = unsafe { libc::proc_pid_rusage(pid, libc::RUSAGE_INFO_V4, info.as_mut_ptr().cast()) };
    (r == 0).then(|| unsafe { info.assume_init() }.ri_phys_footprint)
}

/// Fails as exec would for a program that isn't there or can't run. The spawn gate's own exec
/// can't report that, so it's checked first: a path against `cwd`, a bare name along `path`.
pub fn runnable(program: &str, path: Option<&str>, cwd: &str) -> io::Result<()> {
    let ok = |p: &Path| {
        p.is_file()
            && CString::new(p.as_os_str().as_bytes())
                .is_ok_and(|c| unsafe { libc::access(c.as_ptr(), libc::X_OK) } == 0)
    };
    let found = if program.contains('/') {
        ok(&Path::new(cwd).join(program))
    } else {
        let dirs = path.unwrap_or("/usr/bin:/bin:/usr/sbin:/sbin");
        dirs.split(':').any(|d| ok(&Path::new(d).join(program)))
    };
    found
        .then_some(())
        .ok_or_else(|| io::Error::from_raw_os_error(libc::ENOENT))
}
