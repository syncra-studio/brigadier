//! A subagent's own steps, kept on its row for the side panel: the thread shows only that it
//! started and how it ended [D78, D115]. A step carries no output, so a row
//! sent again on each step stays small.

use super::{Open, Thread};
use serde_json::{Value, json};

impl Thread {
    /// A turn's end: its work folds now, or, while subagents it started run on, it stays one open
    /// block, its answer an update in it, counting on and saying how many run [D67, D114, D118].
    pub(super) fn end_work(&mut self, o: Open, work: Value, ts: u64) {
        // Only a turn that ended well waits on its workers; a stopped or failed one says which still run [D3011].
        if self.turns[o.at]["status"] != "done" {
            self.workers.retain(|_, t| *t != o.id);
        }
        let helpers = self.helpers(&o.id);
        if helpers > 0 || self.working(&o.id) {
            self.turns[o.at]["helpers"] = helpers.into();
            self.turns[o.at]["held"] = true.into();
            self.final_answer(&o, false);
            self.held.insert(o.id.clone(), (o, work));
        } else if !work.is_null() {
            self.push_work(work, ts.saturating_sub(o.started).saturating_sub(o.waited));
        }
    }

    pub(super) fn helpers(&self, turn: &str) -> usize {
        (self.children.values())
            .filter(|&&c| self.items[c]["turnId"] == turn)
            .count()
    }

    /// A worker the turn started still runs: it holds the turn as a subagent does, its result the
    /// wake that carries the block on [D106, D151].
    fn working(&self, turn: &str) -> bool {
        self.workers.values().any(|t| t == turn)
    }

    /// Workers ended, by their result or an End: the turn they held counts them out.
    pub(super) fn workers_ended(&mut self, ids: &[Value], ts: u64) {
        for id in ids {
            if let Some(turn) = id.as_str().and_then(|id| self.workers.remove(id)) {
                self.held_left(&turn, ts);
            }
        }
    }

    /// A subagent at row `row` ended: the turn that waits on it counts one fewer. With none left it
    /// stays open for the turn its agent wakes for next, which carries it on; one that can't come
    /// now, as another turn runs, folds it at once.
    pub(super) fn helper_ended(&mut self, row: usize, ts: u64) {
        let turn = self.items[row]["turnId"].as_str().unwrap_or("").to_string();
        self.held_left(&turn, ts);
    }

    fn held_left(&mut self, turn: &str, ts: u64) {
        let Some(at) = self.held.get(turn).map(|(o, _)| o.at) else {
            return;
        };
        let left = self.helpers(turn);
        self.turns[at]["helpers"] = left.into();
        self.turns[at]["endedAt"] = ts.into();
        self.changed_turns.insert(at);
        if left == 0 && !self.working(turn) && self.open.is_some() {
            self.settle_held(false);
        }
    }

    /// Every held turn whose subagents all ended, and whose wake didn't come, folds now: its time
    /// up to its last subagent's end, its last answer final. A Brigadier cut waits for its carry-on
    /// past its process's end, until `cuts` says another turn came instead [D108, D124].
    pub(super) fn settle_held(&mut self, cuts: bool) {
        let done: Vec<String> = (self.held.iter())
            .filter(|(id, (o, _))| {
                (cuts || !o.cut()) && self.turns[o.at]["helpers"] == 0 && !self.working(id)
            })
            .map(|(id, _)| id.clone())
            .collect();
        for id in done {
            let (o, work) = self.held.remove(&id).unwrap();
            let ended = self.turns[o.at]["endedAt"].as_u64().unwrap_or(o.started);
            self.turns[o.at]["held"] = Value::Null;
            // A cut whose carry-on never came ended where it was stopped.
            if o.cut() {
                self.turns[o.at]["status"] = "cancelled".into();
            }
            self.changed_turns.insert(o.at);
            self.final_answer(&o, true);
            if !work.is_null() {
                self.push_work(
                    work,
                    ended.saturating_sub(o.started).saturating_sub(o.waited),
                );
            }
        }
    }

    /// A Brigadier cut, held open for its carry-on: one block, its answer an update in it [D108,
    /// D124].
    pub(super) fn hold_cut(&mut self, o: Open) {
        self.final_answer(&o, false);
        self.turns[o.at]["held"] = true.into();
        self.turns[o.at]["helpers"] = 0.into();
        self.held.insert(o.id.clone(), (o, Value::Null));
    }

    fn final_answer(&mut self, o: &Open, last: bool) {
        if let Some(answer) = o.answer {
            self.items[answer as usize - 1]["final"] = last.into();
            self.changed_items.insert(answer as usize - 1);
        }
    }

    /// The turn the agent woke for, on its own or at Brigadier's word, carries on the one its
    /// subagents held: one block, counting from that turn's start, folding above the new answer;
    /// the earlier answer becomes part of its work [D106].
    pub(super) fn rejoin(&mut self, mut o: Open) {
        // A Stop of the turn that carries it on draws its own line.
        o.stop = (None, false);
        let turn = &mut self.turns[o.at];
        turn["status"] = "running".into();
        turn["endedAt"] = Value::Null;
        turn["held"] = Value::Null;
        self.changed_turns.insert(o.at);
        self.final_answer(&o, false);
        // The view keeps the work it has until this turn's new work replaces it by turn id.
        if let Some(i) = self.work.iter().position(|w| w["turnId"] == o.id.as_str()) {
            self.work.remove(i);
            if i < self.sent_work {
                self.sent_work -= 1;
            }
        }
        self.open = Some(o);
    }

    fn push_work(&mut self, mut work: Value, ms: u64) {
        work["ms"] = ms.into();
        self.work.push(work);
    }

    /// A step the subagent at row `at` began; a repeated start only fills in its input.
    pub(super) fn sub_started(&mut self, at: usize, item: &Value, ts: u64) {
        let row = &mut self.items[at];
        let id = format!(
            "{}:{}",
            row["id"].as_str().unwrap_or(""),
            item["id"].as_str().unwrap_or("")
        );
        let turn = row["turnId"].clone();
        let log = log(row);
        match log.iter_mut().find(|s| s["id"] == id.as_str()) {
            Some(s) => s["input"] = item["input"].clone(),
            None => log.push(json!({"id": id, "turnId": turn, "kind": "tool", "name": item["name"],
                "input": item["input"], "output": "", "progress": "running", "exitCode": null,
                "step": item["step"], "startedAt": item["at"].as_u64().unwrap_or(ts), "endedAt": null})),
        }
        self.changed_items.insert(at);
        self.heard(at, ts);
    }

    /// A step of the subagent at row `at` ended.
    pub(super) fn sub_done(&mut self, at: usize, item: &Value, ts: u64) {
        let row = &mut self.items[at];
        let id = format!(
            "{}:{}",
            row["id"].as_str().unwrap_or(""),
            item["id"].as_str().unwrap_or("")
        );
        if let Some(s) = log(row).iter_mut().find(|s| s["id"] == id.as_str()) {
            s["progress"] = if item["ok"] == true { "done" } else { "failed" }.into();
            s["exitCode"] = item["exit"].clone();
            s["endedAt"] = item["at"].as_u64().unwrap_or(ts).into();
            self.changed_items.insert(at);
        }
        self.heard(at, ts);
    }

    /// A held turn's subagent did something: its quiet clock starts again [D114].
    fn heard(&mut self, row: usize, ts: u64) {
        let turn = self.items[row]["turnId"].as_str().unwrap_or("");
        if let Some(at) = self.held.get(turn).map(|(o, _)| o.at) {
            self.turns[at]["heardAt"] = ts.into();
            self.changed_turns.insert(at);
        }
    }
}

/// The subagent row's steps, made on its first.
fn log(row: &mut Value) -> &mut Vec<Value> {
    if !row["log"].is_array() {
        row["log"] = json!([]);
    }
    row["log"].as_array_mut().unwrap()
}

/// Its steps still running when the subagent itself ends end with it, so none spins on.
pub(super) fn settle(row: &mut Value, progress: &str) {
    for s in log(row).iter_mut().filter(|s| s["progress"] == "running") {
        s["progress"] = progress.into();
    }
}
