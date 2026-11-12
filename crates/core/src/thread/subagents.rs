//! A subagent's own steps, kept on its row for the side panel: the thread shows only that it
//! started and how it ended [D78, D115]. A step carries no output, so a row
//! sent again on each step stays small.

use super::{Open, Thread};
use serde_json::{Value, json};

impl Thread {
    /// A turn's end: its work folds now, or, while subagents it started run on, when the last of
    /// them ends; till then its header counts on, saying how many run [D67, D114].
    pub(super) fn end_work(&mut self, o: Open, work: Value, ts: u64) {
        let helpers = self.helpers(&o.id);
        if helpers > 0 {
            self.turns[o.at]["helpers"] = helpers.into();
            self.held.insert(o.id.clone(), (o, work));
        } else if !work.is_null() {
            self.push_work(work, ts.saturating_sub(o.started).saturating_sub(o.waited));
        }
    }

    fn helpers(&self, turn: &str) -> usize {
        (self.children.values())
            .filter(|&&c| self.items[c]["turnId"] == turn)
            .count()
    }

    /// A subagent at row `row` ended: the turn that waits on it counts one fewer, and with none
    /// left it ends now, its work folding with the subagent's time in it. The wake turn its agent
    /// starts next may still join it.
    pub(super) fn helper_ended(&mut self, row: usize, ts: u64) {
        let turn = self.items[row]["turnId"].as_str().unwrap_or("").to_string();
        let Some(at) = self.held.get(&turn).map(|(o, _)| o.at) else {
            return;
        };
        let left = self.helpers(&turn);
        self.turns[at]["helpers"] = left.into();
        self.changed_turns.insert(at);
        if left > 0 {
            return;
        }
        let Some((o, work)) = self.held.remove(&turn) else {
            return;
        };
        self.turns[at]["endedAt"] = ts.into();
        if !work.is_null() {
            self.push_work(work, ts.saturating_sub(o.started).saturating_sub(o.waited));
        }
        // Not once another turn runs: a wake then would land after that one.
        self.woke = self.open.is_none().then_some(o);
    }

    /// The turn the agent woke for, on its own or at Brigadier's word, carries on the one its
    /// subagents held: one block, counting from that turn's start, folding above the new answer;
    /// the earlier answer becomes part of its work [D106].
    pub(super) fn rejoin(&mut self, o: Open) {
        let turn = &mut self.turns[o.at];
        turn["status"] = "running".into();
        turn["endedAt"] = Value::Null;
        self.changed_turns.insert(o.at);
        if let Some(answer) = o.answer {
            self.items[answer as usize - 1]["final"] = false.into();
            self.changed_items.insert(answer as usize - 1);
        }
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
