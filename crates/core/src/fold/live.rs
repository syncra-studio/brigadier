//! What the kernel says about a session's processes: its owner, its child and their groups.

use super::{Fold, Owner};
use brigadier_frames::{log, procs};
use serde::Serialize;
use std::collections::BTreeSet;
use std::path::Path;
use std::time::{Duration, Instant};

pub struct Live {
    pub owner: Owner,
    pub child: Option<procs::Proc>,
    pub running_below: usize,
    pub jobs: usize,
    /// What its ended turns left running under the live agent: a dev server, a watcher [D105].
    pub left: Vec<Job>,
    pub orphans: usize,
    pub disk_full: bool,
    pub now: u64,
}

/// Every recorded group that still has a live member, checked by start time. A set of live group
/// ids first, so a session with thousands of spawns costs a lookup per group.
pub fn live_groups(fold: &Fold, all: &[procs::Proc]) -> Vec<(i32, u64)> {
    let pgids: BTreeSet<i32> = all.iter().map(|p| p.pgid).collect();
    fold.groups
        .iter()
        .filter(|&&(g, s)| pgids.contains(&g) && !procs::group(all, g, s).is_empty())
        .copied()
        .collect()
}

/// One process tree a turn left running, by its topmost process.
#[derive(Serialize, Clone, PartialEq, Debug)]
pub struct Job {
    pub pid: i32,
    pub start_us: u64,
    /// Its command, as the agent ran it.
    pub label: String,
}

/// A tool's process can start just before its step reaches the log, or after its turn's end does.
const SLACK_MS: u64 = 1000;
/// The CLI's own hooks run as its children around a tool and at a turn's end, and end within this.
const SETTLE_MS: u64 = 2000;
const SHELLS: [&str; 5] = ["sh", "bash", "zsh", "dash", "fish"];

/// Each topmost process under the agent born in one of its ended turns' tool windows, still alive.
/// The agent's own helpers (MCP servers) start with it, before any tool, so none count; those its
/// CLI starts later it names.
fn left_running(fold: &Fold, all: &[procs::Proc], child: i32) -> Vec<Job> {
    let below = procs::descendants(all, child);
    let helpers = (fold.child.as_ref())
        .and_then(|c| crate::adapters::get(&c.backend))
        .map_or(&[][..], |a| a.helpers());
    let own = |p: &procs::Proc| {
        let argv = procs::args(p.pid).map(|a| a.0).unwrap_or_default();
        let name = argv.first().and_then(|a| a.rsplit('/').next());
        name.is_some_and(|n| helpers.contains(&n))
    };
    // In the running turn, one its CLI said it sent to the background counts at once, not at its end.
    let running = (fold.turns.first()).map_or(0, |t| t.first_tool);
    let now = log::now_ms();
    let born = |p: &procs::Proc| {
        !p.zombie
            && now.saturating_sub(p.start_us / 1000) >= SETTLE_MS
            && ((fold.windows.iter()).any(|&(a, b)| {
                (a.saturating_sub(SLACK_MS) * 1000..=(b + SLACK_MS) * 1000).contains(&p.start_us)
            }) || (running > 0
                && p.start_us >= running.saturating_sub(SLACK_MS) * 1000
                && task_of(fold, p.start_us).is_some()))
    };
    let mut tops: Vec<&procs::Proc> = (below.iter())
        .filter(|p| born(p) && !below.iter().any(|q| q.pid == p.ppid && born(q)) && !own(p))
        .collect();
    // One row a task: its own process, born before a hook that ran beside it.
    tops.sort_by_key(|p| p.start_us);
    let mut tasks = BTreeSet::new();
    tops.retain(|p| task_of(fold, p.start_us).is_none_or(|t| tasks.insert(t)));
    (tops.into_iter())
        .map(|p| Job {
            pid: p.pid,
            start_us: p.start_us,
            label: (task_of(fold, p.start_us).and_then(|t| fold.typed.get(&t).cloned()))
                .unwrap_or_else(|| label(all, p.pid)),
        })
        .collect()
}

/// A job's command: a shell's own child when it has one, else the shell's script.
fn label(all: &[procs::Proc], mut pid: i32) -> String {
    loop {
        let argv = procs::args(pid).map(|a| a.0).unwrap_or_default();
        let name = |a: &String| {
            a.rsplit('/')
                .next()
                .unwrap_or(a)
                .trim_start_matches('-')
                .to_string()
        };
        let shell = argv
            .first()
            .is_some_and(|a| SHELLS.contains(&name(a).as_str()));
        match all.iter().find(|p| p.ppid == pid && !p.zombie) {
            Some(next) if shell || argv.is_empty() => pid = next.pid,
            _ => {
                let flag =
                    |a: &&String| a.starts_with('-') && !a.starts_with("--") && a.contains('c');
                let mut after = argv.iter().skip(1).skip_while(|a| !flag(a));
                let script = shell.then(|| after.find(|a| !a.starts_with('-'))).flatten();
                let words = match script {
                    Some(s) => s.lines().next().unwrap_or("").trim().to_string(),
                    None => argv
                        .first()
                        .map(name)
                        .into_iter()
                        .chain(argv.iter().skip(1).cloned())
                        .collect::<Vec<_>>()
                        .join(" "),
                };
                return words.chars().take(200).collect();
            }
        }
    }
}

/// The id the agent's CLI gave the background command that started the job born at `start_us`:
/// the first said to run in the background from just before it began to a few seconds after.
pub fn task_of(fold: &Fold, start_us: u64) -> Option<String> {
    let at = start_us / 1000;
    (fold.tasks.iter())
        .filter(|&&(ts, _)| ts + SLACK_MS >= at && ts <= at + 5000)
        .min_by_key(|&&(ts, _)| ts)
        .map(|(_, task)| task.clone())
}

/// Stops one job the session left running, its whole tree, only while it's still that job (one
/// already gone is stopped): a TERM, then a KILL for whatever outlives the grace [D105].
pub fn stop_job(fold: &Fold, data: &Path, pid: i32, start_us: u64) {
    let all = procs::all();
    let l = live(fold, Owner::Alive, data, &all);
    if !l
        .left
        .iter()
        .any(|j| j.pid == pid && j.start_us == start_us)
    {
        return;
    }
    let tree: Vec<_> = std::iter::once(procs::same(pid, start_us))
        .flatten()
        .chain(procs::descendants(&all, pid))
        .map(|p| (p.pid, p.start_us))
        .collect();
    let signal = |sig| {
        let left: Vec<_> = (tree.iter())
            .filter(|&&(p, s)| procs::same(p, s).is_some_and(|p| !p.zombie))
            .collect();
        left.iter().for_each(|&&(p, _)| unsafe {
            libc::kill(p, sig);
        });
        !left.is_empty()
    };
    signal(libc::SIGTERM);
    let until = Instant::now() + Duration::from_secs(2);
    while Instant::now() < until && signal(0) {
        std::thread::sleep(Duration::from_millis(50));
    }
    signal(libc::SIGKILL);
}

pub fn live(fold: &Fold, owner: Owner, data_dir: &std::path::Path, all: &[procs::Proc]) -> Live {
    let child = fold
        .child
        .as_ref()
        .filter(|c| !c.exited)
        .and_then(|c| procs::same(c.pid, c.start_us));
    let running_below = child.map_or(0, |c| {
        procs::descendants(all, c.pid)
            .iter()
            .filter(|p| !p.stopped)
            .count()
    });
    let members: usize = live_groups(fold, all)
        .iter()
        .map(|&(g, s)| procs::group(all, g, s).len())
        .sum();
    let left = child.map_or(vec![], |c| left_running(fold, all, c.pid));
    let jobs = members.saturating_sub(child.is_some() as usize + running_below) + left.len();
    let orphans = if owner == Owner::Dead { members } else { 0 };
    Live {
        owner,
        child,
        running_below,
        jobs,
        left,
        orphans,
        disk_full: free_bytes(data_dir) < (2 << 20),
        now: log::now_ms(),
    }
}

fn free_bytes(path: &std::path::Path) -> u64 {
    let Ok(c) = std::ffi::CString::new(path.as_os_str().as_encoded_bytes()) else {
        return u64::MAX;
    };
    let mut s = std::mem::MaybeUninit::<libc::statvfs>::zeroed();
    if unsafe { libc::statvfs(c.as_ptr(), s.as_mut_ptr()) } != 0 {
        return u64::MAX;
    }
    let s = unsafe { s.assume_init() };
    s.f_bavail as u64 * s.f_frsize
}

/// The session's background history (`background`, JSON lines) [D200]: each job's start as it's
/// first seen, its end once it's gone, and the user's Stop. A start seen again (another reader, a
/// restart) or a second end changes nothing when read.
const HISTORY: &str = "background";

/// A session row's Background [D105, D200]: what's left running, and whether anything has run (its
/// card keeps the history's button), noting the jobs that started or ended since the last look.
pub fn background_row(row: &mut serde_json::Value, dir: &Path, left: &[Job]) {
    row["background_ran"] = note_jobs(dir, left).into();
    row["background"] = serde_json::json!(left);
}

/// What each session's jobs were at the last look, by its folder.
static NOTED: std::sync::Mutex<std::collections::BTreeMap<std::path::PathBuf, Vec<Job>>> =
    std::sync::Mutex::new(std::collections::BTreeMap::new());

/// Keeps what changed since the last look at a session's jobs: those new started, those gone ended.
/// Says whether anything has run in its background, so its card keeps the history's button.
fn note_jobs(dir: &Path, now: &[Job]) -> bool {
    let mut noted = NOTED.lock().unwrap_or_else(|e| e.into_inner());
    let was = noted.entry(dir.to_path_buf()).or_default();
    if was.as_slice() != now {
        let at = log::now_ms();
        let lines: Vec<String> = (now.iter().filter(|j| !was.contains(j)))
            .map(|j| serde_json::json!({"pid": j.pid, "start_us": j.start_us, "label": j.label}))
            .chain(
                (was.iter().filter(|j| {
                    now.iter()
                        .all(|n| (n.pid, n.start_us) != (j.pid, j.start_us))
                }))
                .map(|j| serde_json::json!({"pid": j.pid, "start_us": j.start_us, "end": at})),
            )
            .map(|line| format!("{line}\n"))
            .collect();
        note(dir, &lines.concat());
        *was = now.to_vec();
    }
    !now.is_empty() || dir.join(HISTORY).exists()
}

/// The user stopped this job from the card.
pub fn note_stop(dir: &Path, pid: i32, start_us: u64) {
    let line = serde_json::json!({"pid": pid, "start_us": start_us, "stopped": "user"});
    note(dir, &format!("{line}\n"));
}

fn note(dir: &Path, lines: &str) {
    use std::io::Write;
    if lines.is_empty() {
        return;
    }
    let file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join(HISTORY));
    if let Err(e) = file.and_then(|mut f| f.write_all(lines.as_bytes())) {
        eprintln!("brigadier: keeping background history: {e}");
    }
}

/// Everything that ran in the background, newest first, each `{label, startedAt, endedAt,
/// status}`: running (in `left`), stopped (by the user), ended, or unknown (gone unseen).
pub fn history(dir: &Path, left: &[Job]) -> Vec<serde_json::Value> {
    let text = std::fs::read_to_string(dir.join(HISTORY)).unwrap_or_default();
    let mut runs: Vec<serde_json::Value> = Vec::new();
    for line in text.lines() {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        let at = runs
            .iter()
            .position(|r| r["pid"] == v["pid"] && r["start_us"] == v["start_us"]);
        match (at, v.get("label")) {
            (None, Some(_)) => runs.push(v),
            // Its CLI's words for it can come after the process: the latest names it.
            (Some(i), Some(label)) => runs[i]["label"] = label.clone(),
            (Some(i), _) if v["stopped"] == "user" => runs[i]["stopped"] = true.into(),
            (Some(i), _) if runs[i]["end"].is_null() && !v["end"].is_null() => {
                runs[i]["end"] = v["end"].clone()
            }
            _ => {}
        }
    }
    let running = |r: &serde_json::Value| {
        left.iter()
            .any(|j| r["pid"] == j.pid && r["start_us"] == j.start_us)
    };
    let mut out: Vec<serde_json::Value> = (runs.iter())
        .map(|r| {
            let status = match () {
                _ if running(r) => "running",
                _ if r["stopped"] == true => "stopped",
                _ if !r["end"].is_null() => "ended",
                _ => "unknown",
            };
            let ended = (status != "running").then(|| r["end"].clone());
            serde_json::json!({"label": r["label"], "startedAt": r["start_us"].as_u64().map(|us| us / 1000),
                "endedAt": ended, "status": status})
        })
        .collect();
    out.reverse();
    out
}
