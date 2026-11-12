//! How a turn ends, and the files its edit steps changed, what opens the panel the first time
//! [D1023]: an edit counts once it ended well, or when the backend's own record lists it.

use super::Fold;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Default, Serialize, Deserialize, Clone)]
pub struct Turn {
    /// Stable for the turn's life: its first input's cid, or `a<n>` for one the agent started.
    #[serde(default)]
    pub id: String,
    pub cid: Option<String>,
    pub origin: String,
    pub backend: String,
    pub text: String,
    /// The composer's draft it was sent as, chips and files; Null for plain text [D109, D127].
    #[serde(default)]
    pub parts: Value,
    pub retry_of: Option<String>,
    /// The model recorded in this turn’s own setup, including the first input.
    #[serde(default)]
    pub model: Option<String>,
    /// The account or agent switch this input continues, as logged with it [D51].
    #[serde(default)]
    pub switch: Value,
    pub ts: u64,
    pub delivered: Option<u64>,
    pub began: bool,
    pub tools: BTreeSet<String>,
    /// When the earliest of its open tools started (ms).
    #[serde(default)]
    pub tools_since: u64,
    pub question: Option<String>,
    /// Requests waiting on the user (approvals and questions), by the id their CLI gave them.
    #[serde(default)]
    pub asks: BTreeMap<String, Value>,
    /// The user asked it to stop: however its turn ends, it was stopped.
    #[serde(default)]
    pub stopping: bool,
    /// Logged, then its owner died before delivering it.
    pub orphaned: bool,
    /// Its input starts a child that no `spawned` record has named yet.
    #[serde(default)]
    pub spawning: bool,
    /// Its input came while another turn ran: no clean boundary of its own.
    #[serde(default)]
    pub mid: bool,
    /// Its place in the CLI's own record, for a rewind: first entry, latest entry.
    #[serde(default)]
    pub start: Option<String>,
    #[serde(default)]
    pub end: Option<String>,
    /// The CLI's own retry, as logged with its time: shown while nothing came after it [D487].
    #[serde(default)]
    pub retry: Value,
    /// The CLI holds its reply for extra safety checks, until it says it let it go [D487].
    #[serde(default)]
    pub checking: bool,
    /// The files its edit steps changed: an edit counts once it ended well, or when the backend's
    /// own record lists it [D1023]. `editing` holds each edit step still open, by its id.
    #[serde(default)]
    pub edited: BTreeSet<String>,
    #[serde(default)]
    pub editing: BTreeMap<String, Vec<String>>,
}

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
            self.runs.agent.extend(turn.edited.iter().cloned());
            self.bound(&turn);
            self.last = Some(
                json!({"id": turn.id, "cid": turn.cid, "origin": turn.origin, "backend": turn.backend, "retry_of": turn.retry_of, "text": turn.text, "parts": turn.parts, "outcome": outcome, "reason": reason, "ts": ts,
                       "delivered": turn.delivered.is_some(), "began": turn.began, "switch": turn.switch,
                       // The log's proof by command id that no child read it: no `spawned` record, and its spawn failed or its owner died [D300].
                       "never_ran": turn.delivered.is_none() && turn.spawning && turn.orphaned}),
            );
        }
    }

    pub(super) fn close_all(&mut self, outcome: &str, reason: Value, ts: u64) {
        while !self.turns.is_empty() {
            self.close(outcome, reason.clone(), ts);
        }
    }
}
