//! What macOS and Linux share: the walk up to the hosts, signals by checked group, the exec check,
//! and the children this process waits on itself.

use super::{all, args, group, info, short};
use std::collections::BTreeSet;
use std::ffi::CString;
use std::io;
use std::os::unix::ffi::OsStrExt;
use std::path::Path;
use std::process::{Child, Command};
use std::sync::Mutex;

/// The session hosts above `pid`, nearest first: each one's pid, start time and the session folder
/// it was started for. None when the walk couldn't reach the top, which is never the same as none.
pub fn hosts_above(pid: i32) -> Option<Vec<(i32, u64, String)>> {
    let mut found = vec![];
    let mut ppid = short(pid)?.0;
    // A parent of 1 is launchd or init: the top. The bound only guards against a cycle that can't be.
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

/// A pipe or socket end's kernel id is known here, so a hand-off can be proven.
pub const STDIO_KNOWN: bool = true;

/// KILL for every checked member of the group; how many there were.
pub fn kill_group(pgid: i32, not_before_us: u64) -> usize {
    signal_group(pgid, not_before_us, libc::SIGKILL)
}

/// TERM, and CONT so a stopped one can act on it, for every checked member; how many there were.
pub fn term_group(pgid: i32, not_before_us: u64) -> usize {
    let n = signal_group(pgid, not_before_us, libc::SIGTERM);
    signal_group(pgid, not_before_us, libc::SIGCONT);
    n
}

/// Whether a process with this pid is running now, whoever's it is.
pub fn alive(pid: i32) -> bool {
    unsafe { libc::kill(pid, 0) == 0 }
}

/// TERM for the process if it's still the one that started at `start_us`, and CONT if it's
/// stopped, so it can act on it.
pub fn term_checked(pid: i32, start_us: u64) {
    if let Some(p) = super::same(pid, start_us) {
        unsafe { libc::kill(pid, libc::SIGTERM) };
        if p.stopped {
            unsafe { libc::kill(pid, libc::SIGCONT) };
        }
    }
}

/// KILL for the process if it's still the one that started at `start_us`.
pub fn kill_checked(pid: i32, start_us: u64) {
    if super::same(pid, start_us).is_some() {
        unsafe { libc::kill(pid, libc::SIGKILL) };
    }
}

/// Signals every checked member of the group, one by one. Returns how many were signalled.
pub fn signal_group(pgid: i32, not_before_us: u64, sig: i32) -> usize {
    let members = group(&all(), pgid, not_before_us);
    for p in &members {
        unsafe { libc::kill(p.pid, sig) };
    }
    members.len()
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

/// Children this process started itself and waits on, by pid and start: a subreaper's reaping
/// leaves them to their owners.
static OWN: Mutex<BTreeSet<(i32, u64)>> = Mutex::new(BTreeSet::new());

/// Starts a child this process waits on itself, noted as its own.
pub fn spawn(command: &mut Command) -> io::Result<Child> {
    let child = command.spawn()?;
    own(child.id());
    Ok(child)
}

/// Notes a child this process started, right after it starts.
fn own(pid: u32) {
    let mut own = OWN.lock().unwrap();
    own.retain(|&(p, s)| info(p).is_some_and(|q| q.start_us == s));
    if let Some(p) = info(pid as i32) {
        own.insert((p.pid, p.start_us));
    }
}

pub fn is_own(pid: i32) -> bool {
    let own = OWN.lock().unwrap();
    info(pid).is_some_and(|p| own.contains(&(pid, p.start_us)))
}
