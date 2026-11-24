//! The pure normaliser: raw frames in, provider-neutral items out. Same frames, same items, so it can
//! be re-run over any old log. Output is untrusted: bad UTF-8 and huge lines become items, never panics.

use crate::adapters::{self, Event};
use brigadier_frames::log::{self, Frame};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;

/// Bumped whenever the items, or the fold over them, would change for the same frames; old
/// checkpoints and `index.db` are then rebuilt.
pub const VERSION: u32 = 40;
const MAX_LINE: usize = 8 << 20;

#[derive(Default, Serialize, Deserialize, Clone)]
pub struct Norm {
    pub items: u64,
    pub backend: String,
    /// Partial line per stream, and whether it already overflowed MAX_LINE.
    #[serde(skip)]
    bufs: [Vec<u8>; 2],
    over: [usize; 2],
    announced: BTreeMap<String, String>,
    /// Turns begun per resume id, and this turn's file edits so far: (tool id, its changes).
    turns: BTreeMap<String, u64>,
    edits: Vec<(String, Vec<Value>)>,
    /// Background subagents waiting on their own work, as their agent last listed them.
    #[serde(default)]
    awaiting: Vec<String>,
    /// The last tool call's folder as its CLI said it beside its ask: (call id, folder) [D391].
    #[serde(default)]
    cwd: Option<(String, String)>,
    /// This turn's agent's own safety check gave no verdict: its asks say so [D455].
    #[serde(default)]
    unchecked: bool,
    /// This turn's `show_draft` calls, by id: each shows once, as its card, never as a step.
    #[serde(default)]
    drafts: Vec<String>,
}

/// How a `show_draft` call reads in its reply: the message card's fence, its JSON on one line
/// [D525, D529]. Its info names the tool, so the turn-end counters tell it from a fence draft.
pub const DRAFT: &str = "```brigadier-message show_draft\n";

impl Norm {
    /// True when no partial line is held, so the state is small enough to checkpoint.
    pub fn clean(&self) -> bool {
        self.bufs.iter().all(Vec::is_empty) && self.over == [0, 0]
    }

    pub fn push(&mut self, frame: &Frame, out: &mut Vec<Value>) {
        let control = || serde_json::from_slice::<Value>(&frame.data).unwrap_or(Value::Null);
        let mut emit = |me: &mut Norm, mut item: Value| {
            item["n"] = me.items.into();
            item["f"] = frame.seq.into();
            item["ts"] = frame.ts.into();
            me.items += 1;
            out.push(item);
        };
        match frame.kind {
            log::OUT | log::ERR => {
                let i = (frame.kind == log::ERR) as usize;
                for line in self.lines(i, &frame.data) {
                    for item in self.line_items(i, line) {
                        emit(self, item);
                    }
                }
            }
            // A sign-in's screen: nothing to fold.
            log::PTY => {}
            log::INTENT => {
                let v = control();
                if let Some(b) = v["backend"].as_str() {
                    self.backend = b.into();
                }
                emit(
                    self,
                    json!({"kind": "input", "cid": v["cid"], "origin": v["origin"], "text": v["text"], "parts": v["parts"], "backend": v["backend"], "retry_of": v["retry_of"], "switch": v["switch"],
                           "setup": v["setup"], "steer": v["steer"], "control": v["control"], "ack": v["ack"], "brigade": v["brigade"], "review": v["review"], "starts_child": v["starts_child"], "direct": v["direct"]}),
                );
            }
            log::DELIVERED => emit(self, json!({"kind": "delivered", "cid": control()["cid"]})),
            log::SPAWNED | log::EXITED => {
                // A process boundary ends any partial line the last process left behind.
                for i in 0..2 {
                    if !self.bufs[i].is_empty() || self.over[i] > 0 {
                        let line = if self.over[i] > 0 {
                            Err(std::mem::take(&mut self.over[i]))
                        } else {
                            Ok(std::mem::take(&mut self.bufs[i]))
                        };
                        for item in self.line_items(i, line) {
                            emit(self, item);
                        }
                    }
                }
                let mut v = control();
                if frame.kind == log::SPAWNED {
                    if let Some(b) = v["backend"].as_str() {
                        self.backend = b.into();
                    }
                    v["kind"] = "spawned".into();
                } else {
                    v["kind"] = "exited".into();
                }
                emit(self, v);
            }
            log::STOPPED => emit(self, json!({"kind": "stopped", "by": control()["by"]})),
            log::NOTE => {
                let mut v = control();
                if !v.is_object() {
                    v = json!({"raw": String::from_utf8_lossy(&frame.data)});
                }
                // Past a rewind a CLI may name the same conversation again: that's news.
                if (v["event"] == "rewound" || v["event"] == "forked")
                    && let Some(b) = v["backend"].as_str()
                {
                    self.announced.remove(b);
                    if let Some(moved) = v["moved"].as_str() {
                        self.turns
                            .insert(moved.into(), v["turns"].as_u64().unwrap_or(0));
                    }
                }
                // Brigadier's own card for a browser action, as any agent's approval [D518].
                if v["event"] == "browser" && v["item"].is_object() {
                    v = v["item"].take();
                } else {
                    v["kind"] = "note".into();
                }
                emit(self, v);
            }
            kind => emit(
                self,
                json!({"kind": "unknown_frame", "frame_kind": kind, "bytes": frame.data.len()}),
            ),
        }
    }

    /// Complete lines from this chunk. A line past MAX_LINE comes back as Err(its size), not kept.
    fn lines(&mut self, i: usize, data: &[u8]) -> Vec<Result<Vec<u8>, usize>> {
        let mut lines = vec![];
        let mut rest = data;
        while let Some(at) = rest.iter().position(|&b| b == b'\n') {
            let (head, tail) = rest.split_at(at);
            if self.over[i] == 0 && self.bufs[i].len() + head.len() <= MAX_LINE {
                let mut line = std::mem::take(&mut self.bufs[i]);
                line.extend_from_slice(head);
                lines.push(Ok(line));
            } else {
                lines.push(Err(self.over[i] + self.bufs[i].len() + head.len()));
                self.over[i] = 0;
                self.bufs[i].clear();
            }
            rest = &tail[1..];
        }
        if self.over[i] > 0 || self.bufs[i].len() + rest.len() > MAX_LINE {
            self.over[i] += self.bufs[i].len() + rest.len();
            self.bufs[i].clear();
        } else {
            self.bufs[i].extend_from_slice(rest);
        }
        lines
    }

    fn line_items(&mut self, i: usize, line: Result<Vec<u8>, usize>) -> Vec<Value> {
        let line = match line {
            Ok(line) => line,
            Err(bytes) => return vec![json!({"kind": "unknown", "oversize": bytes})],
        };
        let text = match String::from_utf8(line) {
            Ok(t) => t,
            Err(e) => {
                return vec![
                    json!({"kind": "unknown", "invalid_utf8": true, "raw": String::from_utf8_lossy(e.as_bytes())}),
                ];
            }
        };
        if text.trim().is_empty() {
            return vec![];
        }
        if i == 1 {
            return vec![json!({"kind": "stderr", "text": text})];
        }
        let Some(adapter) = adapters::get(&self.backend) else {
            return vec![json!({"kind": "unknown", "raw": text})];
        };
        let mut items = vec![];
        for event in adapter.parse(&text) {
            let item = match event {
                Event::TurnStart => {
                    self.edits.clear();
                    self.drafts.clear();
                    let resume = self
                        .announced
                        .get(&self.backend)
                        .cloned()
                        .unwrap_or_default();
                    *self.turns.entry(resume).or_default() += 1;
                    json!({"kind": "turn_start"})
                }
                Event::TurnEnd(ok) => {
                    self.unchecked = false;
                    items.extend(self.counted(adapter));
                    json!({"kind": "turn_end", "ok": ok})
                }
                Event::Text(t) => json!({"kind": "text", "text": t}),
                Event::TextDelta(t) => json!({"kind": "text_delta", "text": t}),
                Event::Reasoning(t) => json!({"kind": "reasoning", "text": t}),
                // Brigadier's own `show_draft` as the card in the reply (Codex starts it twice).
                Event::ToolStart(t)
                    if t.server.as_deref() == Some("brigadier") && t.name == "show_draft" =>
                {
                    if self.drafts.contains(&t.id) {
                        continue;
                    }
                    self.drafts.push(t.id);
                    let args: Value = serde_json::from_str(&t.input).unwrap_or_default();
                    let args = match args.as_str() {
                        Some(s) => serde_json::from_str(s).unwrap_or_default(),
                        None => args,
                    };
                    json!({"kind": "text", "text": format!("{DRAFT}{args}\n```")})
                }
                Event::ToolEnd(d) if self.drafts.contains(&d.id) => continue,
                Event::ToolStart(mut t) => {
                    // A worker's plugin call through the relay is that plugin's step [D567, D768].
                    if t.step == "run"
                        && let Some((server, tool, args)) = adapters::relay_call(&t.input)
                    {
                        (t.step, t.name, t.server, t.input) = ("other", tool, Some(server), args);
                        t.command.clear();
                    }
                    json!({"kind": "tool", "id": t.id, "name": t.name,
                    "step": t.step, "input": t.input, "parent": t.parent, "changes": t.changes, "at": t.at, "server": t.server.as_deref().map(crate::library::plain), "description": t.description,
                    "command": (!t.command.is_empty()).then_some(t.command)})
                }
                Event::Background(task, label) => {
                    json!({"kind": "background", "task": task, "label": label})
                }
                Event::Awaiting(all, ids) => {
                    self.awaiting = ids;
                    json!({"kind": "pending", "ids": all})
                }
                // A subagent's run that ended while it waits on its own work: it runs again [D67].
                Event::ToolEnd(d)
                    if d.child.as_ref().is_some_and(|c| self.awaiting.contains(c)) =>
                {
                    continue;
                }
                Event::ToolEnd(d) => {
                    if d.parent.is_none() && !d.changes.is_empty() {
                        self.edits.push((d.id.clone(), d.changes.clone()));
                    }
                    json!({"kind": "tool_done", "id": d.id, "output": d.output, "ok": d.ok,
                    "exit": d.exit, "cut": d.cut, "changes": d.changes, "child": d.child, "parent": d.parent, "at": d.at})
                }
                Event::Resume(id) => {
                    if id.is_empty() || self.announced.get(&self.backend) == Some(&id) {
                        continue;
                    }
                    self.announced.insert(self.backend.clone(), id.clone());
                    json!({"kind": "resume_id", "backend": self.backend, "id": id})
                }
                Event::Limited(m, resets) => {
                    json!({"kind": "limited", "message": m, "resets": resets})
                }
                // The old app's words for it: nothing to wait for, so no time [D411].
                Event::OutOfCredits => json!({"kind": "limited", "credits": true,
                    "message": "Out of credits. Continue after credits are available."}),
                Event::Limits(l) => json!({"kind": "limits", "limits": l}),
                Event::SignIn(m) => json!({"kind": "sign_in", "message": m}),
                Event::Unresumable(m) => json!({"kind": "unresumable", "message": m}),
                // A question row shows its first item; the request goes with it whole [D177, D209].
                Event::Question(q) => {
                    let first = &q["items"][0];
                    let options: Vec<&Value> = first["options"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .map(|o| &o["label"])
                        .collect();
                    json!({"kind": "question", "id": q["id"], "text": first["text"], "options": options, "request": q})
                }
                // shortcut: one folder kept, so asks of parallel calls carry none and ask; keep one per call if that shows.
                Event::Cwd(tool, cwd) => {
                    self.cwd = Some((tool, cwd));
                    continue;
                }
                Event::Approval(mut a) => {
                    if let Some((_, cwd)) = self.cwd.take().filter(|(t, _)| a["tool"] == t.as_str())
                    {
                        a["cli"]["cwd"] = cwd.into();
                    }
                    if self.unchecked {
                        a["reason"] =
                            format!("{}'s safety check was unavailable", adapter.label()).into();
                    }
                    json!({"kind": "approval", "id": a["id"], "request": a})
                }
                Event::Resolved(id) => json!({"kind": "resolved", "id": id}),
                Event::External(path) => json!({"kind": "external", "path": path}),
                Event::Image(mut image) => {
                    image["kind"] = "image".into();
                    image
                }
                Event::Decided(id, allowed) => {
                    let decision = if allowed { "approved" } else { "denied" };
                    json!({"kind": "resolved", "id": id, "decision": decision})
                }
                Event::Reply { id, error, level } => {
                    json!({"kind": "reply", "id": id, "error": error, "level": level})
                }
                Event::Level(level) => json!({"kind": "level", "level": level}),
                Event::Answer(id, t) => json!({"kind": "answer", "id": id, "text": t}),
                Event::Compaction(progress) => json!({"kind": "compaction", "progress": progress}),
                Event::Commands(list) => {
                    json!({"kind": "commands", "backend": self.backend, "list": list})
                }
                Event::Usage(u) => json!({"kind": "usage", "usage": u}),
                Event::Context(used, window, opens) => {
                    json!({"kind": "context", "used": used, "window": window, "opens": opens})
                }
                Event::Plan(steps) => json!({"kind": "plan", "steps": steps}),
                Event::Mark { start, end } => json!({"kind": "mark", "start": start, "end": end}),
                Event::Retrying { attempt, max, at } => {
                    json!({"kind": "retrying", "attempt": attempt, "max": max, "at": at})
                }
                Event::Rerouted(from, to) => json!({"kind": "rerouted", "from": from, "to": to}),
                Event::Model(id) => json!({"kind": "model", "backend": self.backend, "id": id}),
                Event::Failed(why, m) => json!({"kind": "failed", "why": why, "message": m}),
                Event::Checking(on) => json!({"kind": "checking", "on": on}),
                Event::Denied => json!({"kind": "denied"}),
                Event::Unchecked => {
                    self.unchecked = true;
                    json!({"kind": "denied", "unchecked": true})
                }
                Event::Unknown(raw) => json!({"kind": "unknown", "raw": raw}),
            };
            items.push(item);
        }
        items
    }

    /// This turn's edits again, each file with its diff from the backend's own record, only when
    /// the record's edits match these one-to-one by order and file; otherwise none [D74, D83, D95].
    fn counted(&mut self, adapter: &dyn adapters::Adapter) -> Vec<Value> {
        let edits = std::mem::take(&mut self.edits);
        let resume = self
            .announced
            .get(&self.backend)
            .cloned()
            .unwrap_or_default();
        let turn = self.turns.get(&resume).map_or(0, |n| n.saturating_sub(1));
        let theirs = match edits.is_empty() {
            true => None,
            false => adapter.diffs(&resume, turn),
        };
        let Some(theirs) = theirs.filter(|t| t.len() == edits.len()) else {
            return vec![];
        };
        let mut out = vec![];
        for ((id, changes), files) in edits.iter().zip(&theirs) {
            if changes.len() != files.len() {
                return vec![];
            }
            let mut counted = vec![];
            for c in changes {
                let path = c["path"].as_str().unwrap_or("");
                let Some((_, diff)) = files.iter().find(|(p, _)| p == path) else {
                    return vec![];
                };
                let (added, removed) = adapters::counts(diff);
                let how = c["change"].as_str().unwrap_or("");
                counted.push(adapters::change(
                    path,
                    how,
                    Some(diff.clone()),
                    Some(added),
                    Some(removed),
                ));
            }
            out.push(json!({"kind": "changes", "id": id, "changes": counted}));
        }
        out
    }
}
