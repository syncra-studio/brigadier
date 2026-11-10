//! The one answer to "is it running?": a fold over the session's items plus what the kernel says
//! about the owner and the child. It never guesses Working: that needs an open, delivered turn, a
//! live child that isn't stopped, and either fresh output or a tool whose processes still run.

use crate::adapters;

mod asks;
mod live;
mod rewind;
mod status;
pub use live::{Live, live, live_groups};
pub use rewind::Boundary;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
pub use status::{Owner, mark, status, switchable, works};
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
    /// The model recorded in this turn’s own setup, including the first input.
    #[serde(default)]
    pub model: Option<String>,
    /// The account or agent switch this input continues, as logged with it [D51].
    #[serde(default)]
    pub switch: Value,
    pub ts: u64,
    pub delivered: Option<u64>,
    pub began: bool,
    pub tools: BTreeSet<String>,
    /// When the earliest of its open tools started (ms).
    #[serde(default)]
    pub tools_since: u64,
    pub question: Option<String>,
    /// Requests waiting on the user (approvals and questions), by the id their CLI gave them.
    #[serde(default)]
    pub asks: BTreeMap<String, Value>,
    /// The user asked it to stop: however its turn ends, it was stopped.
    #[serde(default)]
    pub stopping: bool,
    /// Logged, then its owner died before delivering it.
    pub orphaned: bool,
    /// Its input starts a child that no `spawned` record has named yet.
    #[serde(default)]
    pub spawning: bool,
    /// Its input came while another turn ran: no clean boundary of its own.
    #[serde(default)]
    pub mid: bool,
    /// Its place in the CLI's own record, for a rewind: first entry, latest entry.
    #[serde(default)]
    pub start: Option<String>,
    #[serde(default)]
    pub end: Option<String>,
    /// The CLI's own retry, as logged with its time: shown while nothing came after it [D487].
    #[serde(default)]
    pub retry: Value,
    /// The CLI holds its reply for extra safety checks, until it says it let it go [D487].
    #[serde(default)]
    pub checking: bool,
    /// The files its edit steps changed: an edit counts once it ended well, or when the backend's
    /// own record lists it [D1023]. `editing` holds each edit step still open, by its id.
    #[serde(default)]
    pub edited: BTreeSet<String>,
    #[serde(default)]
    pub editing: BTreeMap<String, Vec<String>>,
}

#[derive(Default, Serialize, Deserialize, Clone)]
pub struct Child {
    pub pid: i32,
    pub start_us: u64,
    pub backend: String,
    pub exited: bool,
}

/// Another agent's model and effort, picked for the next message.
#[derive(Serialize, Deserialize, Clone)]
pub struct Picked {
    pub backend: String,
    pub model: String,
    pub effort: Option<String>,
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
    /// When the limit resets (ms), if its CLI said [D74].
    #[serde(default)]
    pub resets: Option<u64>,
    /// The limit is an account out of credits, which no reset lifts.
    #[serde(default)]
    pub credits: bool,
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
    /// The newest setup (model, effort, level) given to the running child, from its inputs: what a
    /// turn start compares to. None for a child no input set up.
    #[serde(default)]
    pub given: Option<Value>,
    /// The effort each backend runs at, as the app last set it; none is the CLI's default [D129].
    #[serde(default)]
    pub efforts: BTreeMap<String, String>,
    /// Another agent the user picked: the next message goes to it in a new conversation [D90].
    #[serde(default)]
    pub picked: Option<Picked>,
    /// The app's op id of the last `set` taken, which its pick reconciles by [D30].
    #[serde(default)]
    pub setup_op: Option<String>,
    pub cids: BTreeMap<String, u32>,
    pub unknown: u64,
    pub compactions: u64,
    pub items: u64,
    /// The user's last send, else the first frame's time (ms): the list's order, which a turn never moves.
    #[serde(default)]
    pub sent: u64,
    /// When a turn last ended, however it ended (ms): later than the seen time, it's unread [D173].
    #[serde(default)]
    pub finished: u64,
    /// The latest ended turn that changed files: `{at, files}`, its end and how many files. What
    /// opens the panel the first time [D1023, D1125]; never inferred from the checkout's state.
    #[serde(default)]
    pub edited: Option<Value>,
    /// Requests no longer pending, by id, and why: answered, uncertain (an answer never proven
    /// delivered), withdrawn, or the outcome of the turn they ended with.
    #[serde(default)]
    pub closed: BTreeMap<String, String>,
    /// Answers logged and not yet delivered: command id → request id.
    #[serde(default)]
    pub claims: BTreeMap<String, String>,
    /// "Allow … for this session" answers logged and not yet delivered: command id → request.
    #[serde(default)]
    pub granting: BTreeMap<String, Value>,
    /// The session's grants, as the requests they answered: held while its host lives, and given
    /// again to a child started anew, never written to a CLI's settings [D193].
    #[serde(default)]
    pub grants: Vec<Value>,
    /// The agent's replies to requests Brigadier sent it, by request id: `{error, level}`.
    #[serde(default)]
    pub replies: BTreeMap<String, Value>,
    /// Inputs written to an agent that acks, not yet applied by its reply [D222].
    #[serde(default)]
    pub acking: BTreeSet<String>,
    /// Every finished turn still in the conversation, oldest first [D384].
    #[serde(default)]
    pub boundaries: Vec<Boundary>,
    /// Counts switches: a rewind stays on this side of the latest.
    #[serde(default)]
    pub generation: u64,
    /// The record's entry each backend must resume at after a rewind, moving with its turns.
    #[serde(default)]
    pub pin: BTreeMap<String, String>,
    /// Rewinds done, by the app's op id: one is never done twice [D54].
    #[serde(default)]
    pub rewinds: BTreeSet<String>,
}

impl Fold {
    /// The app's `set` [D129]: the conversation's agent takes the model and effort from its next
    /// turn, which drops a pick; another agent is picked, for the next message [D90].
    fn setup(&mut self, item: &Value) {
        let b = item["backend"].as_str().unwrap_or("").to_string();
        let model = item["model"].as_str().unwrap_or("").to_string();
        let effort = item["effort"].as_str().map(String::from);
        self.setup_op = item["op"].as_str().map(String::from);
        if item["pick"] == true {
            self.picked = Some(Picked {
                backend: b,
                model,
                effort,
            });
            return;
        }
        self.picked = None;
        match effort {
            Some(e) => self.efforts.insert(b.clone(), e),
            None => self.efforts.remove(&b),
        };
        self.models.insert(b, model);
    }

    fn close(&mut self, outcome: &str, reason: Value, ts: u64) {
        if let Some(turn) = self.turns.first().cloned() {
            self.end_asks(if outcome == "interrupted" {
                "withdrawn"
            } else {
                outcome
            });
            self.turns.remove(0);
            self.finished = ts;
            if !turn.edited.is_empty() {
                self.edited = Some(json!({"at": ts, "files": turn.edited.len()}));
            }
            self.bound(&turn);
            self.last = Some(
                json!({"id": turn.id, "cid": turn.cid, "origin": turn.origin, "backend": turn.backend, "retry_of": turn.retry_of, "text": turn.text, "outcome": outcome, "reason": reason, "ts": ts,
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
        if self.sent == 0 {
            self.sent = ts;
        }
        let str_of = |k: &str| item[k].as_str().unwrap_or("").to_string();
        let kind = item["kind"].as_str().unwrap_or("");
        if matches!(
            kind,
            "text"
                | "tool"
                | "tool_done"
                | "turn_start"
                | "turn_end"
                | "stderr"
                | "unknown"
                | "usage"
                | "question"
                | "answer"
                | "approval"
                | "resolved"
                | "reasoning"
                | "compaction"
                | "retrying"
                | "checking"
                | "rerouted"
                | "failed"
                | "denied"
        ) {
            self.last_out = ts;
            if let Some(t) = self.turns.first_mut() {
                t.began = true;
                if kind != "retrying" {
                    t.retry = Value::Null;
                }
            }
        }
        match kind {
            "retrying" => {
                if let Some(t) = self.turns.first_mut() {
                    t.retry = json!({"attempt": item["attempt"], "max": item["max"], "at": item["at"], "ts": ts});
                }
            }
            "checking" | "text" => {
                if let Some(t) = self.turns.first_mut() {
                    t.checking = item["on"] == true;
                }
            }
            "input" => {
                let cid = str_of("cid");
                *self.cids.entry(cid.clone()).or_default() += 1;
                if item["ack"] == true {
                    self.acking.insert(cid.clone());
                }
                if item["setup"].is_object() {
                    self.given = Some(item["setup"].clone());
                }
                if self.control(item, &cid) {
                    return;
                }
                (self.limit, self.resets) = (None, None);
                self.sign_in = None;
                self.refused = None;
                // A switch takes effect with the input that continues it, in the same frame [D51].
                let switch = &item["switch"];
                if let Some(to) = switch["to"]["backend"].as_str() {
                    self.generation += 1;
                    let account = switch["to"]["account"].as_str().unwrap_or("");
                    match account {
                        "" => self.accounts.remove(to),
                        a => self.accounts.insert(to.into(), a.into()),
                    };
                    if let Some(m) = switch["to"]["model"].as_str() {
                        self.models.insert(to.into(), m.into());
                    }
                    match switch["to"]["effort"].as_str() {
                        Some(e) => self.efforts.insert(to.into(), e.into()),
                        None => self.efforts.remove(to),
                    };
                    self.picked = None;
                    // For delete, `convs` keeps the old conversation, or the same one's new account.
                    if switch["fresh"] == true {
                        self.resume.remove(to);
                        self.pin.remove(to);
                    } else if let Some(id) = self.resume.get(to) {
                        self.convs.insert((to.into(), account.into(), id.clone()));
                    }
                }
                // An input while the agent waits on a question is its answer, not a new turn.
                if let Some(t) = self.turns.first_mut().filter(|t| t.question.is_some()) {
                    t.question = None;
                    let asked = t.asks.iter().filter(|(_, r)| r["items"].is_array());
                    let asked: Vec<String> = asked.map(|(id, _)| id.clone()).collect();
                    asked.iter().for_each(|id| self.end_ask(id, "answered"));
                    let t = &mut self.turns[0];
                    t.delivered = None;
                    t.cid = Some(cid);
                    t.ts = ts;
                    return;
                }
                self.backend = str_of("backend");
                if item["origin"] == "user" {
                    self.sent = ts;
                }
                let retry_of = item["retry_of"].as_str().map(String::from);
                let mid = !self.turns.is_empty();
                self.turns.push(Turn {
                    mid,
                    id: cid.clone(),
                    cid: Some(cid),
                    origin: str_of("origin"),
                    backend: str_of("backend"),
                    text: str_of("text"),
                    retry_of,
                    model: item["setup"]["model"].as_str().map(String::from),
                    switch: item["switch"].clone(),
                    ts,
                    spawning: item["starts_child"] == true,
                    ..Default::default()
                });
            }
            "delivered" if !self.acking.contains(&str_of("cid")) => {
                self.delivered(&str_of("cid"), ts)
            }
            "spawned" => {
                let (pid, start_us) = (
                    item["pid"].as_i64().unwrap_or(0) as i32,
                    item["start_us"].as_u64().unwrap_or(0),
                );
                // A spawn's own input came first and set it up; one with no input knows nothing.
                if item["cid"].is_null() {
                    self.given = None;
                }
                self.child = Some(Child {
                    pid,
                    start_us,
                    backend: str_of("backend"),
                    exited: false,
                });
                self.groups.push((pid, start_us));
                if let Some(v) = item["cli_version"].as_str() {
                    self.versions.insert(str_of("backend"), v.into());
                }
                self.spawn_settled(&str_of("cid"), false);
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
                let stopped = self.turns.first().is_some_and(|t| t.stopping);
                let outcome = match () {
                    _ if stopped => "stopped",
                    _ if ok => "done",
                    _ => "failed",
                };
                self.close(outcome, Value::Null, ts);
            }
            "mark" => self.mark(item),
            "tool" => {
                if let Some(t) = self.turns.first_mut() {
                    if t.tools.is_empty() {
                        t.tools_since = ts;
                    }
                    t.tools.insert(str_of("id"));
                    if item["step"] == "edit" {
                        let mut paths = paths_of(&item["changes"]);
                        if paths.is_empty() && !str_of("input").is_empty() {
                            paths.push(str_of("input"));
                        }
                        t.editing.insert(str_of("id"), paths);
                    }
                }
            }
            "tool_done" => {
                if let Some(t) = self.turns.first_mut() {
                    t.tools.remove(&str_of("id"));
                    let paths = t.editing.remove(&str_of("id"));
                    if item["ok"] == true {
                        t.edited.extend(
                            paths
                                .into_iter()
                                .flatten()
                                .chain(paths_of(&item["changes"])),
                        );
                    }
                }
            }
            // The backend's own record of a turn's edits [D95].
            "changes" => {
                if let Some(t) = self.turns.first_mut() {
                    t.edited.extend(paths_of(&item["changes"]));
                }
            }
            "question" => {
                if let Some(t) = self.turns.first_mut() {
                    t.question = Some(str_of("text"));
                }
                self.ask(item);
            }
            "approval" => self.ask(item),
            "resolved" => {
                let id = str_of("id");
                self.end_ask(&id, item["decision"].as_str().unwrap_or("withdrawn"));
            }
            "reply" => {
                self.replies.insert(str_of("id"), item.clone());
                self.acked(item, ts);
            }
            // The level the agent says it runs at is the one recorded, never the one asked [D175].
            "level" => {
                if let Some(g) = self.given.as_mut().filter(|g| g.is_object()) {
                    g["level"] = item["level"].clone();
                }
            }
            "answer" => {
                if let Some(t) = self.turns.first_mut() {
                    t.question = None;
                }
                self.end_ask(&str_of("id"), "answered");
            }
            "resume_id" => {
                let (backend, id) = (str_of("backend"), str_of("id"));
                let account = self.accounts.get(&backend).cloned().unwrap_or_default();
                self.convs.insert((backend.clone(), account, id.clone()));
                self.resume.insert(backend, id);
            }
            "limited" => {
                self.limit = Some(str_of("message"));
                self.credits = item["credits"] == true;
                // A second limit line that gives no time keeps the one the first gave [D74].
                self.resets = item["resets"].as_u64().or(self.resets);
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
            "stopped" => {
                // The user's Stop ends the limit; a handoff's stop keeps it [D51].
                if item["by"] == "user" {
                    (self.limit, self.resets, self.refused) = (None, None, None);
                }
                self.close_all("stopped", item["by"].clone(), ts)
            }
            "compaction" if item["progress"] != "running" => self.compactions += 1,
            "unknown" | "unknown_frame" => self.unknown += 1,
            "note" => match item["event"].as_str() {
                Some("interrupted") => self.close_all("interrupted", item["reason"].clone(), ts),
                Some("setup") => self.setup(item),
                Some("rewound") => self.rewound(item),
                Some("spawn_failed") => self.spawn_settled(&str_of("cid"), true),
                Some("owner_started") => {
                    self.interrupt(json!({"owner_restarted": true}), ts);
                    self.turns
                        .iter_mut()
                        .filter(|t| t.delivered.is_none())
                        .for_each(|t| t.orphaned = true);
                    // Session grants live as long as the host that holds them [D193, D238].
                    self.grants.clear();
                    self.granting.clear();
                }
                _ => {}
            },
            _ => {}
        }
    }
}

/// The paths a FileChange list names.
fn paths_of(changes: &Value) -> Vec<String> {
    (changes.as_array().into_iter().flatten())
        .filter_map(|c| c["path"].as_str().map(String::from))
        .collect()
}
