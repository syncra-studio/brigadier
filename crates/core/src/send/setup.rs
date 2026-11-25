//! A new model, effort or level given to the child that runs, between turns or in one.

use super::{CONFIRM_WAIT, Call, Running, level};
use crate::adapters::{self, Delivery, Retune};
use crate::fold::Fold;
use crate::{Spec, as_run};
use serde_json::{Value, json};
use std::thread;
use std::time::{Duration, Instant};

/// A setup handed to the idle child and confirmed: the message's frame as it goes now. What the child
/// runs with is noted whatever comes of the message: never asked twice, and after a failure not
/// known, so the next message starts it again with its setup.
pub(super) fn retuned(
    spec: &Spec,
    call: Call,
    mut base: Value,
    f: &Fold,
    child: Running,
    bytes: String,
    ids: &[String],
) -> Result<Value, Value> {
    let took = confirm(spec, call, &base, child, bytes, ids);
    if let Ok(Some(level)) = &took {
        base["setup"]["level"] = level.as_str().into();
    }
    // The jobs it was last told: confirming a model tells it none.
    let mut now = base["setup"].clone();
    now["jobs"] = (f.given.as_ref()).map_or(Value::Null, |g| g["jobs"].clone());
    let now = took.as_ref().map_or(json!({"unknown": true}), |_| now);
    let noted = call(json!({"op": "note", "data": {"event": "retuned", "setup": now}}));
    took?;
    noted.map_err(|e| json!({"ok": false, "error": e.to_string()}))?;
    // The confirming moved the log: the message goes only if nothing else did.
    base["if_len"] = idle(spec, call, true)?.0.into();
    Ok(base)
}

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
    let refused = |why: String| {
        let message = format!("Its agent didn't take the new model or level ({why})");
        json!({"ok": false, "result": "refused", "error": "setup", "why": why, "message": message})
    };
    // Its own each try: a repeat under one id is never delivered, so its answer never comes.
    let cid = format!(
        "{}.setup-{}",
        base["cid"].as_str().unwrap_or(""),
        ids.concat()
    );
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
pub(super) fn idle(spec: &Spec, call: Call, needs_child: bool) -> Result<(u64, Fold), Value> {
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

/// A new level reaches a running child at once [D166, D455]: as its agent's own request where it
/// takes one mid-turn, confirmed and recorded as the level the child runs at. An agent that takes it
/// only with a turn start is left as it was given, so `rebirth::due` cuts the turn and carries it on.
pub fn relevel(spec: &Spec, f: &Fold, child: Running, call: Call, cid: &str) -> Result<(), Value> {
    let Some(g) = f.given.as_ref() else {
        return Ok(());
    };
    let backend = f.turns.first().map_or(&f.backend, |t| &t.backend);
    let Some(a) = adapters::get(backend) else {
        return Ok(());
    };
    let held = crate::projects::held(&crate::data_of(spec), spec);
    let want = level(spec, a, held).map_err(|e| json!({"ok": false, "error": e}))?;
    if g["level"].as_str() == want {
        return Ok(());
    }
    let next = Spec {
        level: want.map(String::from),
        ..as_run(spec, f, backend, None)
    };
    let last = Spec {
        level: g["level"].as_str().map(String::from),
        ..next.clone()
    };
    let Retune::Confirm(Delivery::Stdin(bytes), ids) = a.retune(&last, &next) else {
        return Ok(());
    };
    let base = json!({"cid": cid, "origin": "user", "backend": backend});
    let took = confirm(spec, call, &base, child, bytes, &ids)?;
    let note = json!({"op": "note", "data": {"event": "level", "level": took.as_deref().or(want)}});
    call(note).map_err(|e| json!({"ok": false, "error": e.to_string()}))?;
    Ok(())
}
