//! The thread fold [D64, D65]: normalised items in, the thread view's `item.ts` out. Rust sends
//! structure (rows, groups, each turn's work, step kinds); the UI writes the words. Which turn runs
//! comes from the status fold, so it has one answer. Grouping follows the old app [D48]: steps in a
//! row are one group; reasoning and plumbing don't break it; any other row does. The same items
//! give the same thread, so ids and `n` stay stable across reads.

use crate::adapters;
use crate::fold::{Fold, Turn};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeSet, HashMap, HashSet};

mod asks;
mod find;
mod page;
mod peer;
mod rows;
mod saved;
mod team;
mod turn;

pub use saved::{Rows, Saved};

/// The turn on screen: the status fold's first turn, from when it became first.
#[derive(Clone, Serialize, Deserialize)]
struct Open {
    id: String,
    backend: String,
    /// Its index in `turns`, and where its rows start in `items`.
    at: usize,
    from: usize,
    started: u64,
    /// It began with an input, so a "Worked for" header can sit under it.
    input: bool,
    /// `n` of its first item after the input, and of its latest assistant text.
    first: Option<u64>,
    answer: Option<u64>,
    /// The group row taking steps, by index; how many groups the turn has had.
    group: Option<usize>,
    groups: usize,
    /// The newest question still unanswered, by index.
    asked: Option<usize>,
    wait: Option<u64>,
    waited: u64,
    /// `n` of its question rows: they stay out of its work fold, like the user's own messages [D99].
    kept: Vec<u64>,
    /// Actions the CLI's own rule or reviewer turned down in it, with nobody asked [D487].
    denied: usize,
    /// Who asked it to stop ("user", or "pause" for a worker's Pause), and whether its line is drawn.
    #[serde(default)]
    stop: (Option<String>, bool),
}

/// Saved whole with its rows apart (`saved`); what only says what changed since the last send isn't.
#[derive(Default, Clone, Serialize, Deserialize)]
pub struct Thread {
    fold: Fold,
    #[serde(skip)]
    pub items: Rows,
    pub turns: Vec<Value>,
    pub work: Vec<Value>,
    open: Option<Open>,
    /// Status-fold turns already shown, by id.
    shown: HashSet<String>,
    /// (turn, tool or question id) → its row's index.
    #[serde(with = "pairs")]
    keys: HashMap<(String, String), usize>,
    /// A step's row index → its group row's index.
    member: HashMap<usize, usize>,
    /// Subagents not yet ended, by tool id: one in the background may end turns later [D78].
    children: HashMap<String, usize>,
    /// What old rows the fold looks up, kept so it never reads old history back [D503]: message
    /// rows' `cid`s, rows by a custom id, and each turn's first row.
    cids: HashSet<String>,
    named: HashMap<String, usize>,
    first_rows: HashMap<String, usize>,
    /// Turns ended so far: a checkpoint is saved when one ended since the last [D503].
    closed: u64,
    #[serde(skip)]
    changed_items: BTreeSet<usize>,
    #[serde(skip)]
    changed_turns: BTreeSet<usize>,
    #[serde(skip)]
    sent_work: usize,
    /// The switch row of a limit no switch has taken yet, by index.
    limit_row: Option<usize>,
    /// The switch row of another agent picked, until the message that goes to it [D76].
    pick_row: Option<usize>,
    /// When the last limit on this side resets (ms), as its CLI said: the next turn after it says so [D487].
    reset_at: Option<u64>,
    /// The agent and model the last turn ran: the next turn on another model of the same agent says so [D487].
    ran: Option<(String, String)>,
    /// The turn whose terminal failure was already shown (some CLIs repeat it in their result).
    failed: Option<String>,
    /// Rows of the requests still waiting on the user, oldest first, and whether that changed.
    pending: Vec<usize>,
    #[serde(skip)]
    pending_changed: bool,
    /// Answers logged, not yet delivered: command id → (row, the answer).
    claims: HashMap<String, (usize, Value)>,
    /// The level the last input set up, to tell when trust taken back holds the next to Ask.
    level: Option<Value>,
    /// Control inputs written to an agent that acks, not yet applied by its reply [D222].
    acking: HashSet<String>,
    startup: crate::worktrees::Startup,
    /// Where the latest setup ran when its input row was still held back.
    setup_at: Option<usize>,
    /// Read from the session's folder, not the log: never saved.
    #[serde(skip)]
    setup: Value,
    #[serde(skip)]
    setup_changed: bool,
    points: Vec<String>,
}

/// Items that may close turns: only then is the status fold's list kept from before the push.
const CLOSES: [&str; 9] = [
    "exited",
    "reply",
    "turn_end",
    "limited",
    "sign_in",
    "unresumable",
    "stopped",
    "note",
    "input",
];

impl Thread {
    pub fn push(&mut self, item: &Value) {
        if crate::worktree_setup::setup_launch(item) {
            // An earlier undelivered turn can hold this input's row back until after its launch.
            self.setup_at = Some(
                item["cid"]
                    .as_str()
                    .and_then(|cid| self.first_rows.get(cid).copied())
                    .unwrap_or(self.items.len()),
            );
        }
        self.startup.push(item);
        let ts = item["ts"].as_u64().unwrap_or(0);
        let kind = item["kind"].as_str().unwrap_or("");
        let before: Vec<Turn> = if CLOSES.contains(&kind) {
            self.fold.turns.clone()
        } else {
            vec![]
        };
        // An input while the agent waits on a question is its answer (the status fold's rule).
        let answering = kind == "input"
            && !item["control"].is_object()
            && item["steer"] != true
            && self
                .fold
                .turns
                .first()
                .is_some_and(|t| t.question.is_some());
        // Another model or agent picked: its line the moment it's picked [D76].
        let pick = (kind == "note" && item["event"] == "setup").then(|| self.before_pick(item));
        self.fold.push(item);
        if let Some(before) = pick {
            self.picked(item, before);
        }
        // Trust taken back holds the next turn to Ask, said once by a notice (proposed); a
        // session held from its start says nothing, its picker shows Ask [D166].
        let setup = &item["setup"];
        if kind == "input" && setup.is_object() {
            let was = self.level.replace(setup["level"].clone());
            if setup["held"] == true && was.is_some_and(|l| l.is_string() && l != "ask") {
                self.break_group();
                self.add(json!({"kind": "notice", "reason": "untrusted"}));
            }
        }
        if answering {
            if let Some(at) = self.open.as_mut().and_then(|o| o.asked.take()) {
                self.items[at]["answer"] = item["text"].clone();
                self.changed_items.insert(at);
                self.unwait_row(at);
            }
            self.end_wait(ts);
        } else if kind == "input" && item["control"].is_object() {
            self.control(item, ts);
        } else if kind == "input" {
            // A joined input (a steer) keeps the running turn and adds no queued turn: its bubble
            // shows in that turn, after the answer it joined.
            let peer = item["origin"]
                .as_str()
                .and_then(|o| o.strip_prefix("peer:"));
            if (item["origin"] == "user" || peer.is_some())
                && before.len() == self.fold.turns.len()
                && before
                    .first()
                    .zip(self.fold.turns.first())
                    .is_some_and(|(before, after)| before.id == after.id)
            {
                if let Some(answer) = self.open.as_ref().and_then(|o| o.answer) {
                    let at = answer as usize - 1;
                    self.items[at]["joined"] = true.into();
                    self.changed_items.insert(at);
                }
                if item["steer"] == true {
                    self.break_group();
                    let mut row = json!({"kind": "message", "role": "user", "text": item["text"],
                        "streaming": false, "origin": "user", "sentAt": ts, "cid": item["cid"],
                        "files": item["parts"]["files"], "draft": item["parts"]});
                    if let Some(from) = peer {
                        let text = item["text"].as_str().unwrap_or("");
                        row = Self::peer_item(from, text, ts, &item["cid"]);
                    }
                    row["steer"] = true.into();
                    let at = self.add(row);
                    // The user's own words stay out of the work fold, like a question [D99].
                    if let Some(o) = self.open.as_mut() {
                        o.kept.push(at as u64 + 1);
                    }
                }
            }
        } else {
            self.content(item, kind, ts);
        }
        let after: HashSet<String> = self.fold.turns.iter().map(|t| t.id.clone()).collect();
        let outcome = self
            .fold
            .last
            .as_ref()
            .map_or("failed", |l| l["outcome"].as_str().unwrap_or("failed"))
            .to_string();
        for t in before.iter().filter(|t| !after.contains(&t.id)) {
            // A queued input closed before it ran (a stop) still shows, as a turn of its own.
            if !self.shown.contains(&t.id) {
                self.open_turn(t, ts);
            }
            self.turn_ended(t, item, &outcome, ts);
            self.close_turn(&outcome, ts);
        }
        if let Some(t) = self
            .fold
            .turns
            .first()
            .filter(|t| !self.shown.contains(&t.id))
            .cloned()
        {
            self.close_turn(&outcome, ts);
            self.open_turn(&t, ts);
        }
    }

    /// Ends the open turn. Every outcome the status fold knows maps to one of the view's [D64].
    fn close_turn(&mut self, outcome: &str, ts: u64) {
        self.end_wait(ts);
        // What still waited ends with its turn: undecided, it reads as withdrawn.
        self.withdraw_all();
        let Some(o) = self.open.take() else {
            return;
        };
        self.closed += 1;
        let status = match outcome {
            "done" => "done",
            "stopped" => "cancelled",
            "failed" | "interrupted" | "limited" | "sign_in" | "unresumable" => "failed",
            _ => "failed",
        };
        // A step the CLI never reported ending can't outlive its turn: it takes the turn's end, its
        // own end time staying unreported. A subagent may, while the CLI's process lives on.
        let lives_on = adapters::get(&o.backend).is_some_and(|a| !a.per_turn());
        for at in o.from..self.items.len() {
            let row = &self.items[at];
            let kind = row["kind"].as_str().unwrap_or("");
            if row["progress"] == "running"
                && kind != "compaction"
                && !(lives_on && kind == "childAgent")
            {
                self.items[at]["progress"] = status.into();
                self.changed_items.insert(at);
                self.children.retain(|_, &mut c| c != at);
            }
        }
        let denied = (self.items.range(o.from..self.items.len()))
            .filter(|r| r["kind"] == "approval" && r["decision"] == "denied")
            .count()
            + o.denied;
        let turn = &mut self.turns[o.at];
        turn["status"] = status.into();
        turn["endedAt"] = ts.into();
        turn["denied"] = denied.into();
        self.changed_turns.insert(o.at);
        if let Some(answer) = o.answer {
            let at = answer as usize - 1;
            self.items[at]["final"] = true.into();
            self.changed_items.insert(at);
        }
        // "Worked for" folds a done turn's work up to its answer, and leaves its waits out [D77]. Its
        // questions, with the user's answers, stay visible inside it [D99].
        if let (true, true, Some(first), Some(answer)) =
            (status == "done", o.input, o.first, o.answer)
        {
            let kept: Vec<u64> = o.kept.into_iter().filter(|&n| n < answer).collect();
            if first + (kept.len() as u64) < answer {
                let ms = ts.saturating_sub(o.started).saturating_sub(o.waited);
                self.work.push(
                    json!({"turnId": o.id, "ms": ms, "folded": [first, answer - 1],
                    "kept": kept, "denied": denied}),
                );
            }
        }
    }

    /// Ends whatever still runs because its host or agent is gone, which no frame may ever say:
    /// the daemon calls this when the session's live state reads interrupted.
    pub fn interrupt(&mut self, ts: u64) {
        self.fold.interrupt(Value::Null, ts);
        self.interrupted_line();
        self.close_turn("interrupted", ts);
        self.end_children("failed");
    }

    /// True while a turn or a subagent still runs.
    pub fn running(&self) -> bool {
        self.open.is_some() || !self.children.is_empty()
    }

    /// The status fold this thread keeps, for the live checks only the daemon can make.
    pub fn status_fold(&self) -> &Fold {
        &self.fold
    }

    fn end_children(&mut self, progress: &str) {
        for (_, at) in std::mem::take(&mut self.children) {
            self.items[at]["progress"] = progress.into();
            self.changed_items.insert(at);
        }
    }

    fn turn_id(&self) -> Option<String> {
        self.open.as_ref().map(|o| o.id.clone()).or_else(|| {
            self.turns
                .last()
                .and_then(|t| t["id"].as_str())
                .map(String::from)
        })
    }

    /// Adds a row; its `n` is its place in the thread, counting from 1, and its id follows from it.
    fn add(&mut self, row: Value) -> usize {
        self.add_as(row, None)
    }

    fn add_as(&mut self, mut row: Value, id: Option<String>) -> usize {
        let at = self.items.len();
        let n = at as u64 + 1;
        if let Some(id) = &id {
            self.named.insert(id.clone(), at);
        }
        row["id"] = id.unwrap_or_else(|| format!("i{n}")).into();
        let turn = self.turn_id().unwrap_or_default();
        self.first_rows.entry(turn.clone()).or_insert(at);
        row["turnId"] = turn.into();
        row["n"] = n.into();
        if let Some(cid) = row["cid"].as_str().filter(|_| row["kind"] == "message") {
            self.cids.insert(cid.into());
        }
        if let Some(o) = self.open.as_mut().filter(|o| o.input && o.first.is_none()) {
            o.first = Some(n);
        }
        self.items.push(row);
        self.changed_items.insert(at);
        at
    }

    /// A limit no switch took any more (a Stop, a new message): its row stays, as history.
    fn end_limit(&mut self) {
        if let Some(at) = self.limit_row.take() {
            self.items[at]["state"] = "over".into();
            self.changed_items.insert(at);
        }
    }

    fn end_wait(&mut self, ts: u64) {
        let Some(o) = self.open.as_mut() else {
            return;
        };
        if let Some(since) = o.wait.take() {
            o.waited += ts.saturating_sub(since);
            let turn = &mut self.turns[o.at];
            turn["waitingSince"] = Value::Null;
            turn["waitedMs"] = o.waited.into();
            self.changed_turns.insert(o.at);
        }
    }

    /// Only unfinished script or CLI startup needs the host's live state.
    pub fn setup_running(&self, setup: &Value) -> bool {
        self.startup.running(setup)
    }

    /// Setup sits under its launch's input, first in its turn [D70].
    pub fn sync_setup(&mut self, setup: Value, alive: bool) {
        let (mut setup, cid) = self.startup.sync(setup, alive);
        let at = (cid.and_then(|cid| self.first_rows.get(cid).copied()))
            .or(self.setup_at)
            .filter(|&at| at < self.items.len() && setup.is_object());
        if setup.is_object() {
            setup["after"] = at.map_or(Value::Null, |at| self.items[at]["id"].clone());
        }
        self.setup_changed |= setup != self.setup;
        self.setup = setup;
        if let Some(at) = at {
            self.setup_work(at);
        }
    }

    /// The turn a worktree was made for has a work block even with nothing else in it, so the
    /// worktree's row folds into it [D85]: added once that turn is done.
    fn setup_work(&mut self, at: usize) {
        let row = &self.items[at];
        let (n, turn) = (row["n"].as_u64().unwrap_or(0), row["turnId"].clone());
        let Some(t) = self
            .turns
            .iter()
            .find(|t| t["id"] == turn && t["status"] == "done")
        else {
            return;
        };
        if self.work.iter().any(|w| w["turnId"] == turn) {
            return;
        }
        let at = |k: &str| t[k].as_u64().unwrap_or(0);
        let ms = at("endedAt")
            .saturating_sub(at("startedAt"))
            .saturating_sub(at("waitedMs"));
        // Nothing of the turn's own folds: the empty span after its input.
        self.work.push(
            json!({"turnId": turn, "ms": ms, "folded": [n + 1, n], "kept": [],
            "denied": t["denied"]}),
        );
    }

    /// What changed since the last call: rows and turns to replace by id, and new work.
    pub fn take(&mut self) -> Option<Value> {
        let items: Vec<Value> = std::mem::take(&mut self.changed_items)
            .into_iter()
            .map(|at| self.items[at].clone())
            .collect();
        let turns: Vec<Value> = std::mem::take(&mut self.changed_turns)
            .into_iter()
            .map(|at| self.turns[at].clone())
            .collect();
        let work = self.work[self.sent_work..].to_vec();
        self.sent_work = self.work.len();
        let quiet = items.is_empty() && turns.is_empty() && work.is_empty();
        let mut out = json!({"items": items, "turns": turns, "work": work});
        let setup_changed = std::mem::take(&mut self.setup_changed);
        if setup_changed {
            out["setup"] = self.setup.clone();
        }
        let points_changed = self.send_points(&mut out);
        // What waits on the user goes whole whenever it changed, to replace what the view holds.
        if std::mem::take(&mut self.pending_changed) {
            for (k, v) in self.requests().as_object().unwrap() {
                out[k] = v.clone();
            }
        } else if quiet && !setup_changed && !points_changed {
            return None;
        }
        Some(out)
    }

    /// Forgets what changed: a thread kept to copy from sends nothing itself.
    pub fn settle(&mut self) {
        self.changed_items.clear();
        self.changed_turns.clear();
        self.sent_work = self.work.len();
        self.pending_changed = false;
    }
}

/// A map with pair keys, as JSON can hold it: a list of `[key, value]`.
mod pairs {
    use serde::{Deserialize, Deserializer, Serializer};
    use std::collections::HashMap;

    type Keys = HashMap<(String, String), usize>;

    pub fn serialize<S: Serializer>(keys: &Keys, s: S) -> Result<S::Ok, S::Error> {
        s.collect_seq(keys.iter())
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Keys, D::Error> {
        Ok(Vec::<((String, String), usize)>::deserialize(d)?
            .into_iter()
            .collect())
    }
}
