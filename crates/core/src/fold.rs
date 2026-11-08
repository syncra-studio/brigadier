//! The one answer to "is it running?": a fold over the session's items plus what the kernel says
//! about the owner and the child. It never guesses Working: that needs an open, delivered turn, a
//! live child that isn't stopped, and either fresh output or a tool whose processes still run.

use crate::adapters;

mod live;
pub use live::{Live, live, live_groups};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Default, Serialize, Deserialize, Clone)]
pub struct Turn {
    /// Stable for the turn's life: its first input's cid, or `a<n>` for one the agent started.
    #[serde(default)]
    pub id: String,
    pub cid: Option<String>,
    pub origin: String,
    pub backend: String,
    pub text: String,
    pub retry_of: Option<String>,
    /// The account or agent switch this input continues, as logged with it [D51].
    #[serde(default)]
    pub switch: Value,
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
    /// A mirror copies its CLI's record into the log, so its turns come and go like piped ones.
    #[serde(default)]
    pub mirror: bool,
    /// The mirror's own process group, which lives beside the CLI for the terminal's life.
    #[serde(default)]
    pub mirror_group: Option<(i32, u64)>,
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
    /// The CLI refused to resume the conversation on this account (D90 Q4).
    #[serde(default)]
    pub refused: Option<String>,
    /// The account each backend runs on now, by account id; none is the computer's login [D51].
    #[serde(default)]
    pub accounts: BTreeMap<String, String>,
    /// Every conversation the session had, as (backend, account, id), so delete cleans each one
    /// where it lives [D35].
    #[serde(default)]
    pub convs: BTreeSet<(String, String, String)>,
    /// The model each backend a switch moved to runs [D51].
    #[serde(default)]
    pub models: BTreeMap<String, String>,
    pub cids: BTreeMap<String, u32>,
    pub unknown: u64,
    pub compactions: u64,
    pub items: u64,
    /// Prompts in the CLI's record already bound to the chat input that typed them, by prompt id.
    #[serde(default)]
    pub bound: BTreeMap<String, String>,
}

impl Fold {
    fn close(&mut self, outcome: &str, reason: Value, ts: u64) {
        if let Some(turn) = self.turns.first().cloned() {
            self.turns.remove(0);
            self.last = Some(
                json!({"cid": turn.cid, "origin": turn.origin, "backend": turn.backend, "retry_of": turn.retry_of, "text": turn.text, "outcome": outcome, "reason": reason, "ts": ts,
                       "delivered": turn.delivered.is_some(), "began": turn.began, "switch": turn.switch}),
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
                | "answer"
                | "reasoning"
                | "compaction"
        ) {
            self.last_out = ts;
            let pty = self.child.as_ref().is_some_and(|c| c.pty);
            if let Some(t) = self.turns.first_mut() {
                t.began = true;
                // A question in a terminal is answered by keys, which aren't logged: the agent's
                // next step in its record ends the wait. Raw screen bytes don't [D77].
                if pty
                    && matches!(
                        kind,
                        "text" | "tool" | "tool_done" | "reasoning" | "turn_start"
                    )
                {
                    t.question = None;
                }
            }
        }
        match kind {
            "input" => {
                let cid = str_of("cid");
                *self.cids.entry(cid.clone()).or_default() += 1;
                self.limit = None;
                self.sign_in = None;
                self.refused = None;
                // A switch takes effect with the input that continues it, in the same frame [D51].
                let switch = &item["switch"];
                if let Some(to) = switch["to"]["backend"].as_str() {
                    let account = switch["to"]["account"].as_str().unwrap_or("");
                    match account {
                        "" => self.accounts.remove(to),
                        a => self.accounts.insert(to.into(), a.into()),
                    };
                    if let Some(m) = switch["to"]["model"].as_str() {
                        self.models.insert(to.into(), m.into());
                    }
                    // A new conversation: the old one stays in `convs` for delete.
                    if switch["fresh"] == true {
                        self.resume.remove(to);
                    }
                }
                // An input while the agent waits on a question is its answer, not a new turn.
                if let Some(t) = self.turns.first_mut().filter(|t| t.question.is_some()) {
                    t.question = None;
                    t.delivered = None;
                    t.cid = Some(cid);
                    t.ts = ts;
                    return;
                }
                self.backend = str_of("backend");
                // A terminal with no mirror has no turn boundaries: each input replaces the last.
                if self
                    .child
                    .as_ref()
                    .is_some_and(|c| c.pty && !c.exited && !c.mirror)
                {
                    self.turns.clear();
                }
                let retry_of = item["retry_of"].as_str().map(String::from);
                self.turns.push(Turn {
                    id: cid.clone(),
                    cid: Some(cid),
                    origin: str_of("origin"),
                    backend: str_of("backend"),
                    text: str_of("text"),
                    retry_of,
                    switch: item["switch"].clone(),
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
                let m = &item["mirror"];
                let mirror_group =
                    (m["pgid"].as_i64().zip(m["start_us"].as_u64())).map(|(g, s)| (g as i32, s));
                self.child = Some(Child {
                    pid,
                    start_us,
                    backend: str_of("backend"),
                    exited: false,
                    pty: item["mode"] == "pty",
                    mirror: m.is_object(),
                    mirror_group,
                });
                self.groups.push((pid, start_us));
                self.groups.extend(mirror_group);
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
                        id: format!("a{}", self.items),
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
            "answer" => drop(self.turns.first_mut().map(|t| t.question = None)),
            // A prompt the CLI took in its terminal. One a chat input typed starts that input's
            // turn, by the binding the mirror logged before it; any other is the user's own [D47].
            "prompt" => {
                self.last_out = ts;
                let cid = self.bound.remove(&str_of("id"));
                // The CLI takes a prompt only once the turn before it is over, ended or not (Esc
                // ends one with no turn end in its record).
                while self
                    .turns
                    .first()
                    .is_some_and(|t| t.began && (cid.is_none() || t.cid != cid))
                {
                    self.close("stopped", json!("terminal"), ts);
                }
                let typed =
                    cid.and_then(|c| self.turns.iter_mut().find(|t| t.cid.as_deref() == Some(&c)));
                if let Some(t) = typed {
                    t.began = true;
                    return;
                }
                // Ahead of inputs still queued: the CLI runs it now.
                let at = self
                    .turns
                    .iter()
                    .position(|t| !t.began)
                    .unwrap_or(self.turns.len());
                let turn = Turn {
                    id: format!("p{}", self.items),
                    origin: "user".into(),
                    backend: self.backend.clone(),
                    text: str_of("text"),
                    ts,
                    delivered: Some(ts),
                    began: true,
                    ..Default::default()
                };
                self.turns.insert(at, turn);
            }
            "resume_id" => {
                let (backend, id) = (str_of("backend"), str_of("id"));
                let account = self.accounts.get(&backend).cloned().unwrap_or_default();
                self.convs.insert((backend.clone(), account, id.clone()));
                self.resume.insert(backend, id);
            }
            "limited" => {
                self.limit = Some(str_of("message"));
                self.close("limited", item["message"].clone(), ts);
            }
            "sign_in" => {
                self.sign_in = Some(str_of("message"));
                self.close("sign_in", item["message"].clone(), ts);
            }
            "unresumable" => {
                self.refused = Some(str_of("message"));
                self.close("unresumable", item["message"].clone(), ts);
            }
            "stopped" => self.close_all("stopped", item["by"].clone(), ts),
            "compaction" if item["progress"] != "running" => self.compactions += 1,
            "unknown" | "unknown_frame" => self.unknown += 1,
            "note" => match item["event"].as_str() {
                Some("bound") => drop(self.bound.insert(str_of("prompt"), str_of("cid"))),
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
           "items": fold.items, "backend": fold.backend, "resume": fold.resume, "versions": fold.versions,
           "account": fold.accounts.get(&fold.backend), "switchable": switchable(fold)})
}

/// What a switch can act on [D51]: the limit (or refused resume) the last turn ended on, even with
/// the terminal open, which the state would show first [D47]. Only while no turn is open.
pub fn switchable(fold: &Fold) -> Option<&'static str> {
    if !fold.turns.is_empty() {
        return None;
    }
    match () {
        _ if fold.limit.is_some() => Some("limited"),
        _ if fold.refused.is_some() => Some("unresumable"),
        _ => None,
    }
}

/// Whether this session keeps the Mac awake [D30, D36]: background jobs its live agent left running,
/// or a delivered turn whose live agent is starting, has fresh output or runs a tool, in chat or in a
/// terminal alike. A turn waiting on the user, or quiet past its stall time, doesn't, so a hung CLI
/// can't keep a Mac awake in a bag.
pub fn works(fold: &Fold, live: &Live) -> bool {
    if live.owner != Owner::Alive {
        return false;
    }
    if live.jobs > 0 {
        return true;
    }
    let (Some(turn), Some(child)) = (fold.turns.first(), live.child) else {
        return false;
    };
    let waiting = child.stopped || turn.question.is_some();
    let Some(delivered) = turn.delivered.filter(|_| !waiting) else {
        return false;
    };
    let t = adapters::get(&turn.backend).map(|a| a.timing());
    let quiet_ms = t.map_or(30_000, |t| [t.no_start_ms, t.stall_ms][turn.began as usize]);
    let silence = live.now.saturating_sub(fold.last_out.max(delivered));
    silence < quiet_ms || (!turn.tools.is_empty() && live.running_below > 0)
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
            // An open terminal between turns, whatever the last chat turn's outcome was [D47].
            _ if live.child.is_some() && fold.child.as_ref().is_some_and(|c| c.pty) => {
                ("terminal", Value::Null)
            }
            _ if fold.sign_in.is_some() => ("sign_in", fold.sign_in.clone().into()),
            _ if fold.limit.is_some() => ("limited", fold.limit.clone().into()),
            _ if fold.refused.is_some() => ("unresumable", fold.refused.clone().into()),
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
    // Also in a terminal: the CLI waits on the user either way [D77].
    if let Some(q) = &turn.question {
        return ("waiting_answer", q.clone().into());
    }
    let silence = live.now.saturating_sub(fold.last_out.max(delivered));
    if fold.child.as_ref().is_some_and(|c| c.pty) {
        return ("terminal", json!({"quiet_ms": silence}));
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
