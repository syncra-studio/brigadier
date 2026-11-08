//! Sending a message to a session's agent, and the one recovery for a turn that didn't finish.

use crate::adapters::{Delivery, Retune};
use crate::fold::{self, Fold, Live};
use crate::{Spec, adapters, as_run, cli_version, sweep};
use brigadier_frames::log;
use serde_json::{Value, json};
use std::io;

pub type Call<'a> = &'a dyn Fn(Value) -> io::Result<Value>;

/// The child a host holds, from its ping: its spawn id (0 from a host too old to say) and
/// whether it runs in a terminal.
pub type Running = Option<(u64, bool)>;

/// Sends one message: the owner logs it with its command id before writing it anywhere. Prints
/// back exactly what happened: delivered, logged (not proven delivered) or refused. While the
/// terminal is open the message is typed into it, made for that one child [D47].
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
    let b = backend.map(String::from).unwrap_or_else(|| {
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
    let asked = Spec {
        level: Some("ask".into()),
        ..spec.clone()
    };
    let level = match level(if held { &asked } else { spec }, a) {
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
    let run = as_run(spec, f, &b, None);
    let setup = adapters::setup(&run);
    let mut base = json!({"cid": cid, "origin": origin, "text": text, "backend": b, "retry_of": retry_of, "setup": setup});
    if held {
        base["setup"]["held"] = true.into();
    }
    let running = child.is_some();
    let pty = child.is_some_and(|(_, pty)| pty);
    if running && f.child.as_ref().is_some_and(|c| c.backend != b) {
        return json!({"ok": false, "result": "refused", "error": "another backend's process is running; stop it first"});
    }
    let mut replace = None;
    let refolded;
    let mut f = f;
    if running && (!a.per_turn() || pty) {
        let mut bytes = String::new();
        if !f.turns.is_empty() {
            // A working child keeps its setup: the change waits for the next turn start.
            base["setup"] = f.given.clone().into();
        } else if !pty && f.given.as_ref().map(unheld) != Some(setup.clone()) {
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
                Retune::Restart => match restart(spec, call) {
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
            let as_typed = if pty {
                adapters::in_pty(spec)
            } else {
                spec.clone()
            };
            bytes += &a.encode(&as_typed, text);
            req["bytes"] = bytes.into();
            if let Some((spawn, _)) = child.filter(|(spawn, _)| *spawn > 0) {
                req["spawn"] = spawn.into();
            }
            let reply = call(req).unwrap_or_else(|e| json!({"ok": false, "error": e.to_string()}));
            if reply["error"] != "no_child" {
                return reply;
            }
        }
    } else if running {
        return json!({"ok": false, "result": "refused", "error": "busy: a turn is running"});
    }
    let resume = f.resume.get(&b).map(String::as_str);
    let launch = a.launch(&as_run(spec, f, &b, None), resume, Some(text));
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
        ("pty", json!(spec.mode == "pty")),
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
    call(req).unwrap_or_else(|e| json!({"ok": false, "error": e.to_string()}))
}

/// For a child that takes a new setup only by starting again: the log's length from its host, then
/// the fold from at least there, so the restart is refused if anything came in between. Refused
/// unless the child is still idle.
fn restart(spec: &Spec, call: Call) -> Result<(u64, Fold), Value> {
    let changed = json!({"ok": false, "result": "refused", "error": "changed"});
    let ping =
        call(json!({"op": "ping"})).map_err(|e| json!({"ok": false, "error": e.to_string()}))?;
    let len = ping["len"].as_u64().ok_or(changed.clone())?;
    let f =
        crate::fold(&spec.dir, true).map_err(|e| json!({"ok": false, "error": e.to_string()}))?;
    match f.fold.turns.is_empty() && ping["child"].is_number() {
        true => Ok((len, f.fold)),
        false => Err(changed),
    }
}

/// The level a turn runs at: the spec's, or (proposed) the agent's most restrictive when it names
/// none. One the agent can't enforce refuses the turn, never runs weaker [D129, D170].
pub fn level(spec: &Spec, a: &dyn adapters::Adapter) -> Result<Option<&'static str>, String> {
    let levels = a.can().levels;
    match spec.level.as_deref() {
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
