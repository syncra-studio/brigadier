//! Switching a session at its limit [D51]: the settings, the pick (proposed: adapter order, the
//! first usable model, and a fixed window before a limited account is tried again), and the one
//! transition `core::switch` makes through the host.

pub mod rebirth;

use crate::accounts::{STORE, accounts_of, agent, agents, check, listed, load, save};
use crate::owner;
use brigadier_core::adapters::Adapter;
use brigadier_core::switch::{self, Target};
use brigadier_core::{self as core, fold};
use brigadier_frames::log;
use serde_json::{Value, json};
use std::io;
use std::path::Path;

fn flag<'a>(args: &'a [String], name: &str) -> Option<&'a str> {
    let i = args.iter().position(|a| a == name)?;
    args.get(i + 1).map(String::as_str)
}

/// How long an account that hit its limit is skipped by an automatic pick when its CLI gave no
/// reset time: 5 hours, the shortest plan window (proposed).
const SKIP_MS: u64 = 5 * 3600 * 1000;

/// `switching [--agent A --auto on|off] [--agents on|off]`. The confirmation
/// before turning one on is the app's; this only stores what was confirmed.
pub fn set(data: &Path, args: &[String]) -> io::Result<Value> {
    let _one = STORE.lock().unwrap();
    let mut v = load(data);
    let on = |name: &str| -> io::Result<Option<bool>> {
        match flag(args, name) {
            None => Ok(None),
            Some("on") => Ok(Some(true)),
            Some("off") => Ok(Some(false)),
            Some(x) => Err(io::Error::other(format!("{name} takes on or off, not {x}"))),
        }
    };
    if let Some(name) = flag(args, "--agent") {
        let a = agent(name)?;
        if let Some(value) = on("--auto")? {
            if a.accounts().is_none() {
                return Err(io::Error::other(format!(
                    "{} keeps one login only",
                    a.label()
                )));
            }
            let list = v["auto"].as_array_mut().unwrap();
            list.retain(|x| x != a.name());
            if value {
                list.push(a.name().into());
            }
        }
    }
    if let Some(value) = on("--agents")? {
        v["agents"] = value.into();
    }
    save(data, &v)?;
    Ok(json!({"ok": true, "auto": v["auto"], "agents": v["agents"]}))
}

/// "Work (Claude Code)", "this computer's login (Claude Code)", or just the agent for one that
/// keeps one login.
fn label(v: &Value, a: &dyn Adapter, id: &str) -> String {
    if a.accounts().is_none() {
        return a.label().into();
    }
    let name = accounts_of(v, a.name())
        .into_iter()
        .find(|(x, _)| x == id)
        .map_or_else(|| id.to_string(), |(_, n)| n);
    // shortcut: an unnamed added account isn't named by its email here, which takes a check; read it if it's missed.
    let name = match (name.is_empty(), id.is_empty()) {
        (false, _) => &name,
        (true, true) => "this computer's login",
        (true, false) => "another account",
    };
    format!("{name} ({})", a.label())
}

/// Switches a session at its limit [D51]: to the account the user picked (`--account`, "" for the
/// computer's login), or, with `--auto`, to the one the settings allow, if any. A refused resume
/// starts a new conversation with a hand-off on the same account (D90 Q4).
pub fn switch_session(data: &Path, id: &str, pick: Option<&str>, auto: bool) -> io::Result<Value> {
    let mut r = attempt(data, id, pick, auto);
    // A log moved meanwhile (a note, a check) is no reason to give up on an automatic switch.
    for _ in 0..3 {
        match &r {
            Ok(v) if auto && v["error"] == "changed" => r = attempt(data, id, pick, auto),
            _ => break,
        }
    }
    // One that can't happen says so on its limit's row, with Try again, not only in a log [D51].
    let failed = match &r {
        Ok(v) if v["ok"] == true => None,
        Ok(v) if matches!(v["error"].as_str(), Some("off" | "not_limited" | "changed")) => None,
        Ok(v) => Some((v["message"].as_str().or(v["error"].as_str()).unwrap_or("")).to_string()),
        Err(e) => Some(e.to_string()),
    };
    if let Some(message) = failed.filter(|_| auto) {
        let to = r.as_ref().map_or(Value::Null, |v| v["to"].clone());
        let note = json!({"event": "switch_failed", "message": message, "to": to});
        let _ = owner::call(data, id, json!({"op": "note", "data": note}));
    }
    r
}

fn attempt(data: &Path, id: &str, pick: Option<&str>, auto: bool) -> io::Result<Value> {
    let spec = core::load(data, id)?;
    owner::ensure(data, &spec)?;
    crate::rewind::settled(data, &spec)?;
    let _fence = core::session::fence(data, &spec)?;
    // The host's state first, then the fold: the host refuses if the log moved in between.
    let ping = owner::call(data, id, json!({"op": "ping"}))?;
    let f = core::fold(&spec.dir, true)?.fold;
    let Some(why) = fold::switchable(&f) else {
        return Ok(
            json!({"ok": false, "error": "not_limited", "message": "This session isn't at a limit."}),
        );
    };
    let b = if f.backend.is_empty() {
        &spec.backend
    } else {
        &f.backend
    };
    let a = agent(b)?;
    let cur = f.accounts.get(b).cloned().unwrap_or_default();
    let v = {
        let _one = STORE.lock().unwrap();
        let mut v = load(data);
        // Skipped until its CLI said it resets [D74].
        if why == "limited" {
            let until = f.resets.unwrap_or(log::now_ms() + SKIP_MS);
            v["limited"][format!("{b}/{cur}")] = until.into();
            save(data, &v)?;
        }
        v
    };
    let from = label(&v, a, &cur);
    let mut target: Option<(&dyn Adapter, String, Option<String>)> = None;
    let mut kind = "accounts";
    if let Some(pick) = pick {
        if pick == cur || !accounts_of(&v, b).iter().any(|(x, _)| x == pick) {
            return Ok(
                json!({"ok": false, "error": "bad_account", "message": "Pick another account of this agent."}),
            );
        }
        target = Some((a, pick.to_string(), None));
    } else if why == "unresumable" && (!auto || listed(&v, "auto", b)) {
        target = Some((a, cur.clone(), None));
    } else if !auto {
        return Ok(
            json!({"ok": false, "error": "pick", "message": "Pick an account to switch to."}),
        );
    } else {
        if listed(&v, "auto", b) {
            target = pick_account(data, &v, a, &cur, &spec.cwd).map(|id| (a, id, None));
        }
        if target.is_none() && v["agents"] == true {
            kind = "agents";
            target = pick_agent(data, &v, b, &spec.cwd).map(|(a, id, m)| (a, id, Some(m)));
        }
    }
    let Some((to, account, model)) = target else {
        return Ok(
            json!({"ok": false, "error": "no_target", "message": "No other account or agent has room."}),
        );
    };
    let to_label = label(&v, to, &account);
    let name = (model.as_deref()).and_then(|m| model_name(data, to.name(), m, &spec.cwd));
    // Asked again last: a setting turned off meanwhile stops an automatic switch [D51].
    let still = || {
        let v = load(data);
        !auto
            || match kind {
                "agents" => v["agents"] == true,
                _ => listed(&v, "auto", b),
            }
    };
    let call = |req| owner::call(data, id, req);
    let target = Target {
        backend: to.name(),
        account: &account,
        model: model.as_deref(),
        name: name.as_deref(),
        label: &to_label,
        from: &from,
    };
    let mut reply = switch::switch(&spec, &f, &ping, &call, &target, auto, &still);
    reply["to"] = to_label.into();
    Ok(reply)
}

/// A model's name as the picker shows it, from the agent's last check here.
fn model_name(data: &Path, agent: &str, model: &str, cwd: &str) -> Option<String> {
    let args = ["agents", agent, "--cwd", cwd, "--cached"].map(String::from);
    let checks = crate::setup::run(data, &args).ok()?;
    let models = checks["agents"][0]["models"].as_array()?;
    let m = models.iter().find(|m| m["id"] == model)?;
    m["name"].as_str().map(String::from)
}

fn recent(v: &Value, key: &str) -> bool {
    v["limited"][key]
        .as_u64()
        .is_some_and(|until| log::now_ms() < until)
}

/// The next account of the same agent, in order, that isn't the current one, hit no limit lately,
/// and is signed in with a kind its home keeps apart (proposed).
fn pick_account(data: &Path, v: &Value, a: &dyn Adapter, cur: &str, cwd: &str) -> Option<String> {
    accounts_of(v, a.name())
        .into_iter()
        .map(|(id, _)| id)
        .filter(|id| id != cur && !recent(v, &format!("{}/{id}", a.name())))
        .find(|id| {
            let c = check(a, data, id, cwd);
            c["signed_in"] == true && c["kept_apart"] == true
        })
}

/// The next agent that is on, in adapter order (proposed), with a model usable in this project
/// on its login (or, when it switches accounts automatically, on one of its accounts with room),
/// and that model: the first it lists (proposed). Sign-in counts only where the model needs it,
/// which the agent's own model list already says [D43, D89].
fn pick_agent(
    data: &Path,
    v: &Value,
    from: &str,
    cwd: &str,
) -> Option<(&'static dyn Adapter, String, String)> {
    agents()
        .filter(|a| a.name() != from && a.exe().is_some())
        .filter(|a| crate::settings::enabled(data, a.name()))
        .find_map(|a| {
            let ids: Vec<String> = accounts_of(v, a.name())
                .into_iter()
                .map(|(id, _)| id)
                .filter(|id| id.is_empty() || listed(v, "auto", a.name()))
                .filter(|id| !recent(v, &format!("{}/{id}", a.name())))
                .collect();
            ids.into_iter().find_map(|id| {
                let c = check(a, data, &id, cwd);
                let model = c["models"][0].as_str()?.to_string();
                (c["kept_apart"] == true).then_some((a, id, model))
            })
        })
}

/// Whether the settings let the daemon act on a limit of `backend`: read once per limit, so off
/// costs nothing [D51].
/// What automatic switching depends on, without the limit times a switch itself writes, so a
/// setting or account change asks again about a session still at its limit [D51].
pub fn switch_settings(data: &Path) -> Value {
    let mut v = load(data);
    v["limited"] = Value::Null;
    v
}

pub fn wants(data: &Path, backend: &str, why: &str) -> bool {
    let v = load(data);
    listed(&v, "auto", backend) || (why == "limited" && v["agents"] == true)
}
