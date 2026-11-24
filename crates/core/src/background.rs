//! A session's own processes, proven by pid and start time through its agent's, host's and daemon's
//! exit: those its host saw under its agent (`sightings`), else those started with its mark, and what
//! either proves by descent, group or session. Never by name, port or folder.

use crate::fold::Fold;
use brigadier_frames::background::{Links, grow, shared};
use brigadier_frames::forks;
use brigadier_frames::procs::{self, Proc};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// How long one read of every process's mark serves the index's pass over all sessions.
const MARKS_FOR: Duration = Duration::from_millis(900);
/// A process can still exec into one whose mark is readable this soon after its start.
const SETTLED_US: u64 = 10_000_000;
/// How long a stopped process has before the KILL.
const GRACE: Duration = Duration::from_secs(2);

/// The session folder each process was started for, where it shows its environment.
#[derive(Default)]
struct Marks {
    at: Option<Instant>,
    of: HashMap<(i32, u64), Option<String>>,
    by: BTreeMap<String, Vec<Proc>>,
}

static MARKS: Mutex<Option<Marks>> = Mutex::new(None);

impl Marks {
    fn read(&mut self, all: &[Proc]) {
        let now = brigadier_frames::log::now_ms() * 1000;
        let mut was = std::mem::take(&mut self.of);
        self.by.clear();
        for p in all {
            let key = (p.pid, p.start_us);
            let mark = was.remove(&key).unwrap_or_else(|| {
                let env = procs::args(p.pid).map(|a| a.1).unwrap_or_default();
                let name = format!("{}=", crate::agent::SESSION);
                env.iter()
                    .find_map(|v| v.strip_prefix(&name))
                    .map(Into::into)
            });
            if let Some(m) = &mark {
                self.by.entry(m.clone()).or_default().push(*p);
            }
            if mark.is_some() || now.saturating_sub(p.start_us) > SETTLED_US {
                self.of.insert(key, mark);
            }
        }
        self.at = Some(Instant::now());
    }
}

/// Every process proven to be the session's, its agent too while it runs.
pub fn proven(dir: &Path, fold: &Fold, all: &[Proc]) -> Vec<Proc> {
    of(dir, fold, all, MARKS_FOR)
}

fn of(dir: &Path, fold: &Fold, all: &[Proc], fresh: Duration) -> Vec<Proc> {
    if fold.groups.is_empty() {
        return vec![];
    }
    // Only spawned for this folder: a copied log names another's [D220].
    let here = fs::canonicalize(dir).unwrap_or_else(|_| dir.into());
    let own = |g: &&(i32, u64, String)| here.to_str() == Some(g.2.as_str());
    let Some(first) = fold.groups.iter().filter(own).map(|g| g.1).min() else {
        return vec![];
    };
    let at: HashMap<i32, &Proc> = all.iter().map(|p| (p.pid, p)).collect();
    let mut seeds = forks::read(dir);
    seeds.extend(
        (fold.child.iter())
            .filter(|c| !c.exited)
            .map(|c| (c.pid, c.start_us)),
    );
    let mut marks = MARKS.lock().unwrap_or_else(|e| e.into_inner());
    let marks = marks.get_or_insert_default();
    if marks.at.is_none_or(|t| t.elapsed() >= fresh) {
        marks.read(all);
    }
    let names = [dir.display().to_string(), here.display().to_string()];
    for p in (names.iter()).filter_map(|n| marks.by.get(n)).flatten() {
        // What launchd started only inherited it; under a shared server it's the server's.
        if p.sid > 1 && p.start_us > first && !under_shared(dir, p, &at) {
            seeds.push((p.pid, p.start_us));
        }
    }
    seeds.retain(|(pid, start)| at.get(pid).is_some_and(|p| p.start_us == *start));
    if seeds.is_empty() {
        return vec![];
    }
    // One started for another session of this data folder is that one's, whoever started it.
    let sessions = [dir.parent(), here.parent()].map(|d| d.map(Path::to_path_buf));
    let elsewhere = |p: &Proc| {
        (marks.of.get(&(p.pid, p.start_us)).cloned().flatten()).is_some_and(|m| {
            !names.contains(&m)
                && sessions.contains(&Path::new(&m).parent().map(Path::to_path_buf))
                && Path::new(&m).join("session.json").exists()
        })
    };
    let all: Vec<Proc> = all.iter().filter(|p| !elsewhere(p)).copied().collect();
    grow(dir, &all, &seeds, &mut Links::default())
}

fn under_shared(dir: &Path, p: &Proc, at: &HashMap<i32, &Proc>) -> bool {
    let mut next = Some(*p);
    // The bound only guards against a cycle that can't be.
    for _ in 0..256 {
        match next {
            Some(p) if shared(dir, &p) => return true,
            Some(p) => next = at.get(&p.ppid).map(|p| **p),
            None => return false,
        }
    }
    true
}

/// Ends proven processes and what they started, or with no `roots` all of the session's: a TERM,
/// then a KILL for whatever outlives the grace, each still the one it was. `first` runs once it's
/// known what goes, so one that loses its parent to it goes too. None: a live root isn't proven.
/// Else those still alive.
pub fn end(
    dir: &Path,
    fold: &Fold,
    roots: Option<&[(i32, u64)]>,
    first: impl FnOnce(),
) -> Option<Vec<Proc>> {
    let all = procs::all();
    let mine = of(dir, fold, &all, Duration::ZERO);
    let mut tree = vec![];
    for root in roots.unwrap_or_default() {
        match mine.iter().find(|p| (p.pid, p.start_us) == *root) {
            Some(p) => tree.push(*p),
            None if procs::same(root.0, root.1).is_some() => return None,
            None => continue,
        }
        tree.extend(procs::descendants(&mine, root.0));
    }
    if roots.is_none() {
        tree = mine;
    }
    // One another session's host saw under its own agent is never ended here.
    let others = others(dir);
    tree.retain(|p| !others.contains(&(p.pid, p.start_us)));
    first();
    signal(&tree, libc::SIGTERM);
    wait(&tree, GRACE);
    // What they started meanwhile goes too.
    let all = procs::all();
    let more: Vec<Proc> = (alive(&tree).iter())
        .flat_map(|p| procs::descendants(&all, p.pid))
        .filter(|p| !shared(dir, p) && !tree.iter().any(|t| t.pid == p.pid))
        .filter(|p| !others.contains(&(p.pid, p.start_us)))
        .collect();
    tree.extend(more);
    signal(&tree, libc::SIGKILL);
    wait(&tree, Duration::from_secs(1));
    Some(alive(&tree))
}

/// Ends all of the session's for good, its agent gone; but a mockup's server, which the user may
/// still compare: only its delete says that's over.
pub fn end_left(dir: &Path) -> io::Result<()> {
    if dir.join("mockup.json").exists() {
        return Ok(());
    }
    let fold = crate::fold(dir, true)?.fold;
    match end(dir, &fold, None, || ()).unwrap_or_default().first() {
        Some(p) => Err(io::Error::other(format!("process {} didn't stop", p.pid))),
        None => Ok(()),
    }
}

fn alive(tree: &[Proc]) -> Vec<Proc> {
    (tree.iter())
        .filter_map(|p| procs::same(p.pid, p.start_us))
        .collect()
}

fn signal(tree: &[Proc], sig: i32) {
    for p in alive(tree) {
        unsafe { libc::kill(p.pid, sig) };
        // A stopped one acts on a TERM only once it goes on.
        if sig == libc::SIGTERM && p.stopped {
            unsafe { libc::kill(p.pid, libc::SIGCONT) };
        }
    }
}

fn wait(tree: &[Proc], grace: Duration) {
    let until = Instant::now() + grace;
    while Instant::now() < until && !alive(tree).is_empty() {
        std::thread::sleep(Duration::from_millis(25));
    }
}

/// What the other sessions of this data folder have seen under their agents.
fn others(dir: &Path) -> HashSet<(i32, u64)> {
    (dir.parent()
        .and_then(|d| fs::read_dir(d).ok())
        .into_iter()
        .flatten())
    .flatten()
    .filter(|e| Some(e.file_name().as_os_str()) != dir.file_name())
    .flat_map(|e| forks::read(&e.path()))
    .collect()
}

/// A session's throwaway files and test instances, its own folder's `tmp`: gone with it.
pub fn tmp(dir: &Path) -> PathBuf {
    dir.join("tmp")
}
