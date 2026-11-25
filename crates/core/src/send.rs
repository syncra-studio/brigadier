//! Sending a message to a session's agent, and the one recovery for a turn that didn't finish.

mod lead;
mod recover;
mod setup;
pub(crate) use recover::{RECONNECT, RESUME};
pub use recover::{reconnect, recover};
pub use setup::relevel;
use setup::{idle, retuned};

use crate::adapters::{Delivery, Retune};
use crate::fold::Fold;
use crate::message::Message;
use crate::{Spec, adapters, as_run, cli_version};
use serde_json::{Value, json};
use std::io;
use std::thread;
use std::time::{Duration, Instant};

pub type Call<'a> = &'a dyn Fn(Value) -> io::Result<Value>;
/// The same, to any session's host, by its id.
pub type CallIn<'a> = &'a dyn Fn(&str, Value) -> io::Result<Value>;

/// The child a host holds, from its ping: its spawn id (0 from a host too old to say).
pub type Running = Option<u64>;

/// Sends one message: the owner logs it with its command id before writing it anywhere. Prints
/// back exactly what happened: delivered, logged (not proven delivered) or refused.
#[allow(clippy::too_many_arguments)]
pub fn send(
    spec: &Spec,
    f: &Fold,
    child: Running,
    call: Call,
    cid: &str,
    origin: &str,
    msg: &Message,
    backend: Option<&str>,
    retry_of: Option<&str>,
) -> Value {
    let (led, night) = lead::led(spec, origin, &msg.agent);
    let text = led.as_deref().unwrap_or(msg.agent.as_str());
    // The user's next turn, or their Resume, goes to the agent they picked; a message into a
    // running turn stays with it, the pick waiting for the next [D90, D76].
    let picking = matches!(origin, "user" | "system")
        && backend.is_none()
        && f.picked.is_some()
        && f.turns.is_empty();
    // Past its threshold, or cut for it, the next input goes to a fresh conversation of the same
    // agent from the hand-off; a message into a running turn stays with it [D88, D108].
    // A rebirth's own input sent again after a crash is a rebirth again, its hand-off rebuilt [D54].
    let redo = retry_of
        .and_then(|r| f.turns.iter().find(|t| t.cid.as_deref() == Some(r)))
        .and_then(|t| t.switch["why"].as_str())
        .filter(|why| matches!(*why, "rebirth" | "cut"));
    let cut = redo.map_or(origin == "system" && text.is_empty(), |why| why == "cut");
    let reborn = !picking
        && (redo.is_some()
            || (backend.is_none() && f.turns.is_empty() && (cut || crate::rebirth::full(spec, f))));
    let mut replace = None;
    let picked_fold;
    let f = if picking || reborn {
        match idle(spec, call, false) {
            Ok((len, again)) if again.picked.is_some() || reborn => {
                replace = Some(len);
                picked_fold = again;
                &picked_fold
            }
            Ok(_) => return json!({"ok": false, "result": "refused", "error": "changed"}),
            Err(reply) => return reply,
        }
    } else {
        f
    };
    let picked = f.picked.as_ref().filter(|_| picking);
    let b = picked
        .map(|p| p.backend.as_str())
        .or(backend)
        .map(String::from)
        .unwrap_or_else(|| {
            if f.backend.is_empty() {
                spec.backend.clone()
            } else {
                f.backend.clone()
            }
        });
    let Some(a) = adapters::get(&b) else {
        return json!({"ok": false, "error": format!("unknown backend {b}")});
    };
    // Its CLI holds the project's trust answer before the turn, "untrusted" included [D182].
    if let Err(e) = crate::trust::ensure(&as_run(spec, f, &b, None), a) {
        return json!({"ok": false, "result": "refused", "error": e});
    }
    // Each turn runs with the level its spec says now, re-checked here [D129, D170], and the model
    // and effort it names: a turn start hands any change to a child already running.
    // An untrusted or unanswered project holds every turn to Ask; an agent that can't enforce it
    // is refused, never run unheld [D129, D166].
    let held = crate::projects::held(&crate::data_of(spec), spec);
    let level = match level(spec, a, held) {
        Ok(level) => level,
        Err(_) if held => {
            return json!({"ok": false, "result": "refused", "error": cant_hold(a)});
        }
        Err(e) => return json!({"ok": false, "result": "refused", "error": e}),
    };
    let spec = &Spec {
        level: level.map(String::from),
        images: msg.images.clone(),
        commands: msg.commands.clone(),
        ..spec.clone()
    };
    let mut run = as_run(spec, f, &b, None);
    let handoff = picked.is_none() && crate::fork::handoff(spec, f, &b);
    let (change, sent) = if let Some(p) = picked {
        run.model = Some(p.model.clone());
        run.effort = p.effort.clone();
        run.fast = p.fast;
        match crate::switch::picked(spec, f, &b, p, text) {
            Ok((change, sent)) => (Some(change), sent),
            Err(e) => return json!({"ok": false, "result": "refused", "error": e.to_string()}),
        }
    } else if reborn {
        let why = if cut { "cut" } else { "rebirth" };
        let last = f.last.clone().unwrap_or_default();
        match crate::handoff::build(spec, f, why, &last, a.label()) {
            Ok(seed) if cut => (
                Some(crate::rebirth::record(spec, f, why)),
                night.map_or(seed.clone(), |night| format!("{seed}\n\n{night}")),
            ),
            Ok(seed) => (
                Some(crate::rebirth::record(spec, f, why)),
                format!("{seed}\n\n{text}"),
            ),
            Err(e) => return json!({"ok": false, "result": "refused", "error": e.to_string()}),
        }
    } else if handoff {
        // A fork with no conversation of its own begins from the hand-off, without asking [D90].
        let unforked = json!({"op": "note", "data": {"event": "unforked", "backend": b}});
        if f.resume.contains_key(&b)
            && let Err(e) = crate::fork::fell_back(&spec.dir).and_then(|()| call(unforked))
        {
            return json!({"ok": false, "error": e.to_string()});
        }
        match crate::switch::forked(spec, f, text) {
            Ok(sent) => (None, sent),
            Err(e) => return json!({"ok": false, "result": "refused", "error": e.to_string()}),
        }
    } else {
        (None, text.to_string())
    };
    // Settings › Routing's rules hold at every launch: a model one bars is refused, an effort above
    // a cap runs at the cap; a turn already running goes on [D376, D388 Q9 Q10, D392 P9].
    let run = match run.ruled(&b) {
        Ok(run) => run,
        Err(e) => return json!({"ok": false, "result": "refused", "error": e}),
    };
    let ruled = run.ruled.clone();
    let setup = adapters::setup(&run);
    let mut base = json!({"cid": cid, "origin": origin, "text": msg.text, "backend": b, "retry_of": retry_of, "setup": setup, "direct": (retry_of.is_none() && crate::message::direct(&spec.dir, cid, origin)).then_some(true)});
    if !msg.parts.is_null() {
        base["parts"] = msg.parts.clone();
    }
    if spec.review {
        base["review"] = true.into();
    }
    if held {
        base["setup"]["held"] = true.into();
    }
    if let Some(change) = change {
        base["switch"] = change;
    }
    crate::rewind::before(spec, f, cid);
    let running = child.is_some() && !picking && !reborn;
    if a.acks() {
        base["ack"] = true.into();
    }
    if running && f.child.as_ref().is_some_and(|c| c.backend != b) {
        return json!({"ok": false, "result": "refused", "error": "another backend's process is running; stop it first"});
    }
    let refolded;
    let mut f = f;
    // An agent that doesn't queue takes a message mid-turn only as a steer.
    if running && !a.per_turn() && (a.queues() || f.turns.is_empty()) {
        let mut bytes = String::new();
        if !f.turns.is_empty() {
            // A working child keeps its setup: the change waits for the next turn start.
            base["setup"] = f.given.clone().into();
        } else if f.given.as_ref().map(unheld) != Some(setup.clone()) {
            let g = f.given.clone().unwrap_or_default();
            let text = |k: &str| g[k].as_str().map(String::from);
            let last = Spec {
                model: text("model"),
                effort: text("effort"),
                level: text("level"),
                fast: g["fast"] == true,
                ruled: crate::Ruled {
                    models: serde_json::from_value(g["allowed"].clone()).unwrap_or_default(),
                    ..run.ruled.clone()
                },
                ..run.clone()
            };
            // Not known what it runs with: started again, never taken as the default.
            let change = match g["unknown"] == true {
                true => Retune::Restart,
                false => a.retune(&last, &run),
            };
            match change {
                Retune::InMessage => {}
                Retune::Send(Delivery::Stdin(pre)) => bytes = pre,
                Retune::Confirm(Delivery::Stdin(pre), ids) => {
                    match retuned(spec, call, base, f, child, pre, &ids) {
                        Ok(now) => base = now,
                        Err(reply) => return reply,
                    }
                }
                Retune::Restart => match idle(spec, call, true) {
                    Ok((len, again)) => {
                        refolded = again;
                        f = &refolded;
                        replace = Some(len);
                    }
                    Err(reply) => return reply,
                },
            }
        }
        if replace.is_none() {
            let mut req = base.clone();
            req["op"] = "input".into();
            let run = Spec {
                cid: Some(cid.into()),
                ..run.clone()
            };
            bytes += &a.encode(&run, &crate::agent::retold(spec, f, &req["setup"], text));
            req["bytes"] = bytes.into();
            if let Some(spawn) = child.filter(|spawn| *spawn > 0) {
                req["spawn"] = spawn.into();
            }
            let reply = call(req).unwrap_or_else(|e| json!({"ok": false, "error": e.to_string()}));
            if reply["error"] != "no_child" {
                return applied(&spec.dir, cid, reply);
            }
        }
    } else if running {
        return json!({"ok": false, "result": "refused", "error": "busy: a turn is running"});
    }
    // A message nobody can say arrived stays in the record: the new one starts after it, never as it.
    if let Some(old) = (f.turns.first())
        .filter(|t| !running && retry_of.is_none() && t.delivered.is_none())
        .and_then(|t| t.cid.as_ref())
        .filter(|old| f.acking.contains(*old))
    {
        let closed =
            json!({"op": "note", "data": {"event": "interrupted", "reason": {"undelivered": old}}});
        if let Err(e) = call(closed) {
            return json!({"ok": false, "error": e.to_string()});
        }
    }
    let resume = if picking || handoff || reborn {
        None
    } else {
        f.resume.get(&b).map(String::as_str)
    };
    let mut run = Spec {
        cid: Some(cid.into()),
        ..if picking {
            run
        } else {
            as_run(spec, f, &b, None)
        }
    };
    (run.effort, run.ruled) = (ruled.effort.clone().or(run.effort), ruled);
    let launch = a.launch(&run, resume, Some(&sent));
    let env: serde_json::Map<String, Value> =
        launch.env.into_iter().map(|(k, v)| (k, v.into())).collect();
    let mut req = base;
    for (k, v) in [
        ("op", json!("spawn")),
        (
            "argv",
            json!(crate::worktrees::wrap(
                &crate::data_of(spec),
                spec,
                launch.argv
            )),
        ),
        ("env", Value::Object(env)),
        ("cwd", json!(spec.cwd)),
        ("keep_stdin", json!(launch.keep_stdin)),
        ("input", json!(launch.input)),
        ("cli_version", json!(cli_version(spec, a))),
    ] {
        req[k] = v;
    }
    // The idle child goes first, only if nothing reached the log since it was judged idle.
    if let Some(len) = replace {
        req["replace"] = true.into();
        req["if_len"] = len.into();
    }
    let mut reply = crate::host::accounts::launch(&run, call, req)
        .unwrap_or_else(|e| json!({"ok": false, "error": e.to_string()}));
    if picking && reply["error"] == "changed" {
        reply["message"] = "The session changed while switching. Try again.".into();
    }
    applied(&spec.dir, cid, reply)
}

/// An input written to an agent that acks is applied only once its reply names the command id
/// [D222]: delivered on success, refused with the agent's reason on an error, and with no reply in
/// time logged, so uncertain and never sent again by itself. Any other reply is returned as is.
pub fn applied(dir: &std::path::Path, cid: &str, mut reply: Value) -> Value {
    if reply["result"] != "sent" {
        return reply;
    }
    let started = Instant::now();
    let (result, error, why) = loop {
        let f = crate::fold(dir, true).ok();
        if let Some(r) = f.as_ref().and_then(|f| f.fold.replies.get(cid)) {
            break match r["error"].as_str() {
                None => ("delivered", Value::Null, Value::Null),
                Some(e) => ("refused", "agent".into(), e.into()),
            };
        }
        if let Some(l) = f.as_ref().and_then(|f| f.fold.last.as_ref())
            && l["cid"] == cid
            && l["outcome"] == "failed"
        {
            break ("logged", "the agent couldn't start".into(), Value::Null);
        }
        if started.elapsed() > CONFIRM_WAIT {
            break ("logged", "the agent didn't confirm it".into(), Value::Null);
        }
        thread::sleep(Duration::from_millis(50));
    };
    reply["ok"] = (result != "refused").into();
    (reply["result"], reply["error"], reply["why"]) = (result.into(), error, why);
    reply
}

/// How long an agent may take to confirm an input or new setup (proposed).
pub(crate) const CONFIRM_WAIT: Duration = Duration::from_secs(10);
/// The level a turn runs at: Ask while its project holds it [D166], else the spec's, or (proposed)
/// the agent's most restrictive when it names none. One the agent doesn't have falls back to its
/// most restrictive, if that is stricter [D222]; otherwise the turn is refused, never run weaker
/// [D129, D170]. The session's row shows the same answer.
pub fn level(
    spec: &Spec,
    a: &dyn adapters::Adapter,
    held: bool,
) -> Result<Option<&'static str>, String> {
    let levels = a.can().levels;
    match if held {
        Some("ask")
    } else {
        spec.level.as_deref()
    } {
        None => Ok(levels.first().copied()),
        Some(want) => {
            let rank = |l: &str| ["ask", "auto", "full"].iter().position(|o| *o == l);
            levels
                .iter()
                .find(|l| **l == want)
                .or(levels.first().filter(|l| rank(l) < rank(want)))
                .copied()
                .map(Some)
                .ok_or_else(|| format!("{} can't run at the {want:?} permission level", a.label()))
        }
    }
}

/// Why a turn in a held project can't run on an agent that can't enforce Ask [D166, D222].
pub(crate) fn cant_hold(a: &dyn adapters::Adapter) -> String {
    format!(
        "This folder isn't trusted, so its sessions run under Ask, which {} can't do yet. Trust the folder in Project settings to run it.",
        a.label()
    )
}

/// A given setup without `held`: being held changes no model, effort or level by itself, so it never retunes.
fn unheld(given: &Value) -> Value {
    let mut given = given.clone();
    if let Some(o) = given.as_object_mut() {
        o.remove("held");
    }
    given
}
