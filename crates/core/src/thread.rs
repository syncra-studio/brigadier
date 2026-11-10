//! The thread fold [D64, D65]: normalised items in, the thread view's `item.ts` out. Rust sends
//! structure (rows, groups, each turn's work, step kinds); the UI writes the words. Which turn runs
//! comes from the status fold, so it has one answer. Grouping follows the old app [D48]: steps in a
//! row are one group; reasoning and plumbing don't break it; any other row does. The same items
//! give the same thread, so ids and `n` stay stable across reads.

use crate::adapters;
use crate::fold::{Fold, Turn};
use serde_json::{Value, json};
use std::collections::{BTreeSet, HashMap, HashSet};

mod asks;
mod find;
mod rows;
mod turn;

/// The turn on screen: the status fold's first turn, from when it became first.
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
}

#[derive(Default)]
pub struct Thread {
    fold: Fold,
    pub items: Vec<Value>,
    pub turns: Vec<Value>,
    pub work: Vec<Value>,
    open: Option<Open>,
    /// Status-fold turns already shown, by id.
    shown: HashSet<String>,
    /// (turn, tool or question id) → its row's index.
    keys: HashMap<(String, String), usize>,
    /// A step's row index → its group row's index.
    member: HashMap<usize, usize>,
    /// Subagents not yet ended, by tool id: one in the background may end turns later [D78].
    children: HashMap<String, usize>,
    changed_items: BTreeSet<usize>,
    changed_turns: BTreeSet<usize>,
    sent_work: usize,
    /// The switch row of a limit no switch has taken yet, by index.
    limit_row: Option<usize>,
    /// When the last limit on this side resets (ms), as its CLI said: the next turn after it says so [D487].
    reset_at: Option<u64>,
    /// The agent and model the last turn ran: the next turn on another model of the same agent says so [D487].
    ran: Option<(String, String)>,
    /// What the composer's rail says about the last turn's failure, and whether that changed [D487].
    notices: Vec<Value>,
    notices_changed: bool,
    /// The turn whose terminal failure was already shown (some CLIs repeat it in their result).
    failed: Option<String>,
    /// Rows of the requests still waiting on the user, oldest first, and whether that changed.
    pending: Vec<usize>,
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
    setup: Value,
    setup_changed: bool,
    points: Vec<String>,
}

/// A switch row's reason, from the status fold's: a usage limit, a resume the agent refused, or
/// another agent the user picked [D129].
fn reason(why: Option<&str>) -> &'static str {
    match why {
        Some("unresumable") => "unresumable",
        Some("picked") => "picked",
        _ => "usage-limit",
    }
}

/// About how many rows the snapshot and each older page carry [D98].
const PAGE: usize = 2000;

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
                self.items
                    .iter()
                    .position(|row| row["turnId"] == item["cid"])
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
        self.fold.push(item);
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
            if item["origin"] == "user"
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
                    let at = self.add(
                        json!({"kind": "message", "role": "user", "text": item["text"],
                        "streaming": false, "origin": "user", "sentAt": ts, "cid": item["cid"],
                        "steer": true}),
                    );
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
        let denied = self.items[o.from..]
            .iter()
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
        row["id"] = id.unwrap_or_else(|| format!("i{n}")).into();
        row["turnId"] = self.turn_id().unwrap_or_default().into();
        row["n"] = n.into();
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

    /// Setup sits before its launch's input.
    pub fn sync_setup(&mut self, setup: Value, alive: bool) {
        let (mut setup, cid) = self.startup.sync(setup, alive);
        if setup.is_object() {
            setup["before"] = cid
                .and_then(|cid| self.items.iter().find(|row| row["turnId"] == cid))
                .or_else(|| self.setup_at.and_then(|at| self.items.get(at)))
                .map_or(Value::Null, |row| row["id"].clone());
        }
        self.setup_changed |= setup != self.setup;
        self.setup = setup;
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
        let notices_changed = std::mem::take(&mut self.notices_changed);
        if notices_changed {
            out["notices"] = self.notices.clone().into();
        }
        // What waits on the user goes whole whenever it changed, to replace what the view holds.
        if std::mem::take(&mut self.pending_changed) {
            for (k, v) in self.requests().as_object().unwrap() {
                out[k] = v.clone();
            }
        } else if quiet && !setup_changed && !points_changed && !notices_changed {
            return None;
        }
        Some(out)
    }

    /// The view's Session with only its newest page of rows [D97, D98]; what changed so far counts
    /// as sent.
    pub fn session(&mut self, id: &str, title: &str) -> Value {
        self.take();
        let mut page = self.page(self.items.len(), self.items.len());
        page["id"] = id.into();
        page["title"] = title.into();
        page["setup"] = self.setup.clone();
        page["rewind"] = self.fold.points().into();
        page["notices"] = self.notices.clone().into();
        for (k, v) in self.requests().as_object().unwrap() {
            page[k] = v.clone();
        }
        page
    }

    /// The page of rows just older than row `before` (an `n`), for a view scrolling up [D97], and
    /// on down to row `through` when given: find going to a match there, in one page.
    pub fn older(&self, before: u64, through: Option<u64>) -> Value {
        let end = (before.saturating_sub(1) as usize).min(self.items.len());
        let floor = through.map_or(end, |n| n.saturating_sub(1) as usize);
        self.page(end, floor)
    }

    /// Whole turns ending at row index `end`, newest first, down to row index `floor` and then up
    /// to about `PAGE` rows and at least one turn, with their turns and work, and `before`: the `n`
    /// of its first row, or null when nothing is older.
    fn page(&self, end: usize, floor: usize) -> Value {
        let turn = |at: usize| &self.items[at]["turnId"];
        let mut start = end;
        while start > 0 {
            let mut from = start - 1;
            while from > 0 && turn(from - 1) == turn(start - 1) {
                from -= 1;
            }
            if start < end && start <= floor && end - from > PAGE {
                break;
            }
            start = from;
        }
        // Its turns run from its first row's to the next page's, so a turn with no rows yet comes too.
        let place = |at: usize| {
            self.turns
                .iter()
                .position(|t| t["id"] == *turn(at))
                .unwrap_or(self.turns.len())
        };
        let first = if start < end { place(start) } else { 0 };
        let last = if end < self.items.len() {
            place(end)
        } else {
            self.turns.len()
        };
        let turns = &self.turns[first.min(last)..last];
        let ids: HashSet<&Value> = turns.iter().map(|t| &t["id"]).collect();
        let work: Vec<&Value> = self
            .work
            .iter()
            .filter(|w| ids.contains(&w["turnId"]))
            .collect();
        let before = (start > 0).then(|| self.items[start]["n"].clone());
        json!({"turns": turns, "items": &self.items[start..end], "work": work, "before": before})
    }
}
