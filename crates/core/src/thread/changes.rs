//! What a thread sends: what changed since the last call, or nothing.

use super::Thread;
use serde_json::{Value, json};

impl Thread {
    /// What changed since the last call: rows and turns to replace by id, and new work.
    pub fn take(&mut self) -> Option<Value> {
        let items: Vec<Value> = std::mem::take(&mut self.changed_items)
            .into_iter()
            .map(|at| self.items[at].clone())
            .collect();
        let turns: Vec<Value> = std::mem::take(&mut self.changed_turns)
            .into_iter()
            .map(|at| self.turns[at].clone())
            .collect();
        let work = self.work[self.sent_work..].to_vec();
        self.sent_work = self.work.len();
        let quiet = items.is_empty() && turns.is_empty() && work.is_empty();
        let mut out = json!({"items": items, "turns": turns, "work": work});
        let setup_changed = std::mem::take(&mut self.setup_changed);
        if setup_changed {
            out["setup"] = self.setup.clone();
        }
        let points_changed = self.send_points(&mut out);
        // What waits on the user goes whole whenever it changed, to replace what the view holds.
        if std::mem::take(&mut self.pending_changed) {
            for (k, v) in self.requests().as_object().unwrap() {
                out[k] = v.clone();
            }
        } else if quiet && !setup_changed && !points_changed {
            return None;
        }
        Some(out)
    }

    /// The renewal's divider, from its cut or its summary turn's start, running till the fresh
    /// conversation starts: one, for a cut its summary turn follows [D112, D203; rev 3 §2.2].
    pub(super) fn divider(&mut self) {
        if self.cutting.is_none() {
            self.break_group();
            let row = json!({"kind": "compaction", "summary": null, "progress": "running"});
            self.cutting = Some(self.add(row));
        }
    }

    /// A summary turn's end: a renewal at the next message leaves its divider done till then, a
    /// cut's renews at once, and one the user's Stop cancelled fails it, the Stop's line shown in
    /// the hidden turn as `user_stopped` draws it [rev 3 §2.2].
    pub(super) fn summary_ended(&mut self, t: &crate::fold::Turn) {
        let Some(at) = self.cutting.filter(|_| t.origin == "summary") else {
            return;
        };
        let progress = match self.fold.renewing.as_ref().map(|r| &r["why"]) {
            None => {
                self.cutting = None;
                "failed"
            }
            Some(why) if why == "rebirth" => "done",
            Some(_) => return,
        };
        self.items[at]["progress"] = progress.into();
        self.changed_items.insert(at);
    }

    /// Forgets what changed: a thread kept to copy from sends nothing itself.
    pub fn settle(&mut self) {
        self.changed_items.clear();
        self.changed_turns.clear();
        self.sent_work = self.work.len();
        self.pending_changed = false;
    }
}

/// The line a stop draws, by who stopped it: none for a rebirth's, whose divider follows [D108];
/// the loop guard's says why, with Continue [D144].
pub(super) fn stop_line(by: Option<&str>) -> Option<&'static str> {
    match by {
        Some("rebirth") => None,
        Some("pause") => Some("paused"),
        Some("stall") => Some("stalled"),
        // Nobody's Stop: a night's, of a turn that hung.
        Some("overnight") => Some("interrupted"),
        _ => Some("stopped"),
    }
}
