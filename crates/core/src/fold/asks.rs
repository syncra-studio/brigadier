//! Requests waiting on the user, by the id their CLI gave them, and what reaches a running turn
//! besides a message: answers, steers and stops [D159, D177].

use super::Fold;
use serde_json::Value;

impl Fold {
    /// A request the agent made: pending in its turn until answered, withdrawn or ended.
    pub(super) fn ask(&mut self, item: &Value) {
        let id = item["id"].as_str().unwrap_or("");
        if let Some(t) = self.turns.first_mut().filter(|_| !id.is_empty()) {
            t.asks.insert(id.into(), item["request"].clone());
        }
    }

    /// A pending request leaves, saying why: answered, withdrawn, or how its turn ended.
    pub(super) fn end_ask(&mut self, id: &str, why: &str) {
        for t in &mut self.turns {
            if t.asks.remove(id).is_some() {
                self.closed.insert(id.into(), why.into());
                if !t.asks.values().any(|r| r["items"].is_array()) {
                    t.question = None;
                }
            }
        }
    }

    /// Every pending request of the first turn leaves: the turn ended, or (in a terminal) the
    /// agent moved on, its answer given by keys that aren't logged [D77].
    pub(super) fn end_asks(&mut self, why: &str) {
        let ids: Vec<String> = (self.turns.first())
            .map(|t| t.asks.keys().cloned().collect())
            .unwrap_or_default();
        for id in ids {
            self.end_ask(&id, why);
        }
    }

    /// An input that controls the running turn rather than starting one. True when it was one.
    /// An answer claims its request at once, so no second answer gets in; only its delivery
    /// makes it answered, and one never proven delivered stays uncertain, never resent [D60].
    pub(super) fn control(&mut self, item: &Value, cid: &str) -> bool {
        let c = &item["control"];
        match c["kind"].as_str() {
            Some("answer") => {
                let id = c["request"].as_str().unwrap_or("");
                let Some(t) = self.turns.first_mut() else {
                    return true;
                };
                if let Some(request) = t.asks.remove(id) {
                    // The turn's question line goes with its last question.
                    if !t.asks.values().any(|r| r["items"].is_array()) {
                        t.question = None;
                    }
                    if c["decision"] == "allowSession" {
                        self.granting.insert(cid.into(), request);
                    }
                    self.claims.insert(cid.into(), id.into());
                    self.closed.insert(id.into(), "uncertain".into());
                }
                true
            }
            Some("interrupt") => {
                if let Some(t) = self.turns.first_mut() {
                    t.stopping = true;
                }
                true
            }
            // A setup the agent confirms before a turn's message: no turn of its own [D222].
            Some("retune") => true,
            // A steer joins the turn that runs; with none running it is a message like any other.
            _ => item["steer"] == true && self.turns.first().is_some_and(|t| t.began),
        }
    }

    /// A control input's delivery: its answer is now answered, and a session grant held.
    pub(super) fn delivered_control(&mut self, cid: &str) {
        if let Some(id) = self.claims.remove(cid) {
            self.closed.insert(id, "answered".into());
        }
        if let Some(request) = self.granting.remove(cid) {
            self.grants.push(request);
        }
    }
}
