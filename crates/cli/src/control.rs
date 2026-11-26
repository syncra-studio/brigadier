//! What reaches a running turn besides a message [D159]: an answer to one of its requests, a steer,
//! a stop. Each goes through the adapter's own channel as an input with a command id, so the host
//! logs it, writes it and marks it delivered as it does a message; one never proven delivered
//! stays uncertain and is never sent again by itself [D60, D82].

use crate::{call_fn, child, flag, owner};
use brigadier_core::adapters::{self, Delivery};
use brigadier_core::fold::{self, Fold};
use brigadier_core::message::answers::{Answers, answers as answers_of};
use brigadier_core::{self as core, Spec, as_run};
use brigadier_frames::{log, procs};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};
use std::{io, process, thread};

mod given;
mod level;
mod steer;
pub use given::beside;
use given::with;
pub use level::level;
pub(crate) use level::{held_level, relevel};
pub use steer::{steer_as, steer_turn};

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
/// `answer <id> <request> --answers JSON` for a question: one answer per item, null skipped, one
/// with images or files as its draft [D177].
pub fn answer(data: &Path, args: &[String]) -> io::Result<Value> {
    let usage = || io::Error::other(crate::USAGE);
    let id = args.get(1).ok_or_else(usage)?;
    let request = args.get(2).ok_or_else(usage)?;
    let decision = args.get(3).filter(|d| !d.starts_with("--")).cloned();
    let reason = flag(args, "--reason");
    let answers: Option<Vec<Value>> = (flag(args, "--answers").map(serde_json::from_str))
        .transpose()
        .map_err(|e| io::Error::other(format!("--answers: {e}")))?;
    let given = match &answers {
        Some(given) => answers_of(data, &core::load(data, id)?, given)?,
        None => Answers::default(),
    };
    // A worker's routing hold or a mockup offer: Rust's own question, the user's call [D2028, D2058].
    let choice = given.said.iter().find_map(Value::as_str);
    if request.starts_with("mockup-") {
        return crate::relay::mockup::answered(data, id, request, choice.unwrap_or(""));
    }
    if request.starts_with("hold-") {
        let args = ["routing", "answer", id, request, choice.unwrap_or("")].map(String::from);
        return crate::routing::run(data, &args);
    }
    let control = json!({"kind": "answer", "request": request, "decision": decision, "reason": reason, "answers": answers.map(|_| &given.said)});
    answered(data, id, request, control, &given)
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
    answered(data, id, request, control, &Answers::default()).map(Some)
}

/// Brigadier's own answer to an exact repeat of a command allowed for the session, which its
/// agent's CLI asks again [D389].
pub fn repeats(data: &Path, rows: &BTreeMap<String, Value>) {
    for (id, row) in rows {
        if let Some(request) = row["reason"]["repeat"].as_str() {
            let _ = answer_as(data, id, request, "allow", None, "brigadier");
        }
    }
}

/// A turn whose agent's own safety check gave no verdict asks the user instead: its child runs at
/// Ask for the rest of that turn, its agent told to retry what was denied [D460], and at the
/// session's own level again once it ends, however it ends [D453, D455]. Each once a turn; a new
/// child starts at the session's level anyway.
pub fn unchecked(data: &Path, rows: &BTreeMap<String, Value>) {
    static DONE: Mutex<BTreeSet<String>> = Mutex::new(BTreeSet::new());
    for (id, row) in rows {
        let (Some(to), Some(turn)) = (row["unchecked"][0].as_str(), row["unchecked"][1].as_str())
        else {
            continue;
        };
        if !DONE.lock().unwrap().insert(format!("{id} {turn} {to}")) {
            continue;
        }
        let (data, id, ask) = (data.to_path_buf(), id.clone(), to == "ask");
        thread::spawn(move || {
            let relevel = || -> io::Result<()> {
                let mut spec = core::load(&data, &id)?;
                if ask {
                    spec.level = Some("ask".into());
                }
                let ping = owner::call(&data, &id, json!({"op": "ping"}))?;
                let Some(spawn) = ping["child"].is_number().then(|| ping["spawn"].as_u64()) else {
                    return Ok(());
                };
                let f = core::fold(&spec.dir, true)?;
                let call = |req| owner::call(&data, &id, req);
                core::relevel(&spec, &f.fold, Some(spawn.unwrap_or(0)), &call, &new_cid())
                    .map_err(|e| io::Error::other(e.to_string()))
            };
            if let Err(e) = relevel() {
                eprintln!("brigadierd: unchecked {id}: {e}");
            } else if ask {
                // Told in its running turn, hidden: else it may wait the "temporary error" out and
                // the card never comes [D460]. A turn that ended refuses it: nothing is sent.
                let note = "The safety check that gives this session's Auto verdicts was \
                    unavailable, so the rest of this turn asks the user to approve each action \
                    instead. Retry the denied command now, as it was.";
                if let Err(e) = steer_as(&data, &id, note, &Value::Null, None, "system", false) {
                    eprintln!("brigadierd: unchecked {id}: {e}");
                }
            }
        });
    }
}

/// A session the user stopped or paused that its CLI woke on its own (a background task ended):
/// stopped again at once, as the user left it, by the same hand [D90, D95].
pub fn hush(data: &Path, rows: &BTreeMap<String, Value>) {
    static HUSHING: Mutex<BTreeSet<String>> = Mutex::new(BTreeSet::new());
    for (id, row) in rows {
        let Some(by) = row["woke"].as_str() else {
            continue;
        };
        if !HUSHING.lock().unwrap().insert(id.clone()) {
            continue;
        }
        let (data, id, by) = (data.to_path_buf(), id.clone(), by.to_string());
        thread::spawn(move || {
            if let Err(e) = crate::queue::stop(&data, &id, &by) {
                eprintln!("brigadierd: hush {id}: {e}");
            }
            HUSHING.lock().unwrap().remove(&id);
        });
    }
}

/// What the running turn asks as `request`, or why nothing waits on it.
fn pending<'a>(f: &'a Fold, request: &str) -> Result<&'a Value, Value> {
    let asked = f.turns.first().and_then(|t| t.asks.get(request));
    asked.ok_or_else(|| {
        let why = f.closed.get(request).map_or("unknown", String::as_str);
        refused("not_pending", why.into())
    })
}

fn answered(
    data: &Path,
    id: &str,
    request: &str,
    mut control: Value,
    given: &Answers,
) -> io::Result<Value> {
    if request.starts_with("browser-") {
        return crate::browser::answered(data, id, request, &control);
    }
    if request.starts_with("computer-") {
        return crate::computer::answered(data, id, request, &control);
    }
    let decision = control["decision"].as_str().map(String::from);
    let answers = control["answers"].as_array().cloned();
    let images = beside(data, id, given, Some(request))?;
    if images["result"] == "refused" {
        return Ok(images);
    }
    let req = with(json!({"cid": new_cid()}), &mut control, given);
    deliver(data, id, req, true, |f| {
        let asked = pending(f, request)?;
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
                // A plan has no bare deny: only one with words, its reply [D177, D400].
                Some("deny") if asked["action"] != "plan" || control["reason"].is_string() => {}
                _ => return wrong("decision"),
            },
        }
        let mut msg = control.clone();
        msg["request"] = asked.clone();
        if answers.is_some() {
            msg["answers"] = given.told.clone().into();
        }
        Ok(msg)
    })
}

/// A plain message while the agent waits on a question: that question's answer, through its
/// control channel, so the agent and the log agree on what's pending. None when no question waits
/// or the agent can't take it there: the message goes as any other [D159, D222]. Also a plan's
/// reply, which keeps its agent planning: its answerer's words, or its reviewer's findings (`by`
/// review) while the review holds it [D177, §6].
pub fn reply(
    data: &Path,
    id: &str,
    text: &str,
    parts: &Value,
    cid: Option<&str>,
    by: Option<&str>,
) -> io::Result<Option<Value>> {
    let f = core::fold(&core::session_dir(data, id), true)?;
    let review = by == Some("review");
    let asked = f.fold.turns.first().and_then(|t| {
        let mut questions = t.asks.iter().filter(|(_, r)| {
            let plan = r["action"] == "plan" && (r["to"] == "review") == review;
            // The user's words never answer what a worker asked its parent [D131, D305].
            let to_us = by == Some("parent") || r["to"] != "parent";
            r["items"].is_array() && !review && to_us || plan && by != Some("overnight")
        });
        questions.next().map(|(k, _)| k.clone())
    });
    let Some(request) = asked else {
        return Ok(None);
    };
    let given = Answers::of(&core::load(data, id)?, text, parts)?;
    if beside(data, id, &given, Some(&request))?["result"] == "refused" {
        return Ok(None);
    }
    let mut control =
        json!({"kind": "answer", "request": request, "reply": given.said[0], "by": by});
    let cid = cid.map_or_else(new_cid, String::from);
    let req = with(json!({"cid": cid}), &mut control, &given);
    let reply = deliver(data, id, req, true, |f| {
        match f.turns.first().and_then(|t| t.asks.get(request.as_str())) {
            Some(asked) => {
                let mut msg = control.clone();
                msg["request"] = asked.clone();
                msg["reply"] = given.told[0].clone();
                Ok(msg)
            }
            None => Err(refused("not_pending", Value::Null)),
        }
    })?;
    Ok((reply["result"] != "refused").then_some(reply))
}

/// How long a clean stop may take before the kill (proposed).
const STOP_WAIT: Duration = Duration::from_secs(3);
/// How long the command an agent's own stop left gets to go before the KILL.
const COMMAND_WAIT: Duration = Duration::from_secs(1);

/// Ends what's below the child and started since `since` (ms). An agent's stop can end its turn and
/// leave the command it was running [D222]: that command goes, and the agent stays, as any CLI's
/// own stop leaves it [D159, D693].
fn end_commands(dir: &Path, since: u64) -> io::Result<()> {
    let fold = core::fold(dir, true)?.fold;
    let child = (fold.child.as_ref())
        .filter(|c| !c.exited)
        .and_then(|c| procs::same(c.pid, c.start_us));
    let left: Vec<_> = (child.map(|c| procs::descendants(&procs::all(), c.pid)))
        .into_iter()
        .flatten()
        .filter(|p| p.start_us / 1000 >= since)
        .map(|p| (p.pid, p.start_us))
        .collect();
    fold::end(&left, COMMAND_WAIT);
    Ok(())
}

/// Stops the running turn through the adapter's own stop, the process staying alive, and ends the
/// command it left. None when it can't or the turn didn't end in time: the caller kills instead,
/// and the next message resumes [D159, D222]. `by`: "user", or "pause" for a worker's Pause.
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
            if let Some(since) = tool_since {
                end_commands(&dir, since)?;
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

/// The user's message, or a start's first [D54]. `queued`: the caller holds the queue's lock.
#[allow(clippy::too_many_arguments)]
pub(crate) fn send(
    data: &Path,
    spec: &Spec,
    text: &str,
    parts: Value,
    cid: Option<&str>,
    backend: Option<&str>,
    retry_of: Option<&str>,
    queued: bool,
) -> io::Result<Value> {
    // Under the queue's lock, as a delivery sends: what's held for this message goes with it [D329].
    // Taken before the fence, the order every rewind and delivery takes them in [JR-FX2].
    let _lock = (!queued)
        .then(|| crate::queue::hold(&spec.dir))
        .transpose()?;
    crate::rewind::settle_held(data, spec)?;
    let _fence = core::session::fence(data, spec)?;
    let cid = cid.map_or_else(new_cid, String::from);
    let call = call_fn(data, &spec.id);
    let mut msg = core::message::compose(spec, text, parts, backend)?;
    let held = crate::workers::with_next(data, &spec.id, Some(&cid), &mut msg.agent);
    let go = || -> io::Result<Value> {
        let f = core::fold(&spec.dir, true)?;
        let running = child(data, &spec.id);
        // A launch tells a session's agent the user's jobs as they are now [D387].
        let spec = &crate::routing::told(data, spec);
        Ok(core::send(
            spec, &f.fold, running, &call, &cid, "user", &msg, backend, retry_of,
        ))
    };
    let mut reply = go()?;
    let logged = || core::fold(&spec.dir, true).is_ok_and(|f| f.fold.cids.contains_key(&cid));
    // Retry a busy race or moving host only when the log proves the command never got in;
    // an uncertain delivery is never sent again by itself [D54].
    if reply["result"].is_null() && !logged() {
        thread::sleep(Duration::from_millis(200));
        // If no host answers, the resend fails too and the log decides the result below.
        let _ = owner::ensure(data, spec);
        reply = go()?;
    }
    // A dropped connection says nothing about the log: the log itself does.
    if reply["result"].is_null() {
        reply["result"] = match (reply["ok"] == true, logged()) {
            (true, _) => "delivered",
            (false, true) => "logged",
            (false, false) => "not_logged",
        }
        .into();
    }
    if matches!(reply["result"].as_str(), Some("delivered" | "logged")) {
        crate::workers::went_with(data, &spec.id, held);
    }
    Ok(reply)
}
