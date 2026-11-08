//! What reaches a running turn besides a message [D159]: an answer to one of its requests, a steer,
//! a stop. Each goes through the adapter's own channel as an input with a command id, so the host
//! logs it, writes it and marks it delivered as it does a message; one never proven delivered
//! stays uncertain and is never sent again by itself [D60, D82].

use crate::{flag, owner};
use brigadier_core::adapters::{self, Delivery};
use brigadier_core::fold::Fold;
use brigadier_core::{self as core, as_run};
use brigadier_frames::log;
use serde_json::{Value, json};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};
use std::{io, process, thread};

fn refused(error: &str, why: Value) -> Value {
    json!({"ok": false, "result": "refused", "error": error, "why": why})
}

/// Judges the session on its log, asks the adapter how `msg` reaches its agent, and sends that as
/// an input. With `exact`, the host takes it only if nothing reached the log since it was judged,
/// in the same lock as it logs it: an answer can't pass a cancel or another answer [D30, D159].
fn deliver(
    data: &Path,
    id: &str,
    mut req: Value,
    exact: bool,
    judge: impl Fn(&Fold) -> Result<Value, Value>,
) -> io::Result<Value> {
    let spec = core::load(data, id)?;
    for _ in 0..10 {
        let Ok(ping) = owner::call(data, id, json!({"op": "ping"})) else {
            return Ok(refused("not_running", "interrupted".into()));
        };
        let caps = ping["caps"].as_array().cloned().unwrap_or_default();
        if !caps.contains(&"control".into()) {
            return Ok(refused("host_too_old", Value::Null));
        }
        if !ping["child"].is_number() {
            return Ok(refused("not_running", "interrupted".into()));
        }
        if ping["pty"] == true {
            return Ok(refused("terminal", Value::Null));
        }
        let f = core::fold(&spec.dir, true)?;
        let msg = match judge(&f.fold) {
            Ok(msg) => msg,
            Err(refusal) => return Ok(refusal),
        };
        let backend = f.fold.backend.clone();
        let Some(a) = adapters::get(&backend) else {
            return Ok(refused("unknown_backend", backend.into()));
        };
        let run = core::Spec {
            cid: req["cid"].as_str().map(String::from),
            ..as_run(&spec, &f.fold, &backend, None)
        };
        let Delivery::Stdin(bytes) = match a.control(&run, &msg) {
            Ok(d) => d,
            Err(e) => return Ok(refused("unsupported", e.into())),
        };
        if a.acks() {
            req["ack"] = true.into();
        }
        req["op"] = "input".into();
        req["origin"] = "user".into();
        req["backend"] = backend.into();
        req["bytes"] = bytes.into();
        req["spawn"] = ping["spawn"].clone();
        if exact {
            req["if_len"] = ping["len"].clone();
        }
        let reply = owner::call(data, id, req.clone())?;
        if reply["error"] != "changed" {
            let cid = req["cid"].as_str().unwrap_or("");
            return Ok(core::applied(&spec.dir, cid, reply));
        }
        thread::sleep(Duration::from_millis(50));
    }
    Ok(refused("busy", Value::Null))
}

/// `answer <id> <request> allow|allowSession|deny [--reason R]` for an approval, or
/// `answer <id> <request> --answers JSON` for a question: one answer per item, null skipped [D177].
pub fn answer(data: &Path, args: &[String]) -> io::Result<Value> {
    let usage = || io::Error::other(crate::USAGE);
    let (id, request) = (
        args.get(1).ok_or_else(usage)?,
        args.get(2).ok_or_else(usage)?,
    );
    let decision = args.get(3).filter(|d| !d.starts_with("--")).cloned();
    let reason = flag(args, "--reason");
    let answers: Option<Vec<Value>> = match flag(args, "--answers") {
        Some(a) => {
            Some(serde_json::from_str(a).map_err(|e| io::Error::other(format!("--answers: {e}")))?)
        }
        None => None,
    };
    let control = json!({"kind": "answer", "request": request, "decision": decision, "reason": reason, "answers": answers});
    let req = json!({"cid": new_cid(), "control": control});
    deliver(data, id, req, true, |f| {
        let Some(asked) = f.turns.first().and_then(|t| t.asks.get(request.as_str())) else {
            let why = f
                .closed
                .get(request.as_str())
                .map_or("unknown", String::as_str);
            return Err(refused("not_pending", why.into()));
        };
        let wrong = |what: &str| Err(refused("invalid", what.into()));
        match asked["items"].as_array() {
            Some(items) => {
                let fits = answers.as_ref().is_some_and(|a| {
                    a.len() == items.len() && a.iter().all(|x| x.is_string() || x.is_null())
                });
                if !fits || decision.is_some() {
                    return wrong("answers");
                }
            }
            None => match decision.as_deref() {
                Some("allow") => {}
                Some("allowSession") if asked["grant"].is_object() => {}
                // A plan has no deny: the user replies instead [D177].
                Some("deny") if asked["action"] != "plan" => {}
                _ => return wrong("decision"),
            },
        }
        let mut msg = control.clone();
        msg["request"] = asked.clone();
        Ok(msg)
    })
}

/// A plain message while the agent waits on a question: that question's answer, through its
/// control channel, so the agent and the log agree on what's pending. None when no question waits
/// or the agent can't take it there: the message goes as any other [D159, D222].
pub fn reply(data: &Path, id: &str, text: &str, cid: Option<&str>) -> io::Result<Option<Value>> {
    let f = core::fold(&core::session_dir(data, id), true)?;
    let asked = f.fold.turns.first().and_then(|t| {
        let mut questions = t.asks.iter().filter(|(_, r)| r["items"].is_array());
        questions.next().map(|(k, _)| k.clone())
    });
    let Some(request) = asked else {
        return Ok(None);
    };
    let control = json!({"kind": "answer", "request": request, "reply": text});
    let cid = cid.map_or_else(new_cid, String::from);
    let req = json!({"cid": cid, "control": control});
    let reply = deliver(data, id, req, true, |f| {
        match f.turns.first().and_then(|t| t.asks.get(request.as_str())) {
            Some(asked) => {
                let mut msg = control.clone();
                msg["request"] = asked.clone();
                Ok(msg)
            }
            None => Err(refused("not_pending", Value::Null)),
        }
    })?;
    Ok((reply["result"] != "refused").then_some(reply))
}

/// A message into the turn that runs, where the agent can take one [D109, D159].
pub fn steer(data: &Path, id: &str, text: &str, cid: Option<&str>) -> io::Result<Value> {
    let cid = cid.map_or_else(new_cid, String::from);
    let req = json!({"cid": cid, "text": text, "steer": true});
    deliver(data, id, req, false, |f| {
        let running = f.turns.first().is_some_and(|t| t.began);
        let can = adapters::get(&f.backend).is_some_and(|a| a.can().steer);
        match (running, can) {
            (false, _) => Err(refused("not_running", Value::Null)),
            (_, false) => Err(refused("unsupported", Value::Null)),
            _ => Ok(json!({"kind": "steer", "text": text})),
        }
    })
}

/// How long a clean stop may take before the kill (proposed).
const STOP_WAIT: Duration = Duration::from_secs(3);

/// Stops the running turn through the adapter's own stop, the process staying alive. None when it
/// can't or the turn didn't end in time: the caller kills instead [D159].
pub fn interrupt(data: &Path, id: &str) -> io::Result<Option<Value>> {
    let req = json!({"cid": new_cid(), "control": {"kind": "interrupt"}});
    let reply = deliver(data, id, req, false, |f| {
        let can = adapters::get(&f.backend).is_some_and(|a| a.can().stop);
        match !f.turns.is_empty() && can {
            true => Ok(json!({"kind": "interrupt"})),
            false => Err(refused("unsupported", Value::Null)),
        }
    })?;
    if reply["result"] != "delivered" {
        return Ok(None);
    }
    let dir = core::session_dir(data, id);
    let started = Instant::now();
    while started.elapsed() < STOP_WAIT {
        if core::fold(&dir, true)?.fold.turns.is_empty() {
            return Ok(Some(
                json!({"ok": true, "how": "interrupt", "ms": started.elapsed().as_millis() as u64}),
            ));
        }
        thread::sleep(Duration::from_millis(50));
    }
    Ok(None)
}

/// A fresh command id. The daemon sends from many threads of one process: the counter keeps them apart.
pub(super) fn new_cid() -> String {
    static N: AtomicU64 = AtomicU64::new(0);
    let n = N.fetch_add(1, Ordering::Relaxed);
    format!("c{}-{}-{n}", log::now_ms(), process::id())
}

/// The session's permission level, taken at its next turn start [D129, D170].
pub fn level(data: &Path, args: &[String]) -> io::Result<Value> {
    let id = crate::arg(args, 1)?;
    let mut spec = core::load(data, id)?;
    if let Some(want) = args.get(2) {
        let f = core::fold(&spec.dir, true)?;
        let backend = if f.fold.backend.is_empty() {
            &spec.backend
        } else {
            &f.fold.backend
        };
        spec.level = Some(want.clone());
        if let Some(a) = adapters::get(backend) {
            core::level(&spec, a).map_err(io::Error::other)?;
        }
        core::create(data, &spec)?;
    }
    Ok(json!({"ok": true, "level": spec.level}))
}
