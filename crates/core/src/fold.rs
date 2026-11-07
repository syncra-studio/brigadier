//! The one answer to "is it running?": a fold over the session's items plus what the kernel says
//! about the owner and the child. It never guesses Working: that needs an open, delivered turn, a
//! live child that isn't stopped, and either fresh output or a tool whose processes still run.

use crate::adapters;
use brigadier_frames::{log, procs};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Default, Serialize, Deserialize, Clone)]
pub struct Turn {
    pub cid: Option<String>,
    pub origin: String,
    pub backend: String,
    pub text: String,
    pub retry_of: Option<String>,
    pub ts: u64,
    pub delivered: Option<u64>,
    pub began: bool,
    pub tools: BTreeSet<String>,
    pub question: Option<String>,
    /// Logged, then its owner died before delivering it.
    pub orphaned: bool,
}

#[derive(Default, Serialize, Deserialize, Clone)]
pub struct Child {
    pub pid: i32,
    pub start_us: u64,
    pub backend: String,
    pub exited: bool,
    pub pty: bool,
}

#[derive(Default, Serialize, Deserialize, Clone)]
pub struct Fold {
    pub turns: Vec<Turn>,
    pub last: Option<Value>,
    pub last_out: u64,
    pub child: Option<Child>,
    pub groups: Vec<(i32, u64)>,
    pub resume: BTreeMap<String, String>,
    pub versions: BTreeMap<String, String>,
    pub backend: String,
    pub limit: Option<String>,
    pub sign_in: Option<String>,
    pub cids: BTreeMap<String, u32>,
    pub unknown: u64,
    pub compactions: u64,
    pub items: u64,
}

impl Fold {
    fn close(&mut self, outcome: &str, reason: Value, ts: u64) {
        if let Some(turn) = self.turns.first().cloned() {
            self.turns.remove(0);
            self.last = Some(
                json!({"cid": turn.cid, "origin": turn.origin, "backend": turn.backend, "retry_of": turn.retry_of, "text": turn.text, "outcome": outcome, "reason": reason, "ts": ts}),
            );
        }
    }

    fn close_all(&mut self, outcome: &str, reason: Value, ts: u64) {
        while !self.turns.is_empty() {
            self.close(outcome, reason.clone(), ts);
        }
    }

    pub fn push(&mut self, item: &Value) {
        self.items += 1;
        let ts = item["ts"].as_u64().unwrap_or(0);
        let str_of = |k: &str| item[k].as_str().unwrap_or("").to_string();
        let kind = item["kind"].as_str().unwrap_or("");
        if matches!(
            kind,
            "text"
                | "tool"
                | "tool_done"
                | "turn_start"
                | "turn_end"
                | "terminal"
                | "stderr"
                | "unknown"
                | "usage"
                | "question"
                | "compaction"
        ) {
            self.last_out = ts;
            if let Some(t) = self.turns.first_mut() {
                t.began = true;
            }
        }
        match kind {
            "input" => {
                let cid = str_of("cid");
                *self.cids.entry(cid.clone()).or_default() += 1;
                self.limit = None;
                self.sign_in = None;
                // An input while the agent waits on a question is its answer, not a new turn.
                if let Some(t) = self.turns.first_mut().filter(|t| t.question.is_some()) {
                    t.question = None;
                    t.delivered = None;
                    t.cid = Some(cid);
                    t.ts = ts;
                    return;
                }
                self.backend = str_of("backend");
                // A terminal has no turn boundaries: each input replaces the last as "current".
                if self.child.as_ref().is_some_and(|c| c.pty && !c.exited) {
                    self.turns.clear();
                }
                let retry_of = item["retry_of"].as_str().map(String::from);
                self.turns.push(Turn {
                    cid: Some(cid),
                    origin: str_of("origin"),
                    backend: str_of("backend"),
                    text: str_of("text"),
                    retry_of,
                    ts,
                    ..Default::default()
                });
            }
            "delivered" => {
                let cid = item["cid"].as_str();
                if let Some(t) = self.turns.iter_mut().find(|t| t.cid.as_deref() == cid) {
                    t.delivered = Some(ts);
                }
            }
            "spawned" => {
                let (pid, start_us) = (
                    item["pid"].as_i64().unwrap_or(0) as i32,
                    item["start_us"].as_u64().unwrap_or(0),
                );
                self.child = Some(Child {
                    pid,
                    start_us,
                    backend: str_of("backend"),
                    exited: false,
                    pty: item["mode"] == "pty",
                });
                self.groups.push((pid, start_us));
                if self.groups.len() > 8 {
                    self.groups.remove(0);
                }
                if let Some(v) = item["cli_version"].as_str() {
                    self.versions.insert(str_of("backend"), v.into());
                }
            }
            "exited" => {
                let pid = item["pid"].as_i64().unwrap_or(0) as i32;
                let Some(child) = self.child.as_mut().filter(|c| c.pid == pid) else {
                    return;
                };
                child.exited = true;
                let per_turn = adapters::get(&child.backend).is_some_and(|a| a.per_turn());
                let clean = item["code"].as_i64() == Some(0);
                let delivered = self.turns.first().is_some_and(|t| t.delivered.is_some());
                if per_turn && clean && delivered {
                    self.close("done", Value::Null, ts);
                } else if delivered {
                    self.close_all(
                        "interrupted",
                        json!({"child_exited": {"code": item["code"], "signal": item["signal"]}}),
                        ts,
                    );
                }
            }
            "turn_start" => {
                if self.turns.is_empty() {
                    self.turns.push(Turn {
                        origin: "agent".into(),
                        backend: self.backend.clone(),
                        ts,
                        delivered: Some(ts),
                        began: true,
                        ..Default::default()
                    });
                }
            }
            "turn_end" => {
                let ok = item["ok"].as_bool().unwrap_or(true);
                self.close(if ok { "done" } else { "failed" }, Value::Null, ts);
            }
            "tool" => drop(self.turns.first_mut().map(|t| t.tools.insert(str_of("id")))),
            "tool_done" => drop(
                self.turns
                    .first_mut()
                    .map(|t| t.tools.remove(&str_of("id"))),
            ),
            "question" => drop(
                self.turns
                    .first_mut()
                    .map(|t| t.question = Some(str_of("text"))),
            ),
            "resume_id" => drop(self.resume.insert(str_of("backend"), str_of("id"))),
            "limited" => {
                self.limit = Some(str_of("message"));
                self.close("limited", item["message"].clone(), ts);
            }
            "sign_in" => {
                self.sign_in = Some(str_of("message"));
                self.close("sign_in", item["message"].clone(), ts);
            }
            "stopped" => self.close_all("stopped", item["by"].clone(), ts),
            "compaction" => self.compactions += 1,
            "unknown" | "unknown_frame" => self.unknown += 1,
            "note" => match item["event"].as_str() {
                Some("interrupted") => self.close_all("interrupted", item["reason"].clone(), ts),
                Some("owner_started") => self
                    .turns
                    .iter_mut()
                    .filter(|t| t.delivered.is_none())
                    .for_each(|t| t.orphaned = true),
                _ => {}
            },
            _ => {}
        }
    }
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Owner {
    Alive,
    Dead,
    /// Holds the lock but is stopped or not answering: can't tell, so it is never replaced.
    Frozen,
}

pub struct Live {
    pub owner: Owner,
    pub child: Option<procs::Proc>,
    pub running_below: usize,
    pub jobs: usize,
    pub orphans: usize,
    pub disk_full: bool,
    pub now: u64,
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
    let members: usize = fold
        .groups
        .iter()
        .map(|&(g, s)| procs::group(all, g, s).len())
        .sum();
    let jobs = members.saturating_sub(child.is_some() as usize + running_below);
    let orphans = if owner == Owner::Dead { members } else { 0 };
    Live {
        owner,
        child,
        running_below,
        jobs,
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

pub fn status(fold: &Fold, live: &Live) -> Value {
    let (state, reason) = state(fold, live);
    let turn = fold.turns.first().map(|t| json!({"cid": t.cid, "origin": t.origin, "backend": t.backend, "delivered": t.delivered.is_some(), "began": t.began, "tools": t.tools.len()}));
    let undelivered: Vec<_> = fold
        .turns
        .iter()
        .filter(|t| t.delivered.is_none())
        .map(|t| t.cid.clone())
        .collect();
    let dups = fold.cids.values().filter(|&&n| n > 1).count();
    json!({"state": state, "reason": reason, "turn": turn, "last": fold.last, "owner": format!("{:?}", live.owner).to_lowercase(),
           "child": live.child.map(|c| c.pid), "jobs": live.jobs, "helpers": live.running_below, "orphans": live.orphans, "disk_full": live.disk_full,
           "undelivered": undelivered, "dup_cids": dups, "unknown": fold.unknown, "compactions": fold.compactions,
           "items": fold.items, "backend": fold.backend, "resume": fold.resume, "versions": fold.versions})
}

fn state(fold: &Fold, live: &Live) -> (&'static str, Value) {
    let Some(turn) = fold.turns.first() else {
        let outcome = fold
            .last
            .as_ref()
            .and_then(|l| l["outcome"].as_str())
            .unwrap_or("");
        return match () {
            _ if live.owner == Owner::Frozen => ("unresponsive", Value::Null),
            _ if fold.sign_in.is_some() => ("sign_in", fold.sign_in.clone().into()),
            _ if fold.limit.is_some() => ("limited", fold.limit.clone().into()),
            _ if outcome == "interrupted" => (
                "interrupted",
                fold.last.clone().unwrap_or_default()["reason"].clone(),
            ),
            _ if live.jobs > 0 => ("idle_jobs", live.jobs.into()),
            _ if outcome == "stopped" => ("stopped", Value::Null),
            _ if outcome == "failed" => ("failed", Value::Null),
            _ if fold.items == 0 => ("new", Value::Null),
            _ => ("idle", Value::Null),
        };
    };
    let timing = adapters::get(&turn.backend)
        .map(|a| a.timing())
        .unwrap_or(adapters::Timing {
            silent_ms: 20_000,
            stall_ms: 120_000,
            no_start_ms: 30_000,
        });
    let Some(delivered) = turn.delivered else {
        let young = live.now.saturating_sub(turn.ts) < 2_000
            && live.owner == Owner::Alive
            && !turn.orphaned;
        return if young {
            ("logged", Value::Null)
        } else {
            ("undelivered", turn.cid.clone().into())
        };
    };
    if live.owner == Owner::Dead {
        return (
            "interrupted",
            json!({"owner_gone": true, "orphans": live.orphans}),
        );
    }
    if live.owner == Owner::Frozen {
        return ("unresponsive", Value::Null);
    }
    let Some(child) = live.child else {
        return ("interrupted", json!({"child_gone": true}));
    };
    if child.stopped {
        return ("stalled", json!({"stopped": child.pid}));
    }
    let silence = live.now.saturating_sub(fold.last_out.max(delivered));
    if fold.child.as_ref().is_some_and(|c| c.pty) {
        return ("terminal", json!({"quiet_ms": silence}));
    }
    if let Some(q) = &turn.question {
        return ("waiting_answer", q.clone().into());
    }
    if !turn.began {
        return if silence > timing.no_start_ms {
            ("no_turn_started", silence.into())
        } else {
            ("starting", silence.into())
        };
    }
    if silence < timing.silent_ms {
        return ("working", Value::Null);
    }
    if !turn.tools.is_empty() && live.running_below > 0 {
        return (
            "working",
            json!({"tool_running": true, "silent_ms": silence}),
        );
    }
    if silence < timing.stall_ms {
        ("silent", silence.into())
    } else {
        ("stalled", json!({"silent_ms": silence}))
    }
}
