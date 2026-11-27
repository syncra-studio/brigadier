//! Following what a session's agent starts: the kernel says when a followed process forks, so a
//! short-lived parent is seen before what it started is reparented, and when it exits, so a group
//! it leaves empty is forgotten. With nothing followed it sleeps.

use crate::background::{self, Links};
use crate::procs::{self, Proc};
use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

/// The session's sightings: its folder on the first line, so a copied folder's are never taken for
/// its own [D220], then one `pid start_us` a line.
pub const SEEN: &str = "sightings";
/// What lives at least this long is kept; the rest is a step's own command.
const KEEP_US: u64 = 2_000_000;
/// A full look this soon after a fork or an exit, then each second while something's still young.
const LOOK: Duration = Duration::from_millis(250);
/// The sightings are rewritten with only the live ones past this many.
const LINES: usize = 4000;

struct State {
    dir: PathBuf,
    #[cfg_attr(target_os = "linux", allow(dead_code))]
    kq: i32,
    /// Each live one, and whether it's kept in the file.
    known: BTreeMap<(i32, u64), bool>,
    links: Links,
    lines: usize,
}

#[derive(Clone)]
pub struct Forks(Arc<Mutex<State>>);

impl Forks {
    /// Carries on from the session's file: what's still alive of it.
    pub fn open(dir: &Path) -> io::Result<Forks> {
        let kq = queue()?;
        let mut state = State {
            dir: dir.to_path_buf(),
            kq,
            known: BTreeMap::new(),
            links: Links::default(),
            lines: 0,
        };
        for (pid, start) in read(dir) {
            if let Some(p) = procs::same(pid, start) {
                state.known.insert((pid, start), true);
                state.links.add(&p);
            }
        }
        if dir.join(SEEN).exists() {
            state.rewrite();
        }
        for (pid, _) in state.known.keys() {
            state.watch(*pid);
        }
        let forks = Forks(Arc::new(Mutex::new(state)));
        let me = forks.clone();
        thread::spawn(move || me.run(kq));
        Ok(forks)
    }

    /// Follows the agent and all it starts. Called before it runs.
    pub fn follow(&self, pid: i32) {
        self.0.lock().unwrap().see(pid);
    }

    /// Keeps even the youngest, as its host goes.
    pub fn keep(&self) {
        let mut state = self.0.lock().unwrap();
        state.look();
        state.known.values_mut().for_each(|kept| *kept = true);
        if !state.known.is_empty() {
            state.rewrite();
        }
    }

    #[cfg(target_os = "macos")]
    fn run(&self, kq: i32) {
        let mut events: [libc::kevent; 64] = unsafe { std::mem::zeroed() };
        let mut due = Some(Instant::now());
        loop {
            let wait = due.map(|d| {
                let left = d.saturating_duration_since(Instant::now());
                libc::timespec {
                    tv_sec: left.as_secs() as _,
                    tv_nsec: left.subsec_nanos() as _,
                }
            });
            let wait = wait.as_ref().map_or(std::ptr::null(), |w| w as *const _);
            let null = std::ptr::null();
            let n = unsafe { libc::kevent(kq, null, 0, events.as_mut_ptr(), 64, wait) };
            let mut state = self.0.lock().unwrap();
            for e in &events[..n.max(0) as usize] {
                let pid = e.ident as i32;
                let alive = procs::info(pid).filter(|p| !background::shared(&state.dir, p));
                if e.fflags & libc::NOTE_FORK != 0 && alive.is_some() {
                    procs::children(pid).into_iter().for_each(|c| state.see(c));
                }
            }
            if n > 0 {
                let soon = Instant::now() + LOOK;
                due = Some(due.map_or(soon, |d| d.min(soon)));
            }
            if due.is_some_and(|d| d <= Instant::now()) {
                due = state
                    .look()
                    .then(|| Instant::now() + Duration::from_secs(1));
            }
        }
    }
    /// Linux has no fork event: while anything is followed, each look reads the children of every
    /// known one, the orphans this host adopted as their subreaper and, in a scope of its own, every
    /// member of its control group, which a double fork can't leave (proposed). An exit is a known
    /// one gone. It reaps the orphans it adopted, never a child of its own.
    #[cfg(target_os = "linux")]
    fn run(&self, _kq: i32) {
        let me = std::process::id() as i32;
        let scope = scope();
        let mut due = Some(Instant::now());
        let mut dead = std::collections::BTreeSet::new();
        loop {
            let idle = due.is_none() && self.0.lock().unwrap().known.is_empty();
            thread::sleep(if idle { Duration::from_secs(1) } else { LOOK });
            dead = reap(me, &dead);
            let mut state = self.0.lock().unwrap();
            let had: Vec<i32> = state.known.keys().map(|k| k.0).collect();
            let gone = had.iter().any(|&p| !state.watch(p));
            let mut new: Vec<i32> = had.iter().flat_map(|&p| procs::children(p)).collect();
            new.extend(
                procs::children(me)
                    .into_iter()
                    .filter(|&c| !procs::is_own(c)),
            );
            if let Some(scope) = &scope {
                let members = fs::read_to_string(scope).unwrap_or_default();
                new.extend(members.lines().filter_map(|l| l.parse::<i32>().ok()));
            }
            let before = state.known.len();
            new.into_iter()
                .filter(|&p| p != me)
                .for_each(|p| state.see(p));
            if gone || state.known.len() != before {
                let soon = Instant::now() + LOOK;
                due = Some(due.map_or(soon, |d| d.min(soon)));
            }
            if due.is_some_and(|d| d <= Instant::now()) {
                due = state
                    .look()
                    .then(|| Instant::now() + Duration::from_secs(1));
            }
        }
    }
}

#[cfg(target_os = "macos")]
fn queue() -> io::Result<i32> {
    let kq = unsafe { libc::kqueue() };
    if kq < 0 {
        return Err(io::Error::last_os_error());
    }
    unsafe { libc::fcntl(kq, libc::F_SETFD, libc::FD_CLOEXEC) };
    Ok(kq)
}

#[cfg(target_os = "linux")]
fn queue() -> io::Result<i32> {
    Ok(-1)
}

/// This host's own control group's member list, when it runs in a scope of its own: the daemon
/// names each host's scope `brigadier-<…>.scope` (proposed).
#[cfg(target_os = "linux")]
fn scope() -> Option<PathBuf> {
    let text = fs::read_to_string("/proc/self/cgroup").ok()?;
    let path = text.lines().find_map(|l| l.strip_prefix("0::"))?;
    let name = path.rsplit('/').next()?;
    (name.starts_with("brigadier-") && name.ends_with(".scope")).then(|| {
        Path::new("/sys/fs/cgroup")
            .join(path.trim_start_matches('/'))
            .join("cgroup.procs")
    })
}

/// Waits on the adopted orphans that have exited: a zombie child this host didn't start itself,
/// seen dead on two looks in a row, so a child of its own is always its owner's to wait on.
#[cfg(target_os = "linux")]
fn reap(
    me: i32,
    was: &std::collections::BTreeSet<(i32, u64)>,
) -> std::collections::BTreeSet<(i32, u64)> {
    let mut now = std::collections::BTreeSet::new();
    for pid in procs::children(me) {
        let Some(p) = procs::info(pid).filter(|p| p.zombie && !procs::is_own(pid)) else {
            continue;
        };
        if was.contains(&(pid, p.start_us)) {
            unsafe { libc::waitpid(pid, std::ptr::null_mut(), libc::WNOHANG) };
        } else {
            now.insert((pid, p.start_us));
        }
    }
    now
}

impl State {
    /// False: it's gone already.
    #[cfg(target_os = "linux")]
    fn watch(&self, pid: i32) -> bool {
        procs::info(pid).is_some_and(|p| !p.zombie)
    }

    /// False: it's gone already.
    #[cfg(target_os = "macos")]
    fn watch(&self, pid: i32) -> bool {
        let event = libc::kevent {
            ident: pid as usize,
            filter: libc::EVFILT_PROC,
            flags: libc::EV_ADD | libc::EV_CLEAR,
            fflags: libc::NOTE_FORK | libc::NOTE_EXIT,
            data: 0,
            udata: std::ptr::null_mut(),
        };
        let (none, null) = (std::ptr::null_mut(), std::ptr::null());
        unsafe { libc::kevent(self.kq, &event, 1, none, 0, null) == 0 }
    }

    /// One more of the session's, and what it has started by now.
    fn see(&mut self, pid: i32) {
        let Some(p) = procs::info(pid).filter(|p| !p.zombie) else {
            return;
        };
        if self.known.contains_key(&(pid, p.start_us)) || background::shared(&self.dir, &p) {
            return;
        }
        self.known.insert((pid, p.start_us), false);
        self.links.add(&p);
        self.watch(pid);
        procs::children(pid).into_iter().for_each(|c| self.see(c));
    }

    /// A full look: what the known ones prove by now, and those old enough kept. Says whether any
    /// is still too young.
    fn look(&mut self) -> bool {
        let all = procs::all();
        self.links.prune(&all);
        let seeds: Vec<(i32, u64)> = self.known.keys().copied().collect();
        let mine = background::grow(&self.dir, &all, &seeds, &mut self.links);
        let was = std::mem::take(&mut self.known);
        let now = crate::log::now_ms() * 1000;
        let old = |p: &Proc| now.saturating_sub(p.start_us) >= KEEP_US;
        let (mut fresh, mut young) = (String::new(), false);
        for p in &mine {
            let key = (p.pid, p.start_us);
            // One gone as it was found tells no exit: the next look sees it.
            young |= !was.contains_key(&key) && !self.watch(p.pid);
            let kept = was.get(&key) == Some(&true);
            if !kept && old(p) {
                fresh += &format!("{} {}\n", p.pid, p.start_us);
                self.lines += 1;
            }
            young |= !old(p);
            self.known.insert(key, kept || old(p));
        }
        if fresh.is_empty() {
            return young;
        }
        if self.lines > LINES || !self.dir.join(SEEN).exists() {
            self.rewrite();
        } else if let Err(e) = (OpenOptions::new().append(true).open(self.dir.join(SEEN)))
            .and_then(|mut f| f.write_all(fresh.as_bytes()))
        {
            eprintln!("brigadier-host: keeping sightings: {e}");
        }
        young
    }

    /// In place: a rename would read as the session having changed.
    fn rewrite(&mut self) {
        let kept: Vec<_> = (self.known.iter()).filter(|k| *k.1).map(|k| k.0).collect();
        let mut text = format!("{}\n", here(&self.dir));
        for (pid, start) in &kept {
            text += &format!("{pid} {start}\n");
        }
        self.lines = kept.len();
        let wrote =
            File::create(self.dir.join(SEEN)).and_then(|mut f| f.write_all(text.as_bytes()));
        if let Err(e) = wrote {
            eprintln!("brigadier-host: keeping sightings: {e}");
        }
    }
}

fn here(dir: &Path) -> String {
    let dir = fs::canonicalize(dir).unwrap_or_else(|_| dir.into());
    dir.display().to_string()
}

/// The sightings a session's file holds, dead ones too; a torn line is left out.
pub fn read(dir: &Path) -> Vec<(i32, u64)> {
    let text = fs::read_to_string(dir.join(SEEN)).unwrap_or_default();
    let whole = text.rsplit_once('\n').map_or("", |t| t.0);
    if whole.is_empty() {
        return vec![];
    }
    let mut lines = whole.lines();
    if lines.next() != Some(here(dir).as_str()) {
        return vec![];
    }
    (lines.filter_map(|l| l.split_once(' ')))
        .filter_map(|(p, s)| Some((p.parse().ok()?, s.parse().ok()?)))
        .collect()
}
