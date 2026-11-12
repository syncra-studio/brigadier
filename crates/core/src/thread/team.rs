//! A parent's workers in its thread, as the old app's TeamSentence and lead rows [D3010]: their
//! start, how each ended as its result came, the lead's or the user's End, and "still running"
//! after the user's Stop [D3009, D3011]. Sentences, never cards; each stays out of the work fold.

use super::Thread;
use serde_json::{Value, json};

impl Thread {
    fn team_row(&mut self, row: Value) {
        self.break_group();
        let at = self.add(row);
        if let Some(o) = self.open.as_mut() {
            o.kept.push(at as u64 + 1);
        }
    }

    /// A `worker` note: `started` joins the start row just before it, so one turn's starts read
    /// as one sentence; `ended` and `still` name every worker they're about.
    pub(super) fn team(&mut self, item: &Value) {
        let ids = match item["phase"].as_str() {
            Some("started") => json!([item["id"]]),
            _ => item["ids"].clone(),
        };
        match item["phase"].as_str() {
            Some("started") => {
                let at = self.items.len().checked_sub(1);
                let joins = at.and_then(|at| self.items.get(at)).is_some_and(|r| r["kind"] == "team" && r["word"] == "started");
                if let Some(at) = at.filter(|_| joins) {
                    if let Some(w) = self.items[at]["workers"].as_array_mut() {
                        w.push(item["id"].clone());
                    }
                    self.changed_items.insert(at);
                    return;
                }
                self.team_row(json!({"kind": "team", "word": "started", "workers": ids}));
            }
            Some("ended") => self.team_row(
                json!({"kind": "team_step", "type": "stopped", "byUser": item["by"] == "user", "workers": ids}),
            ),
            Some("still") => self.team_row(json!({"kind": "team_still", "workers": ids})),
            _ => {}
        }
    }

    /// A result's input (`result:<how>:<worker>`): the sentence of how it ended, in its place.
    pub(super) fn team_result(&mut self, rest: &str) {
        let (how, wid) = rest.split_once(':').unwrap_or(("finished", rest));
        let word = match how {
            "finished" => "finished",
            "stopped" => "stopped",
            _ => "failed",
        };
        self.team_row(json!({"kind": "team", "word": word, "workers": [wid]}));
    }
}
