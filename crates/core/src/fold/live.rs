//! What the kernel says about a session's processes: its owner, its child and their groups.

use super::{Fold, Owner};
use brigadier_frames::{log, procs};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::time::{Duration, Instant};

#[derive(Default, Serialize, Deserialize, Clone)]
pub struct Child {
    pub pid: i32,
    pub start_us: u64,
    pub backend: String,
    pub exited: bool,
}

pub struct Live {
    pub owner: Owner,
    pub child: Option<procs::Proc>,
    pub running_below: usize,
    pub jobs: usize,
    /// What its ended turns left running, its agent's end notwithstanding: a dev server, a watcher [D105].
    pub left: Vec<Job>,
    /// Every process proven the session's.
    pub mine: Vec<procs::Proc>,
    pub orphans: usize,
    pub disk_full: bool,
    pub now: u64,
}

/// Every recorded group that still has a live member, checked by start time. A set of live group
/// ids first, so a session with thousands of spawns costs a lookup per group.
pub fn live_groups<'a>(fold: &'a Fold, all: &[procs::Proc]) -> Vec<&'a (i32, u64, String)> {
    let pgids: BTreeSet<i32> = all.iter().map(|p| p.pgid).collect();
    fold.groups
        .iter()
        .filter(|&&(g, s, _)| pgids.contains(&g) && !procs::group(all, g, s).is_empty())
        .collect()
}

/// One process tree a turn left running, by its topmost process.
#[derive(Serialize, Clone, PartialEq, Debug)]
pub struct Job {
    pub pid: i32,
    pub start_us: u64,
    /// Its command, as the agent ran it.
    pub label: String,
    /// Under the live agent, which its CLI tells of its end.
    #[serde(skip)]
    pub under: bool,
    /// The id its CLI gave it, under the live agent.
    #[serde(skip)]
    pub task: Option<String>,
}

/// What the live child's CLI runs in the background, by id, as it last listed it: each one's end
/// wakes its agent, so a worker's turn that ended meanwhile hasn't reported yet.
#[derive(Serialize, Deserialize, Clone, Default)]
pub struct Pending {
    pub ids: BTreeSet<String>,
    /// One of those, or a subagent, ended with no turn open: the wake it starts is on its way.
    pub due: bool,
    /// Each one, and each subagent, by the turn that started it, the one it reports in.
    #[serde(default)]
    pub by: BTreeMap<String, String>,
    /// The turn the wake on its way carries on: the one whose work ended, where it's known.
    #[serde(default)]
    pub woke: String,
    /// A subagent's end is what it wakes for: that wake deals with it, as a result's turn does [D48].
    #[serde(default)]
    pub agent: bool,
}

impl Pending {
    /// Its CLI's new list, with the turns open now: the first, if any, started what's new in it.
    pub(super) fn listed(&mut self, item: &serde_json::Value, turns: &[super::Turn]) {
        let open = turns.first().map(super::Turn::report);
        let ids = item["ids"].as_array().into_iter().flatten();
        let now: BTreeSet<String> = ids.filter_map(|i| i.as_str().map(String::from)).collect();
        if let Some(gone) = self.ids.iter().find(|i| !now.contains(*i)).cloned() {
            self.ended(&gone, open.is_none());
        }
        if let Some(t) = open {
            let new = now.iter().filter(|i| !self.ids.contains(*i));
            new.for_each(|i| drop(self.by.insert(i.clone(), t.into())));
        }
        self.ids = now;
    }

    /// One of them or a subagent ended; `idle`: no turn is open, so it wakes its agent.
    pub(super) fn ended(&mut self, id: &str, idle: bool) {
        if idle {
            self.due = true;
            self.woke = self.by.get(id).cloned().unwrap_or_default();
        }
    }

    /// Whether its agent will be woken by it.
    pub fn wakes(&self) -> bool {
        !self.ids.is_empty() || self.due
    }
}

/// A tool's process can start just before its step reaches the log, or after its turn's end does.
const SLACK_MS: u64 = 1000;
/// The CLI's own hooks run as its children around a tool and at a turn's end, and end within this.
const SETTLE_MS: u64 = 2000;
const SHELLS: [&str; 5] = ["sh", "bash", "zsh", "dash", "fish"];

/// The CLI's server, when the agent is Brigadier's helper that holds it: the helper starts nothing
/// else. With it what it handed the helper's own pipes to, as a launcher does to the CLI it runs;
/// a tool or an MCP server gets its own.
fn server(all: &[procs::Proc], child: i32) -> BTreeSet<i32> {
    let argv = procs::args(child).map(|a| a.0).unwrap_or_default();
    let helper =
        matches!(&argv[..], [exe, word, ..] if exe.ends_with("/brigadier") && word == "helper");
    let mut found = BTreeSet::new();
    for p in all.iter().filter(|p| helper && p.ppid == child) {
        found.insert(p.pid);
        if let Some(pipes) = procs::stdio(p.pid) {
            let below = procs::descendants(all, p.pid).into_iter().map(|p| p.pid);
            found.extend(below.filter(|&b| procs::stdio(b) == Some(pipes)));
        }
    }
    found
}

/// Each topmost process proven the session's and born in one of its ended turns' tool windows, still
/// alive, whatever became of its agent. Its CLI's server, the helpers it names and the MCP servers
/// its config gives it, whenever each started, are never a job, nor what runs them on their own
/// pipes; what runs under one can be.
fn left_running(
    fold: &Fold,
    all: &[procs::Proc],
    child: Option<i32>,
    mine: &[procs::Proc],
    dir: &Path,
) -> Vec<Job> {
    let below: BTreeSet<i32> = (child.map(|c| procs::descendants(all, c)))
        .into_iter()
        .flatten()
        .map(|p| p.pid)
        .collect();
    let helpers = (fold.child.as_ref())
        .and_then(|c| crate::adapters::get(&c.backend))
        .map_or(&[][..], |a| a.helpers());
    let own = |p: &procs::Proc| {
        let argv = procs::args(p.pid).map(|a| a.0).unwrap_or_default();
        let name = argv.first().and_then(|a| a.rsplit('/').next());
        name.is_some_and(|n| helpers.contains(&n))
    };
    let server = child.map(|c| server(all, c)).unwrap_or_default();
    // The CLI itself, which starts its MCP servers on its own pipes to them.
    let cli: BTreeSet<i32> = child.into_iter().chain(server.iter().copied()).collect();
    let backend = fold.child.as_ref().map_or("", |c| c.backend.as_str());
    let lines = std::cell::OnceCell::new();
    let started = |p: &procs::Proc| {
        own(p)
            || (cli.contains(&p.ppid) && procs::stdio(p.pid).is_some() && {
                let argv = procs::args(p.pid).map(|a| a.0).unwrap_or_default();
                let lines = lines.get_or_init(|| mcp_lines(dir, backend));
                lines.iter().any(|l: &Vec<String>| runs(&argv, l))
            })
    };
    // One of those, or what it handed its own pipes to, as a launcher does to the program it runs.
    let kept = |p: &procs::Proc| {
        let pipes = procs::stdio(p.pid);
        let mut at = *p;
        loop {
            if started(&at) {
                return at.pid == p.pid || (pipes.is_some() && procs::stdio(at.pid) == pipes);
            }
            match all.iter().find(|q| q.pid == at.ppid) {
                Some(q) if !cli.contains(&q.pid) => at = *q,
                _ => return false,
            }
        }
    };
    // In the running turn, one its CLI said it sent to the background counts at once, not at its end;
    // a turn whose agent is gone is over.
    let since = child.map_or(0, |_| fold.child.as_ref().map_or(0, |c| c.start_us / 1000));
    let running = (fold.turns.first()).map_or(0, |t| t.first_tool);
    let now = log::now_ms();
    // Out of the agent's tree, one is left whenever it was born: an orphan's own child, long after.
    let opened = (fold.windows.first().map(|w| w.0)).or((running > 0).then_some(running));
    let out = |p: &procs::Proc| {
        !below.contains(&p.pid)
            && opened.is_some_and(|o| p.start_us >= o.saturating_sub(SLACK_MS) * 1000)
    };
    let after =
        |p: &procs::Proc| running > 0 && p.start_us >= running.saturating_sub(SLACK_MS) * 1000;
    let born = |p: &procs::Proc| {
        !p.zombie
            && Some(p.pid) != child
            && !server.contains(&p.pid)
            && now.saturating_sub(p.start_us / 1000) >= SETTLE_MS
            && (out(p)
                || (below.contains(&p.pid)
                    && ((fold.windows.iter()).any(|&(a, b)| {
                        // Only the live agent's own turns': its helpers start just after the last one's end.
                        a >= since
                            && (a.saturating_sub(SLACK_MS) * 1000..=(b + SLACK_MS) * 1000)
                                .contains(&p.start_us)
                    }) || (after(p) && said_by(fold, p.start_us).next().is_some()))))
            && !kept(p)
    };
    let found: Vec<&procs::Proc> = mine.iter().filter(|p| born(p)).collect();
    let pids: BTreeSet<i32> = found.iter().map(|p| p.pid).collect();
    let mut tops: Vec<&procs::Proc> = (found.into_iter())
        .filter(|p| !pids.contains(&p.ppid))
        .collect();
    // One row a task, two started at once each their own: its own process, born before a hook that
    // ran beside it.
    tops.sort_by_key(|p| p.start_us);
    let mut taken = BTreeSet::new();
    let mut left = vec![];
    for p in tops {
        let under = below.contains(&p.pid);
        let near: Vec<_> = said_by(fold, p.start_us).filter(|_| under).collect();
        let free = near.iter().filter(|(_, t)| !taken.contains(t));
        let task = free.min_by_key(|(ts, _)| ts.abs_diff(p.start_us / 1000));
        if task.is_none() && !near.is_empty() {
            continue;
        }
        let task = task.map(|(_, t)| t.clone());
        taken.extend(task.clone());
        left.push(Job {
            pid: p.pid,
            start_us: p.start_us,
            label: (task.as_ref().and_then(|t| fold.typed.get(t).cloned()))
                .unwrap_or_else(|| label(all, p.pid)),
            under,
            task,
        });
    }
    left
}

/// The command lines, a program then its args, the session's agent may start an MCP server with: its
/// config's, the library's and Brigadier's own.
fn mcp_lines(dir: &Path, backend: &str) -> Vec<Vec<String>> {
    let spec = std::fs::read(dir.join("session.json")).ok();
    let Some(mut spec) = spec.and_then(|b| serde_json::from_slice::<crate::Spec>(&b).ok()) else {
        return vec![];
    };
    spec.dir = dir.into();
    let mut servers = crate::adapters::get(backend).map_or(vec![], |a| a.launched_servers(&spec));
    servers.extend(crate::library::on_for(
        &crate::data_of(&spec),
        spec.project.as_deref(),
    ));
    let line = |s: &serde_json::Value| {
        let args = s["args"].as_array().into_iter().flatten();
        let args = args.filter_map(|a| a.as_str().map(String::from));
        Some(
            std::iter::once(s["command"].as_str()?.to_string())
                .chain(args)
                .collect(),
        )
    };
    let mut all: Vec<Vec<String>> = servers.iter().filter_map(line).collect();
    all.push(vec!["brigadier".into(), "mcp-server".into()]);
    all
}

/// Whether `argv` runs `line`, a program then its args: as it is, through the interpreter its script
/// names, or under the title it gave itself in their place, ending with them from the first that
/// isn't a flag (npm's `npm exec <package> <args>`, for `npx -y <package> <args>`).
fn runs(argv: &[String], line: &[String]) -> bool {
    let Some((program, args)) = line.split_first() else {
        return false;
    };
    let base = |a: &str| a.rsplit('/').next().unwrap_or(a).to_string();
    let at = (argv.len().checked_sub(args.len())).filter(|n| (1..=3).contains(n));
    let direct = at.is_some_and(|n| argv[n..] == *args && base(&argv[n - 1]) == base(program));
    let tail: Vec<&str> = (args.iter())
        .skip_while(|a| a.starts_with('-'))
        .map(String::as_str)
        .collect();
    let title =
        (argv.first().filter(|t| t.contains(' '))).map(|t| t.split(' ').collect::<Vec<_>>());
    direct || title.is_some_and(|t| !tail.is_empty() && t.len() > tail.len() && t.ends_with(&tail))
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

/// The ids the agent's CLI gave background commands that may have started a process born at
/// `start_us`, each by when that was said: from just before it began to a few seconds after.
fn said_by(fold: &Fold, start_us: u64) -> impl Iterator<Item = &(u64, String)> {
    let at = start_us / 1000;
    (fold.tasks.iter()).filter(move |(ts, _)| ts + SLACK_MS >= at && *ts <= at + 5000)
}

/// Ends these processes, each only while it's still that one: a TERM, then a KILL for whatever
/// outlives the grace.
pub fn end(tree: &[(i32, u64)], grace: Duration) {
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
    let until = Instant::now() + grace;
    while Instant::now() < until && signal(0) {
        std::thread::sleep(Duration::from_millis(25));
    }
    signal(libc::SIGKILL);
}

/// `dir`: the session's own folder.
pub fn live(fold: &Fold, owner: Owner, dir: &Path, all: &[procs::Proc]) -> Live {
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
        .map(|&&(g, s, _)| procs::group(all, g, s).len())
        .sum();
    let mine = crate::background::proven(dir, fold, all);
    let left = left_running(fold, all, child.map(|c| c.pid), &mine, dir);
    let jobs = members.saturating_sub(child.is_some() as usize + running_below)
        + left.iter().filter(|j| j.under).count();
    let orphans = if owner == Owner::Dead { members } else { 0 };
    Live {
        owner,
        child,
        running_below,
        jobs,
        left,
        mine,
        orphans,
        disk_full: free_bytes(dir) < (2 << 20),
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
pub const HISTORY: &str = "background";

/// A session row's Background [D105, D200]: what's left running, each with the TCP ports its tree
/// listens on and the open apps in it, by which the card lists it [D145], and whether anything has
/// run (its card keeps the history's button), noting the jobs that started or ended since the last look.
pub fn background_row(row: &mut serde_json::Value, dir: &Path, live: &Live) {
    row["background_ran"] = note_jobs(dir, &live.left).into();
    let job = |j: &Job| {
        let tree = |pid: i32| {
            let mut tree = procs::descendants(&live.mine, pid);
            tree.extend(live.mine.iter().filter(|p| p.pid == pid));
            tree
        };
        let ports = |tree: &[procs::Proc]| -> BTreeSet<u16> {
            (tree.iter())
                .flat_map(|p| procs::listening(p.pid))
                .collect()
        };
        let all = tree(j.pid);
        let apps: Vec<_> = (crate::background::apps::open(&all).iter())
            .map(|(p, name)| {
                serde_json::json!({"pid": p.pid, "start_us": p.start_us, "label": name,
                    "ports": ports(&tree(p.pid))})
            })
            .collect();
        let mut job = serde_json::json!(j);
        job["ports"] = serde_json::json!(ports(&all));
        job["apps"] = apps.into();
        job
    };
    row["background"] = live.left.iter().map(job).collect();
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
