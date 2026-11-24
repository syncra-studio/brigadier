//! A session's own processes, proven by pid and start time through its agent's, host's and daemon's
//! exit: those its host saw under its agent (`sightings`), else those started with its mark, and what
//! either proves by descent, group or session. Never by name, port or folder. Each has one owner.

use crate::fold::Fold;
use brigadier_frames::background::{Links, grow, shared};
use brigadier_frames::forks;
use brigadier_frames::procs::{self, Proc};
use std::collections::HashMap;
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
/// How often what's started as the rest is killed is looked for and killed too.
const ROUNDS: usize = 3;

/// The session folder each process was started for, where it shows its environment, and the
/// session of one data folder that owns it.
#[derive(Default)]
struct Marks {
    at: Option<(Instant, PathBuf)>,
    of: HashMap<(i32, u64), Option<String>>,
    owner: HashMap<(i32, u64), String>,
}

static MARKS: Mutex<Option<Marks>> = Mutex::new(None);

impl Marks {
    fn read(&mut self, dir: &Path, all: &[Proc]) {
        let now = brigadier_frames::log::now_ms() * 1000;
        let mut was = std::mem::take(&mut self.of);
        for p in all {
            let key = (p.pid, p.start_us);
            let mark = was.remove(&key).unwrap_or_else(|| {
                let env = procs::args(p.pid).map(|a| a.1).unwrap_or_default();
                let name = format!("{}=", crate::agent::SESSION);
                env.iter()
                    .find_map(|v| v.strip_prefix(&name))
                    .map(Into::into)
            });
            if mark.is_some() || now.saturating_sub(p.start_us) > SETTLED_US {
                self.of.insert(key, mark);
            }
        }
        self.own(dir, all);
        self.at = Some((Instant::now(), sessions(dir)));
    }

    /// One owner each: the session whose host saw it under its agent, or an ancestor of it, else
    /// the one whose mark it carries.
    fn own(&mut self, dir: &Path, all: &[Proc]) {
        let at: HashMap<i32, &Proc> = all.iter().map(|p| (p.pid, p)).collect();
        let root = sessions(dir);
        let real = fs::canonicalize(&root).unwrap_or_else(|_| root.clone());
        let marked = |key: &(i32, u64)| {
            let mark = Path::new(self.of.get(key)?.as_ref()?);
            let here = mark.parent().is_some_and(|d| d == root || d == real);
            let id = mark.file_name()?.to_str()?;
            (here && mark.join("session.json").exists()).then(|| id.to_string())
        };
        let mut seen = HashMap::new();
        let mut ids: Vec<_> = (fs::read_dir(&root).into_iter().flatten().flatten())
            .filter_map(|e| e.file_name().into_string().ok())
            .collect();
        ids.sort();
        for id in &ids {
            for key in forks::read(&root.join(id)) {
                if at.get(&key.0).is_none_or(|p| p.start_us != key.1) {
                    continue;
                }
                // Two hosts saw it: its mark says, else the first.
                if !seen.contains_key(&key) || marked(&key).as_ref() == Some(id) {
                    seen.insert(key, id.clone());
                }
            }
        }
        self.owner = seen.clone();
        for key in self.of.keys().filter(|k| !seen.contains_key(k)) {
            if let Some(id) = marked(key) {
                let above = (at.get(&key.0)).and_then(|p| seen_above(dir, p, &at, &seen));
                self.owner.insert(*key, above.unwrap_or(id));
            }
        }
    }
}

/// The session whose host saw its nearest seen ancestor; a shared server's are nobody's.
fn seen_above(
    dir: &Path,
    p: &Proc,
    at: &HashMap<i32, &Proc>,
    seen: &HashMap<(i32, u64), String>,
) -> Option<String> {
    let mut p = *p;
    // The bound only guards against a cycle that can't be.
    for _ in 0..256 {
        let up = **at.get(&p.ppid).filter(|up| up.start_us <= p.start_us)?;
        if let Some(id) = seen.get(&(up.pid, up.start_us)) {
            return Some(id.clone());
        }
        if shared(dir, &up) {
            return None;
        }
        p = up;
    }
    None
}

/// The folder of this data folder's sessions.
fn sessions(dir: &Path) -> PathBuf {
    dir.parent().unwrap_or(dir).into()
}

/// Every process proven to be the session's, its agent too while it runs.
pub fn proven(dir: &Path, fold: &Fold, all: &[Proc]) -> Vec<Proc> {
    of(dir, fold, all, MARKS_FOR, &mut Links::default())
}

fn of(dir: &Path, fold: &Fold, all: &[Proc], fresh: Duration, links: &mut Links) -> Vec<Proc> {
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
    let (all, owned) = ours(dir, all, fresh);
    // What launchd started only inherited its mark; under a shared server it's the server's.
    let own = (owned.iter())
        .filter(|p| p.sid > 1 && p.start_us > first && !under_shared(dir, p, &at))
        .map(|p| (p.pid, p.start_us));
    seeds.extend(own);
    seeds.retain(|(pid, start)| at.get(pid).is_some_and(|p| p.start_us == *start));
    grow(dir, &all, &seeds, links)
}

/// Every process but another session's, whoever started it, and those known to be this one's.
fn ours(dir: &Path, all: &[Proc], fresh: Duration) -> (Vec<Proc>, Vec<Proc>) {
    let mut marks = MARKS.lock().unwrap_or_else(|e| e.into_inner());
    let marks = marks.get_or_insert_default();
    let stale = |(t, root): &(Instant, PathBuf)| t.elapsed() >= fresh || *root != sessions(dir);
    if marks.at.as_ref().is_none_or(stale) {
        marks.read(dir, all);
    }
    let me = dir.file_name().and_then(|n| n.to_str());
    let owner = |p: &Proc| marks.owner.get(&(p.pid, p.start_us)).map(String::as_str);
    let all: Vec<Proc> = (all.iter())
        .filter(|p| owner(p).is_none_or(|id| Some(id) == me))
        .copied()
        .collect();
    let owned = all.iter().filter(|p| owner(p).is_some()).copied().collect();
    (all, owned)
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
    let mut links = Links::default();
    let mine = of(dir, fold, &all, Duration::ZERO, &mut links);
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
    first();
    signal(&tree, libc::SIGTERM);
    wait(&tree, GRACE);
    // What they started meanwhile goes too. With the agent gone (no `roots`), also what one that
    // ended left in its place; else that can't be told from what the agent just started.
    for _ in 0..ROUNDS {
        let all = procs::all();
        let more: Vec<Proc> = if roots.is_none() {
            links.prune(&all);
            of(dir, fold, &all, Duration::ZERO, &mut links)
        } else {
            let all = ours(dir, &all, Duration::ZERO).0;
            (alive(&tree).iter())
                .flat_map(|p| procs::descendants(&all, p.pid))
                .filter(|p| !shared(dir, p))
                .collect()
        };
        for p in more {
            if !(tree.iter()).any(|t: &Proc| (t.pid, t.start_us) == (p.pid, p.start_us)) {
                tree.push(p);
            }
        }
        if alive(&tree).is_empty() {
            break;
        }
        signal(&tree, libc::SIGKILL);
        wait(&tree, Duration::from_secs(1));
        if roots.is_some() {
            break;
        }
    }
    Some(alive(&tree))
}

/// Ends all of the session's as it's archived, its agent gone.
pub fn end_left(dir: &Path) -> io::Result<()> {
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

/// A session's throwaway files and test instances, its own folder's `tmp`: gone with it.
pub fn tmp(dir: &Path) -> PathBuf {
    dir.join("tmp")
}
