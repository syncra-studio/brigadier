//! The one answer to "is it running?": a fold over the session's items plus what the kernel says
//! about the owner and the child. It never guesses Working: that needs an open, delivered turn, a
//! live child that isn't stopped, and either fresh output or a tool whose processes still run.

use crate::adapters;

mod asks;
mod input;
mod live;
pub mod plan;
mod rewind;
pub mod runs;
mod status;
mod turns;
pub use live::{
    Job, Live, background_row, history, live, live_groups, note_stop, stop_job, task_of,
};
pub use rewind::Boundary;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
pub use status::{Owner, held, mark, notice, quiet, resumable, status, switchable, woke, works};
use std::collections::{BTreeMap, BTreeSet};
pub use turns::Turn;

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
    #[serde(default)]
    pub fast: bool,
    /// Its name as the picker shows it; the id where none was given.
    #[serde(default)]
    pub name: String,
}

#[derive(Default, Serialize, Deserialize, Clone)]
pub struct Fold {
    pub turns: Vec<Turn>,
    pub last: Option<Value>,
    pub last_out: u64,
    pub child: Option<Child>,
    /// Each spawned group, with the session folder its record names ("" before D220).
    pub groups: Vec<(i32, u64, String)>,
    /// The live child's ended turns, from first tool to end (ms): what was born in one and still
    /// runs under it was left running [D105].
    #[serde(default)]
    pub windows: Vec<(u64, u64)>,
    /// The live child's commands sent to the background, by when that was said (ms), with the id
    /// its CLI gave each, where it gives one.
    #[serde(default)]
    pub tasks: Vec<(u64, String)>,
    /// Each command as the agent typed it: by its step's id while it runs, by its task's id once
    /// sent to the background, so its Background row reads `python3 …`, not the process's name.
    #[serde(default)]
    pub typed: BTreeMap<String, String>,
    /// The agent's own calls at work, oldest first, as `{id, step, name, input, description}`: a
    /// worker's newest is what its strip row says it does [D143]. Plumbing has no step and isn't one.
    #[serde(default)]
    pub calls: Vec<Value>,
    /// The live child's subagents still running, by step id: a turn that answered stays held open
    /// till they end [D118].
    #[serde(default)]
    pub agents: BTreeSet<String>,
    pub resume: BTreeMap<String, String>,
    pub versions: BTreeMap<String, String>,
    /// Each agent's own commands, as it last listed them [D2009].
    #[serde(default)]
    pub commands: BTreeMap<String, Value>,
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
    /// A worker held for the user's call, its routing row out of quota: Rust's `hold` note while
    /// asked, then while it waits for the reset (`until`) [D2028, D342].
    #[serde(default)]
    pub hold: Option<Value>,
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
    /// Each turn a switch carried on, by its id: the switch's own input, which goes on in its
    /// place [D51, D2041].
    #[serde(default)]
    pub carried: BTreeMap<String, String>,
    /// The newest setup (model, effort, level) given to the running child, from its inputs: what a
    /// turn start compares to. None for a child no input set up.
    #[serde(default)]
    pub given: Option<Value>,
    /// The effort each backend runs at, as the app last set it; none is the CLI's default [D129].
    #[serde(default)]
    pub efforts: BTreeMap<String, String>,
    /// The backends whose model runs on its fast tier, as the app last set it.
    #[serde(default)]
    pub fast: BTreeSet<String>,
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
    /// Backends whose next launch makes a fork's conversation, forking the one it resumes [D1089].
    #[serde(default)]
    pub branching: BTreeSet<String>,
    /// Rewinds done, by the app's op id: one is never done twice [D54].
    #[serde(default)]
    pub rewinds: BTreeSet<String>,
    #[serde(default)]
    pub runs: runs::Runs,
    /// How full the conversation's window is, `{used, window}`, as its CLI last said; none since
    /// a new conversation began [D88].
    #[serde(default)]
    pub context: Option<Value>,
    /// The agent's to-do list as it last wrote it [D104].
    #[serde(default)]
    pub plan: Option<Value>,
    /// The turn Brigadier stopped for a rebirth: it goes on in a fresh conversation [D108].
    #[serde(default)]
    pub cut: Option<String>,
    /// That cut was for a model or agent the user picked mid-turn: it carries on there [D124].
    #[serde(default)]
    pub switched: bool,
    /// The stalled turn the user's Continue carries on: the rebirth guard starts over [D144].
    #[serde(default)]
    pub go_on: Option<String>,
    /// Its CLI's newest usage report in a run, `{backend, account, limits, at}`, for the store [D2039].
    #[serde(default)]
    pub limits: Option<Value>,
    /// Its plans' adversarial reviews [§6].
    #[serde(default)]
    pub plans: plan::Reviews,
}

impl Fold {
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
                | "text_delta"
                | "tool"
                | "tool_done"
                | "turn_start"
                | "turn_end"
                | "stderr"
                | "unknown"
                | "usage"
                | "limits"
                | "context"
                | "plan"
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
                t.unchecked |= item["unchecked"] == true; // its own check gave no verdict [D455]
                t.said |= matches!(
                    kind,
                    "text" | "text_delta" | "tool" | "reasoning" | "question" | "approval" | "plan"
                );
                if kind != "retrying" {
                    t.retry = Value::Null;
                }
            }
        }
        match kind {
            "failed" => {
                if let Some(t) = self.turns.first_mut() {
                    t.why = item["why"].as_str().map(String::from);
                }
            }
            "retrying" => {
                if let Some(t) = self.turns.first_mut() {
                    t.retry = json!({"attempt": item["attempt"], "max": item["max"], "at": item["at"], "ts": ts});
                }
            }
            "checking" | "text" | "text_delta" => {
                if let Some(t) = self.turns.first_mut() {
                    t.checking = item["on"] == true;
                }
            }
            "input" => self.input(item, ts),
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
                self.groups.push((pid, start_us, str_of("dir")));
                self.windows.clear();
                self.tasks.clear();
                self.typed.clear();
                self.calls.clear();
                self.agents.clear();
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
                self.agents.clear();
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
                // The agent woke: what a held turn's subagent asked ends, as at any new turn.
                if self.turns.first().is_some_and(|t| t.held) {
                    self.close("withdrawn", Value::Null, ts);
                }
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
                let stopped = self.turns.first().filter(|t| t.stopping);
                let outcome = match () {
                    _ if stopped.is_some() => "stopped",
                    _ if ok => "done",
                    _ => "failed",
                };
                let by = stopped.map(|t| t.stop_by.clone()).unwrap_or_default();
                self.calls.clear();
                self.close(outcome, by, ts);
            }
            "mark" => self.mark(item),
            // A command or watch sent to the background, by what the agent said it does [D187].
            "background" => {
                self.tasks.push((ts, str_of("task")));
                if let Some(label) = item["label"].as_str().filter(|l| !l.is_empty()) {
                    self.typed.insert(str_of("task"), label.into());
                }
            }
            "tool" => {
                if let (Some("run"), Some(input)) = (item["step"].as_str(), item["input"].as_str())
                {
                    self.typed.insert(str_of("id"), input.into());
                }
                if item["step"] == "agent" && item["parent"].is_null() {
                    self.agents.insert(str_of("id"));
                }
                if item["parent"].is_null() && item["step"].as_str().is_some_and(|s| !s.is_empty())
                {
                    self.calls.push(json!({"id": item["id"], "step": item["step"], "name": item["name"], "input": item["input"], "description": item["description"]}));
                }
                self.run_started(item, ts);
                let again = item["step"] == "run"
                    && (runs::looks(&str_of("input")) || !self.runs.ran.insert(str_of("input")));
                if let Some(t) = self.turns.first_mut() {
                    t.tool_started(item, ts, again);
                }
            }
            "tool_done" => {
                let typed = self.typed.remove(&str_of("id"));
                self.calls.retain(|c| c["id"] != item["id"]);
                if let (true, Some(task)) = (item["cut"] == true, item["child"].as_str()) {
                    self.tasks.push((ts, task.into()));
                    // What the agent said it does, when its CLI said so first, before the command.
                    if let Some(typed) = typed {
                        self.typed.entry(task.into()).or_insert(typed);
                    }
                }
                if item["parent"].is_null() {
                    self.agents.remove(&str_of("id"));
                }
                self.run_done(item, ts);
                if let Some(t) = self.turns.first_mut() {
                    t.tools.remove(&str_of("id"));
                    t.edit_done(item);
                }
            }
            // The backend's own record of a turn's edits [D95].
            "changes" => {
                if let Some(t) = self.turns.first_mut() {
                    t.edited.extend(turns::paths_of(&item["changes"]));
                }
            }
            "question" => {
                self.held_ask(ts);
                if let Some(t) = self.turns.first_mut() {
                    t.question = Some(str_of("text"));
                }
                self.ask(item);
            }
            "approval" => {
                self.held_ask(ts);
                self.ask(item);
            }
            "resolved" => {
                let id = str_of("id");
                self.end_ask(&id, item["decision"].as_str().unwrap_or("withdrawn"));
                self.unhold();
            }
            "reply" => {
                self.replies.insert(str_of("id"), item.clone());
                self.acked(item, ts);
            }
            // The level the agent says it runs at is the one recorded, never the one asked [D175].
            "level" => self.took("level", &item["level"]),
            "model" => self.took("real", &item["id"]),
            "answer" => {
                if let Some(t) = self.turns.first_mut() {
                    t.question = None;
                }
                self.end_ask(&str_of("id"), "answered");
                self.unhold();
            }
            "commands" => {
                self.commands
                    .insert(str_of("backend"), item["list"].clone());
            }
            "resume_id" => {
                let (backend, id) = (str_of("backend"), str_of("id"));
                let account = self.accounts.get(&backend).cloned().unwrap_or_default();
                self.convs.insert((backend.clone(), account, id.clone()));
                self.branched(&backend, &id);
                if self.resume.get(&backend) != Some(&id) {
                    self.context = None;
                }
                self.resume.insert(backend, id);
            }
            "context" => self.context = Some(crate::rebirth::reading(self.context.as_ref(), item)),
            "plan" => self.plan = Some(item["steps"].clone()),
            "limits" => {
                let account = self
                    .accounts
                    .get(&self.backend)
                    .cloned()
                    .unwrap_or_default();
                self.limits = Some(json!({"backend": self.backend, "account": account,
                    "limits": item["limits"], "at": ts}));
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
                // The user's Stop or Pause ends the limit; a handoff's stop keeps it [D51].
                if matches!(item["by"].as_str(), Some("user" | "pause")) {
                    (self.limit, self.resets, self.refused) = (None, None, None);
                }
                self.agents.clear();
                self.close_all("stopped", item["by"].clone(), ts)
            }
            "compaction" if item["progress"] != "running" => self.compactions += 1,
            "unknown" | "unknown_frame" => self.unknown += 1,
            "note" => match item["event"].as_str() {
                Some("interrupted") => self.close_all("interrupted", item["reason"].clone(), ts),
                Some("rebirth_cut") => {
                    (self.cut, self.switched) = (Some(str_of("turn")), item["switch"] == true)
                }
                Some("go_on") => self.go_on = Some(str_of("turn")),
                // A new level the running child confirmed mid-turn [D166].
                Some("level") => self.took("level", &item["level"]),
                Some("setup") => self.setup(item),
                Some("rewound" | "forked" | "unforked") => self.rewound(item),
                Some("spawn_failed") => self.spawn_settled(&str_of("cid"), true),
                Some("peer") => self.passed_to_user(item),
                Some("plan_review") => self.plan_review(item),
                Some("hold") => self.hold = (item["phase"] != "answered").then(|| item.clone()),
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
