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
    /// `n` of its question rows: they stay out of its work fold, like the user's own messages [D99].
    kept: Vec<u64>,
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

/// About how many rows the snapshot and each older page carry [D98].
const PAGE: usize = 2000;

/// Items that may close turns: only then is the status fold's list kept from before the push.
const CLOSES: [&str; 8] = [
    "exited",
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
        } else if kind == "input" {
            // A joined input keeps the running turn and adds no queued turn; steer will land here.
            if item["origin"] == "user"
                && before.len() == self.fold.turns.len()
                && before
                    .first()
                    .zip(self.fold.turns.first())
                    .is_some_and(|(before, after)| before.id == after.id)
                && let Some(answer) = self.open.as_ref().and_then(|o| o.answer)
            {
                let at = answer as usize - 1;
                self.items[at]["joined"] = true.into();
                self.changed_items.insert(at);
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
            kept: vec![],
        });
        // A switch shows as its note [D51]; a continuation it wrote (not the user's words) shows
        // only that.
        if let Some(note) = t.switch["note"].as_str() {
            self.add(json!({"kind": "notice", "level": "info", "text": note}));
            if t.origin != "user" {
                return;
            }
        }
        // An input, or a prompt typed in the terminal (the user's, with no command id).
        if t.cid.is_some() || t.origin == "user" {
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
        let turn = &mut self.turns[o.at];
        turn["status"] = status.into();
        turn["endedAt"] = ts.into();
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
                    json!({"turnId": o.id, "ms": ms, "folded": [first, answer - 1], "kept": kept}),
                );
            }
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

    /// The view's Session with only its newest page of rows [D97, D98]; what changed so far counts
    /// as sent.
    pub fn session(&mut self, id: &str, title: &str) -> Value {
        self.take();
        let mut page = self.page(self.items.len());
        page["id"] = id.into();
        page["title"] = title.into();
        page
    }

    /// The page of rows just older than row `before` (an `n`), for a view scrolling up [D97].
    pub fn older(&self, before: u64) -> Value {
        self.page((before.saturating_sub(1) as usize).min(self.items.len()))
    }

    /// Whole turns ending at row index `end`, newest first, up to about `PAGE` rows and at least
    /// one turn, with their turns and work, and `before`: the `n` of its first row, or null when
    /// nothing is older.
    fn page(&self, end: usize) -> Value {
        let turn = |at: usize| &self.items[at]["turnId"];
        let mut start = end;
        while start > 0 {
            let mut from = start - 1;
            while from > 0 && turn(from - 1) == turn(start - 1) {
                from -= 1;
            }
            if start < end && end - from > PAGE {
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
