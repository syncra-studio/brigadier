//! The thread's requests [D159, D177]: their rows, the ones still waiting on the user (sent beside
//! the rows, so a reconnect gets them again [D30, D40, D71]), and the answers that close them.

use super::Thread;
use serde_json::{Value, json};

impl Thread {
    /// A request's row starts waiting: kept out of the work fold like the user's own messages
    /// [D99], and its turn's wait starts [D77].
    pub(super) fn wait_on(&mut self, at: usize, ts: u64) {
        self.pending.push(at);
        self.pending_changed = true;
        if let Some(o) = self.open.as_mut() {
            o.kept.push(at as u64 + 1);
            if o.wait.is_none() {
                o.wait = Some(ts);
                self.turns[o.at]["waitingSince"] = ts.into();
                self.changed_turns.insert(o.at);
            }
        }
    }

    /// The waiting request with this id (or row) stops waiting; its row.
    pub(super) fn unwait(&mut self, id: &str) -> Option<usize> {
        let k = (self.pending.iter()).position(|&at| self.items[at]["request"]["id"] == id)?;
        self.pending_changed = true;
        Some(self.pending.remove(k))
    }

    pub(super) fn unwait_row(&mut self, at: usize) {
        if let Some(id) = self.items[at]["request"]["id"].as_str().map(String::from) {
            self.unwait(&id);
        }
    }

    /// An answer logged: its request stops waiting at once; its row shows it once delivered.
    pub(super) fn control(&mut self, item: &Value, ts: u64) {
        let c = &item["control"];
        if item["ack"] == true {
            self.acking
                .insert(item["cid"].as_str().unwrap_or("").to_string());
        }
        if c["kind"] != "answer" {
            return;
        }
        if let Some(at) = self.unwait(c["request"].as_str().unwrap_or("")) {
            self.withdraw_row(at);
            let cid = item["cid"].as_str().unwrap_or("").to_string();
            self.claims.insert(cid, (at, c.clone()));
            self.end_wait(ts);
        }
    }

    /// A delivered answer: an approval's decision, or a question's answers (skipped ones left out).
    pub(super) fn delivered(&mut self, cid: &str) {
        let Some((at, c)) = self.claims.remove(cid) else {
            return;
        };
        let row = &mut self.items[at];
        if row["kind"] == "approval" {
            row["decision"] = if c["decision"] == "deny" {
                "denied"
            } else {
                "approved"
            }
            .into();
        } else {
            let answers = c["answers"].as_array().cloned().unwrap_or_default();
            let given: Vec<&str> = answers.iter().filter_map(Value::as_str).collect();
            row["answer"] = given.join("\n").into();
            row["answers"] = answers.into();
            row["withdrawn"] = false.into();
            if let Some(o) = self.open.as_mut().filter(|o| o.asked == Some(at)) {
                o.asked = None;
            }
        }
        self.changed_items.insert(at);
    }

    /// The CLI cleared a request, or (in a terminal) the agent moved on past it [D77].
    pub(super) fn withdraw(&mut self, id: &str) {
        if let Some(at) = self.unwait(id) {
            self.withdraw_row(at);
        }
    }

    fn withdraw_row(&mut self, at: usize) {
        if self.items[at]["kind"] == "approval" {
            self.items[at]["decision"] = "withdrawn".into();
        } else {
            self.items[at]["withdrawn"] = true.into();
            if let Some(o) = self.open.as_mut().filter(|o| o.asked == Some(at)) {
                o.asked = None;
            }
        }
        self.changed_items.insert(at);
    }

    pub(super) fn withdraw_all(&mut self) {
        let ids: Vec<String> = (self.pending.iter())
            .filter_map(|&at| self.items[at]["request"]["id"].as_str().map(String::from))
            .collect();
        ids.iter().for_each(|id| self.withdraw(id));
    }

    /// What still waits on the user, oldest first, in D177's shapes.
    pub(super) fn requests(&self) -> Value {
        let of = |kind: &str| -> Vec<Value> {
            (self.pending.iter())
                .filter(|&&at| self.items[at]["kind"] == kind)
                .map(|&at| self.items[at]["request"].clone())
                .collect()
        };
        json!({"approvals": of("approval"), "questions": of("question")})
    }
}
