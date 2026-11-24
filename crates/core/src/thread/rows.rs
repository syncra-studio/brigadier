//! The thread's rows: what each normalised item adds or changes, and the groups steps make [D48, D65].

use super::Thread;
use serde_json::{Value, json};

impl Thread {
    /// A tool's row by id: in this turn, or a subagent still running from an earlier one.
    pub(super) fn row_of(&self, turn: &str, id: &str) -> Option<usize> {
        let found = self.keys.get(&(turn.to_string(), id.to_string()));
        found.or_else(|| self.children.get(id)).copied()
    }

    fn stopping(&self) -> bool {
        self.fold.turns.first().is_some_and(|t| t.stopping)
    }

    /// The user's Stop ends the limit: its line stays, without its switch [D51]. Said in the
    /// thread too, out of the work fold, like the user's words [D99, D487]: once a turn, and a
    /// worker's Pause says Paused.
    pub(super) fn user_stopped(&mut self, ts: u64) {
        self.end_limit();
        // A Stop that lands after the turn ended stopped none of it: no line.
        let Some(o) = self.open.as_mut().filter(|o| !o.stop.1) else {
            return;
        };
        o.stop.1 = true;
        let Some(reason) = super::turn::stop_line(o.stop.0.as_deref()) else {
            // A rebirth runs from where its cut turn ended, its divider live till the fresh
            // conversation starts [D112, D203]; a model picked mid-turn is no rebirth [D124].
            if !self.fold.switched {
                self.break_group();
                let row = json!({"kind": "compaction", "summary": null, "progress": "running"});
                self.cutting = Some(self.add(row));
            }
            return;
        };
        let ms = ts.saturating_sub(o.started);
        self.kept_row(json!({"kind": "line", "reason": reason, "ms": ms}));
    }

    pub(super) fn content(&mut self, item: &Value, kind: &str, ts: u64) {
        // A worker held before its first turn has no turn yet, and still shows its card [D2028].
        if kind == "note" && matches!(item["event"].as_str(), Some("hold" | "mockup" | "left")) {
            return self.hold(item, ts);
        }
        let Some(turn) = self.turn_id() else {
            return;
        };
        let str_of = |k: &str| item[k].as_str().unwrap_or("").to_string();
        let key = |id: String| (turn.clone(), id);
        // The agent's next output ends a wait on the user [D77].
        if matches!(
            kind,
            "text" | "text_delta" | "reasoning" | "tool" | "tool_done" | "compaction" | "unknown"
        ) {
            self.end_wait(ts);
        }
        // A step after the cut: the carry-on's text is a reply of its own.
        if let (Some(o), "tool" | "compaction") = (self.open.as_mut(), kind) {
            o.joins = None;
        }
        match kind {
            "text" | "text_delta" => self.said(item, kind, ts),
            "reasoning" => {
                let text = str_of("text");
                // A step of its run, as a work log: a thought is one of the group's lines [D752].
                self.step(json!({"kind": "reasoning", "heading": heading(&text), "text": text, "streaming": false}));
            }
            "tool" => {
                let step = str_of("step");
                if let Some(parent) = item["parent"].as_str() {
                    if let Some(at) = self.row_of(&turn, parent)
                        && !step.is_empty()
                    {
                        self.sub_started(at, item, ts);
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
                        "progress": "running", "startedAt": at, "endedAt": null, "answer": null})
                    }
                    // A shell command that writes a file stays its command, opening to its output [D116].
                    "edit" if item["command"].is_null() => {
                        json!({"kind": "fileChange", "changes": item["changes"], "progress": "running"})
                    }
                    _ => {
                        json!({"kind": "tool", "name": item["name"], "input": item["input"], "output": "",
                        "progress": "running", "exitCode": null, "step": step, "startedAt": at, "endedAt": null,
                        "server": item["server"], "description": item["description"], "command": item["command"]})
                    }
                };
                let row = self.asked_first(&turn, &str_of("id"), row);
                let at = self.step(row);
                self.keys.insert(key(str_of("id")), at);
                if step == "agent" {
                    self.children.insert(str_of("id"), at);
                    self.count_helpers(&turn);
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
                        self.sub_done(at, item, ts);
                    }
                    return;
                }
                let Some(at) = self.row_of(&turn, &str_of("id")) else {
                    return;
                };
                if self.children.remove(&str_of("id")).is_some() {
                    self.helper_ended(at, item["at"].as_u64().unwrap_or(ts));
                }
                let stopped = self.stopping() || self.items[at]["progress"] == "cancelled";
                let progress = match item["ok"] == true {
                    true => "done",
                    false if stopped => "cancelled",
                    false => "failed",
                };
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
                        super::subagents::settle(row, progress);
                        // Its end may come twice (its result and its notification): an empty one keeps the
                        // answer. A stopped one's says only that it was stopped.
                        let answer = str_of("output");
                        if !answer.is_empty() && progress != "cancelled" {
                            row["answer"] = answer.into();
                        }
                        if let Some(child) = item["child"].as_str() {
                            row["sessionId"] = child.into();
                        }
                    }
                    _ => {}
                }
                row["progress"] = progress.into();
                self.step_changed(at);
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
                self.wait_on(at, ts, item);
            }
            "approval" => {
                self.break_group();
                let mut request = item["request"].clone();
                // A plan after its review carries the review's line, from the fold [§6].
                let asked = self
                    .fold
                    .turns
                    .first()
                    .and_then(|t| t.asks.get(&str_of("id")));
                if let Some(line) = asked.map(|r| &r["reviewed"]).filter(|l| l.is_string()) {
                    request["reviewed"] = line.clone();
                }
                // A revised plan takes the row of the one sent back: one plan card, updated [D401].
                let revised = (request["action"] == "plan")
                    .then(|| self.revising.take())
                    .flatten();
                let at = match revised {
                    Some(at) => {
                        let row = &mut self.items[at];
                        (row["request"], row["decision"]) = (request, Value::Null);
                        row.as_object_mut().map(|r| r.remove("by"));
                        self.changed_items.insert(at);
                        at
                    }
                    None => {
                        self.add(json!({"kind": "approval", "request": request, "decision": null}))
                    }
                };
                self.wait_on(at, ts, item);
            }
            "resolved" => {
                self.withdraw(&str_of("id"), item["decision"].as_str(), ts);
                self.end_wait(ts);
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
            // A process gone ends its background subagents with it, and no wake can come for them.
            "exited" => {
                self.end_children("failed", ts);
                self.settle_held(false);
            }
            "stopped" => {
                self.end_children("cancelled", ts);
                // Brigadier's own stop for a hand-off leaves a cut waiting on its carry-on.
                self.settle_held(item["by"] != "handoff");
                if let Some(by @ ("user" | "pause" | "rebirth" | "stall")) = item["by"].as_str() {
                    match self.open.as_mut() {
                        Some(o) => _ = o.stop.0.get_or_insert(by.into()),
                        // A worker paused between turns stops only its background jobs: its line, untimed.
                        None if by == "pause" => {
                            self.kept_row(json!({"kind": "line", "reason": "paused", "ms": null}));
                        }
                        None => {}
                    }
                    self.user_stopped(ts);
                }
            }
            // A limit (or a refused resume) is no error of the turn: one row that a switch turns into
            // the switched line in place, as compaction's row changes, never a second row [D51, D132].
            "limited" | "unresumable" => {
                if self.limit_again(item, &turn) {
                    return;
                }
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
                    "reason": if item["credits"] == true { "credits" } else { super::turn::reason(Some(kind)) }, "backend": backend, "account": account,
                    "handoff": false, "automatic": false, "text": item["message"], "resets": item["resets"]}));
                self.limit_row = Some(at);
                self.reset_at = item["resets"].as_u64();
            }
            // Kept out of the work fold: where the model changed shows once the turn is done [D92].
            "rerouted" => {
                self.kept_row(json!({"kind": "line", "reason": "model", "why": "rerouted",
                    "from": item["from"], "to": item["to"]}));
            }
            "denied" => match self.open.as_mut() {
                // None judged it: its agent's own check gave no verdict, and its turn says so [D455].
                Some(o) if item["unchecked"] == true => self.turns[o.at]["unchecked"] = true.into(),
                Some(o) => o.denied += 1,
                None => {}
            },
            // A failed turn: one row at its end, Rust's reason and the CLI's own words; the UI writes the rest and offers Retry [D487, D54].
            "failed" => {
                // A turn its limit ended fails with it: the limit's row says so.
                if self.failed.as_deref() == Some(&turn) || self.limit_of(&turn).is_some() {
                    return;
                }
                self.failed = Some(turn.clone());
                // An agent stopped by its interrupt ends its turn as failed: it is the user's Stop.
                if self.stopping() {
                    return self.user_stopped(ts);
                }
                // A full window carries on in a fresh one, or the loop guard stops it [D88, D144].
                if self.full(item) {
                    return;
                }
                self.break_group();
                let why = item["why"].as_str().unwrap_or("");
                // A passing cause, its row's words; Try again carries it on [D339].
                let cause = json!(Some(why).filter(|w| crate::adapters::temporary(w)));
                let failed = |reason: &str| json!({"kind": "notice", "reason": "failed", "why": reason, "cause": cause, "text": item["message"]});
                self.add(match why {
                    "review" => json!({"kind": "line", "reason": "review-ended"}),
                    "blocked" => {
                        json!({"kind": "notice", "reason": "blocked", "text": item["message"]})
                    }
                    "model" => failed("model-unavailable"),
                    "ended" => failed("ended-for-safety"),
                    "context" => failed("context-full"),
                    _ => failed("turn-failed"),
                });
            }
            // The agent's own sign-in, or a library server's (its key) a session's proxy found ended [D381, wave4 D2043].
            k @ ("sign_in" | "note") if k == "sign_in" || item["event"] == "sign_in" => {
                self.kept_row(json!({"kind": "notice", "reason": "sign-in", "text": item["message"], "plugin": item["server"].as_str().map(crate::library::key)}));
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
                    // Where it summarised: it folds with the steps around it, as a rebirth's does [D92, D170].
                    None => {
                        self.add(
                            json!({"kind": "compaction", "summary": null, "progress": progress}),
                        );
                        self.keys
                            .insert(key("compaction".into()), self.items.len() - 1);
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
            "note" if item["event"] == "switch_failed" => self.switch_failed(item),
            // Send as new [D204]: a row per session started here, intent then result; never sent to the agent.
            "note" if item["event"] == "side" => {
                let id = format!("side:{}", str_of("session"));
                let at = match self.named.get(&id).copied() {
                    Some(at) => at,
                    None => {
                        self.break_group();
                        let at = self.add_as(
                            json!({"kind": "started", "session": item["session"],
                            "state": "starting", "text": item["text"], "title": item["title"],
                            "replay": item["cid"].as_str().is_some_and(|cid| !cid.is_empty())}),
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
                    for k in ["base", "title", "error", "left", "text"] {
                        if k != "text" || item[k].is_string() {
                            row[k] = item[k].clone();
                        }
                    }
                    self.changed_items.insert(at);
                }
            }
            k if k == "image" || (k == "note" && item["event"] == "image") => self.image(item),
            "note" if item["event"] == "worker" => self.team(item, ts),
            "note" if item["event"] == "peer" => self.peer(item),
            "note" if item["event"] == "shell" => self.shell(item),
            "note" if item["event"] == "plan_review" => self.plan_review(item, ts),
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
        let from = Thread::settled(items);
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
    pub(super) fn step(&mut self, row: Value) -> usize {
        // A subagent is its own row, never a step under a group's header [D115].
        let Some(o) = self.open.as_mut().filter(|_| row["kind"] != "childAgent") else {
            self.break_group();
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
        // The turn's latest run: the UI draws it as its live line only, never its count [D230].
        self.items[g]["run"] = true.into();
        let at = self.add(row);
        self.member.insert(at, g);
        self.items[g]["span"] = json!([g as u64 + 2, at as u64 + 1]);
        self.recount(g);
        at
    }

    /// A group's counts per kind, from its member rows; hidden only while all they are is [D752].
    pub(super) fn recount(&mut self, g: usize) {
        let last = self.items[g]["span"][1].as_u64().unwrap_or(0) as usize;
        let members: Vec<usize> = (g + 1..last.min(self.items.len()))
            .filter(|at| self.member.get(at) == Some(&g))
            .collect();
        let steps = super::subagents::counts(members.iter().map(|&at| &self.items[at]));
        let hidden = members.iter().all(|&at| self.items[at]["hidden"] == true);
        self.items[g]["hidden"] = hidden.into();
        self.items[g]["steps"] = steps.into();
        self.changed_items.insert(g);
    }

    /// Whatever shows after a run ends it: from then on it reads as its header [D230].
    pub(super) fn break_group(&mut self) {
        if let Some(g) = self.open.as_mut().and_then(|o| o.group.take()) {
            self.items[g]["run"] = false.into();
            self.changed_items.insert(g);
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
