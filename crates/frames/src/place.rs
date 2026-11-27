//! Windows: Git's shell (Cygwin) leaves its job for each program it runs, so a tool's `sleep 300 &`
//! leaves its group's job, and neither Stop nor its host's end would reach it. Cygwin's own process
//! group says what macOS's would: led by a member of a group job this host holds, it goes back into
//! that job; led by one gone or by itself with its parent gone (setsid, a double fork), it's detached
//! work, found by its mark as on macOS. An exec'd root, which keeps its own Cygwin pid, and a native
//! program follow the live parent that started it (proposed).

use crate::procs::{self, Proc};
use crate::win;
use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, mpsc};
use std::thread;
use std::time::Duration;

/// The session's file of what's been put back: `reads N`, how many times Cygwin's processes were
/// read, then `pid start_us leader` a line, each one's Cygwin group leader standing in for the
/// parent Cygwin's exec left gone, so D114's walk up to an MCP server still reaches it.
pub const PLACED: &str = "placed";

#[derive(Default)]
struct State {
    /// Each one looked at once, by pid and start: put back, left detached, or not this session's.
    done: HashSet<(i32, u64)>,
    placed: Vec<(i32, u64, u32)>,
    reads: u64,
}

static STATE: Mutex<Option<State>> = Mutex::new(None);

/// One Cygwin process as its install's `/proc` shows it.
#[derive(Default)]
struct Ids {
    winpid: u32,
    pgid: u32,
    mark: Option<String>,
}

/// Puts back what this session's tools started outside every job of ours, at least `min_us` old,
/// and gives the session's detached ones, for its sightings: Cygwin keeps a program's environment,
/// its mark too, to itself. Cygwin's processes are read only when one outside every job of ours,
/// or a native one with this session's mark, is that old and not yet looked at, once per install.
pub fn place(dir: &Path, min_us: u64) -> Vec<(i32, u64)> {
    let held: HashSet<u32> = win::held_members().into_iter().collect();
    if held.is_empty() {
        return vec![];
    }
    let mut state = STATE.lock().unwrap_or_else(|e| e.into_inner());
    let state = state.get_or_insert_default();
    let all = procs::all();
    let live: HashSet<(i32, u64)> = all.iter().map(|p| (p.pid, p.start_us)).collect();
    state.done.retain(|k| live.contains(k));
    let was = state.placed.len();
    state.placed.retain(|p| live.contains(&(p.0, p.1)));
    let now = crate::log::now_ms() * 1000;
    let mut installs: Vec<PathBuf> = vec![];
    let mut waiting: Vec<(Proc, bool)> = vec![];
    for p in &all {
        let young = now.saturating_sub(p.start_us) < min_us;
        if p.pgid != 0 || young || state.done.contains(&(p.pid, p.start_us)) {
            continue;
        }
        // Where it runs from and its mark are there from the start: one look decides it for good.
        state.done.insert((p.pid, p.start_us));
        let bin = cygwin(p.pid);
        let marked = marked(p.pid, dir);
        if bin.is_some() || marked {
            waiting.push((*p, marked));
        }
        if let Some(bin) = bin.filter(|b| !installs.contains(b)) {
            installs.push(bin);
        }
    }
    if waiting.is_empty() {
        if state.placed.len() != was {
            write(dir, state);
        }
        return vec![];
    }
    for pid in &held {
        if let Some(bin) = cygwin(*pid as i32).filter(|b| !installs.contains(b)) {
            installs.push(bin);
        }
    }
    // Each Cygwin process's group leader when that one runs, and whether it carries the mark.
    let (mut leader, mut cygwin_marked) = (HashMap::new(), HashSet::new());
    for bin in &installs {
        state.reads += 1;
        let ids = read(bin);
        for id in ids.values() {
            if let Some(lead) = ids.get(&id.pgid) {
                leader.insert(id.winpid, lead.winpid);
            }
            if id.mark.as_deref().is_some_and(|m| same(m, dir)) {
                cygwin_marked.insert(id.winpid);
            }
        }
    }
    let start = |pid: u32| all.iter().find(|p| p.pid == pid as i32).map(|p| p.start_us);
    let mut placed = held;
    loop {
        let mut more = false;
        for (p, _) in &waiting {
            let me = p.pid as u32;
            if placed.contains(&me) {
                continue;
            }
            // Led by a live other: that one decides. Else (an exec'd root keeps its own Cygwin pid,
            // a native program has none) the live parent that started it does; a setsid'd one's
            // is gone.
            let by = match leader.get(&me) {
                Some(l) if *l != me => *l,
                _ => p.ppid as u32,
            };
            let by = Some(by)
                .filter(|b| placed.contains(b) && start(*b).is_some_and(|s| s <= p.start_us));
            if let Some(b) = by.filter(|b| win::rejoin(*b, me, p.start_us)) {
                placed.insert(me);
                state.placed.push((p.pid, p.start_us, b));
                more = true;
            }
        }
        if !more {
            break;
        }
    }
    write(dir, state);
    let ours = |p: &Proc, marked: bool| marked || cygwin_marked.contains(&(p.pid as u32));
    (waiting.iter())
        .filter(|(p, m)| !placed.contains(&(p.pid as u32)) && ours(p, *m))
        .map(|(p, _)| (p.pid, p.start_us))
        .collect()
}

/// The folder of the Cygwin install the process runs from, if it's one's program.
fn cygwin(pid: i32) -> Option<PathBuf> {
    let bin = procs::exe(pid)?.parent()?.to_path_buf();
    ["msys-2.0.dll", "cygwin1.dll"]
        .iter()
        .any(|d| bin.join(d).exists())
        .then_some(bin)
}

fn same(mark: &str, dir: &Path) -> bool {
    let norm = |s: &str| s.replace('/', "\\");
    norm(mark).eq_ignore_ascii_case(&norm(&dir.to_string_lossy()))
}

/// Whether its Windows environment carries this session's mark (a native program's does).
fn marked(pid: i32, dir: &Path) -> bool {
    let env = win::environ(pid as u32).unwrap_or_default();
    env.iter()
        .any(|v| v.strip_prefix(MARK).is_some_and(|m| same(m, dir)))
}

const MARK: &str = "BRIGADIER_SESSION=";

fn write(dir: &Path, state: &State) {
    let mut text = format!("reads {}\n", state.reads);
    for (pid, start, leader) in &state.placed {
        text += &format!("{pid} {start} {leader}\n");
    }
    // In place: a rename would read as the session having changed.
    if let Err(e) = std::fs::write(dir.join(PLACED), text) {
        eprintln!("brigadier-host: keeping what was put back: {e}");
    }
}

/// What's been put back, by pid and start, with the leader that stands in for its parent.
pub fn leaders(dir: &Path) -> HashMap<(i32, u64), i32> {
    let text = std::fs::read_to_string(dir.join(PLACED)).unwrap_or_default();
    let line = |l: &str| {
        let mut w = l.split(' ').map(str::parse::<u64>);
        let (Some(Ok(pid)), Some(Ok(start)), Some(Ok(leader))) = (w.next(), w.next(), w.next())
        else {
            return None;
        };
        Some(((pid as i32, start), leader as i32))
    };
    text.lines().skip(1).filter_map(line).collect()
}

/// One install's processes from its own `/proc`, by Cygwin pid: their Windows pid, process group
/// and mark. Nothing when it can't be read in 2 s.
fn read(bin: &Path) -> HashMap<u32, Ids> {
    let mut sh = Command::new(bin.join("sh.exe"));
    let marks = format!("grep -a -o -H '{MARK}[^[:cntrl:]]*' /proc/[0-9]*/environ");
    sh.args([
        "-c",
        &format!("grep -H . /proc/[0-9]*/winpid /proc/[0-9]*/pgid; {marks}"),
    ])
    .stdin(Stdio::null())
    .stdout(Stdio::piped())
    .stderr(Stdio::null());
    // CREATE_NO_WINDOW
    std::os::windows::process::CommandExt::creation_flags(&mut sh, 0x0800_0000);
    let Ok(mut child) = sh.spawn() else {
        return HashMap::new();
    };
    let (tx, rx) = mpsc::channel();
    let mut out = child.stdout.take();
    thread::spawn(move || {
        let mut text = String::new();
        let _ = out.as_mut().map(|o| o.read_to_string(&mut text));
        let _ = tx.send(text);
    });
    let text = rx.recv_timeout(Duration::from_secs(2)).unwrap_or_default();
    // Our own child, by its handle.
    let _ = child.kill();
    let _ = child.wait();
    let mut ids: HashMap<u32, Ids> = HashMap::new();
    for line in text.lines() {
        let Some((path, value)) = line.split_once(':') else {
            continue;
        };
        let mut parts = path.trim_start_matches("/proc/").split('/');
        let (Some(Ok(cyg)), Some(field)) = (parts.next().map(str::parse::<u32>), parts.next())
        else {
            continue;
        };
        let e = ids.entry(cyg).or_default();
        let n = value.trim().parse().unwrap_or(0);
        match field {
            "winpid" => e.winpid = n,
            "pgid" => e.pgid = n,
            _ => e.mark = value.strip_prefix(MARK).map(String::from),
        }
    }
    ids.retain(|_, e| e.winpid != 0);
    ids
}
