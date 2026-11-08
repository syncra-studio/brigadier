//! The thread fold [D64, D65]: normalised items in, the thread view's `item.ts` out. Rust sends
//! structure (rows, groups, each turn's work, step kinds); the UI writes the words. Which turn runs
//! comes from the status fold, so it has one answer. Grouping follows the old app [D48]: steps in a
//! row are one group; reasoning and plumbing don't break it; any other row does. The same items
//! give the same thread, so ids and `n` stay stable across reads.

use crate::fold::{Fold, Turn};
use serde_json::{Value, json};
use std::collections::{BTreeSet, HashMap, HashSet};

/// The turn on screen: the status fold's first turn, from when it became first.
struct Open {
    id: String,
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
        // own end time staying unreported.
        for at in o.from..self.items.len() {
            if self.items[at]["progress"] == "running" && self.items[at]["kind"] != "compaction" {
                self.items[at]["progress"] = status.into();
                self.changed_items.insert(at);
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

    fn content(&mut self, item: &Value, kind: &str, ts: u64) {
        let Some(turn) = self.turn_id() else {
            return;
        };
        let str_of = |k: &str| item[k].as_str().unwrap_or("").to_string();
        let key = |id: String| (turn.clone(), id);
        // The agent's next output ends a wait on the user [D77].
        if matches!(
            kind,
            "text" | "reasoning" | "tool" | "tool_done" | "compaction" | "unknown"
        ) {
            self.end_wait(ts);
        }
        match kind {
            "text" => {
                self.break_group();
                let at = self.add(
                    json!({"kind": "message", "role": "assistant", "text": item["text"],
                    "streaming": false, "sentAt": ts}),
                );
                if let Some(o) = self.open.as_mut() {
                    o.answer = Some(at as u64 + 1);
                }
            }
            "reasoning" => {
                let text = str_of("text");
                self.add(json!({"kind": "reasoning", "heading": heading(&text), "text": text, "streaming": false}));
            }
            "tool" => {
                let step = str_of("step");
                if let Some(parent) = item["parent"].as_str() {
                    // A subagent's own step: its row shows it as the current one [D78].
                    if let Some(&at) = self.keys.get(&key(parent.into()))
                        && !step.is_empty()
                    {
                        let row = &mut self.items[at];
                        row["steps"] = (row["steps"].as_u64().unwrap_or(0) + 1).into();
                        row["current"] = json!({"step": step, "input": item["input"]});
                        self.changed_items.insert(at);
                    }
                    return;
                }
                if step.is_empty() {
                    return;
                }
                // A start may repeat with more detail (a query known only once it ran).
                if let Some(&at) = self.keys.get(&key(str_of("id"))) {
                    if self.items[at]["kind"] == "tool" && !str_of("input").is_empty() {
                        self.items[at]["input"] = item["input"].clone();
                        self.changed_items.insert(at);
                    }
                    return;
                }
                let at = item["at"].as_u64().unwrap_or(ts);
                let row = match step.as_str() {
                    "agent" => {
                        json!({"kind": "childAgent", "sessionId": item["id"], "title": item["input"],
                        "progress": "running", "startedAt": at, "endedAt": null, "current": null,
                        "steps": null, "answer": null})
                    }
                    "edit" => {
                        json!({"kind": "fileChange", "changes": item["changes"], "progress": "running"})
                    }
                    _ => {
                        json!({"kind": "tool", "name": item["name"], "input": item["input"], "output": "",
                        "progress": "running", "exitCode": null, "step": step, "startedAt": at, "endedAt": null})
                    }
                };
                let at = self.step(row);
                self.keys.insert(key(str_of("id")), at);
            }
            "tool_done" => {
                if let Some(parent) = item["parent"].as_str() {
                    if let Some(&at) = self.keys.get(&key(parent.into())) {
                        self.items[at]["current"] = Value::Null;
                        self.changed_items.insert(at);
                    }
                    return;
                }
                let Some(&at) = self.keys.get(&key(str_of("id"))) else {
                    return;
                };
                let progress = if item["ok"] == true { "done" } else { "failed" };
                let ended = item["at"].as_u64().unwrap_or(ts);
                let row = &mut self.items[at];
                match row["kind"].as_str().unwrap_or("") {
                    "tool" => {
                        row["output"] = item["output"].clone();
                        row["exitCode"] = item["exit"].clone();
                        row["endedAt"] = ended.into();
                    }
                    "fileChange" if item["changes"].as_array().is_some_and(|c| !c.is_empty()) => {
                        row["changes"] = item["changes"].clone();
                    }
                    "childAgent" => {
                        row["endedAt"] = ended.into();
                        row["current"] = Value::Null;
                        let answer = str_of("output");
                        row["answer"] = if answer.is_empty() {
                            Value::Null
                        } else {
                            answer.into()
                        };
                        if let Some(child) = item["child"].as_str() {
                            row["sessionId"] = child.into();
                        }
                    }
                    _ => {}
                }
                row["progress"] = progress.into();
                self.changed_items.insert(at);
                if let Some(&g) = self.member.get(&at) {
                    self.recount(g);
                }
            }
            "question" => {
                self.break_group();
                let at = self.add(json!({"kind": "question", "question": item["text"],
                    "options": item["options"].as_array().cloned().unwrap_or_default(), "answer": null}));
                self.keys.insert(key(str_of("id")), at);
                if let Some(o) = self.open.as_mut() {
                    o.asked = Some(at);
                    if o.wait.is_none() {
                        o.wait = Some(ts);
                        self.turns[o.at]["waitingSince"] = ts.into();
                        self.changed_turns.insert(o.at);
                    }
                }
            }
            "answer" => {
                if let Some(&at) = self.keys.get(&key(str_of("id"))) {
                    self.items[at]["answer"] = item["text"].clone();
                    self.changed_items.insert(at);
                    if let Some(o) = self.open.as_mut().filter(|o| o.asked == Some(at)) {
                        o.asked = None;
                    }
                }
                self.end_wait(ts);
            }
            "limited" | "sign_in" => {
                self.break_group();
                let level = if kind == "limited" {
                    "warning"
                } else {
                    "error"
                };
                self.add(json!({"kind": "notice", "level": level, "text": item["message"]}));
            }
            "compaction" => {
                self.break_group();
                let progress = item["progress"].as_str().unwrap_or("done");
                let running = self.keys.get(&key("compaction".into())).copied();
                match running.filter(|&at| self.items[at]["progress"] == "running") {
                    Some(at) => {
                        self.items[at]["progress"] = progress.into();
                        self.changed_items.insert(at);
                    }
                    None => {
                        let at = self.add(
                            json!({"kind": "compaction", "summary": null, "progress": progress}),
                        );
                        self.keys.insert(key("compaction".into()), at);
                    }
                }
            }
            "unknown" | "unknown_frame" => {
                self.break_group();
                let raw = match item["raw"].as_str() {
                    Some(text) => serde_json::from_str(text).unwrap_or_else(|_| text.into()),
                    None => {
                        let mut raw = item.clone();
                        for k in ["n", "f", "ts"] {
                            raw.as_object_mut().map(|o| o.remove(k));
                        }
                        raw
                    }
                };
                self.add(json!({"kind": "unknown", "raw": raw}));
            }
            _ => {}
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

    /// Adds a step's row under the open group, starting one when none is open.
    fn step(&mut self, row: Value) -> usize {
        let Some(o) = self.open.as_mut() else {
            return self.add(row);
        };
        let g = match o.group {
            Some(g) => g,
            None => {
                let id = format!("{}:g{}", o.id, o.groups);
                o.groups += 1;
                let g = self.add_as(
                    json!({"kind": "group", "steps": [], "span": [0, 0]}),
                    Some(id),
                );
                if let Some(o) = self.open.as_mut() {
                    o.group = Some(g);
                }
                g
            }
        };
        let at = self.add(row);
        self.member.insert(at, g);
        self.items[g]["span"] = json!([g as u64 + 2, at as u64 + 1]);
        self.recount(g);
        at
    }

    /// A group's counts per kind, in the order the kinds came. Edits count distinct files [D48].
    fn recount(&mut self, g: usize) {
        let last = self.items[g]["span"][1].as_u64().unwrap_or(0) as usize;
        let mut steps: Vec<(String, u64)> = vec![];
        let (mut files, mut unnamed) = (BTreeSet::new(), 0u64);
        for at in g + 1..last.min(self.items.len()) {
            if self.member.get(&at) != Some(&g) {
                continue;
            }
            let row = &self.items[at];
            let kind = match row["kind"].as_str().unwrap_or("") {
                "fileChange" => "edit",
                "childAgent" => "agent",
                _ => row["step"].as_str().unwrap_or("other"),
            };
            match steps.iter_mut().find(|(k, _)| k == kind) {
                Some((_, n)) => *n += 1,
                None => steps.push((kind.into(), 1)),
            }
            if kind == "edit" {
                let changes = row["changes"].as_array().cloned().unwrap_or_default();
                files.extend(
                    changes
                        .iter()
                        .filter_map(|c| c["path"].as_str().map(String::from)),
                );
                unnamed += changes.is_empty() as u64;
            }
        }
        let steps: Vec<Value> = steps
            .into_iter()
            .map(|(kind, n)| {
                let n = if kind == "edit" {
                    files.len() as u64 + unnamed
                } else {
                    n
                };
                json!({"kind": kind, "n": n})
            })
            .collect();
        self.items[g]["steps"] = steps.into();
        self.changed_items.insert(g);
    }

    fn break_group(&mut self) {
        if let Some(o) = self.open.as_mut() {
            o.group = None;
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

/// The newest line that is bold alone (`**Reading the fold**`), as reasoning summaries head their parts.
fn heading(text: &str) -> Option<String> {
    text.lines()
        .rev()
        .map(str::trim)
        .find(|l| l.len() > 4 && l.starts_with("**") && l.ends_with("**"))
        .map(|l| l[2..l.len() - 2].to_string())
}
