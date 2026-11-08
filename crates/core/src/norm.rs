//! The pure normaliser: raw frames in, provider-neutral items out. Same frames, same items, so it can
//! be re-run over any old log. Output is untrusted: bad UTF-8 and huge lines become items, never panics.

use crate::adapters::{self, Event};
use brigadier_frames::log::{self, Frame};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;

/// Bumped whenever the items, or the fold over them, would change for the same frames; old
/// checkpoints and `index.db` are then rebuilt.
pub const VERSION: u32 = 13;
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
}

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
                    json!({"kind": "input", "cid": v["cid"], "origin": v["origin"], "text": v["text"], "backend": v["backend"], "retry_of": v["retry_of"], "switch": v["switch"],
                           "setup": v["setup"], "steer": v["steer"], "control": v["control"], "ack": v["ack"], "starts_child": v["starts_child"]}),
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
                v["kind"] = "note".into();
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
                    let resume = self
                        .announced
                        .get(&self.backend)
                        .cloned()
                        .unwrap_or_default();
                    *self.turns.entry(resume).or_default() += 1;
                    json!({"kind": "turn_start"})
                }
                Event::TurnEnd(ok) => {
                    items.extend(self.counted(adapter));
                    json!({"kind": "turn_end", "ok": ok})
                }
                Event::Text(t) => json!({"kind": "text", "text": t}),
                Event::Reasoning(t) => json!({"kind": "reasoning", "text": t}),
                Event::ToolStart(t) => json!({"kind": "tool", "id": t.id, "name": t.name,
                    "step": t.step, "input": t.input, "parent": t.parent, "changes": t.changes, "at": t.at}),
                Event::ToolEnd(d) => {
                    if d.parent.is_none() && !d.changes.is_empty() {
                        self.edits.push((d.id.clone(), d.changes.clone()));
                    }
                    json!({"kind": "tool_done", "id": d.id, "output": d.output, "ok": d.ok,
                    "exit": d.exit, "changes": d.changes, "child": d.child, "parent": d.parent, "at": d.at})
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
                Event::Approval(a) => json!({"kind": "approval", "id": a["id"], "request": a}),
                Event::Resolved(id) => json!({"kind": "resolved", "id": id}),
                Event::External(path) => json!({"kind": "external", "path": path}),
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
                Event::Usage(u) => json!({"kind": "usage", "usage": u}),
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
