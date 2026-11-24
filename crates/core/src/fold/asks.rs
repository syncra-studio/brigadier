//! Requests waiting on the user, by the id their CLI gave them, and what reaches a running turn
//! besides a message: answers, steers and stops [D159, D177].

use super::Fold;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// A session's mockups [D2067].
#[derive(Default, Serialize, Deserialize, Clone)]
pub struct Mockups {
    /// The cards waiting on the user's pick, each turn over or not, with its turn's id.
    pub cards: Vec<(String, String)>,
    /// The workers whose mockup it opened: its own, and the ones it reuses.
    pub opened: Vec<String>,
}

impl Fold {
    /// A lost host ends delivered turns; unproven inputs stay available for explicit recovery.
    pub(crate) fn interrupt(&mut self, reason: Value, ts: u64) {
        while self.turns.first().is_some_and(|t| t.delivered.is_some()) {
            self.close("interrupted", reason.clone(), ts);
        }
    }

    /// A new host: what it was delivering is lost, and session grants live as long as the host
    /// that holds them [D193, D238].
    pub(super) fn owner_started(&mut self, ts: u64) {
        self.interrupt(serde_json::json!({"owner_restarted": true}), ts);
        self.turns
            .iter_mut()
            .filter(|t| t.delivered.is_none())
            .for_each(|t| t.orphaned = true);
        self.grants.clear();
        self.granting.clear();
    }

    /// A mockup card shown, or picked [D2067]; a mockup opened.
    pub(super) fn offered(&mut self, item: &Value) {
        let id = item["id"].as_str().unwrap_or("").to_string();
        match item["phase"].as_str() {
            Some("asked") => {
                let turn = self.turns.first().map(|t| t.id.clone());
                self.mockups.cards.push((id, turn.unwrap_or_default()));
            }
            Some("answered") => self.mockups.cards.retain(|c| c.0 != id),
            Some("started") if !self.mockups.opened.contains(&id) => self.mockups.opened.push(id),
            _ => {}
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
        if let Some(to) = self.to(item) {
            request["to"] = to.into();
        }
        self.plan_asked(&mut request);
        if let Some(t) = self.turns.first_mut().filter(|_| !id.is_empty()) {
            t.asks.insert(id.into(), request);
        }
    }

    /// A subagent asks after its parent's turn ended, held for it: the ask gets a turn of its own,
    /// so it waits on the user and can be answered [D128, D131].
    pub(super) fn held_ask(&mut self, ts: u64) {
        if self.turns.is_empty() && !self.agents.is_empty() {
            self.turns.push(super::Turn {
                id: format!("a{}", self.items),
                origin: "agent".into(),
                backend: self.backend.clone(),
                ts,
                delivered: Some(ts),
                began: true,
                held: true,
                ..Default::default()
            });
        }
    }

    /// That turn goes once nothing it was opened for waits.
    pub(super) fn unhold(&mut self) {
        if self
            .turns
            .first()
            .is_some_and(|t| t.held && t.asks.is_empty())
        {
            self.turns.remove(0);
        }
    }

    /// A `peer` note: a message to its own worker (`messaged`), or a sub-session's ask its boss
    /// passed to the user [D189]: its own request now waits on the user, or the question it sent
    /// its boss (`peer-<mid>`) is the user's to answer, till answered.
    pub(super) fn passed_to_user(&mut self, item: &Value) {
        let mid = item["mid"].as_str().map(|m| format!("peer-{m}"));
        match (item["phase"].as_str(), mid) {
            (Some("to_user"), Some(id)) => {
                if let Some(t) = self.turns.first_mut() {
                    t.question = item["text"].as_str().map(String::from);
                    t.asks.insert(id, item["request"].clone());
                }
            }
            (Some("to_user"), None) => {
                let id = item["id"].as_str().unwrap_or("");
                let r = self.turns.first_mut().and_then(|t| t.asks.get_mut(id));
                r.and_then(Value::as_object_mut).map(|r| r.remove("to"));
            }
            (Some("answered"), Some(id)) => self.end_ask(&id, "answered"),
            (Some("sent"), Some(_)) => self.messaged(item),
            _ => {}
        }
    }

    /// Who answers a request instead of the user: Brigadier, an exact repeat of a command allowed
    /// for the session, as Codex's and OpenCode's helpers do [D389]; or a worker's parent agent.
    pub fn to(&self, item: &Value) -> Option<&'static str> {
        let r = &item["request"];
        let cwd = &r["cli"]["cwd"];
        if r["grant"]["scope"] == "command"
            && (self.grants.iter()).any(|g| crate::adapters::repeat(g, &r["command"], cwd))
        {
            return Some("brigadier");
        }
        if self.held_for_review(item) {
            return Some("review");
        }
        self.for_parent(item).then_some("parent")
    }

    /// Whether a request goes to the parent agent rather than the user: a worker's question, and
    /// its approval on Auto or Full access; on Ask its approvals stay the user's [D126, D131].
    pub fn for_parent(&self, item: &Value) -> bool {
        let Some(g) = self.given.as_ref().filter(|g| g["worker"] == true) else {
            return false;
        };
        // A turn the user started in it is the user's conversation: its asks are theirs [D305].
        if self.turns.first().is_some_and(|t| t.direct) {
            return false;
        }
        // On Auto while its check gave no verdict, it asks as it would on Auto [D455].
        item["kind"] == "question"
            || self.turns.first().is_some_and(|t| t.unchecked)
            || matches!(g["level"].as_str(), Some("auto" | "full"))
    }

    /// A pending request leaves, saying why: answered, withdrawn, or how its turn ended.
    pub(super) fn end_ask(&mut self, id: &str, why: &str) {
        let mut left = vec![];
        for t in &mut self.turns {
            if let Some(r) = t.asks.remove(id) {
                left.push(r);
                self.closed.insert(id.into(), why.into());
                if !t.asks.values().any(|r| r["items"].is_array()) {
                    t.question = None;
                }
            }
        }
        left.iter()
            .for_each(|r| self.plan_left(r, &Value::Null, &Value::Null));
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
                    self.plan_left(&request, &c["decision"], &c["by"]);
                    if c["decision"] == "allowSession" {
                        self.granting.insert(cid.into(), request);
                    }
                    self.claims.insert(cid.into(), id.into());
                    self.closed.insert(id.into(), "uncertain".into());
                }
                self.unhold();
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
            // An answer's images, before it.
            Some("beside") => true,
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
