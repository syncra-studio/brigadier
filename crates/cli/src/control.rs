//! What reaches a running turn besides a message [D159]: an answer to one of its requests, a steer,
//! a stop. Each goes through the adapter's own channel as an input with a command id, so the host
//! logs it, writes it and marks it delivered as it does a message; one never proven delivered
//! stays uncertain and is never sent again by itself [D60, D82].

use crate::{flag, owner};
use brigadier_core::adapters::{self, Delivery};
use brigadier_core::fold::Fold;
use brigadier_core::{self as core, as_run};
use brigadier_frames::{log, procs};
use serde_json::{Value, json};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};
use std::{io, process, thread};

pub(crate) fn refused(error: &str, why: Value) -> Value {
    json!({"ok": false, "result": "refused", "error": error, "why": why})
}

/// Judges the session on its log, asks the adapter how `msg` reaches its agent, and sends that as
/// an input. With `exact`, the host takes it only if nothing reached the log since it was judged,
/// in the same lock as it logs it: an answer can't pass a cancel or another answer [D30, D159].
pub(crate) fn deliver(
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
            // A steer's images, in the agent's own form [D2008].
            images: (msg["images"].as_array().into_iter().flatten())
                .filter_map(|p| p.as_str().map(Into::into))
                .collect(),
            commands: msg["commands"].as_array().cloned().unwrap_or_default(),
            ..as_run(&spec, &f.fold, &backend, None)
        };
        let sent = match msg["kind"] == "command" {
            true => a.command(&run, msg["name"].as_str().unwrap_or("")),
            false => a.control(&run, &msg),
        };
        let Delivery::Stdin(bytes) = match sent {
            Ok(d) => d,
            Err(e) => return Ok(refused("unsupported", e.into())),
        };
        if a.acks() {
            req["ack"] = true.into();
        }
        req["op"] = "input".into();
        if req["origin"].is_null() {
            req["origin"] = "user".into();
        }
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
    // A question a Brigade's session sent its boss, passed to the user: back to its wait [D189].
    if let Some(mid) = request.strip_prefix("peer-") {
        return crate::workers::user_answer(data, id, mid, answers.as_deref().unwrap_or_default());
    }
    let control = json!({"kind": "answer", "request": request, "decision": decision, "reason": reason, "answers": answers});
    answered(data, id, request, control)
}

/// A worker's parent answers its approval, as the parent's (`by`), never the user's [D131].
pub fn answer_as(
    data: &Path,
    id: &str,
    request: &str,
    decision: &str,
    reason: Option<&str>,
    by: &str,
) -> io::Result<Option<Value>> {
    let control = json!({"kind": "answer", "request": request, "decision": decision, "reason": reason, "by": by});
    answered(data, id, request, control).map(Some)
}

fn answered(data: &Path, id: &str, request: &str, control: Value) -> io::Result<Value> {
    let (decision, answers) = (
        control["decision"].as_str().map(String::from),
        control["answers"].as_array().cloned(),
    );
    let req = json!({"cid": new_cid(), "control": control});
    deliver(data, id, req, true, |f| {
        let Some(asked) = f.turns.first().and_then(|t| t.asks.get(request)) else {
            let why = f.closed.get(request).map_or("unknown", String::as_str);
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
pub fn reply(
    data: &Path,
    id: &str,
    text: &str,
    cid: Option<&str>,
    by: Option<&str>,
) -> io::Result<Option<Value>> {
    let f = core::fold(&core::session_dir(data, id), true)?;
    let asked = f.fold.turns.first().and_then(|t| {
        let mut questions = t.asks.iter().filter(|(_, r)| r["items"].is_array());
        questions.next().map(|(k, _)| k.clone())
    });
    let Some(request) = asked else {
        return Ok(None);
    };
    let control = json!({"kind": "answer", "request": request, "reply": text, "by": by});
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
pub fn steer(
    data: &Path,
    id: &str,
    text: &str,
    parts: &Value,
    cid: Option<&str>,
) -> io::Result<Value> {
    steer_as(data, id, text, parts, cid, "user")
}

/// The same from `origin`: the user, or another session's `peer:<id>` [D2034].
pub fn steer_as(
    data: &Path,
    id: &str,
    text: &str,
    parts: &Value,
    cid: Option<&str>,
    origin: &str,
) -> io::Result<Value> {
    let cid = cid.map_or_else(new_cid, String::from);
    let spec = core::load(data, id)?;
    core::message::take(data, &spec.dir, parts, None)?;
    let msg = core::message::compose(&spec, text, parts.clone())?;
    let mut req = json!({"cid": cid, "text": text, "steer": true, "origin": origin});
    if !parts.is_null() {
        req["parts"] = msg.parts;
    }
    let images = msg.images;
    deliver(data, id, req, false, |f| {
        let running = f.turns.first().is_some_and(|t| t.began);
        let can = adapters::get(&f.backend).is_some_and(|a| a.can().steer);
        match (running, can) {
            (false, _) => Err(refused("not_running", Value::Null)),
            (_, false) => Err(refused("unsupported", Value::Null)),
            _ => Ok(
                json!({"kind": "steer", "text": msg.agent, "images": images, "commands": msg.commands}),
            ),
        }
    })
}

/// How long a clean stop may take before the kill (proposed).
const STOP_WAIT: Duration = Duration::from_secs(3);
/// How long the command an agent's own stop ended gets to go.
const COMMAND_WAIT: Duration = Duration::from_secs(1);

/// Whether what's below the child and started since `since` (ms) outlives this wait. An agent's
/// stop can end its turn and leave the command it was running [D222]; the old app closed the CLI.
fn command_left(dir: &Path, since: u64) -> io::Result<bool> {
    let started = Instant::now();
    loop {
        let fold = core::fold(dir, true)?.fold;
        let child = (fold.child.as_ref())
            .filter(|c| !c.exited)
            .and_then(|c| procs::same(c.pid, c.start_us));
        let left = child.is_some_and(|c| {
            procs::descendants(&procs::all(), c.pid)
                .iter()
                .any(|p| p.start_us / 1000 >= since)
        });
        if !left || started.elapsed() >= COMMAND_WAIT {
            return Ok(left);
        }
        thread::sleep(Duration::from_millis(50));
    }
}

/// Stops the running turn through the adapter's own stop, the process staying alive. None when it
/// can't, the turn didn't end in time, or the turn's command outlived it: the caller kills
/// instead, and the next message resumes [D159, D222]. `by`: "user", or "pause" for a worker's Pause.
pub fn interrupt(data: &Path, id: &str, by: &str) -> io::Result<Option<Value>> {
    let dir = core::session_dir(data, id);
    let turn = core::fold(&dir, true)?.fold.turns.into_iter().next();
    // From its open tool, not the turn: a helper's own server can start after the turn's input.
    // shortcut: 1s early, as a tool's command can start before its line is logged; a server
    // started within 1s of the tool would count too, which no CLI here does.
    let tool_since = turn
        .filter(|t| !t.tools.is_empty())
        .map(|t| t.tools_since.saturating_sub(1000));
    let req = json!({"cid": new_cid(), "control": {"kind": "interrupt", "by": by}});
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
    let started = Instant::now();
    while started.elapsed() < STOP_WAIT {
        if core::fold(&dir, true)?.fold.turns.is_empty() {
            if let Some(since) = tool_since
                && command_left(&dir, since)?
            {
                return Ok(None);
            }
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

/// The session's permission level: a running turn takes it at once [D166], else its next turn start [D129, D170].
pub fn level(data: &Path, args: &[String]) -> io::Result<Value> {
    let id = crate::arg(args, 1)?;
    let mut spec = core::load(data, id)?;
    let op = crate::flag(args, "--op");
    if let Some(want) = args.get(2).filter(|w| !w.starts_with("--")) {
        // Held to Ask, it can't be raised: the project's trust is the way [D166, D187].
        if want != "ask" && crate::models::held(data, spec.project.as_deref()) {
            return Err(io::Error::other(
                "This folder isn't trusted, so sessions here ask first. Change it in the project's settings.",
            ));
        }
        let f = core::fold(&spec.dir, true)?;
        spec.level = Some(want.clone());
        spec.level_op = op.map(String::from);
        // Checked against the agent the next message goes to [D225].
        if let Some(a) = adapters::get(crate::models::next_agent(&spec, &f.fold)) {
            core::level(&spec, a, false).map_err(io::Error::other)?;
        }
        // A running turn takes it now, before it's saved, so no cut races it [D166].
        let ping = (!f.fold.turns.is_empty()).then(|| owner::call(data, id, json!({"op": "ping"})));
        if let Some(Ok(ping)) = ping.filter(|p| p.as_ref().is_ok_and(|p| p["child"].is_number())) {
            let child = Some(ping["spawn"].as_u64().unwrap_or(0));
            let call = |req| owner::call(data, id, req);
            core::relevel(&spec, &f.fold, child, &call, &new_cid()).map_err(|e| {
                io::Error::other(
                    e["why"]
                        .as_str()
                        .or(e["error"].as_str())
                        .unwrap_or("refused")
                        .to_string(),
                )
            })?;
        }
        core::create(data, &spec)?;
    }
    Ok(json!({"ok": true, "level": spec.level, "op": op}))
}
