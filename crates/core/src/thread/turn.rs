//! Opening a turn, the change lines that precede its message, and the line its end leaves.

use super::{Open, Thread};
use crate::adapters::s;
use crate::fold::Turn;
use serde_json::{Value, json};

impl Thread {
    /// A turn the user's Stop ended, however its agent ended it: the clean interrupt too; one its
    /// agent says ended well finished before the Stop took. One its host or agent dropped says
    /// so, a line that stays once another turn runs [D92].
    pub(super) fn turn_ended(&mut self, t: &Turn, item: &Value, outcome: &str, ts: u64) {
        if t.stopping && !(item["kind"] == "turn_end" && item["ok"] != false) {
            self.user_stopped(ts);
        } else if outcome == "interrupted" && t.delivered.is_some() {
            self.interrupted_line();
        } else if item["kind"] == "exited" && t.delivered.is_none() {
            // Its agent couldn't start: one line, the CLI's own words under it [D476].
            self.add(json!({"kind": "notice", "reason": "failed", "why": "start-failed", "cause": null, "text": self.startup.failed()}));
        }
    }

    /// A steer's bubble goes where the turn is now: its steps still running move below it, the
    /// same tool's row under a new id [D78]. It stays where it arrived, never folded, the user's
    /// as another session's [D332, D548].
    pub(super) fn steered(&mut self, row: Value) {
        let steer = self.kept_row(row);
        let from = self.open.as_ref().map_or(steer, |o| o.from);
        let running: Vec<usize> = (from..steer)
            .filter(|&at| {
                let row = &self.items[at];
                row["progress"] == "running"
                    && row["hidden"] != true
                    && matches!(row["kind"].as_str(), Some("tool" | "fileChange"))
            })
            .collect();
        for at in running {
            self.move_down(at);
        }
    }

    /// A step's row moves to the turn's end under a new id, its old row hidden: what finds it by
    /// tool id finds the new one. Its own visibility comes along unhidden.
    pub(super) fn move_down(&mut self, at: usize) {
        let mut row = self.items[at].clone();
        self.items[at]["hidden"] = true.into();
        self.changed_items.insert(at);
        for key in ["id", "n", "turnId", "hidden"] {
            row.as_object_mut().map(|o| o.remove(key));
        }
        if let Some(g) = self.member.remove(&at) {
            self.recount(g);
        }
        let moved = self.step(row);
        (self.keys.values_mut().chain(self.children.values_mut()))
            .filter(|v| **v == at)
            .for_each(|v| *v = moved);
    }

    pub(super) fn interrupted_line(&mut self) {
        if self.open.is_some() {
            self.kept_row(json!({"kind": "line", "reason": "interrupted"}));
        }
    }

    /// The row of the limit `turn` ended on, while no switch took it.
    /// A turn its full window failed: its rebirth's divider follows, or the loop guard's line
    /// says it stopped [D88, D144]. True when that is all it shows.
    pub(super) fn full(&mut self, item: &Value) -> bool {
        if item["why"] != "context" {
            return false;
        }
        if !crate::rebirth::goes_on(&self.fold) {
            self.kept_row(json!({"kind": "line", "reason": "stalled"}));
        }
        true
    }

    /// A limit no switch took any more (a Stop, a new message): its row stays, as history.
    pub(super) fn end_limit(&mut self) {
        if let Some(at) = self.limit_row.take() {
            self.items[at]["state"] = "over".into();
            self.changed_items.insert(at);
        }
    }

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

    fn new_turn(&mut self, t: &Turn, ts: u64) {
        let at = self.turns.len();
        self.turns.push(
            json!({"id": t.id, "status": "running", "startedAt": ts, "endedAt": null,
            "backend": t.backend, "waitingSince": null, "waitedMs": 0, "quiet": t.quiet}),
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
            quiet: t.quiet,
            joins: None,
            after: None,
        });
    }

    /// The agent's reply: it grows in one row as it's written, and its whole text, or its turn's
    /// end (kind ""), finishes that row, same id [D147].
    pub(super) fn said(&mut self, item: &Value, kind: &str, ts: u64) {
        // The carry-on's text goes on in the reply its turn's stop cut mid-way: that row streams again [D124, D154].
        let joins = self.open.as_ref().and_then(|o| o.joins.as_ref());
        if let Some((n, ..)) = joins.filter(|_| !kind.is_empty() && self.streaming.is_none()) {
            self.streaming = Some(*n as usize - 1);
            self.items[*n as usize - 1]["streaming"] = (kind == "text_delta").into();
        }
        if self.drafted(item, kind, ts) {
            return;
        }
        if let Some(at) = self.streaming {
            let after = self.open.as_ref().and_then(|o| o.after.clone());
            let joins = (self.open.as_mut())
                .and_then(|o| o.joins.as_mut())
                .filter(|(n, ..)| *n as usize == at + 1);
            let row = &mut self.items[at];
            match (kind, joins) {
                ("text_delta", Some((_, cut, so_far))) => {
                    so_far.push_str(s(item, &["text"]));
                    row["text"] = super::subagents::joined(cut, so_far).into();
                }
                ("text_delta", None) => {
                    let text = row["text"].as_str().unwrap_or("").to_string();
                    row["text"] = (text + s(item, &["text"])).into();
                }
                (_, joins) => {
                    // A reply cut off before its whole text came keeps what was written.
                    if kind == "text" {
                        let text = &(after.unwrap_or_default() + s(item, &["text"]));
                        let text = joins.map_or(text.into(), |(_, cut, _)| {
                            super::subagents::joined(cut, text)
                        });
                        (row["text"], row["sentAt"]) = (text.into(), ts.into());
                        if let Some(o) = self.open.as_mut() {
                            o.joins = None;
                        }
                    }
                    row["streaming"] = false.into();
                    self.streaming = None;
                    if let Some(o) = self.open.as_mut() {
                        o.after = None;
                    }
                }
            }
            self.changed_items.insert(at);
            return;
        }
        // An empty message, as Codex sends one after a send-back's reply, is no row.
        if kind.is_empty() || (kind == "text" && s(item, &["text"]).trim().is_empty()) {
            return;
        }
        self.break_group();
        let streaming = kind == "text_delta";
        let at = self.add(
            json!({"kind": "message", "role": "assistant", "text": item["text"],
            "streaming": streaming, "sentAt": ts}),
        );
        self.streaming = streaming.then_some(at);
        if let Some(o) = self.open.as_mut() {
            o.answer = Some(at as u64 + 1);
        }
    }

    /// A row of a quiet turn is hidden, unless it asks the user or the user's own words join it.
    pub(super) fn quiet_row(&mut self, row: &mut Value) {
        if let Some(o) = self.open.as_mut().filter(|o| o.quiet) {
            match row["kind"].as_str() {
                Some("approval" | "question") => {}
                Some("message") if row["origin"] == "user" => {
                    o.quiet = false;
                    self.turns[o.at]["quiet"] = false.into();
                    self.changed_turns.insert(o.at);
                }
                _ => row["hidden"] = true.into(),
            }
        }
    }

    pub(super) fn open_turn(&mut self, t: &Turn, ts: u64) {
        self.shown.insert(t.id.clone());
        // A turn no one sent, or a worker's result, while a turn is held for its helpers, or right
        // after they ended: the agent woke for them, and carries that block on [D106, D118, D151].
        // So does the input that carries on a turn Brigadier cut [D108, D124]. While its helpers
        // still run the block is running: any turn that starts then is part of it, the user's
        // message a steer in it, never a second block beside it [D521]. Any other ends what waits.
        let last = (self.held.values().map(|(o, _)| o.at).max())
            .filter(|&at| at + 1 == self.turns.len())
            .and_then(|at| self.turns[at]["id"].as_str().map(String::from));
        let cut = (last.as_ref())
            .and_then(|id| self.held.get(id))
            .is_some_and(|(o, _)| o.cut());
        let wakes = (matches!(t.origin.as_str(), "agent" | "system")
            || t.origin.starts_with("result:"))
            && (t.switch.is_null() || (cut && t.origin == "system"));
        let holds =
            !cut && (last.as_ref()).is_some_and(|id| self.helpers(id) > 0 || self.working());
        // Resume after the user's Stop is a block of its own under the stopped one, which stays as it
        // ended, as the next message after a stop is in any CLI [D693]. The agent waking on its own,
        // for a command it left running that ended after its block folded, carries that block on: no
        // new block without the user's words [D117, D179].
        let resume = t.origin == "system" && t.text == crate::send::RESUME;
        // Brigadier's resume once the network is back: its own block, the failed row saying it carried on [D339].
        let reconnect = t.origin == "system" && t.text == crate::send::RECONNECT;
        let failed = || self.items.iter().rposition(|i| i["reason"] == "failed");
        if let Some(at) = reconnect.then(failed).flatten() {
            self.items[at]["resumed"] = true.into();
            self.changed_items.insert(at);
        }
        let resume = resume || reconnect;
        // Brigadier's send-back of a reply that asked in prose goes on in its block [D529].
        let back = t.origin == "system" && t.text == crate::rules::SEND_BACK;
        let resumed = (self.ended.take())
            .filter(|o| o.at + 1 == self.turns.len())
            .filter(|o| match back {
                true => self.turns[o.at]["status"] == "done",
                // A stopped worker's result, let go after the turn, follows on in its block [D316].
                false => {
                    (t.origin == "agent" || t.origin.starts_with("result:stopped:"))
                        && !self.held.contains_key(&o.id)
                }
            });
        let resuming = resumed.is_some();
        let held = last
            .filter(|_| (wakes || holds) && !resuming)
            .and_then(|id| self.held.remove(&id));
        // The user's or another session's words into a block only its helpers held: a steer's bubble.
        let steers = held.is_some() && !wakes;
        match resumed.or(held.map(|(o, _)| o)) {
            // Carried on by another agent, the turn is that agent's now [D124].
            Some(mut o) => {
                o.backend.clone_from(&t.backend);
                // A worker's ask its parent answers stays out of the block it carries on [D329].
                o.quiet = t.quiet;
                self.turns[o.at]["backend"] = t.backend.clone().into();
                self.rejoin(o)
            }
            None => {
                self.settle_held(true);
                self.new_turn(t, ts)
            }
        }
        // A model picked for the same agent between turns; another agent's is the switch row's [D129].
        let model = t
            .model
            .as_ref()
            .or_else(|| self.fold.models.get(&t.backend))
            .cloned()
            .unwrap_or_default();
        // One sent mid-turn runs on the setup the child kept, which says nothing of a pick.
        if !model.is_empty() && !t.mid {
            let ran = self.ran.replace((t.backend.clone(), model.clone()));
            let moved = ran.filter(|(b, m)| *b == t.backend && *m != model);
            if let Some((_, from)) = moved.filter(|_| t.switch.is_null()) {
                self.add(json!({"kind": "line", "reason": "model", "why": "changed", "from": from, "to": model}));
            }
        }
        // A model of this agent picked mid-turn: live till the turn carrying it on draws a row [D241].
        if let Some(at) = self
            .pick_row
            .take_if(|at| self.items[*at]["kind"] == "line")
        {
            self.switching = Some(at);
        }
        // A rebirth shows as one divider, the message that carries it under it; a cut another turn beat fails [D88, D112, D203].
        let rebirth = matches!(t.switch["why"].as_str(), Some("rebirth" | "cut"));
        if let Some(at) = self.cutting.take_if(|_| !rebirth) {
            self.items[at]["progress"] = "failed".into();
            self.changed_items.insert(at);
        }
        if rebirth {
            self.end_limit();
            // Sent again after a crash, or drawn at its cut: its divider runs again, never a second one [D54, D203].
            let again = (t.retry_of.as_ref())
                .and(self.items.iter().rposition(|i| i["kind"] == "compaction"))
                .or(self.cutting.take());
            if let Some(at) = again {
                self.items[at]["progress"] = "running".into();
                self.changed_items.insert(at);
            } else {
                // Where the cut fell: it folds with the steps around it, as any step does [D170].
                self.break_group();
                self.add(json!({"kind": "compaction", "summary": null, "progress": "running"}));
            }
            self.reborn = Some(again.unwrap_or(self.items.len() - 1));
            if t.origin == "system" {
                return;
            }
        } else if let Some(note) = t.switch["note"].as_str() {
            // The kit's switch shape (D133); `text` is the whole note, for logs from before it.
            let sw = &t.switch;
            let named = sw["to"].get("name").unwrap_or(&sw["to"]["model"]);
            // A picked agent's row was drawn at its pick [D76].
            let picked = (sw["why"] == "picked")
                .then(|| self.pick_row.take())
                .flatten();
            // Live till the new model's first output, but a pick made idle was done at once [D125, D241].
            let live = picked.is_none_or(|at| self.items[at]["state"] != "switched");
            let state = if live { "switching" } else { "switched" };
            let switched = json!({"state": state, "text": note, "from": sw["from_label"],
                "to": sw["to_label"], "model": named, "handoff": sw["fresh"],
                "automatic": sw["auto"], "moved": sw["moved"], "error": null});
            let at = match picked.or_else(|| self.limit_row.take()) {
                Some(at) => at,
                None => self.add(json!({"kind": "switch", "reason": reason(sw["why"].as_str())})),
            };
            self.reset_at = None;
            for (k, v) in switched.as_object().unwrap() {
                self.items[at][k] = v.clone();
            }
            self.changed_items.insert(at);
            self.switching = live.then_some(at);
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
        // Brigadier's words carrying on a cut or stopped turn are no row: its steps flow on in that block [D124, D693].
        if (cut && wakes || resuming || resume) && t.origin == "system" {
            // A Resume's own block folds its work as any turn does.
            if let Some(o) = self.open.as_mut().filter(|_| resume) {
                o.input = true;
            }
            return;
        }
        // A message sent again in place of a failed attempt says so before it [D487, D492].
        let replaced = (t.retry_of.as_ref()).is_some_and(|cid| !self.cids.contains(cid));
        if replaced && t.origin == "user" {
            self.add(json!({"kind": "line", "reason": "retried"}));
        }
        // A worker's result is its wake's input: the agent's work on it folds under it [D151].
        if let Some(rest) = t.origin.strip_prefix("result:") {
            self.team_result(rest, ts);
        } else if t.cid.is_some() {
            let origin = if t.origin == "user" { "user" } else { "system" };
            let peer = t.origin.strip_prefix("peer:");
            let mut row = match peer {
                Some(from) => Self::peer_item(from, &t.text, t.ts, &t.id.clone().into()),
                None => {
                    json!({"kind": "message", "role": "user", "text": t.text, "streaming": false,
                    "origin": origin, "sentAt": t.ts, "cid": t.id, "files": t.parts["files"], "draft": t.parts, "brigade": t.brigade})
                }
            };
            if steers {
                row["steer"] = true.into();
                self.steered(row);
            } else {
                self.add(row);
            }
        }
        // A turn its agent woke for on its own folds its work too, from its first row.
        if let Some(o) = self.open.as_mut() {
            o.input = true;
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
        // A turn held for its subagents gets its block when the last ends, timed then.
        if self.work.iter().any(|w| w["turnId"] == turn)
            || turn.as_str().is_some_and(|t| self.held.contains_key(t))
        {
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

/// The line a stop draws, by who stopped it: none for a rebirth's, whose divider follows [D108];
/// the loop guard's says why, with Continue [D144].
pub(super) fn stop_line(by: Option<&str>) -> Option<&'static str> {
    match by {
        Some("rebirth") => None,
        Some("pause") => Some("paused"),
        Some("stall") => Some("stalled"),
        _ => Some("stopped"),
    }
}
