//! A parent's workers in its thread, as the old app's TeamSentence and lead rows [D3010]: their
//! start, how each ended as its result came, the lead's or the user's End, and "still running"
//! after the user's Stop [D3009, D3011]. Sentences, never cards; each folds with the work, as a
//! subagent's row does [D118].

use super::Thread;
use serde_json::{Value, json};

impl Thread {
    /// A worker's row, its own and never a step under a group's header, folds with its turn's
    /// work as a subagent's does [D115, D118].
    pub(super) fn team_row(&mut self, row: Value) {
        self.break_group();
        self.add(row);
    }

    /// A row that stays out of its turn's work fold, as the user's words do [D99].
    /// Why a new chat didn't start on the account picked with Use, said once [C38].
    pub(super) fn account_note(&mut self, item: &Value) {
        self.kept_row(json!({"kind": "notice", "level": "info", "text": item["text"]}));
    }

    pub(super) fn kept_row(&mut self, row: Value) -> usize {
        self.kept_as(row, None)
    }

    fn kept_as(&mut self, row: Value, id: Option<String>) -> usize {
        self.break_group();
        let at = self.add_as(row, id);
        if let Some(o) = self.open.as_mut() {
            o.kept.push(at as u64 + 1);
        }
        at
    }

    /// Overnight's moments, each written to the log till it's there: drawn once, by its id.
    pub(super) fn overnight(&mut self, item: &Value) {
        let id = format!("overnight:{}", item["id"].as_str().unwrap_or(""));
        if self.named.contains_key(&id) {
            return;
        }
        let mut row = item["row"].clone();
        row["kind"] = "overnight".into();
        self.kept_as(row, Some(id));
    }

    /// A `worker` note: `started` joins the start row just before it, so one turn's starts read
    /// as one sentence; `ended` and `still` name every worker they're about.
    pub(super) fn team(&mut self, item: &Value, ts: u64) {
        let ids = match item["phase"].as_str() {
            Some("started") => json!([item["id"]]),
            _ => item["ids"].clone(),
        };
        match item["phase"].as_str() {
            Some("started") => {
                if let Some(id) = item["id"].as_str() {
                    self.over.remove(id);
                }
                let at = self.items.len().checked_sub(1);
                let joins = at
                    .and_then(|at| self.items.get(at))
                    .is_some_and(|r| r["kind"] == "team" && r["word"] == "started");
                if let Some(at) = at.filter(|_| joins) {
                    if let Some(w) = self.items[at]["workers"].as_array_mut() {
                        w.push(item["id"].clone());
                    }
                    self.changed_items.insert(at);
                    return;
                }
                self.team_row(json!({"kind": "team", "word": "started", "workers": ids}));
            }
            Some("ended") => {
                let ended = ids.as_array().map_or(&[][..], Vec::as_slice);
                self.over
                    .extend(ended.iter().filter_map(Value::as_str).map(String::from));
                self.worker_ended(ts);
                // An ended worker's result wakes no one, so a block it alone held folds now [D314, D330].
                self.settle_held(false);
                self.team_row(json!({"kind": "team_step", "type": "stopped", "byUser": item["by"] == "user", "workers": ids}));
            }
            // The user's Stop ended the block: the workers that run on hold it no longer.
            Some("still") => {
                self.settle_held(false);
                self.team_row(json!({"kind": "team_still", "workers": ids}));
            }
            // A result its parent's own `wait` or next message took, never sent: its sentence all
            // the same [D97]. No wake comes for it, so a block it alone held folds now.
            Some("result") => {
                self.team_result(item["result"].as_str().unwrap_or(""), ts);
                self.settle_held(false);
            }
            // Stopped, its result waits for the parent's next turn and wakes no one [D314].
            Some("held") => {
                self.worker_ended(ts);
                self.settle_held(false);
            }
            // A worker waits on the user, at Ask: its block waits with it, that time waited [D551].
            Some("waits") => {
                (self.asking).extend(
                    ids.as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(Value::as_str)
                        .map(String::from),
                );
                if self.asking.iter().any(|w| self.fold.workers.contains(w)) {
                    self.worker_waits(ts);
                }
            }
            Some("waited") => {
                (ids.as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str))
                .for_each(|w| {
                    self.asking.remove(w);
                });
                self.end_wait(ts);
            }
            // The user's own message to it, in its tab or by its To chip [D293, D303].
            Some("messaged") => {
                self.team_row(json!({"kind": "team_step", "type": "messaged", "byUser": true, "workers": ids, "text": item["text"]}));
            }
            // The user's Pause and Resume [D3041].
            Some(p @ ("paused" | "resumed")) => {
                self.team_row(json!({"kind": "team_step", "type": p, "workers": ids}));
            }
            _ => {}
        }
    }

    /// A result's input (`result:<how>:<worker>[:merged=<base>|:unmerged=<base>][:open|:wakes]`): how it
    /// ended and whether it merged back [D97], in its place.
    pub(super) fn team_result(&mut self, rest: &str, ts: u64) {
        // One whose worker has a later task open leaves it at work.
        let open = rest.strip_suffix(":open");
        let rest = open.unwrap_or(rest.strip_suffix(":wakes").unwrap_or(rest));
        let (how, wid) = rest.split_once(':').unwrap_or(("finished", rest));
        // A worker's ask to its parent is no row in the parent's thread [D121].
        if how == "asks" {
            return;
        }
        let (wid, merge) = wid.split_once(':').unwrap_or((wid, ""));
        if open.is_none() {
            self.over.insert(wid.into());
        }
        self.worker_ended(ts);
        let merge =
            (merge.split_once('=')).map(|(m, into)| json!({"into": into, "ok": m == "merged"}));
        let word = match how {
            "finished" => "finished",
            "stopped" => "stopped",
            _ => "failed",
        };
        // Hidden: its batch's row says it once all are done, its merge there opened or in the
        // Workers tab [D103, D175]; the row stays as its wake's input.
        self.team_row(
            json!({"kind": "team", "word": word, "workers": [wid], "merge": merge, "hidden": true}),
        );
    }

    /// An image made, one row from its start to its end, out of the turn's work fold as the
    /// user's words are; a worker's comes to its parent's thread too [D289].
    pub(super) fn image(&mut self, item: &Value) {
        let id = format!("image-{}", item["id"].as_str().unwrap_or(""));
        let row = json!({"kind": "image", "progress": item["progress"], "attachment": item["attachment"],
            "name": item["name"], "prompt": item["prompt"], "error": item["error"], "from": item["from"]});
        if let Some(at) = self.named.get(&id).copied() {
            // An end that names no prompt (OpenCode's notice) keeps the start's.
            let kept = |(k, v): &(&String, &Value)| !(*k == "prompt" && v.is_null());
            for (k, v) in row.as_object().into_iter().flatten().filter(kept) {
                self.items[at][k] = v.clone();
            }
            self.changed_items.insert(at);
            return;
        }
        self.break_group();
        let at = self.add_as(row, Some(id));
        if let Some(o) = self.open.as_mut() {
            o.kept.push(at as u64 + 1);
        }
    }
}

impl Thread {
    /// A `shell` note: a `!` command the user ran [D316]. `start` adds its row, out of the work
    /// fold; `end` sets how it ended and its newest output in place.
    pub(super) fn shell(&mut self, item: &Value) {
        let id = format!("shell:{}", item["id"].as_str().unwrap_or(""));
        let at = match self.named.get(&id).copied() {
            Some(at) => at,
            None => {
                self.break_group();
                let row = json!({"kind": "shell", "cmd": item["id"], "command": item["command"], "progress": "running", "output": "", "exitCode": null});
                let at = self.add_as(row, Some(id));
                if let Some(o) = self.open.as_mut() {
                    o.kept.push(at as u64 + 1);
                }
                at
            }
        };
        if item["phase"] == "end" {
            for k in ["progress", "exitCode", "output", "ms", "error"] {
                self.items[at][k] = item[k].clone();
            }
            self.changed_items.insert(at);
        }
    }
}
