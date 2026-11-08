//! The one answer to "is it running?": a fold over the session's items plus what the kernel says
//! about the owner and the child. It never guesses Working: that needs an open, delivered turn, a
//! live child that isn't stopped, and either fresh output or a tool whose processes still run.

use crate::adapters;

mod asks;
mod live;
mod status;
pub use live::{Live, live, live_groups};
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
    /// The account or agent switch this input continues, as logged with it [D51].
    #[serde(default)]
    pub switch: Value,
    pub ts: u64,
    pub delivered: Option<u64>,
    pub began: bool,
    pub tools: BTreeSet<String>,
    pub question: Option<String>,
    /// Requests waiting on the user (approvals and questions), by the id their CLI gave them.
    #[serde(default)]
    pub asks: BTreeMap<String, Value>,
    /// The user asked it to stop: however its turn ends, it was stopped.
    #[serde(default)]
    pub stopping: bool,
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
    /// turn start compares to. None for a child no input set up (a terminal).
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
    /// Prompts in the CLI's record already bound to the chat input that typed them, by prompt id.
    #[serde(default)]
    pub bound: BTreeMap<String, String>,
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
    /// The session's grants, as the requests they answered: held for the whole session, and given
    /// again to a child started anew, never written to a CLI's settings [D193].
    #[serde(default)]
    pub grants: Vec<Value>,
    /// The agent's replies to requests Brigadier sent it, by request id: `{error, level}`.
    #[serde(default)]
    pub replies: BTreeMap<String, Value>,
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
            self.end_asks(outcome);
            self.turns.remove(0);
            self.finished = ts;
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
                | "terminal"
                | "stderr"
                | "unknown"
                | "usage"
                | "question"
                | "answer"
                | "approval"
                | "resolved"
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
                    self.end_asks("withdrawn");
                }
            }
        }
        match kind {
            "input" => {
                let cid = str_of("cid");
                *self.cids.entry(cid.clone()).or_default() += 1;
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
                self.delivered_control(cid.unwrap_or(""));
            }
            "spawned" => {
                let (pid, start_us) = (
                    item["pid"].as_i64().unwrap_or(0) as i32,
                    item["start_us"].as_u64().unwrap_or(0),
                );
                let m = &item["mirror"];
                let mirror_group =
                    (m["pgid"].as_i64().zip(m["start_us"].as_u64())).map(|(g, s)| (g as i32, s));
                // A spawn's own input came first and set it up; one with no input knows nothing.
                if item["cid"].is_null() {
                    self.given = None;
                }
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
                let stopped = self.turns.first().is_some_and(|t| t.stopping);
                let outcome = match () {
                    _ if stopped => "stopped",
                    _ if ok => "done",
                    _ => "failed",
                };
                self.close(outcome, Value::Null, ts);
            }
            "tool" => drop(self.turns.first_mut().map(|t| t.tools.insert(str_of("id")))),
            "tool_done" => drop(
                self.turns
                    .first_mut()
                    .map(|t| t.tools.remove(&str_of("id"))),
            ),
            "question" => {
                if let Some(t) = self.turns.first_mut() {
                    t.question = Some(str_of("text"));
                }
                self.ask(item);
            }
            "approval" => self.ask(item),
            "resolved" => self.end_ask(&str_of("id"), "withdrawn"),
            "reply" => drop(self.replies.insert(str_of("id"), item.clone())),
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
                self.sent = ts;
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
                // The user's Stop ends the limit; a terminal's handoff stop keeps it [D51, D47].
                if item["by"] == "user" {
                    (self.limit, self.resets, self.refused) = (None, None, None);
                }
                self.close_all("stopped", item["by"].clone(), ts)
            }
            "compaction" if item["progress"] != "running" => self.compactions += 1,
            "unknown" | "unknown_frame" => self.unknown += 1,
            "note" => match item["event"].as_str() {
                Some("bound") => drop(self.bound.insert(str_of("prompt"), str_of("cid"))),
                Some("interrupted") => self.close_all("interrupted", item["reason"].clone(), ts),
                Some("setup") => self.setup(item),
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
