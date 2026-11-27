//! Process facts from the kernel. A pid is only trusted together with its start time, so a reused
//! pid is never mistaken for our child.

use std::collections::BTreeSet;
use std::ffi::CString;
use std::io;
use std::mem::{MaybeUninit, size_of};
use std::os::unix::ffi::{OsStrExt, OsStringExt};
use std::path::Path;

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
        sid: unsafe { libc::getsid(pid) },
        start_us: b.pbi_start_tvsec * 1_000_000 + b.pbi_start_tvusec,
        stopped: b.pbi_status == libc::SSTOP,
        zombie: b.pbi_status == libc::SZOMB,
    })
}

/// A process's arguments and the environment it was started with, from the kernel. Only the
/// same user's processes answer.
pub fn args(pid: i32) -> Option<(Vec<String>, Vec<String>)> {
    let mut mib = [libc::CTL_KERN, libc::KERN_PROCARGS2, pid];
    let mut size: libc::size_t = 0;
    let null = std::ptr::null_mut();
    if unsafe { libc::sysctl(mib.as_mut_ptr(), 3, null, &mut size, null, 0) } != 0 {
        return None;
    }
    let mut buf = vec![0u8; size];
    let at = buf.as_mut_ptr().cast();
    if unsafe { libc::sysctl(mib.as_mut_ptr(), 3, at, &mut size, null, 0) } != 0 {
        return None;
    }
    let argc = i32::from_ne_bytes(buf.get(..4)?.try_into().ok()?) as usize;
    // The program's path and its padding, then argv, then the environment, each NUL-ended. A
    // process that retitled itself (npm) zeroed its args: those are empty words, never the
    // environment's first.
    let mut words = buf[4..size].split(|b| *b == 0);
    words.next()?;
    let mut words = words
        .skip_while(|w| w.is_empty())
        .map(|w| String::from_utf8_lossy(w).into_owned());
    let argv: Vec<String> = (words.by_ref().take(argc))
        .filter(|w| !w.is_empty())
        .collect();
    Some((argv, words.filter(|w| !w.is_empty()).collect()))
}

/// A process's parent and short name. It answers for every user's processes, the walk's root
/// ones too (`login`), where the full record doesn't.
fn short(pid: i32) -> Option<(i32, Vec<u8>)> {
    let mut b = MaybeUninit::<libc::proc_bsdshortinfo>::zeroed();
    let size = size_of::<libc::proc_bsdshortinfo>() as i32;
    let n = unsafe {
        libc::proc_pidinfo(
            pid,
            libc::PROC_PIDT_SHORTBSDINFO,
            0,
            b.as_mut_ptr().cast(),
            size,
        )
    };
    let b = (n == size).then(|| unsafe { b.assume_init() })?;
    let name = (b.pbsi_comm.iter())
        .take_while(|c| **c != 0)
        .map(|c| *c as u8)
        .collect();
    Some((b.pbsi_ppid as i32, name))
}

/// The session hosts above `pid`, nearest first: each one's pid, start time and the session folder
/// it was started for. None when the walk couldn't reach the top, which is never the same as none.
pub fn hosts_above(pid: i32) -> Option<Vec<(i32, u64, String)>> {
    let mut found = vec![];
    let mut ppid = short(pid)?.0;
    // A parent of 1 is launchd: the top. The bound only guards against a cycle that can't be.
    for _ in 0..256 {
        if ppid <= 1 {
            return Some(found);
        }
        let (next, name) = short(ppid)?;
        if name == b"brigadier-host" {
            let (argv, _) = args(ppid)?;
            found.push((ppid, info(ppid)?.start_us, argv.get(1)?.clone()));
        }
        ppid = next;
    }
    None
}

/// The file a process runs.
pub fn exe(pid: i32) -> Option<std::path::PathBuf> {
    let mut buf = vec![0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
    let n = unsafe { libc::proc_pidpath(pid, buf.as_mut_ptr().cast(), buf.len() as u32) };
    buf.truncate(usize::try_from(n).ok().filter(|n| *n > 0)?);
    Some(std::ffi::OsString::from_vec(buf).into())
}

/// The TCP ports a process listens on, one it holds on IPv4 and IPv6 once. Only the same user's
/// processes answer.
pub fn listening(pid: i32) -> BTreeSet<u16> {
    // `struct socket_fdinfo`, which libc has no type for: its size, and where its kind, local port
    // and TCP state are (`sys/proc_info.h`).
    const SOCKET: i32 = 3; // PROC_PIDFDSOCKETINFO
    const SIZE: usize = 792;
    let (kind, port, state) = (256, 268, 344);
    let (tcp, listen) = (2, 1); // SOCKINFO_TCP, TSI_S_LISTEN
    let list = |at: *mut libc::proc_fdinfo, n: usize| unsafe {
        let bytes = (n * size_of::<libc::proc_fdinfo>()) as i32;
        libc::proc_pidinfo(pid, libc::PROC_PIDLISTFDS, 0, at.cast(), bytes)
    };
    let room = list(std::ptr::null_mut(), 0).max(0) as usize / size_of::<libc::proc_fdinfo>();
    let mut fds: Vec<libc::proc_fdinfo> = Vec::with_capacity(room);
    let n = list(fds.as_mut_ptr(), room).max(0) as usize / size_of::<libc::proc_fdinfo>();
    unsafe { fds.set_len(n.min(room)) };
    let mut ports = BTreeSet::new();
    for fd in fds
        .iter()
        .filter(|f| f.proc_fdtype == libc::PROX_FDTYPE_SOCKET as u32)
    {
        let mut buf = [0u64; SIZE / 8];
        let at = buf.as_mut_ptr().cast();
        let n = unsafe { libc::proc_pidfdinfo(pid, fd.proc_fd, SOCKET, at, SIZE as i32) };
        let bytes = unsafe { std::slice::from_raw_parts(buf.as_ptr().cast::<u8>(), SIZE) };
        let int = |at: usize| i32::from_ne_bytes(bytes[at..at + 4].try_into().unwrap());
        if n as usize == SIZE && int(kind) == tcp && int(state) == listen {
            // Its low half, in the network's order.
            ports.insert(u16::from_be(int(port) as u16));
        }
    }
    ports
}

/// The pipe or socket ends a process has as its stdin and stdout, by the kernel's own ids: the same
/// in another one it passed them on to. Node's children get socket pairs. None when either is
/// neither.
pub fn stdio(pid: i32) -> Option<[u64; 2]> {
    // `struct pipe_fdinfo` and `struct socket_fdinfo`, which libc has no type for: each one's
    // flavor and size; both have the end's id, `pipe_handle` or `soi_so`, at the same place, as
    // u64s (`sys/proc_info.h`).
    const KINDS: [(i32, usize); 2] = [(6, 184), (3, 792)]; // PROC_PIDFDPIPEINFO, PROC_PIDFDSOCKETINFO
    let end = |fd: i32| {
        KINDS.iter().find_map(|&(kind, size)| {
            let mut buf = [0u64; 792 / 8];
            let at = buf.as_mut_ptr().cast();
            let n = unsafe { libc::proc_pidfdinfo(pid, fd, kind, at, size as i32) };
            (n as usize == size).then_some(buf[20])
        })
    };
    Some([end(0)?, end(1)?])
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

/// A process's children now, without reading every process's record.
pub fn children(pid: i32) -> Vec<i32> {
    let mut pids = vec![0i32; 1024];
    let bytes = (pids.len() * size_of::<i32>()) as i32;
    let n = unsafe { libc::proc_listchildpids(pid, pids.as_mut_ptr().cast(), bytes) };
    pids.truncate(n.max(0) as usize);
    pids
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

/// Why nothing can run in `dir`: it is gone (deleted, moved, its drive out), so the user is told
/// at once, never left waiting on a child that can't start.
pub fn gone(dir: &str) -> Option<String> {
    (!Path::new(dir).is_dir())
        .then(|| format!("This folder is gone. Remove the project, or put it back. ({dir})"))
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
