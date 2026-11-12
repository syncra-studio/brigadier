//! Opening a turn and the change lines that precede its message.

use super::{Open, Thread, reason};
use crate::fold::Turn;
use serde_json::json;

impl Thread {
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
        });
        // The rail's notices are about the last turn's failure: the next turn ends them (proposed).
        if !self.notices.is_empty() {
            self.notices.clear();
            self.notices_changed = true;
        }
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
            let switched = json!({"state": "switched", "text": note, "from": sw["from_label"],
                "to": sw["to_label"], "model": sw["to"]["model"], "handoff": sw["fresh"],
                "automatic": sw["auto"]});
            let at = match self.limit_row.take() {
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
