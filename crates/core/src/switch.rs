//! Moving a session that hit its limit to another account or agent [D51]. One transition,
//! serialised by the host: a single spawn that replaces the
//! idle child and logs one input frame carrying the switch. The host refuses it if the log moved
//! since the caller judged the session, and its cid is fixed by the limit, so a repeat, a racing
//! caller or a retry after a crash does it at most once [D54, D82].

use crate::fold::{self, Fold};
use crate::{Call, Spec, adapters, as_run, cli_version};
use serde_json::{Value, json};

/// The old app's words for a turn its account's limit cut short (D48).
const CARRY_ON: &str = "[Your last turn stopped early: its account hit a usage limit. You now run on another account, in the same session. Carry on from where you stopped. Don't redo anything you already did.]";

/// What the same agent is told when a model picked mid-turn stopped it [D124].
pub const SWITCHED: &str = "[The user switched your model or permission level mid-turn, so your last turn was stopped. A step that stop cut may read as refused or rejected; nobody refused it: redo it if still needed. Carry on from where you stopped: a reply cut off goes on from its last word, none of it repeated. Don't redo anything you already did.]";

/// Where the session goes: a backend, its account ("" is the computer's login), and its model
/// when it changes; `label` and `from` name both sides (the model apart) for the thread's row.
pub struct Target<'a> {
    pub backend: &'a str,
    pub account: &'a str,
    pub model: Option<&'a str>,
    /// Its effort when a worker's routing row sets one [D2041]; else the session's own.
    pub effort: Option<&'a str>,
    /// The model as the picker names it, where known [D76].
    pub name: Option<&'a str>,
    pub label: &'a str,
    pub from: &'a str,
}

/// Makes the switch, or says why not. `ping` is the host's answer taken before `f` was folded;
/// `still` is asked last, just before the host is, so a setting turned off meanwhile stops an
/// automatic switch.
pub fn switch(
    spec: &Spec,
    f: &Fold,
    ping: &Value,
    call: Call,
    to: &Target,
    auto: bool,
    still: &dyn Fn() -> bool,
) -> Value {
    let caps = ping["caps"].as_array().into_iter().flatten();
    if !caps.into_iter().any(|c| c == "switch") {
        return json!({"ok": false, "error": "old_host", "message": "This session's host is on an older build. It moves to the new one once nothing runs."});
    }
    let Some(why) = fold::switchable(f) else {
        return json!({"ok": false, "error": "not_limited", "message": "This session isn't at a limit."});
    };
    let Some(a) = adapters::get(to.backend) else {
        return json!({"ok": false, "error": format!("unknown backend {}", to.backend)});
    };
    let mut run = as_run(spec, f, to.backend, Some(to.account));
    // A switched turn passes the gate of any turn start: the target's CLI has the trust answer
    // first, and a held project runs under Ask or not at all [D166, D182, D222].
    if let Err(e) = crate::trust::ensure(&run, a) {
        return json!({"ok": false, "error": e.clone(), "message": e});
    }
    let held = crate::projects::held(&crate::data_of(spec), spec);
    match crate::send::level(spec, a, held) {
        Ok(level) => run.level = level.map(String::from),
        Err(e) => {
            let e = if held { crate::send::cant_hold(a) } else { e };
            return json!({"ok": false, "error": e.clone(), "message": e});
        }
    }
    let last = f.last.clone().unwrap_or_default();
    let from = if f.backend.is_empty() {
        spec.backend.as_str()
    } else {
        f.backend.as_str()
    };
    let fresh = to.backend != from || why == "unresumable";
    // The message the CLI refused outright goes again only on proof: its limit, after delivery,
    // before any work. Anything else is told what happened, never sent the user's words twice.
    let proof = last["outcome"] == "limited"
        && last["delivered"] == true
        && last["began"] == false
        && last["origin"] == "user";
    let (origin, text) = if fresh {
        match crate::handoff::build(spec, f, why, &last, to.from) {
            Ok(t) => ("system", t),
            Err(e) => {
                return json!({"ok": false, "error": format!("couldn't start the new conversation: {e}")});
            }
        }
    } else if proof {
        ("user", last["text"].as_str().unwrap_or("").to_string())
    } else {
        ("system", CARRY_ON.to_string())
    };
    let to_named = match to.name.or(to.model) {
        Some(m) => format!("{} · {m}", to.label),
        None => to.label.to_string(),
    };
    let how = if auto {
        "switched automatically to"
    } else {
        "switched to"
    };
    let note = if why == "unresumable" {
        format!("{to_named} couldn't resume this conversation · started a new one")
    } else {
        format!("Usage limit on {} · {how} {to_named}", to.from)
    };
    let mut switch = json!({"from": {"backend": from, "account": f.accounts.get(from)},
        "to": {"backend": to.backend, "account": to.account, "model": to.model},
        "auto": auto, "fresh": fresh, "why": why, "note": note,
        "from_label": to.from, "to_label": to.label});
    if let Some(name) = to.name {
        switch["to"]["name"] = name.into();
    }
    if let Some(m) = to.model {
        run.model = Some(m.into());
    }
    if let Some(e) = to.effort {
        (run.effort, switch["to"]["effort"]) = (Some(e.into()), e.into());
    }
    let mut setup = adapters::setup(&run);
    if held {
        setup["held"] = true.into();
    }
    let resume = (!fresh)
        .then(|| f.resume.get(to.backend).map(String::as_str))
        .flatten();
    let launch = a.launch(&run, resume, Some(&text));
    let env: serde_json::Map<String, Value> =
        launch.env.into_iter().map(|(k, v)| (k, v.into())).collect();
    let req = json!({"op": "spawn", "cid": format!("sw-{}", last["ts"]), "origin": origin, "text": text,
        "backend": to.backend, "retry_of": last["cid"], "switch": switch, "setup": setup, "argv": launch.argv, "env": env,
        "cwd": spec.cwd, "keep_stdin": launch.keep_stdin, "input": launch.input,
        "cli_version": cli_version(spec, a), "replace": true, "if_len": ping["len"]});
    if !still() {
        return json!({"ok": false, "error": "off", "message": "Automatic switching was turned off."});
    }
    let mut reply = call(req).unwrap_or_else(|e| json!({"ok": false, "error": e.to_string()}));
    if reply["error"] == "changed" {
        reply["message"] = "The session changed while switching. Try again.".into();
    }
    reply
}

/// The user's next message after picking another agent (`to`, its model and effort) [D90, D129]:
/// the input's `switch` and what the CLI is sent, the hand-off and then the user's own words. The
/// log keeps only the words. A new conversation on `to`'s current account; its row says so.
pub fn picked(
    spec: &Spec,
    f: &Fold,
    to: &str,
    p: &crate::fold::Picked,
    text: &str,
) -> std::io::Result<(Value, String)> {
    let model = &p.model;
    let from = if f.backend.is_empty() {
        spec.backend.as_str()
    } else {
        f.backend.as_str()
    };
    let label = |b: &str| adapters::get(b).map_or_else(|| b.to_string(), |a| a.label().into());
    let (from_label, to_label) = (label(from), label(to));
    // None of the user's words: picked mid-turn, it carries on from where that turn stopped [D124].
    let why = if text.is_empty() {
        "switched"
    } else {
        "picked"
    };
    let seed = crate::handoff::build(
        spec,
        f,
        why,
        &f.last.clone().unwrap_or_default(),
        &from_label,
    )?;
    let switch = json!({"from": {"backend": from, "account": f.accounts.get(from)},
        "to": {"backend": to, "account": f.accounts.get(to).map_or("", String::as_str), "model": model, "name": p.name, "effort": p.effort, "fast": p.fast},
        "auto": false, "fresh": true, "why": "picked", "note": format!("Switched to {to_label} · {}", p.name),
        "from_label": from_label, "to_label": to_label});
    Ok((
        switch,
        if text.is_empty() {
            seed
        } else {
            format!("{seed}\n\n{text}")
        },
    ))
}

/// A fork's first message with no conversation of its own: the hand-off from its inherited copy,
/// then the user's own words, which alone the log keeps [D90, D1063].
pub fn forked(spec: &Spec, f: &Fold, text: &str) -> std::io::Result<String> {
    // The agent the thread came from, which a fork to another agent doesn't run on [D1081].
    let source = crate::fork::record(&spec.dir).map(|r| r["backend"].clone());
    let from = (source.as_ref().and_then(Value::as_str))
        .and_then(adapters::get)
        .map_or("the agent", |a| a.label());
    let last = (f.last.clone()).unwrap_or_else(|| json!({"ts": brigadier_frames::log::now_ms()}));
    let seed = crate::handoff::build(spec, f, "forked", &last, from)?;
    Ok(format!("{seed}\n\n{text}"))
}
