//! A subagent's own steps, kept on its row for the side panel: the thread shows only that it
//! started and how it ended [D78, D115]. A step carries no output, so a row
//! sent again on each step stays small.

use super::Thread;
use serde_json::{Value, json};

impl Thread {
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
