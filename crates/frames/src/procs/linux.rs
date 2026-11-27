//! Linux's sources: `/proc`. Start times are microseconds since 1970, boot time plus the start in
//! clock ticks, the same numbers brigadier-procs gives [D172].

use super::Proc;
use std::collections::BTreeSet;
use std::fs;
use std::path::PathBuf;
use std::sync::OnceLock;

/// Boot time in µs and clock ticks a second.
fn clock() -> Option<(u64, u64)> {
    static CLOCK: OnceLock<Option<(u64, u64)>> = OnceLock::new();
    *CLOCK.get_or_init(|| {
        let stat = fs::read_to_string("/proc/stat").ok()?;
        let boot: u64 = (stat.lines().find_map(|l| l.strip_prefix("btime ")))?
            .trim()
            .parse()
            .ok()?;
        let tick = unsafe { libc::sysconf(libc::_SC_CLK_TCK) };
        (tick > 0).then(|| (boot * 1_000_000, tick as u64))
    })
}

/// `/proc/<pid>/stat`'s fields after the name, which may hold spaces and parentheses: state is
/// the first, then ppid, pgrp, session, and the start in ticks is the 20th.
fn stat(pid: i32) -> Option<Vec<String>> {
    let text = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let rest = text.get(text.rfind(')')? + 1..)?;
    Some(rest.split_whitespace().map(str::to_owned).collect())
}

pub fn info(pid: i32) -> Option<Proc> {
    let f = stat(pid)?;
    let (boot, tick) = clock()?;
    let num = |i: usize| f.get(i)?.parse::<i64>().ok();
    let state = f.first()?.as_str();
    Some(Proc {
        pid,
        ppid: num(1)? as i32,
        pgid: num(2)? as i32,
        sid: num(3)? as i32,
        start_us: boot + num(19)? as u64 * 1_000_000 / tick,
        stopped: matches!(state, "T" | "t"),
        zombie: matches!(state, "Z" | "X"),
    })
}

fn words(pid: i32, file: &str) -> Option<Vec<String>> {
    let bytes = fs::read(format!("/proc/{pid}/{file}")).ok()?;
    Some(
        (bytes.split(|b| *b == 0))
            .filter(|w| !w.is_empty())
            .map(|w| String::from_utf8_lossy(w).into_owned())
            .collect(),
    )
}

/// A process's arguments and the environment it was started with, from the kernel. Only the
/// same user's processes answer, as on macOS: `environ` is the owner's alone.
pub fn args(pid: i32) -> Option<(Vec<String>, Vec<String>)> {
    Some((words(pid, "cmdline")?, words(pid, "environ")?))
}

/// A process's parent and short name, for every user's processes.
pub(super) fn short(pid: i32) -> Option<(i32, Vec<u8>)> {
    let text = fs::read(format!("/proc/{pid}/stat")).ok()?;
    let open = text.iter().position(|b| *b == b'(')?;
    let close = text.iter().rposition(|b| *b == b')')?;
    let name = text.get(open + 1..close)?.to_vec();
    let rest = String::from_utf8_lossy(text.get(close + 1..)?).into_owned();
    Some((rest.split_whitespace().nth(1)?.parse().ok()?, name))
}

/// The file a process runs.
pub fn exe(pid: i32) -> Option<PathBuf> {
    fs::read_link(format!("/proc/{pid}/exe")).ok()
}

/// The kernel's id of each socket, pipe or the like a process holds open, by fd: `socket:[id]`.
fn fd_link(pid: i32, fd: &str) -> Option<String> {
    let link = fs::read_link(format!("/proc/{pid}/fd/{fd}")).ok()?;
    link.to_str().map(str::to_owned)
}

fn inode(link: &str, kind: &str) -> Option<u64> {
    link.strip_prefix(kind)?
        .strip_prefix(":[")?
        .strip_suffix(']')?
        .parse()
        .ok()
}

/// The TCP ports a process listens on, one it holds on IPv4 and IPv6 once. Only the same user's
/// processes answer.
pub fn listening(pid: i32) -> BTreeSet<u16> {
    let socks: BTreeSet<u64> = (fs::read_dir(format!("/proc/{pid}/fd"))
        .into_iter()
        .flatten())
    .filter_map(|e| fd_link(pid, e.ok()?.file_name().to_str()?))
    .filter_map(|l| inode(&l, "socket"))
    .collect();
    let mut ports = BTreeSet::new();
    if socks.is_empty() {
        return ports;
    }
    for table in ["tcp", "tcp6"] {
        let text = fs::read_to_string(format!("/proc/{pid}/net/{table}")).unwrap_or_default();
        for line in text.lines().skip(1) {
            // sl local rem st tx:rx tr:when retrnsmt uid timeout inode
            let f: Vec<&str> = line.split_whitespace().collect();
            let (Some(local), Some(&"0A"), Some(ino)) = (f.get(1), f.get(3), f.get(9)) else {
                continue;
            };
            let port = local
                .rsplit(':')
                .next()
                .and_then(|p| u16::from_str_radix(p, 16).ok());
            if let (Some(port), Ok(ino)) = (port, ino.parse::<u64>())
                && socks.contains(&ino)
            {
                ports.insert(port);
            }
        }
    }
    ports
}

/// The pipe or socket ends a process has as its stdin and stdout, by the kernel's own ids: the same
/// in another one it passed them on to. None when either is neither.
pub fn stdio(pid: i32) -> Option<[u64; 2]> {
    let end = |fd| {
        let link = fd_link(pid, fd)?;
        inode(&link, "pipe").or_else(|| inode(&link, "socket"))
    };
    Some([end("0")?, end("1")?])
}

pub fn all() -> Vec<Proc> {
    (fs::read_dir("/proc").into_iter().flatten())
        .filter_map(|e| e.ok()?.file_name().to_str()?.parse::<i32>().ok())
        .filter_map(info)
        .filter(|p| !p.zombie)
        .collect()
}

/// A process's children now, from each of its threads' `children`; every process's record only
/// where the kernel keeps no such list.
pub fn children(pid: i32) -> Vec<i32> {
    let Ok(tasks) = fs::read_dir(format!("/proc/{pid}/task")) else {
        return vec![];
    };
    let mut found: Vec<i32> = vec![];
    for task in tasks.flatten() {
        match fs::read_to_string(task.path().join("children")) {
            Ok(text) => found.extend(
                text.split_whitespace()
                    .filter_map(|p| p.parse::<i32>().ok()),
            ),
            Err(_) => {
                let all = all();
                return all
                    .iter()
                    .filter(|p| p.ppid == pid)
                    .map(|p| p.pid)
                    .collect();
            }
        }
    }
    found
}
