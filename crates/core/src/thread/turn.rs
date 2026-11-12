//! Opening a turn, the change lines that precede its message, and the line its end leaves.

use super::{Open, Thread};
use crate::adapters::s;
use crate::fold::Turn;
use serde_json::{Value, json};

impl Thread {
    /// A model picked for the conversation's agent: its line at once, or after the turn that runs,
    /// and the next turn on it says nothing more [D76].
    /// What a pick's line needs from before it's folded: the model the agent ran, and whether
    /// another agent was picked.
    pub(super) fn before_pick(&self, note: &Value) -> (Option<String>, bool) {
        let b = s(note, &["backend"]);
        let was = (self.fold.models.get(b).cloned())
            .or_else(|| self.ran.clone().filter(|(r, _)| r == b).map(|(_, m)| m));
        (was, self.fold.picked.is_some())
    }

    pub(super) fn picked(&mut self, note: &Value, (was, back): (Option<String>, bool)) {
        if self.open.is_some() {
            return self.later.push((note.clone(), (was, back)));
        }
        match note["pick"] == true {
            false => self.model_picked(s(note, &["backend"]).into(), was, note, back),
            true if note["to_label"].is_string() => self.agent_picked(note),
            true => {}
        }
    }

    /// The lines of picks made while the turn now ended ran [D76].
    pub(super) fn picked_later(&mut self) {
        for (note, before) in std::mem::take(&mut self.later) {
            self.picked(&note, before);
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
        self.break_group();
        let named = |k: &str, id: String| note[k].as_str().map_or(id, String::from);
        let at = self.add(json!({"kind": "line", "reason": "model", "why": "changed",
            "from": named("was", from), "to": named("name", model.clone()), "op": note["op"]}));
        // Between turns it's in none, so the last one's answer keeps its actions above it.
        self.items[at]["turnId"] = "".into();
        self.ran = Some((backend, model));
    }

    /// Another agent picked for the next message: its switch row at once, which that message's
    /// turn takes in place; every pick its own row [D76, D90].
    fn agent_picked(&mut self, note: &Value) {
        self.break_group();
        let (to, model) = (s(note, &["to_label"]), s(note, &["name"]));
        let at = self.add(
            json!({"kind": "switch", "reason": "picked", "state": "switched",
            "from": note["from_label"], "to": to, "model": model, "handoff": true,
            "automatic": false, "text": format!("Switched to {to} · {model}"), "op": note["op"]}),
        );
        self.items[at]["turnId"] = "".into();
        self.pick_row = Some(at);
    }

    /// A turn the user's Stop ended, however its agent ended it: the clean interrupt too; one its
    /// agent says ended well finished before the Stop took. One its host or agent dropped says
    /// so, a line that stays once another turn runs [D92].
    pub(super) fn turn_ended(&mut self, t: &Turn, item: &Value, outcome: &str, ts: u64) {
        if t.stopping && !(item["kind"] == "turn_end" && item["ok"] != false) {
            self.user_stopped(ts);
        } else if outcome == "interrupted" && t.delivered.is_some() {
            self.interrupted_line();
        }
    }

    pub(super) fn interrupted_line(&mut self) {
        if self.open.is_some() {
            self.kept_row(json!({"kind": "line", "reason": "interrupted"}));
        }
    }

    /// The row of the limit `turn` ended on, while no switch took it.
    pub(super) fn limit_of(&self, turn: &str) -> Option<usize> {
        self.limit_row
            .filter(|&at| self.items[at]["turnId"] == turn)
    }

    /// The same limit said again in its turn (a CLI's event, then its words): one row, its latest
    /// words and the first time said [D74].
    pub(super) fn limit_again(&mut self, item: &Value, turn: &str) -> bool {
        let Some(at) = self.limit_of(turn) else {
            return false;
        };
        self.items[at]["text"] = item["message"].clone();
        if let Some(resets) = item["resets"].as_u64() {
            self.items[at]["resets"] = resets.into();
            self.reset_at = Some(resets);
        }
        self.changed_items.insert(at);
        true
    }

    /// An automatic switch that couldn't happen: its limit's row says so, with Try again [D51].
    pub(super) fn switch_failed(&mut self, item: &Value) {
        if let Some(at) = self.limit_row {
            let row = &mut self.items[at];
            row["state"] = "failed".into();
            row["automatic"] = true.into();
            row["error"] = item["message"].clone();
            row["to"] = item["to"].clone();
            self.changed_items.insert(at);
        }
    }

    pub(super) fn open_turn(&mut self, t: &Turn, ts: u64) {
        self.shown.insert(t.id.clone());
        let at = self.turns.len();
        self.turns.push(
            json!({"id": t.id, "status": "running", "startedAt": ts, "endedAt": null,
            "backend": t.backend, "waitingSince": null, "waitedMs": 0}),
        );
        self.changed_turns.insert(at);
        self.open = Some(Open {
            id: t.id.clone(),
            backend: t.backend.clone(),
            at,
            from: self.items.len(),
            started: ts,
            input: false,
            first: None,
            answer: None,
            group: None,
            groups: 0,
            asked: None,
            wait: None,
            waited: 0,
            kept: vec![],
            denied: 0,
            stop: (None, false),
        });
        // A model picked for the same agent between turns; another agent's is the switch row's [D129].
        let model = t
            .model
            .as_ref()
            .or_else(|| self.fold.models.get(&t.backend))
            .cloned()
            .unwrap_or_default();
        if !model.is_empty() {
            let ran = self.ran.replace((t.backend.clone(), model.clone()));
            let moved = ran.filter(|(b, m)| *b == t.backend && *m != model);
            if let Some((_, from)) = moved.filter(|_| t.switch.is_null()) {
                self.add(json!({"kind": "line", "reason": "model", "why": "changed", "from": from, "to": model}));
            }
        }
        // A switch turns its limit's row into the switched line, in place [D51, D132]; a
        // continuation it wrote (not the user's words) shows only that.
        if let Some(note) = t.switch["note"].as_str() {
            // The kit's switch shape (D133); `text` is the whole note, for logs from before it.
            let sw = &t.switch;
            let named = sw["to"].get("name").unwrap_or(&sw["to"]["model"]);
            let switched = json!({"state": "switched", "text": note, "from": sw["from_label"],
                "to": sw["to_label"], "model": named, "handoff": sw["fresh"],
                "automatic": sw["auto"], "error": null});
            // A picked agent's row was drawn at its pick [D76].
            let picked = (sw["why"] == "picked")
                .then(|| self.pick_row.take())
                .flatten();
            let at = match picked.or_else(|| self.limit_row.take()) {
                Some(at) => at,
                None => self.add(json!({"kind": "switch", "reason": reason(sw["why"].as_str())})),
            };
            self.reset_at = None;
            for (k, v) in switched.as_object().unwrap() {
                self.items[at][k] = v.clone();
            }
            self.changed_items.insert(at);
            if t.origin != "user" {
                return;
            }
        } else {
            self.end_limit();
            if let Some(at) = self.reset_at.filter(|&at| at <= ts) {
                self.reset_at = None;
                self.add(json!({"kind": "line", "reason": "limit-reset", "at": at}));
            }
        }
        // A message sent again in place of a failed attempt says so before it [D487, D492].
        let replaced = (t.retry_of.as_ref()).is_some_and(|cid| !self.cids.contains(cid));
        if replaced && t.origin == "user" {
            self.add(json!({"kind": "line", "reason": "retried"}));
        }
        if let Some(rest) = t.origin.strip_prefix("result:") {
            return self.team_result(rest);
        }
        if t.cid.is_some() {
            let origin = if t.origin == "user" { "user" } else { "system" };
            let row = match t.origin.strip_prefix("peer:") {
                Some(from) => Self::peer_item(from, &t.text, t.ts, &t.id.clone().into()),
                None => {
                    json!({"kind": "message", "role": "user", "text": t.text, "streaming": false,
                    "origin": origin, "sentAt": t.ts, "cid": t.id, "files": t.parts["files"], "draft": t.parts})
                }
            };
            self.add(row);
            if let Some(o) = self.open.as_mut() {
                o.input = true;
            }
        }
    }
}

/// A switch row's reason, from the status fold's: a usage limit, a resume the agent refused, or
/// another agent the user picked [D129].
pub(super) fn reason(why: Option<&str>) -> &'static str {
    match why {
        Some("unresumable") => "unresumable",
        Some("picked") => "picked",
        _ => "usage-limit",
    }
}

impl Thread {
    /// Setup sits under its launch's input, first in its turn [D70].
    pub fn sync_setup(&mut self, setup: Value, alive: bool) {
        let (mut setup, cid) = self.startup.sync(setup, alive);
        // Its CLI's launch is logged just after the message: until then it's the newest turn's [D85].
        let newest = || {
            self.turns.last()?["id"]
                .as_str()
                .and_then(|t| self.first_rows.get(t))
                .copied()
        };
        let at = (cid.and_then(|cid| self.first_rows.get(cid).copied()))
            .or(self.setup_at)
            .or_else(|| cid.is_none().then(newest).flatten())
            .filter(|&at| at < self.items.len() && setup.is_object());
        if setup.is_object() {
            setup["after"] = at.map_or(Value::Null, |at| self.items[at]["id"].clone());
        }
        self.setup_changed |= setup != self.setup;
        self.setup = setup;
        if let Some(at) = at {
            self.setup_work(at);
        }
    }

    /// The turn a worktree was made for has a work block even with nothing else in it, so the
    /// worktree's row folds into it [D85]: added once that turn is done.
    fn setup_work(&mut self, at: usize) {
        let row = &self.items[at];
        let (n, turn) = (row["n"].as_u64().unwrap_or(0), row["turnId"].clone());
        let Some(t) = self
            .turns
            .iter()
            .find(|t| t["id"] == turn && t["status"] == "done")
        else {
            return;
        };
        if self.work.iter().any(|w| w["turnId"] == turn) {
            return;
        }
        let at = |k: &str| t[k].as_u64().unwrap_or(0);
        let ms = at("endedAt")
            .saturating_sub(at("startedAt"))
            .saturating_sub(at("waitedMs"));
        // Nothing of the turn's own folds: the empty span after its input.
        self.work.push(
            json!({"turnId": turn, "ms": ms, "folded": [n + 1, n], "kept": [],
            "denied": t["denied"]}),
        );
    }
}
