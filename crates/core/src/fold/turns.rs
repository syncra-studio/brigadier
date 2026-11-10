//! How a turn ends, and the files its edit steps changed, what opens the panel the first time
//! [D1023]: an edit counts once it ended well, or when the backend's own record lists it.

use super::{Fold, Turn};
use serde_json::{Value, json};

/// The paths a FileChange list names.
pub(super) fn paths_of(changes: &Value) -> Vec<String> {
    (changes.as_array().into_iter().flatten())
        .filter_map(|c| c["path"].as_str().map(String::from))
        .collect()
}

impl Turn {
    /// An edit step began: its paths, from its changes or else its input, wait for its end.
    pub(super) fn edit_started(&mut self, item: &Value) {
        if item["step"] != "edit" {
            return;
        }
        let mut paths = paths_of(&item["changes"]);
        match item["input"].as_str() {
            Some(input) if paths.is_empty() && !input.is_empty() => paths.push(input.into()),
            _ => {}
        }
        let id = item["id"].as_str().unwrap_or_default().to_string();
        self.editing.insert(id, paths);
    }

    /// An edit step ended: its paths count if it went well.
    pub(super) fn edit_done(&mut self, item: &Value) {
        let paths = self.editing.remove(item["id"].as_str().unwrap_or_default());
        if item["ok"] == true {
            let ended = paths
                .into_iter()
                .flatten()
                .chain(paths_of(&item["changes"]));
            self.edited.extend(ended);
        }
    }
}

impl Fold {
    pub(super) fn close(&mut self, outcome: &str, reason: Value, ts: u64) {
        if let Some(turn) = self.turns.first().cloned() {
            self.end_asks(if outcome == "interrupted" {
                "withdrawn"
            } else {
                outcome
            });
            self.turns.remove(0);
            self.finished = ts;
            if !turn.edited.is_empty() {
                self.edited = Some(json!({"at": ts, "files": turn.edited.len()}));
            }
            self.bound(&turn);
            self.last = Some(
                json!({"id": turn.id, "cid": turn.cid, "origin": turn.origin, "backend": turn.backend, "retry_of": turn.retry_of, "text": turn.text, "outcome": outcome, "reason": reason, "ts": ts,
                       "delivered": turn.delivered.is_some(), "began": turn.began, "switch": turn.switch}),
            );
        }
    }

    pub(super) fn close_all(&mut self, outcome: &str, reason: Value, ts: u64) {
        while !self.turns.is_empty() {
            self.close(outcome, reason.clone(), ts);
        }
    }
}
