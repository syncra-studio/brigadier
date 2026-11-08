//! The thread fold [D64, D65]: normalised items in, the thread view's `item.ts` out. Rust sends
//! structure (rows, groups, each turn's work, step kinds); the UI writes the words. Which turn runs
//! comes from the status fold, so it has one answer. Grouping follows the old app [D48]: steps in a
//! row are one group; reasoning and plumbing don't break it; any other row does. The same items
//! give the same thread, so ids and `n` stay stable across reads.

use crate::adapters;
use crate::fold::{Fold, Turn};
use serde_json::{Value, json};
use std::collections::{BTreeSet, HashMap, HashSet};

mod rows;

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
}

/// Items that may close turns: only then is the status fold's list kept from before the push.
const CLOSES: [&str; 7] = [
    "exited", "turn_end", "limited", "sign_in", "stopped", "note", "input",
];

impl Thread {
    pub fn push(&mut self, item: &Value) {
        let ts = item["ts"].as_u64().unwrap_or(0);
        let kind = item["kind"].as_str().unwrap_or("");
        let before: Vec<Turn> = if CLOSES.contains(&kind) {
            self.fold.turns.clone()
        } else {
            vec![]
        };
        // An input while the agent waits on a question is its answer (the status fold's rule).
        let answering = kind == "input"
            && self
                .fold
                .turns
                .first()
                .is_some_and(|t| t.question.is_some());
        self.fold.push(item);
        if answering {
            if let Some(at) = self.open.as_mut().and_then(|o| o.asked.take()) {
                self.items[at]["answer"] = item["text"].clone();
                self.changed_items.insert(at);
            }
            self.end_wait(ts);
        } else if kind != "input" {
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

    fn open_turn(&mut self, t: &Turn, ts: u64) {
        self.shown.insert(t.id.clone());
        let at = self.turns.len();
        self.turns.push(
            json!({"id": t.id, "status": "running", "startedAt": ts, "endedAt": null,
            "backend": t.backend, "waitingSince": null, "waitedMs": 0}),
        );
        self.changed_turns.insert(at);
        self.open = Some(Open {
            id: t.id.clone(),
            backend: t.backend.clone(),
            at,
            from: self.items.len(),
            started: ts,
            input: false,
            first: None,
            answer: None,
            group: None,
            groups: 0,
            asked: None,
            wait: None,
            waited: 0,
        });
        if t.cid.is_some() {
            let origin = if t.origin == "user" { "user" } else { "system" };
            self.add(
                json!({"kind": "message", "role": "user", "text": t.text, "streaming": false,
                "origin": origin, "sentAt": t.ts}),
            );
            if let Some(o) = self.open.as_mut() {
                o.input = true;
            }
        }
    }

    /// Ends the open turn. Every outcome the status fold knows maps to one of the view's [D64].
    fn close_turn(&mut self, outcome: &str, ts: u64) {
        self.end_wait(ts);
        let Some(o) = self.open.take() else {
            return;
        };
        let status = match outcome {
            "done" => "done",
            "stopped" => "cancelled",
            "failed" | "interrupted" | "limited" | "sign_in" => "failed",
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
        let turn = &mut self.turns[o.at];
        turn["status"] = status.into();
        turn["endedAt"] = ts.into();
        self.changed_turns.insert(o.at);
        // "Worked for" folds a done turn's work up to its answer, and leaves its waits out [D77].
        if let (true, true, Some(first), Some(answer)) =
            (status == "done", o.input, o.first, o.answer)
            && first < answer
        {
            let ms = ts.saturating_sub(o.started).saturating_sub(o.waited);
            self.work
                .push(json!({"turnId": o.id, "ms": ms, "folded": [first, answer - 1]}));
        }
    }

    /// Ends whatever still runs because its host or agent is gone, which no frame may ever say:
    /// the daemon calls this when the session's live state reads interrupted.
    pub fn interrupt(&mut self, ts: u64) {
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

    /// What changed since the last call: rows and turns to replace by id, and new work.
    pub fn take(&mut self) -> Option<(Vec<Value>, Vec<Value>, Vec<Value>)> {
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
        (!items.is_empty() || !turns.is_empty() || !work.is_empty()).then_some((items, turns, work))
    }

    /// The whole thread as the view's Session; what changed so far counts as sent.
    pub fn session(&mut self, id: &str, title: &str) -> Value {
        self.take();
        json!({"id": id, "title": title, "turns": self.turns, "items": self.items, "work": self.work})
    }
}
