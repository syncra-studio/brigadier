//! Windows' process facts: Toolhelp snapshots, GetProcessTimes for the start, and the named jobs
//! (crate::win) for groups and hosts. There are no process sessions or stopped processes, so `sid`
//! is 0 and `stopped` false; a pgid is the pid of the child whose `g` job holds the process.

use super::Proc;
use crate::win::{self, GROUP, HOST, Handle};
use std::collections::{BTreeSet, HashMap};
use std::io;
use std::mem::size_of;
use std::path::{Path, PathBuf};
use windows_sys::Win32::NetworkManagement::IpHelper::{
    GetExtendedTcpTable, TCP_TABLE_OWNER_PID_LISTENER,
};
use windows_sys::Win32::Networking::WinSock::{AF_INET, AF_INET6};
use windows_sys::Win32::System::ProcessStatus::{
    K32GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS, PROCESS_MEMORY_COUNTERS_EX,
};
use windows_sys::Win32::System::Threading::{
    PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW,
};

/// No process's stdin and stdout can be told apart by kernel id here, so callers that would
/// prove a pipe hand-off keep what they can't prove instead [D114].
pub const STDIO_KNOWN: bool = false;

fn query(pid: u32) -> Option<Handle> {
    win::open(pid, PROCESS_QUERY_LIMITED_INFORMATION)
}

/// Each process in a live group job, by the group's pid: the innermost (latest-started) job's.
fn pgids() -> HashMap<u32, (i32, u64)> {
    let mut of: HashMap<u32, (i32, u64)> = HashMap::new();
    for (leader, start) in win::jobs(GROUP) {
        let Some(job) = win::open_job(GROUP, leader, start) else {
            continue;
        };
        for pid in win::members(&job) {
            let e = of.entry(pid).or_insert((leader as i32, start));
            if start > e.1 {
                *e = (leader as i32, start);
            }
        }
    }
    of
}

fn proc_of(pid: u32, ppid: u32, groups: &HashMap<u32, (i32, u64)>) -> Option<Proc> {
    let p = query(pid)?;
    if !win::live(&p) {
        return None;
    }
    Some(Proc {
        pid: pid as i32,
        ppid: ppid as i32,
        pgid: groups.get(&pid).map_or(0, |g| g.0),
        sid: 0,
        start_us: win::start_us(&p)?,
        stopped: false,
        zombie: false,
    })
}

pub fn info(pid: i32) -> Option<Proc> {
    let pid = u32::try_from(pid).ok().filter(|p| *p != 0)?;
    let ppid = win::parent(&query(pid)?)?;
    proc_of(pid, ppid, &pgids())
}

/// A process's arguments, split as its C runtime would, and its environment.
pub fn args(pid: i32) -> Option<(Vec<String>, Vec<String>)> {
    let pid = u32::try_from(pid).ok()?;
    let line = win::cmdline(&query(pid)?)?;
    let argv = win::split(&line)
        .into_iter()
        .map(|a| a.replace('\\', "/"))
        .collect();
    Some((argv, win::environ(pid).unwrap_or_default()))
}

/// The session hosts whose jobs hold `pid`, nearest (latest-started) first: each one's pid, start
/// and the session folder it was started for. A child can't leave its host's job unless it broke
/// away, and can't join one, so this can't be faked the way a parent pid could.
pub fn hosts_above(pid: i32) -> Option<Vec<(i32, u64, String)>> {
    let me = u32::try_from(pid).ok()?;
    let mut found = vec![];
    for (host, start) in win::jobs(HOST).into_iter().filter(|(h, _)| *h != me) {
        let Some(job) = win::open_job(HOST, host, start) else {
            continue;
        };
        if !win::members(&job).contains(&me) {
            continue;
        }
        if super::same(host as i32, start).is_none() {
            continue;
        }
        let (argv, _) = args(host as i32)?;
        found.push((host as i32, start, argv.get(1)?.clone()));
    }
    found.sort_by_key(|h| std::cmp::Reverse(h.1));
    Some(found)
}

/// The file a process runs.
pub fn exe(pid: i32) -> Option<PathBuf> {
    let p = query(u32::try_from(pid).ok()?)?;
    let mut buf = vec![0u16; 32768];
    let mut len = buf.len() as u32;
    if unsafe { QueryFullProcessImageNameW(p.0, PROCESS_NAME_WIN32, buf.as_mut_ptr(), &mut len) }
        == 0
    {
        return None;
    }
    Some(PathBuf::from(String::from_utf16_lossy(
        &buf[..len as usize],
    )))
}

/// The TCP ports a process listens on, one it holds on IPv4 and IPv6 once.
pub fn listening(pid: i32) -> BTreeSet<u16> {
    let mut ports = BTreeSet::new();
    // MIB_TCPROW_OWNER_PID and MIB_TCP6ROW_OWNER_PID in u32 words: (size, local port, owner).
    for (family, words, port, owner) in [(AF_INET, 6, 2, 5), (AF_INET6, 14, 5, 13)] {
        let mut size = 0u32;
        let null = std::ptr::null_mut();
        let class = TCP_TABLE_OWNER_PID_LISTENER;
        unsafe { GetExtendedTcpTable(null, &mut size, 0, family as u32, class, 0) };
        let mut buf = vec![0u32; size as usize / 4 + 64];
        size = (buf.len() * 4) as u32;
        let at = buf.as_mut_ptr().cast();
        if unsafe { GetExtendedTcpTable(at, &mut size, 0, family as u32, class, 0) } != 0 {
            continue;
        }
        let n = buf[0] as usize;
        for row in buf[1..].chunks_exact(words).take(n) {
            if row[owner] as i32 == pid {
                ports.insert(u16::from_be(row[port] as u16));
            }
        }
    }
    ports
}

/// Not known here: see STDIO_KNOWN.
pub fn stdio(_pid: i32) -> Option<[u64; 2]> {
    None
}

pub fn all() -> Vec<Proc> {
    let groups = pgids();
    win::processes()
        .iter()
        .filter(|e| e.th32ProcessID != 0)
        .filter_map(|e| proc_of(e.th32ProcessID, e.th32ParentProcessID, &groups))
        .collect()
}

/// A process's children now: those naming it as parent that started after it did, since a dead
/// parent's pid can be reused and Windows never reparents.
pub fn children(pid: i32) -> Vec<i32> {
    let Some(start) = info(pid).map(|p| p.start_us) else {
        return vec![];
    };
    (win::processes().iter())
        .filter(|e| e.th32ParentProcessID as i32 == pid && e.th32ProcessID as i32 != pid)
        .filter_map(|e| query(e.th32ProcessID).map(|h| (e.th32ProcessID, h)))
        .filter(|(_, h)| win::start_us(h).is_some_and(|s| s >= start))
        .map(|(p, _)| p as i32)
        .collect()
}

/// Ends every process of the group's job; how many there were. The job's own name carries the
/// leader's start, so a reused pid names no job [D97 D100].
pub fn kill_group(pgid: i32, not_before_us: u64) -> usize {
    let Some(job) = u32::try_from(pgid)
        .ok()
        .and_then(|g| win::open_job(GROUP, g, not_before_us))
    else {
        return 0;
    };
    let n = win::members(&job).len();
    win::terminate(&job);
    n
}

/// Windows has no TERM to send a group: the polite stop is the runner's own (Ctrl-C on its
/// terminal, or its input closed). Counts the group's live members.
pub fn term_group(pgid: i32, not_before_us: u64) -> usize {
    u32::try_from(pgid)
        .ok()
        .and_then(|g| win::open_job(GROUP, g, not_before_us))
        .map_or(0, |job| win::members(&job).len())
}

/// Starts a child this process waits on itself, with no console window of its own.
pub fn spawn(command: &mut std::process::Command) -> io::Result<std::process::Child> {
    use std::os::windows::process::CommandExt;
    command
        .creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW)
        .spawn()
}

/// Whether a process with this pid is running now, whoever's it is.
pub fn alive(pid: i32) -> bool {
    u32::try_from(pid)
        .ok()
        .and_then(query)
        .is_some_and(|p| win::live(&p))
}

/// Windows has no TERM for one process: a selected one is only ever ended outright.
pub fn term_checked(_pid: i32, _start_us: u64) {}

/// Ends the process if it's still the one that started at `start_us`, through the one handle that
/// was checked, so a pid reused in between is never hit [D97 D100].
pub fn kill_checked(pid: i32, start_us: u64) {
    use windows_sys::Win32::System::Threading::{PROCESS_TERMINATE, TerminateProcess};
    let Some(p) = u32::try_from(pid)
        .ok()
        .and_then(|pid| win::open(pid, PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE))
    else {
        return;
    };
    if win::live(&p) && win::start_us(&p) == Some(start_us) {
        unsafe { TerminateProcess(p.0, 1) };
    }
}

/// Private bytes, the figure Task Manager shows as Memory.
pub fn footprint(pid: i32) -> Option<u64> {
    let p = query(u32::try_from(pid).ok()?)?;
    let mut c = PROCESS_MEMORY_COUNTERS_EX {
        cb: size_of::<PROCESS_MEMORY_COUNTERS_EX>() as u32,
        ..Default::default()
    };
    let at = (&mut c as *mut PROCESS_MEMORY_COUNTERS_EX).cast::<PROCESS_MEMORY_COUNTERS>();
    (unsafe { K32GetProcessMemoryInfo(p.0, at, c.cb) } != 0).then_some(c.PrivateUsage as u64)
}

/// The extensions a bare name may run with, PATHEXT's or Windows' own default.
pub fn pathext() -> Vec<String> {
    std::env::var("PATHEXT")
        .unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into())
        .split(';')
        .filter(|e| !e.is_empty())
        .map(|e| e.to_ascii_lowercase())
        .collect()
}

/// The file `program` names: a path against `cwd`, a bare name along `path`, each tried as given
/// and with PATHEXT's extensions, as CreateProcess and cmd find it.
pub fn find(program: &str, path: Option<&str>, cwd: &str) -> Option<PathBuf> {
    let exts = pathext();
    let try_in = |dir: &Path| {
        let base = dir.join(program);
        let has = base.extension().is_some_and(|e| {
            exts.contains(&format!(".{}", e.to_string_lossy().to_ascii_lowercase()))
        });
        (has.then(|| base.clone()).into_iter())
            .chain(
                exts.iter()
                    .map(|e| PathBuf::from(format!("{}{e}", base.display()))),
            )
            .find(|p| p.is_file())
    };
    if program.contains(['/', '\\']) {
        return try_in(Path::new(cwd));
    }
    let dirs = path.map_or_else(|| std::env::var("PATH").unwrap_or_default(), String::from);
    dirs.split(';')
        .filter(|d| !d.is_empty())
        .find_map(|d| try_in(Path::new(d)))
}

/// Fails as CreateProcess would for a program that isn't there.
pub fn runnable(program: &str, path: Option<&str>, cwd: &str) -> io::Result<()> {
    find(program, path, cwd)
        .map(|_| ())
        .ok_or_else(|| io::Error::from(io::ErrorKind::NotFound))
}
