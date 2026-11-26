//! Inputs: each is logged durably with its command id before it reaches the agent, then marked
//! delivered once written.

use super::{Runner, crash_at, fail, is_full};
use crate::log;
use serde_json::{Value, json};
use std::io::{self, Write};
use std::sync::atomic::Ordering;

impl Runner {
    /// Logs the input durably before anything reaches the agent. Some(reply) means stop here: a
    /// repeat of a known command id, or a refusal.
    pub(super) fn intent(&self, req: &Value) -> Option<Value> {
        let cid = req["cid"].as_str()?;
        let origin = req["origin"].as_str().unwrap_or("");
        // A worker's result names it and how it ended: `result:<how>:<worker>` [D3006]; another
        // session's message names its sender: `peer:<id>` [D2034].
        let named = origin.starts_with("result:") || origin.starts_with("peer:");
        // `summary`: Brigadier's own, like `system`, the turn that writes a renewal's summary.
        if !matches!(origin, "user" | "system" | "summary") && !named {
            return Some(fail(
                "origin must be user, system, a worker's result or another session",
            ));
        }
        let mut cids = self.cids.lock().unwrap();
        if let Some(&delivered) = cids.get(cid) {
            return Some(
                json!({"ok": true, "cid": cid, "dup": true, "result": if delivered { "delivered" } else { "logged" }}),
            );
        }
        let data = json!({"cid": cid, "origin": origin, "text": req["text"], "backend": req["backend"], "retry_of": req["retry_of"], "switch": req["switch"], "parts": req["parts"],
                          "setup": req["setup"], "steer": req["steer"], "control": req["control"], "ack": req["ack"], "review": req["review"], "starts_child": req["op"] == "spawn", "direct": req["direct"]});
        // A control message (an answer, a steer, a stop) was judged on the log at `if_len`: it is
        // claimed only if nothing reached the log since, in the same lock as its intent [D159].
        let appended = {
            let mut log = self.log.lock().unwrap();
            if req["if_len"].as_u64().is_some_and(|len| len != log.len) {
                return Some(fail("changed"));
            }
            log.append(log::INTENT, data.to_string().as_bytes(), true)
        };
        self.disk_full.store(
            appended.as_ref().err().is_some_and(is_full),
            Ordering::Relaxed,
        );
        if let Err(e) = appended {
            return Some(
                json!({"ok": false, "cid": cid, "result": "not_logged", "error": e.to_string(), "disk_full": is_full(&e)}),
            );
        }
        cids.insert(cid.to_string(), false);
        // Drill hook: die between logging and writing to the agent.
        crash_at("after_intent:", cid);
        None
    }

    pub(super) fn delivered(&self, cid: Option<&str>) {
        if let Some(cid) = cid
            && self
                .append(
                    log::DELIVERED,
                    json!({"cid": cid}).to_string().as_bytes(),
                    false,
                )
                .is_ok()
        {
            self.cids.lock().unwrap().insert(cid.to_string(), true);
        }
    }

    /// Marks a written input delivered, unless its agent acks: then only the agent's own reply to
    /// the command id, a later line of its output, says it was applied [D222].
    pub(super) fn written(&self, req: &Value, cid: Option<&str>) -> &'static str {
        if req["ack"] == true {
            return "sent";
        }
        self.delivered(cid);
        "delivered"
    }

    pub(super) fn input(&self, req: &Value) -> Value {
        let _op = self.op.lock().unwrap();
        {
            let slot = self.child.lock().unwrap();
            let Some(c) = slot.as_ref().filter(|c| c.input.is_some() && !c.exited) else {
                return fail("no_child");
            };
            // Bytes made for another child (a handoff happened since) are refused before logging.
            if req["spawn"].as_u64().is_some_and(|s| s != c.spawn) {
                return fail("changed");
            }
        }
        if let Some(reply) = self.intent(req) {
            return reply;
        }
        let cid = req["cid"].as_str();
        let bytes = req["bytes"].as_str().unwrap_or("");
        // Written outside the child lock, so a child that stopped reading can't freeze ping or exit.
        let input = self
            .child
            .lock()
            .unwrap()
            .as_ref()
            .and_then(|c| c.input.as_ref().and_then(|f| f.try_clone().ok()));
        let written = match input {
            Some(mut f) => f.write_all(bytes.as_bytes()).and_then(|_| f.flush()),
            None => Err(io::Error::other("child exited")),
        };
        match written {
            Ok(()) => json!({"ok": true, "cid": cid, "result": self.written(req, cid)}),
            Err(e) => json!({"ok": true, "cid": cid, "result": "logged", "error": e.to_string()}),
        }
    }
}
