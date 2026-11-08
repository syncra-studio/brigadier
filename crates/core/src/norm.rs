//! The pure normaliser: raw frames in, provider-neutral items out. Same frames, same items, so it can
//! be re-run over any old log. Output is untrusted: bad UTF-8 and huge lines become items, never panics.

use crate::adapters::{self, Event};
use brigadier_frames::log::{self, Frame};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;

/// Bumped whenever the items, or the fold over them, would change for the same frames; old
/// checkpoints and `index.db` are then rebuilt.
pub const VERSION: u32 = 4;
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
            log::PTY => emit(self, json!({"kind": "terminal", "bytes": frame.data.len()})),
            log::INTENT => {
                let v = control();
                if let Some(b) = v["backend"].as_str() {
                    self.backend = b.into();
                }
                emit(
                    self,
                    json!({"kind": "input", "cid": v["cid"], "origin": v["origin"], "text": v["text"], "backend": v["backend"], "retry_of": v["retry_of"]}),
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
            items.push(match event {
                Event::TurnStart => json!({"kind": "turn_start"}),
                Event::TurnEnd(ok) => json!({"kind": "turn_end", "ok": ok}),
                Event::Text(t) => json!({"kind": "text", "text": t}),
                Event::Reasoning(t) => json!({"kind": "reasoning", "text": t}),
                Event::ToolStart(t) => json!({"kind": "tool", "id": t.id, "name": t.name,
                    "step": t.step, "input": t.input, "parent": t.parent, "changes": t.changes, "at": t.at}),
                Event::ToolEnd(d) => json!({"kind": "tool_done", "id": d.id, "output": d.output, "ok": d.ok,
                    "exit": d.exit, "changes": d.changes, "child": d.child, "parent": d.parent, "at": d.at}),
                Event::Resume(id) => {
                    if id.is_empty() || self.announced.get(&self.backend) == Some(&id) {
                        continue;
                    }
                    self.announced.insert(self.backend.clone(), id.clone());
                    json!({"kind": "resume_id", "backend": self.backend, "id": id})
                }
                Event::Limited(m) => json!({"kind": "limited", "message": m}),
                Event::SignIn(m) => json!({"kind": "sign_in", "message": m}),
                Event::Question(id, t, options) => {
                    json!({"kind": "question", "id": id, "text": t, "options": options})
                }
                Event::Answer(id, t) => json!({"kind": "answer", "id": id, "text": t}),
                Event::Compaction(progress) => json!({"kind": "compaction", "progress": progress}),
                Event::Usage(u) => json!({"kind": "usage", "usage": u}),
                Event::Unknown(raw) => json!({"kind": "unknown", "raw": raw}),
            });
        }
        items
    }
}
