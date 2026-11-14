//! A model or agent picked: its line at once [D76]; a switch's divider live till the new model runs [D241].

use super::Thread;
use crate::adapters::s;
use serde_json::{Value, json};

impl Thread {
    /// A model picked for the conversation's agent: its line at once, where the user is, and the
    /// next turn on it says nothing more [D76, D124, D125].
    /// What a pick's line needs from before it's folded: the model the agent ran, and whether
    /// another agent was picked.
    pub(super) fn before_pick(&self, note: &Value) -> (Option<String>, bool) {
        let b = s(note, &["backend"]);
        let was = (self.fold.models.get(b).cloned())
            .or_else(|| self.ran.clone().filter(|(r, _)| r == b).map(|(_, m)| m));
        (was, self.fold.picked.is_some())
    }

    pub(super) fn picked(&mut self, note: &Value, (was, back): (Option<String>, bool)) {
        match note["pick"] == true {
            false => self.model_picked(s(note, &["backend"]).into(), was, note, back),
            true if note["to_label"].is_string() => self.agent_picked(note),
            true => {}
        }
    }

    /// Its line names both models as the picker does; picked back from another agent, it reads as
    /// that switch's own, even on the same model.
    fn model_picked(&mut self, backend: String, was: Option<String>, note: &Value, back: bool) {
        let model = note["model"].as_str().map(String::from);
        let Some(model) = model.or_else(|| self.fold.models.get(&backend).cloned()) else {
            return;
        };
        if back && note["to_label"].is_string() {
            self.agent_picked(note);
            self.pick_row = None;
            self.ran = Some((backend, model));
            return;
        }
        let Some(from) = was.filter(|m| !m.is_empty() && *m != model) else {
            return;
        };
        let named = |k: &str, id: String| note[k].as_str().map_or(id, String::from);
        // Live while a turn runs, as another agent's pick is [D241].
        let live = self.open.is_some();
        let at = self.pick_line(
            json!({"kind": "line", "reason": "model", "why": "changed", "live": live,
            "from": named("was", from), "to": named("name", model.clone()), "op": note["op"]}),
        );
        self.pick_row = live.then_some(at);
        self.ran = Some((backend, model));
    }

    /// Another agent picked: its switch row at once, which the turn that goes to it takes in
    /// place; every pick its own row [D76, D90].
    fn agent_picked(&mut self, note: &Value) {
        let (to, model) = (s(note, &["to_label"]), s(note, &["name"]));
        // Live while a turn runs: it carries on on the new model at a safe point [D124, D241].
        let state = if self.open.is_some() {
            "switching"
        } else {
            "switched"
        };
        let at = self.pick_line(json!({"kind": "switch", "reason": "picked", "state": state,
            "from": note["from_label"], "to": to, "model": model, "handoff": true,
            "automatic": false, "text": format!("Switched to {to} · {model}"), "op": note["op"]}));
        self.pick_row = Some(at);
    }

    /// A pick's line where the user is: in the running turn, never folded into its work, as the
    /// new model carries on under it [D124]; between turns in none, so the last one's answer keeps
    /// its actions above it.
    fn pick_line(&mut self, row: Value) -> usize {
        // A pick still live that another replaces is done: its turn carries on on the new one.
        if let Some(at) = self.pick_row.take() {
            self.switched(at);
        }
        self.break_group();
        let at = self.add(row);
        match self.open.as_mut() {
            Some(o) => o.kept.push(at as u64 + 1),
            None => self.items[at]["turnId"] = "".into(),
        }
        at
    }

    /// A switch is done once the new model draws a row: not its reasoning alone, nor a CLI ack [D241, D245].
    pub(super) fn switch_shown(&mut self, kind: &str) {
        let shown = matches!(kind, "text" | "text_delta" | "tool" | "compaction");
        if let Some(at) = self.switching.take_if(|_| shown) {
            self.switched(at);
        }
    }

    /// A switch's turn ended before any output, or a picking one with no cut to carry it on: the
    /// next message goes to it [D125, D241].
    pub(super) fn switch_ended(&mut self, cut: bool) {
        let picked = self.pick_row.filter(|_| !cut);
        for at in self.switching.take().into_iter().chain(picked) {
            self.switched(at);
        }
    }

    fn switched(&mut self, at: usize) {
        match self.items[at]["kind"] == "switch" {
            true => self.items[at]["state"] = "switched".into(),
            false => self.items[at]["live"] = false.into(),
        }
        self.changed_items.insert(at);
    }
}
