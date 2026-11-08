//! Sending a message to a session's agent, and the one recovery for a turn that didn't finish.

use crate::adapters::{Delivery, Retune};
use crate::fold::{self, Fold, Live};
use crate::{Spec, adapters, as_run, cli_version, sweep};
use brigadier_frames::log;
use serde_json::{Value, json};
use std::io;
use std::thread;
use std::time::{Duration, Instant};

pub type Call<'a> = &'a dyn Fn(Value) -> io::Result<Value>;

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
    text: &str,
    backend: Option<&str>,
    retry_of: Option<&str>,
) -> Value {
    let picking = origin == "user" && backend.is_none() && retry_of.is_none() && f.picked.is_some();
    let mut replace = None;
    let picked_fold;
    let f = if picking {
        match idle(spec, call, false) {
            Ok((len, again)) if again.picked.is_some() => {
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
        let e = format!(
            "This folder isn't trusted, and Brigadier couldn't record that in {}'s own settings, so it could trust the folder on its own: {e}",
            a.label()
        );
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
            let e = format!(
                "This folder isn't trusted, so its sessions run under Ask, which {} can't do yet. Trust the folder in Project settings to run it.",
                a.label()
            );
            return json!({"ok": false, "result": "refused", "error": e});
        }
        Err(e) => return json!({"ok": false, "result": "refused", "error": e}),
    };
    let spec = &Spec {
        level: level.map(String::from),
        ..spec.clone()
    };
    let mut run = as_run(spec, f, &b, None);
    let (change, sent) = if let Some(p) = picked {
        run.model = Some(p.model.clone());
        run.effort = p.effort.clone();
        match crate::switch::picked(spec, f, &b, &p.model, p.effort.as_deref(), text) {
            Ok((change, sent)) => (Some(change), sent),
            Err(e) => return json!({"ok": false, "result": "refused", "error": e.to_string()}),
        }
    } else {
        (None, text.to_string())
    };
    let setup = adapters::setup(&run);
    let mut base = json!({"cid": cid, "origin": origin, "text": text, "backend": b, "retry_of": retry_of, "setup": setup});
    if held {
        base["setup"]["held"] = true.into();
    }
    if let Some(change) = change {
        base["switch"] = change;
    }
    let running = child.is_some() && !picking;
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
                ..run.clone()
            };
            match a.retune(&last, &run) {
                Retune::InMessage => {}
                Retune::Send(Delivery::Stdin(pre)) => bytes = pre,
                Retune::Confirm(Delivery::Stdin(pre), ids) => {
                    match confirm(spec, call, &base, child, pre, &ids) {
                        Ok(Some(level)) => base["setup"]["level"] = level.into(),
                        Ok(None) => {}
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
                ..spec.clone()
            };
            bytes += &a.encode(&run, text);
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
    let resume = if picking {
        None
    } else {
        f.resume.get(&b).map(String::as_str)
    };
    let run = Spec {
        cid: Some(cid.into()),
        ..if picking {
            run
        } else {
            as_run(spec, f, &b, None)
        }
    };
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
    let mut reply = call(req).unwrap_or_else(|e| json!({"ok": false, "error": e.to_string()}));
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
        if started.elapsed() > CONFIRM_WAIT {
            break ("logged", "the agent didn't confirm it".into(), Value::Null);
        }
        thread::sleep(Duration::from_millis(50));
    };
    reply["ok"] = (result != "refused").into();
    (reply["result"], reply["error"], reply["why"]) = (result.into(), error, why);
    reply
}

/// How long an idle child may take to confirm a new setup before the turn is refused (proposed).
const CONFIRM_WAIT: Duration = Duration::from_secs(10);

/// Hands a setup to the idle child on its own, then waits for its reply to each request: the turn
/// goes on only once every one succeeded, at the level the child says it took. An error or no
/// reply refuses the turn, and nothing is recorded as applied [D175, D222].
fn confirm(
    spec: &Spec,
    call: Call,
    base: &Value,
    child: Running,
    bytes: String,
    ids: &[String],
) -> Result<Option<String>, Value> {
    let refused =
        |why: String| json!({"ok": false, "result": "refused", "error": "setup", "why": why});
    let cid = format!("{}.setup", base["cid"].as_str().unwrap_or(""));
    let mut req = json!({"op": "input", "cid": cid, "origin": base["origin"], "backend": base["backend"],
                         "bytes": bytes, "control": {"kind": "retune"}});
    if let Some(spawn) = child.filter(|spawn| *spawn > 0) {
        req["spawn"] = spawn.into();
    }
    let reply = call(req).map_err(|e| refused(e.to_string()))?;
    if reply["result"] != "delivered" {
        return Err(refused(format!("the new setup wasn't delivered: {reply}")));
    }
    let started = Instant::now();
    loop {
        let f = crate::fold(&spec.dir, true).map_err(|e| refused(e.to_string()))?;
        let got: Vec<Value> = (ids.iter())
            .filter_map(|id| f.fold.replies.get(id).cloned())
            .collect();
        if let Some(e) = got.iter().find_map(|r| r["error"].as_str()) {
            return Err(refused(e.into()));
        }
        if got.len() == ids.len() {
            return Ok(got
                .iter()
                .find_map(|r| r["level"].as_str().map(String::from)));
        }
        if started.elapsed() > CONFIRM_WAIT {
            return Err(refused("the agent didn't confirm its new setup".into()));
        }
        thread::sleep(Duration::from_millis(50));
    }
}

/// The host's log length, then its fold: a restart or picked switch is refused if anything comes
/// between judging it idle and spawning. A picked switch also works with no child left alive.
fn idle(spec: &Spec, call: Call, needs_child: bool) -> Result<(u64, Fold), Value> {
    let changed = json!({"ok": false, "result": "refused", "error": "changed"});
    let ping =
        call(json!({"op": "ping"})).map_err(|e| json!({"ok": false, "error": e.to_string()}))?;
    if !needs_child
        && !ping["caps"]
            .as_array()
            .is_some_and(|caps| caps.iter().any(|c| c == "switch"))
    {
        return Err(
            json!({"ok": false, "result": "refused", "error": "old_host", "message": "This session's host is on an older build. It moves to the new one once nothing runs."}),
        );
    }
    let len = ping["len"].as_u64().ok_or(changed.clone())?;
    let f =
        crate::fold(&spec.dir, true).map_err(|e| json!({"ok": false, "error": e.to_string()}))?;
    match f.fold.turns.is_empty() && (!needs_child || ping["child"].is_number()) {
        true => Ok((len, f.fold)),
        false => Err(changed),
    }
}

/// The level a turn runs at: Ask while its project holds it [D166], else the spec's, or (proposed)
/// the agent's most restrictive when it names none. One the agent can't enforce refuses the turn,
/// never runs weaker [D129, D170]. The session's row shows the same answer.
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
        Some(want) => levels
            .iter()
            .find(|l| **l == want)
            .copied()
            .map(Some)
            .ok_or_else(|| format!("{} can't run at the {want:?} permission level", a.label())),
    }
}

/// The one recovery. An unproven delivery is re-sent only when a person asks (never by itself);
/// an interrupted turn continues through the backend's resume id.
pub fn recover(spec: &Spec, f: &Fold, live: &Live, child: Running, call: Call) -> Value {
    let status = fold::status(f, live);
    let state = status["state"].as_str().unwrap_or("");
    let now = log::now_ms();
    let note = |data: Value| call(json!({"op": "note", "data": data}));
    match state {
        "undelivered" => {
            let Some(turn) = f.turns.iter().find(|t| t.delivered.is_none()) else {
                return json!({"ok": false});
            };
            let old = turn.cid.clone().unwrap_or_default();
            if let Err(e) = note(json!({"event": "interrupted", "reason": {"undelivered": old}})) {
                return json!({"ok": false, "error": e.to_string()});
            }
            let cid = format!("{old}.r{now}");
            let mut reply = send(
                spec,
                f,
                child,
                call,
                &cid,
                &turn.origin,
                &turn.text,
                Some(&turn.backend),
                Some(&old),
            );
            reply["recovered"] = "resent".into();
            reply
        }
        "interrupted" => {
            let swept = sweep(f);
            let last = f
                .turns
                .first()
                .map(|t| (t.cid.clone(), t.retry_of.clone(), t.backend.clone()));
            let last = last.or_else(|| {
                f.last.as_ref().map(|l| {
                    (
                        l["cid"].as_str().map(String::from),
                        l["retry_of"].as_str().map(String::from),
                        l["backend"].as_str().unwrap_or("").to_string(),
                    )
                })
            });
            let (cid, retry_of, backend) = last.unwrap_or_default();
            let root = retry_of.or(cid).unwrap_or_default();
            if let Err(e) = note(json!({"event": "interrupted", "reason": status["reason"]})) {
                return json!({"ok": false, "error": e.to_string()});
            }
            if !f.resume.contains_key(&backend) {
                return json!({"ok": false, "swept": swept, "error": "no resume id was announced, so there is nothing to continue; send a new message"});
            }
            let text = "Continue where you left off; your previous run was cut off.";
            let mut reply = send(
                spec,
                f,
                None,
                call,
                &format!("rc{now}"),
                "system",
                text,
                Some(&backend),
                Some(&root),
            );
            reply["recovered"] = "continued".into();
            reply["swept"] = swept.into();
            reply
        }
        _ => json!({"ok": false, "error": format!("nothing to recover: {state}")}),
    }
}

/// A given setup without `held`: being held changes no model, effort or level by itself, so it never retunes.
fn unheld(given: &Value) -> Value {
    let mut given = given.clone();
    if let Some(o) = given.as_object_mut() {
        o.remove("held");
    }
    given
}
