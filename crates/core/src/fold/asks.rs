//! Requests waiting on the user, by the id their CLI gave them, and what reaches a running turn
//! besides a message: answers, steers and stops [D159, D177].

use super::Fold;
use serde_json::Value;

impl Fold {
    /// A lost host ends delivered turns; unproven inputs stay available for explicit recovery.
    pub(crate) fn interrupt(&mut self, reason: Value, ts: u64) {
        while self.turns.first().is_some_and(|t| t.delivered.is_some()) {
            self.close("interrupted", reason.clone(), ts);
        }
    }

    /// The child an input asked for: started (`spawned`) or never started (`failed`).
    pub(super) fn spawn_settled(&mut self, cid: &str, failed: bool) {
        if let Some(t) = self
            .turns
            .iter_mut()
            .find(|t| t.cid.as_deref() == Some(cid))
        {
            t.spawning = failed;
            t.orphaned |= failed;
        }
    }

    /// A request the agent made: pending in its turn until answered, withdrawn or ended. One its
    /// parent agent answers says so (`to: parent`).
    pub(super) fn ask(&mut self, item: &Value) {
        let id = item["id"].as_str().unwrap_or("");
        let mut request = item["request"].clone();
        if self.for_parent(item) {
            request["to"] = "parent".into();
        }
        if let Some(t) = self.turns.first_mut().filter(|_| !id.is_empty()) {
            t.asks.insert(id.into(), request);
        }
    }

    /// Whether a request goes to the parent agent rather than the user: a worker's question, and
    /// its approval on Auto or Full access; on Ask its approvals stay the user's [D126, D131].
    pub fn for_parent(&self, item: &Value) -> bool {
        let Some(g) = self.given.as_ref().filter(|g| g["worker"] == true) else {
            return false;
        };
        item["kind"] == "question" || matches!(g["level"].as_str(), Some("auto" | "full"))
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

    /// Every pending request of the first turn leaves: the turn ended [D77].
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
            // An instant command (/compact): the agent's own turn events say what it does.
            Some("command") => true,
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
                    t.stop_by = c["by"].clone();
                }
                true
            }
            // A setup the agent confirms before a turn's message: no turn of its own [D222].
            Some("retune") => true,
            Some("stop_task") => true,
            // A steer joins the turn that runs; with none running it is a message like any other.
            _ => {
                let t = self.turns.first_mut().filter(|t| t.began);
                let joins = item["steer"] == true && t.is_some();
                if let Some(t) = t.filter(|_| joins && item["origin"] == "user") {
                    t.quiet = false;
                }
                joins
            }
        }
    }

    /// An input's delivery: its turn's message reached the agent, or its answer is answered.
    pub(super) fn delivered(&mut self, cid: &str, ts: u64) {
        if let Some(t) = self
            .turns
            .iter_mut()
            .find(|t| t.cid.as_deref() == Some(cid))
        {
            t.delivered = Some(ts);
        }
        self.delivered_control(cid);
    }

    /// The agent's reply to an input it acks [D222]: success delivers it; an error refuses it with
    /// the agent's reason, closing its request or failing its turn. No reply keeps it uncertain.
    pub(super) fn acked(&mut self, item: &Value, ts: u64) {
        let cid = item["id"].as_str().unwrap_or("");
        if !self.acking.remove(cid) {
            return;
        }
        let Some(error) = item["error"].as_str() else {
            return self.delivered(cid, ts);
        };
        if let Some(id) = self.claims.remove(cid) {
            self.closed.insert(id, "refused".into());
        }
        self.granting.remove(cid);
        if self
            .turns
            .first()
            .is_some_and(|t| t.cid.as_deref() == Some(cid))
        {
            self.close("failed", serde_json::json!({"refused": error}), ts);
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
