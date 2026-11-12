//! The thread's rows: what each normalised item adds or changes, and the groups steps make [D48, D65].

use super::Thread;
use serde_json::{Value, json};
use std::collections::BTreeSet;

impl Thread {
    /// A tool's row by id: in this turn, or a subagent still running from an earlier one.
    fn row_of(&self, turn: &str, id: &str) -> Option<usize> {
        let found = self.keys.get(&(turn.to_string(), id.to_string()));
        found.or_else(|| self.children.get(id)).copied()
    }

    pub(super) fn content(&mut self, item: &Value, kind: &str, ts: u64) {
        let Some(turn) = self.turn_id() else {
            return;
        };
        let str_of = |k: &str| item[k].as_str().unwrap_or("").to_string();
        let key = |id: String| (turn.clone(), id);
        // The agent's next output ends a wait on the user [D77].
        if matches!(
            kind,
            "text" | "reasoning" | "tool" | "tool_done" | "compaction" | "unknown"
        ) {
            self.end_wait(ts);
        }
        match kind {
            "text" => {
                self.break_group();
                let at = self.add(
                    json!({"kind": "message", "role": "assistant", "text": item["text"],
                    "streaming": false, "sentAt": ts}),
                );
                if let Some(o) = self.open.as_mut() {
                    o.answer = Some(at as u64 + 1);
                }
            }
            "reasoning" => {
                let text = str_of("text");
                self.add(json!({"kind": "reasoning", "heading": heading(&text), "text": text, "streaming": false}));
            }
            "tool" => {
                let step = str_of("step");
                if let Some(parent) = item["parent"].as_str() {
                    // A subagent's own step: its row shows it as the current one [D78].
                    if let Some(at) = self.row_of(&turn, parent)
                        && !step.is_empty()
                    {
                        let row = &mut self.items[at];
                        row["steps"] = (row["steps"].as_u64().unwrap_or(0) + 1).into();
                        row["current"] = json!({"step": step, "input": item["input"]});
                        self.changed_items.insert(at);
                    }
                    return;
                }
                if step.is_empty() {
                    return;
                }
                // A start may repeat with more detail (a query known only once it ran).
                if let Some(&at) = self.keys.get(&key(str_of("id"))) {
                    if self.items[at]["kind"] == "tool" && !str_of("input").is_empty() {
                        self.items[at]["input"] = item["input"].clone();
                        self.changed_items.insert(at);
                    }
                    return;
                }
                let at = item["at"].as_u64().unwrap_or(ts);
                let row = match step.as_str() {
                    "agent" => {
                        json!({"kind": "childAgent", "sessionId": item["id"], "title": item["input"],
                        "progress": "running", "startedAt": at, "endedAt": null, "current": null,
                        "steps": null, "answer": null})
                    }
                    "edit" => {
                        json!({"kind": "fileChange", "changes": item["changes"], "progress": "running"})
                    }
                    _ => {
                        json!({"kind": "tool", "name": item["name"], "input": item["input"], "output": "",
                        "progress": "running", "exitCode": null, "step": step, "startedAt": at, "endedAt": null})
                    }
                };
                let at = self.step(row);
                self.keys.insert(key(str_of("id")), at);
                if step == "agent" {
                    self.children.insert(str_of("id"), at);
                }
            }
            // The backend's own record of a turn's edits, with their diffs [D95].
            "changes" => {
                if let Some(at) = self.row_of(&turn, &str_of("id")) {
                    self.items[at]["changes"] = item["changes"].clone();
                    self.changed_items.insert(at);
                }
            }
            "tool_done" => {
                if let Some(parent) = item["parent"].as_str() {
                    if let Some(at) = self.row_of(&turn, parent) {
                        self.items[at]["current"] = Value::Null;
                        self.changed_items.insert(at);
                    }
                    return;
                }
                let Some(at) = self.row_of(&turn, &str_of("id")) else {
                    return;
                };
                self.children.remove(&str_of("id"));
                let progress = if item["ok"] == true { "done" } else { "failed" };
                let ended = item["at"].as_u64().unwrap_or(ts);
                let row = &mut self.items[at];
                match row["kind"].as_str().unwrap_or("") {
                    "tool" => {
                        row["output"] = item["output"].clone();
                        row["exitCode"] = item["exit"].clone();
                        row["endedAt"] = ended.into();
                    }
                    "fileChange" if item["changes"].as_array().is_some_and(|c| !c.is_empty()) => {
                        row["changes"] = item["changes"].clone();
                    }
                    "childAgent" => {
                        row["endedAt"] = ended.into();
                        row["current"] = Value::Null;
                        let answer = str_of("output");
                        row["answer"] = if answer.is_empty() {
                            Value::Null
                        } else {
                            answer.into()
                        };
                        if let Some(child) = item["child"].as_str() {
                            row["sessionId"] = child.into();
                        }
                    }
                    _ => {}
                }
                row["progress"] = progress.into();
                self.changed_items.insert(at);
                if let Some(&g) = self.member.get(&at) {
                    self.recount(g);
                }
            }
            "question" => {
                self.break_group();
                let at = self.add(json!({"kind": "question", "question": item["text"],
                    "options": item["options"].as_array().cloned().unwrap_or_default(), "answer": null,
                    "request": item["request"]}));
                self.keys.insert(key(str_of("id")), at);
                if let Some(o) = self.open.as_mut() {
                    o.asked = Some(at);
                }
                self.wait_on(at, ts);
            }
            "approval" => {
                self.break_group();
                let at = self
                    .add(json!({"kind": "approval", "request": item["request"], "decision": null}));
                self.wait_on(at, ts);
            }
            "resolved" => {
                self.withdraw(&str_of("id"), item["decision"].as_str());
                if self.pending.is_empty() {
                    self.end_wait(ts);
                }
            }
            "delivered" if !self.acking.contains(&str_of("cid")) => self.delivered(&str_of("cid")),
            // An input the agent acks is applied by its reply, not by being written [D222].
            "reply" if self.acking.remove(&str_of("id")) && item["error"].is_null() => {
                self.delivered(&str_of("id"))
            }
            "answer" => {
                if let Some(&at) = self.keys.get(&key(str_of("id"))) {
                    self.items[at]["answer"] = item["text"].clone();
                    self.changed_items.insert(at);
                    if let Some(o) = self.open.as_mut().filter(|o| o.asked == Some(at)) {
                        o.asked = None;
                    }
                }
                self.unwait(&str_of("id"));
                self.end_wait(ts);
            }
            // A process gone ends its background subagents with it.
            "exited" => self.end_children("failed"),
            "stopped" => {
                self.end_children("cancelled");
                // The user's Stop ends the limit: its line stays, without its switch [D51].
                if item["by"] == "user" {
                    self.end_limit();
                    // Said in the thread too, out of the work fold, like the user's words [D99, D487].
                    let ms = self.open.as_ref().map(|o| ts.saturating_sub(o.started));
                    let at = self.add(json!({"kind": "line", "reason": "stopped", "ms": ms}));
                    if let Some(o) = self.open.as_mut() {
                        o.kept.push(at as u64 + 1);
                    }
                }
            }
            // A limit (or a refused resume) is no error of the turn: one row that a switch turns into
            // the switched line in place, as compaction's row changes, never a second row [D51, D132].
            "limited" | "unresumable" => {
                self.break_group();
                self.end_limit();
                let backend = self.fold.backend.clone();
                let account = self
                    .fold
                    .accounts
                    .get(&backend)
                    .cloned()
                    .unwrap_or_default();
                // `backend` and `account` name the side at its limit until a switch names both.
                let at = self.add(json!({"kind": "switch", "state": "limit",
                    "reason": if item["credits"] == true { "credits" } else { super::reason(Some(kind)) }, "backend": backend, "account": account,
                    "handoff": false, "automatic": false, "text": item["message"], "resets": item["resets"]}));
                self.limit_row = Some(at);
                self.reset_at = item["resets"].as_u64();
            }
            "rerouted" => {
                self.break_group();
                self.add(json!({"kind": "line", "reason": "model", "why": "rerouted",
                    "from": item["from"], "to": item["to"]}));
            }
            "denied" => {
                if let Some(o) = self.open.as_mut() {
                    o.denied += 1;
                }
            }
            // A failed turn: its line in the thread, and what it means on the composer's rail [D487].
            "failed" => {
                if self.failed.as_deref() == Some(&turn) {
                    return;
                }
                self.failed = Some(turn.clone());
                self.break_group();
                let why = item["why"].as_str().unwrap_or("");
                match why {
                    "review" => self.add(json!({"kind": "line", "reason": "review-ended"})),
                    "blocked" => self.add(
                        json!({"kind": "notice", "reason": "blocked", "text": item["message"]}),
                    ),
                    _ => self
                        .add(json!({"kind": "notice", "level": "error", "text": item["message"]})),
                };
                let reason = match why {
                    "model" => "model-unavailable",
                    "ended" => "ended-for-safety",
                    "blocked" | "review" => return,
                    _ => "turn-failed",
                };
                let cause = if why == "capacity" {
                    json!("capacity")
                } else {
                    Value::Null
                };
                self.notices
                    .push(json!({"id": format!("{turn}:{reason}"), "reason": reason,
                    "cause": cause, "text": item["message"], "turnId": turn}));
                self.notices_changed = true;
            }
            "sign_in" => {
                self.break_group();
                self.add(json!({"kind": "notice", "reason": "sign-in", "text": item["message"]}));
            }
            "compaction" => {
                self.break_group();
                let progress = item["progress"].as_str().unwrap_or("done");
                let running = self.keys.get(&key("compaction".into())).copied();
                match running.filter(|&at| self.items[at]["progress"] == "running") {
                    Some(at) => {
                        self.items[at]["progress"] = progress.into();
                        self.changed_items.insert(at);
                    }
                    None => {
                        let at = self.add(
                            json!({"kind": "compaction", "summary": null, "progress": progress}),
                        );
                        self.keys.insert(key("compaction".into()), at);
                    }
                }
            }
            "unknown" | "unknown_frame" => {
                self.break_group();
                let raw = match item["raw"].as_str() {
                    Some(text) => serde_json::from_str(text).unwrap_or_else(|_| text.into()),
                    None => {
                        let mut raw = item.clone();
                        for k in ["n", "f", "ts"] {
                            raw.as_object_mut().map(|o| o.remove(k));
                        }
                        raw
                    }
                };
                self.add(json!({"kind": "unknown", "raw": raw}));
            }
            // Send as new [D204]: one row per session started from here, its intent then its
            // result in place; never sent to the agent.
            "note" if item["event"] == "side" => {
                let id = format!("side:{}", str_of("session"));
                let at = match self.named.get(&id).copied() {
                    Some(at) => at,
                    None => {
                        self.break_group();
                        let at = self.add_as(
                            json!({"kind": "started", "session": item["session"],
                            "state": "starting", "text": item["text"]}),
                            Some(id),
                        );
                        // Out of the turn's work fold, like the user's own words [D99].
                        if let Some(o) = self.open.as_mut() {
                            o.kept.push(at as u64 + 1);
                        }
                        at
                    }
                };
                if item["phase"] != "intent" {
                    let row = &mut self.items[at];
                    row["state"] = if item["ok"] == true {
                        "started"
                    } else {
                        "failed"
                    }
                    .into();
                    for k in ["base", "title", "error", "left"] {
                        row[k] = item[k].clone();
                    }
                    self.changed_items.insert(at);
                }
            }
            "note" if item["event"] == "worker" => self.team(item),
            "note" if item["event"] == "peer" => self.peer(item),
            // A native fork whose first launch fell to the hand-off: its line says so [D90].
            "note" if item["event"] == "unforked" => {
                let forked = self.items.iter().rposition(|r| r["kind"] == "forked");
                if let Some(at) = forked {
                    self.items[at]["summary"] = true.into();
                    self.changed_items.insert(at);
                }
            }
            _ => {}
        }
    }

    /// A fork's start [D1063]: its source's rows up to the answer it forked at, read only, from
    /// its own copy, then the line saying where it came from. The copy never reaches this fold:
    /// its turns aren't the fork's own [D35].
    pub(crate) fn inherit(&mut self, items: &[Value], forked: &Value) {
        let mut from = Thread::default();
        items.iter().for_each(|item| from.push(item));
        for mut row in from.items.iter().cloned() {
            row["inherited"] = true.into();
            self.changed_items.insert(self.items.len());
            self.items.push(row);
        }
        for mut turn in from.turns {
            turn["inherited"] = true.into();
            self.changed_turns.insert(self.turns.len());
            self.turns.push(turn);
        }
        self.work.extend(from.work);
        self.break_group();
        self.add(
            json!({"kind": "forked", "source": forked["source"], "where": forked["where"],
            "summary": forked["summary"], "leftOut": forked["leftOut"]}),
        );
    }

    /// The messages a rewind can go back to, when they changed [D384].
    pub(super) fn send_points(&mut self, out: &mut Value) -> bool {
        let points = self.fold.points();
        let changed = points != self.points;
        if changed {
            out["rewind"] = points.clone().into();
            self.points = points;
        }
        changed
    }

    /// Adds a step's row under the open group, starting one when none is open.
    fn step(&mut self, row: Value) -> usize {
        let Some(o) = self.open.as_mut() else {
            return self.add(row);
        };
        let g = match o.group {
            Some(g) => g,
            None => {
                let id = format!("{}:g{}", o.id, o.groups);
                o.groups += 1;
                let g = self.add_as(
                    json!({"kind": "group", "steps": [], "span": [0, 0]}),
                    Some(id),
                );
                if let Some(o) = self.open.as_mut() {
                    o.group = Some(g);
                }
                g
            }
        };
        let at = self.add(row);
        self.member.insert(at, g);
        self.items[g]["span"] = json!([g as u64 + 2, at as u64 + 1]);
        self.recount(g);
        at
    }

    /// A group's counts per kind, in the order the kinds came. Edits count distinct files [D48].
    pub(super) fn recount(&mut self, g: usize) {
        let last = self.items[g]["span"][1].as_u64().unwrap_or(0) as usize;
        let mut steps: Vec<(String, u64)> = vec![];
        let (mut files, mut unnamed) = (BTreeSet::new(), 0u64);
        for at in g + 1..last.min(self.items.len()) {
            if self.member.get(&at) != Some(&g) {
                continue;
            }
            let row = &self.items[at];
            if row["hidden"] == true {
                continue;
            }
            let kind = match row["kind"].as_str().unwrap_or("") {
                "fileChange" => "edit",
                "childAgent" => "agent",
                _ => row["step"].as_str().unwrap_or("other"),
            };
            match steps.iter_mut().find(|(k, _)| k == kind) {
                Some((_, n)) => *n += 1,
                None => steps.push((kind.into(), 1)),
            }
            if kind == "edit" {
                let changes = row["changes"].as_array().cloned().unwrap_or_default();
                files.extend(
                    changes
                        .iter()
                        .filter_map(|c| c["path"].as_str().map(String::from)),
                );
                unnamed += changes.is_empty() as u64;
            }
        }
        let steps: Vec<Value> = steps
            .into_iter()
            .map(|(kind, n)| {
                let n = if kind == "edit" {
                    files.len() as u64 + unnamed
                } else {
                    n
                };
                json!({"kind": kind, "n": n})
            })
            .collect();
        if steps.is_empty() || self.items[g]["hidden"] == true {
            self.items[g]["hidden"] = steps.is_empty().into();
        }
        self.items[g]["steps"] = steps.into();
        self.changed_items.insert(g);
    }

    pub(super) fn break_group(&mut self) {
        if let Some(o) = self.open.as_mut() {
            o.group = None;
        }
    }
}

/// The newest line that is bold alone (`**Reading the fold**`), as reasoning summaries head their parts.
fn heading(text: &str) -> Option<String> {
    text.lines()
        .rev()
        .map(str::trim)
        .find(|l| l.len() > 4 && l.starts_with("**") && l.ends_with("**"))
        .map(|l| l[2..l.len() - 2].to_string())
}
