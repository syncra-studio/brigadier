//! The thread's requests [D159, D177]: their rows, the ones still waiting on the user (sent beside
//! the rows, so a reconnect gets them again [D30, D40, D71]), and the answers that close them.

use super::Thread;
use serde_json::{Value, json};

impl Thread {
    /// A request's row starts waiting, and its turn's wait starts [D77]. A question stays out of
    /// the work fold with its answer [D99]; an approval folds with the work it allowed [D118]. One
    /// the parent agent answers is a quiet step in the fold instead, with no card and no wait for
    /// the user [D119, D122].
    pub(super) fn wait_on(&mut self, at: usize, ts: u64, item: &Value) {
        let to = self.fold.to(item);
        self.pending.push(at);
        self.pending_changed = true;
        // A repeat Brigadier answers itself never shows: its step runs on as if never asked [D391].
        if to == Some("brigadier") {
            self.items[at]["to"] = "brigadier".into();
            self.items[at]["hidden"] = true.into();
            return self.resume_group();
        }
        self.approval_tool(at, None);
        self.agent_waits(at, true);
        if let Some(to) = to {
            self.items[at]["to"] = to.into();
            return;
        }
        self.user_waits(at, ts);
    }

    /// The request at row `at` waits on the user: a question stays out of the fold, and its turn
    /// waits from `ts`. Also a sub-session's ask its boss passed to the user [D189].
    pub(super) fn user_waits(&mut self, at: usize, ts: u64) {
        if let Some(r) = self.items[at].as_object_mut() {
            r.remove("to");
        }
        self.changed_items.insert(at);
        let question = self.items[at]["kind"] == "question";
        let turn = self.items[at]["turnId"].as_str().unwrap_or("").to_string();
        // Or the turn held for the subagent that asks: it waits on the user as a running one [D128].
        let held = self.held.get_mut(&turn).map(|(o, _)| o);
        if let Some(o) = self.open.as_mut().or(held) {
            if question {
                o.kept.push(at as u64 + 1);
            }
            if o.wait.is_none() {
                o.wait = Some(ts);
                self.turns[o.at]["waitingSince"] = ts.into();
                self.changed_turns.insert(o.at);
            }
        }
    }

    /// A worker of the running or newest held block waits on the user: the block waits from `ts`.
    pub(super) fn worker_waits(&mut self, ts: u64) {
        let held = self.held.values_mut().map(|(o, _)| o).max_by_key(|o| o.at);
        if let Some(o) = self.open.as_mut().or(held).filter(|o| o.wait.is_none()) {
            o.wait = Some(ts);
            self.turns[o.at]["waitingSince"] = ts.into();
            self.changed_turns.insert(o.at);
        }
    }

    /// A plan's review moved on (fold `plan.rs`): its card names its reviewer, or the plan goes to
    /// its answerer with the review's line [§6].
    pub(super) fn plan_review(&mut self, item: &Value, ts: u64) {
        let id = item["id"].as_str().unwrap_or("");
        let r = self
            .fold
            .turns
            .first()
            .and_then(|t| t.asks.get(id))
            .cloned();
        let at = (self.pending.iter()).find(|&&at| self.items[at]["request"]["id"] == id);
        let (Some(r), Some(&at)) = (r, at) else {
            return;
        };
        for k in ["review", "reviewed"] {
            self.items[at]["request"][k] = r[k].clone();
        }
        self.pending_changed = true;
        self.changed_items.insert(at);
        match r["to"].as_str() {
            Some("review") => {}
            Some(to) => self.items[at]["to"] = to.into(),
            None => self.user_waits(at, ts),
        }
    }

    /// A worker's routing hold [D2028, D342]: Rust's question card for the user, as a sub-session's
    /// passed ask is, closed by the user's answer.
    pub(super) fn hold(&mut self, item: &Value, ts: u64) {
        // A mockup's one row in its lead's chat, out of the turn's fold; the app reads its moment
        // from the mockup [D560]. And each send of the user's notes: "You → mockup · 3 notes on A
        // and B · round 2 drawing".
        if matches!(item["phase"].as_str(), Some("started" | "notes")) {
            self.kept_row(
                json!({"kind": "mockup", "worker": item["id"], "count": item["count"],
                "on": item["on"], "round": item["round"]}),
            );
            return;
        }
        let r = &item["request"];
        if item["phase"] == "asked" {
            let q = &r["items"][0];
            let at = self.add(json!({"kind": "question", "question": q["text"],
                "options": q["options"].as_array().cloned().unwrap_or_default(), "answer": null, "request": r, "held": true,
                "offer": item["event"] == "mockup"}));
            self.pending.push(at);
            self.pending_changed = true;
            return self.user_waits(at, ts);
        }
        if let Some(at) = self.unwait(item["id"].as_str().unwrap_or("")) {
            self.items[at]["answer"] = item["choice"].clone();
            self.changed_items.insert(at);
            self.end_wait(ts);
        }
    }

    /// The turn's wait on the user ends once nothing waits on them any more [D128]; so does a held
    /// turn's, whose subagent asked.
    pub(super) fn end_wait(&mut self, ts: u64) {
        // Only a worker that still holds the block: a Stop or a failure lets go of them all [D3011].
        if self.asking.iter().any(|w| self.fold.workers.contains(w))
            || (self.pending.iter()).any(|&at| self.items[at]["to"].is_null())
        {
            return;
        }
        let held = self.held.values_mut().map(|(o, _)| o);
        for o in self.open.iter_mut().chain(held) {
            if let Some(since) = o.wait.take() {
                o.waited += ts.saturating_sub(since);
                let turn = &mut self.turns[o.at];
                turn["waitingSince"] = Value::Null;
                turn["waitedMs"] = o.waited.into();
                self.changed_turns.insert(o.at);
            }
        }
    }

    /// The waiting request with this id (or row) stops waiting; its row.
    pub(super) fn unwait(&mut self, id: &str) -> Option<usize> {
        let k = (self.pending.iter()).position(|&at| self.items[at]["request"]["id"] == id)?;
        self.pending_changed = true;
        let at = self.pending.remove(k);
        self.agent_waits(at, false);
        Some(at)
    }

    /// A subagent waits on the user while any request for it, or one it asks (`parent` names its
    /// call), waits; then it works on. Its step that asks waits with it, as the thread's do [D141].
    fn agent_waits(&mut self, at: usize, waits: bool) {
        let Some(a) = self.agent_of(at) else {
            return;
        };
        let (from, to) = if waits {
            ("running", "pending")
        } else {
            ("pending", "running")
        };
        let step = format!(
            "{}:{}",
            self.items[a]["id"].as_str().unwrap_or(""),
            self.items[at]["request"]["tool"].as_str().unwrap_or("")
        );
        let mut log = self.items[a]["log"].as_array_mut().into_iter().flatten();
        if let Some(s) = log.find(|s| s["id"] == step.as_str() && s["progress"] == from) {
            s["progress"] = to.into();
            self.changed_items.insert(a);
        }
        if !waits && (self.pending.iter()).any(|&p| self.agent_of(p) == Some(a)) {
            return;
        }
        if self.items[a]["progress"] == from {
            self.items[a]["progress"] = to.into();
            self.changed_items.insert(a);
        }
    }

    /// The subagent row a request at row `at` is for, or asked inside.
    fn agent_of(&self, at: usize) -> Option<usize> {
        let row = &self.items[at];
        let r = &row["request"];
        let id = r["parent"].as_str().or(r["tool"].as_str())?;
        let turn = row["turnId"].as_str().unwrap_or("");
        // Or one of its own steps asks (Claude names the step, not the subagent).
        let step = |c: usize| format!("{}:{id}", self.items[c]["id"].as_str().unwrap_or(""));
        let in_log = |c: &usize| {
            (self.items[*c]["log"].as_array().into_iter().flatten())
                .any(|s| s["id"] == step(*c).as_str())
        };
        (self
            .row_of(turn, id)
            .or_else(|| self.children.values().copied().find(in_log)))
        .filter(|&a| self.items[a]["kind"] == "childAgent")
    }

    pub(super) fn unwait_row(&mut self, at: usize) {
        if let Some(id) = self.items[at]["request"]["id"].as_str().map(String::from) {
            self.unwait(&id);
        }
    }

    /// An answer logged: its request stops waiting at once; its row shows it once delivered.
    pub(super) fn control(&mut self, item: &Value, ts: u64) {
        let c = &item["control"];
        if item["ack"] == true {
            self.acking
                .insert(item["cid"].as_str().unwrap_or("").to_string());
        }
        if c["kind"] == "interrupt"
            && let Some(o) = self.open.as_mut()
        {
            o.stop.0 = Some(c["by"].as_str().unwrap_or("user").into());
        }
        if c["kind"] != "answer" {
            return;
        }
        if let Some(at) = self.unwait(c["request"].as_str().unwrap_or("")) {
            self.withdraw_row(at);
            let cid = item["cid"].as_str().unwrap_or("").to_string();
            // When it was given: an allowed subagent starts then.
            let mut c = c.clone();
            c["at"] = ts.into();
            self.claims.insert(cid, (at, c));
            self.end_wait(ts);
        }
    }

    /// A delivered answer: an approval's decision, or a question's answers (skipped ones left out).
    pub(super) fn delivered(&mut self, cid: &str) {
        let Some((at, c)) = self.claims.remove(cid) else {
            return;
        };
        let row = &mut self.items[at];
        if row["kind"] == "approval" {
            // A reply to a plan is its deny with words: the agent plans on [D177].
            row["decision"] = if c["decision"] == "deny" || c["reply"].is_string() {
                "denied"
            } else {
                "approved"
            }
            .into();
        } else {
            let answers = c["answers"].as_array().cloned().unwrap_or_default();
            let given: Vec<&str> = answers.iter().filter_map(Value::as_str).collect();
            // A plain message that answered the round shows as its answer.
            row["answer"] = c["reply"]
                .as_str()
                .map_or(given.join("\n"), String::from)
                .into();
            row["answers"] = answers.into();
            row["withdrawn"] = false.into();
            if let Some(o) = self.open.as_mut().filter(|o| o.asked == Some(at)) {
                o.asked = None;
            }
        }
        // A plan sent back keeps its card while its agent revises it [D401].
        if row["kind"] == "approval"
            && row["request"]["action"] == "plan"
            && row["decision"] == "denied"
        {
            self.revising = Some(at);
            self.pending_changed = true;
        }
        let row = &mut self.items[at];
        // Who answered, when not the user: a plan the review sent back says so [D394].
        if matches!(c["by"].as_str(), Some("parent" | "review")) {
            row["by"] = c["by"].clone();
        }
        self.changed_items.insert(at);
        if row["decision"] == "approved" {
            self.approval_tool(at, Some(c["at"].as_u64().unwrap_or_default()));
        }
        // Its words show: the reviewer's as its peer row [D3014], the user's as their message, a
        // reply or a plan's deny with words [D400].
        let plan = self.items[at]["request"]["action"] == "plan";
        let reply = (c["reply"].as_str())
            .or(c["reason"].as_str().filter(|_| plan))
            .filter(|_| self.items[at]["kind"] == "approval");
        if let Some(text) = reply.filter(|_| c["by"] != "parent") {
            let (ts, cid) = (c["at"].as_u64().unwrap_or_default(), Value::from(cid));
            let row = match c["by"] == "review" {
                true => Self::peer_item(
                    self.fold.plans.now["by"].as_str().unwrap_or(""),
                    text,
                    ts,
                    &cid,
                ),
                false => {
                    json!({"kind": "message", "role": "user", "text": text, "streaming": false,
                    "origin": "user", "sentAt": ts, "cid": cid})
                }
            };
            self.break_group();
            self.add(row);
        }
    }

    /// The CLI cleared a request [D77]; or another client, or the CLI's own rule, decided it.
    pub(super) fn withdraw(&mut self, id: &str, decision: Option<&str>, ts: u64) {
        if let Some(at) = self.unwait(id) {
            self.withdraw_row(at);
            if let Some(d) = decision.filter(|_| self.items[at]["kind"] == "approval") {
                self.items[at]["decision"] = d.into();
                if d == "approved" {
                    self.approval_tool(at, Some(ts));
                }
            }
        }
    }

    /// A tool awaiting permission has not run; only an approval (`allowed`, when) makes its work
    /// visible again. A subagent starts then, so its clock counts from then.
    fn approval_tool(&mut self, at: usize, allowed: Option<u64>) {
        let row = &self.items[at];
        let Some(tool) = row["request"]["tool"]
            .as_str()
            .filter(|_| row["kind"] == "approval")
        else {
            return;
        };
        let key = (
            row["turnId"].as_str().unwrap_or("").to_string(),
            tool.to_string(),
        );
        let Some(&tool) = self.keys.get(&key) else {
            return;
        };
        // A claim kept from before its time was noted has none: its start stays.
        if let Some(ts) = allowed.filter(|&t| t > 0 && self.items[tool]["kind"] == "childAgent") {
            self.items[tool]["startedAt"] = ts.into();
        }
        // The user's allowing goes inside the step it allowed; a parent's keeps its row [D122, D173],
        // and its step, started before the ask, moves below it once allowed, so the thread reads in order.
        let inside = self.items[at]["to"] != "parent" && self.items[tool]["kind"] != "childAgent";
        if let (Some(_), true) = (allowed, inside) {
            self.items[tool]["approval"] = self.items[at]["request"].clone();
            self.items[at]["hidden"] = true.into();
            self.changed_items.insert(at);
            self.resume_group();
        } else if allowed.is_some() && tool < at {
            self.break_group();
            return self.move_down(tool);
        }
        self.items[tool]["hidden"] = allowed.is_none().into();
        self.step_changed(tool);
    }

    /// A step that starts after the ask that allowed it, as Codex's do, takes it in [D173].
    pub(super) fn asked_first(&mut self, turn: &str, id: &str, mut row: Value) -> Value {
        let from = self.open.as_ref().map_or(self.items.len(), |o| o.from);
        let ask = (self.items.range(from..self.items.len())).rposition(|r| {
            r["kind"] == "approval" && r["turnId"] == turn && r["request"]["tool"] == id
        });
        let ask = ask.map(|a| from + a).filter(|&a| {
            let r = &self.items[a];
            r["decision"] == "approved" && r["to"] != "parent" && r["hidden"] != true
        });
        if let Some(a) = ask {
            row["approval"] = self.items[a]["request"].clone();
            self.items[a]["hidden"] = true.into();
            self.changed_items.insert(a);
            self.resume_group();
        }
        row
    }

    /// The turn's last group takes steps again when nothing shows after it, as when the ask that
    /// broke it went inside its step: no two groups side by side for one run of steps.
    fn resume_group(&mut self) {
        let Some(o) = self.open.as_ref().filter(|o| o.group.is_none()) else {
            return;
        };
        let g = (self.items.range(o.from..self.items.len()))
            .rposition(|r| r["kind"] == "group")
            .map(|g| o.from + g);
        let quiet = |i: usize| {
            let r = &self.items[i];
            r["hidden"] == true || r["kind"] == "reasoning" || self.member.get(&i) == g.as_ref()
        };
        let g = g.filter(|&g| (g + 1..self.items.len()).all(quiet));
        if let (Some(o), Some(g)) = (self.open.as_mut(), g) {
            o.group = Some(g);
            self.items[g]["run"] = true.into();
            self.changed_items.insert(g);
        }
    }

    /// A step's row changed: its group counts it again.
    pub(super) fn step_changed(&mut self, at: usize) {
        self.changed_items.insert(at);
        if let Some(&g) = self.member.get(&at) {
            self.recount(g);
        }
    }

    fn withdraw_row(&mut self, at: usize) {
        if self.items[at]["kind"] == "approval" {
            self.items[at]["decision"] = "withdrawn".into();
        } else {
            self.items[at]["withdrawn"] = true.into();
            if let Some(o) = self.open.as_mut().filter(|o| o.asked == Some(at)) {
                o.asked = None;
            }
        }
        self.changed_items.insert(at);
    }

    pub(super) fn withdraw_all(&mut self) {
        let ids: Vec<String> = (self.pending.iter())
            // A mockup offer outlives its turn: a later pick comes as a message [D2055].
            .filter(|&&at| self.items[at]["offer"] != true)
            .filter_map(|&at| self.items[at]["request"]["id"].as_str().map(String::from))
            .collect();
        ids.iter().for_each(|id| self.withdraw(id, None, 0));
    }

    /// What still waits on the user, oldest first, in D177's shapes.
    pub(super) fn requests(&self) -> Value {
        let of = |kind: &str| -> Vec<Value> {
            (self.pending.iter())
                // A plan its review holds shows, saying so, though it's nobody's to answer [§6].
                .filter(|&&at| self.items[at]["kind"] == kind)
                .filter(|&&at| matches!(self.items[at]["to"].as_str(), None | Some("review")))
                .map(|&at| {
                    let mut r = self.items[at]["request"].clone();
                    // The card names the subagent that asks [w43 #16].
                    if let Some(a) = self.agent_of(at) {
                        r["agent"] = self.items[a]["title"].clone();
                    }
                    r
                })
                .collect()
        };
        let mut approvals = of("approval");
        // The plan its agent revises, nobody's to answer, till its next plan takes the card [D401].
        let revising = (self.revising.iter())
            .filter(|&&at| matches!(self.items[at]["to"].as_str(), None | Some("review")));
        approvals.extend(revising.map(|&at| {
            let mut r = self.items[at]["request"].clone();
            r["revising"] = true.into();
            r
        }));
        json!({"approvals": approvals, "questions": of("question")})
    }
}
