//! Switching a session at its limit [D51]: the settings, the pick (proposed: adapter order, the
//! first usable model, and a fixed window before a limited account is tried again), and the one
//! transition `core::switch` makes through the host.

pub mod rebirth;
pub mod reconnect;

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
pub(crate) fn label(v: &Value, a: &dyn Adapter, id: &str) -> String {
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
    let mut r = attempt(data, id, pick, auto, None);
    // A log moved meanwhile (a note, a check) is no reason to give up on an automatic switch.
    for _ in 0..3 {
        match &r {
            Ok(v) if auto && v["error"] == "changed" => r = attempt(data, id, pick, auto, None),
            _ => break,
        }
    }
    // One that can't happen says so on its limit's row, with Try again, not only in a log [D51].
    let failed = match &r {
        Ok(v) if v["ok"] == true => None,
        Ok(v)
            if matches!(
                v["error"].as_str(),
                Some("off" | "not_limited" | "changed" | "held")
            ) =>
        {
            None
        }
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

/// Where a switch goes: the agent, the account, and the model and effort where they change.
pub(crate) type To = (&'static dyn Adapter, String, Option<String>, Option<String>);

/// A worker's move the user's call on its hold made: to `to`, behind the same divider [D2028].
pub(crate) fn switch_to(data: &Path, id: &str, to: To) -> io::Result<Value> {
    attempt(data, id, None, false, Some(to))
}

fn attempt(
    data: &Path,
    id: &str,
    pick: Option<&str>,
    auto: bool,
    to: Option<To>,
) -> io::Result<Value> {
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
    // The account at the limit was removed since: the chat is on the login now [C40].
    let left = f
        .limit_on
        .as_deref()
        .is_some_and(|a| a != cur && core::gone(data, a));
    // Past a removed account's limit, the login it went on to counts as a way on.
    let skip = if left {
        f.limit_on.clone().unwrap_or_default()
    } else {
        cur.clone()
    };
    let v = {
        let _one = STORE.lock().unwrap();
        let mut v = load(data);
        // Skipped until its CLI said it resets [D74].
        if why == "limited" && !left {
            let until = f.resets.unwrap_or(log::now_ms() + SKIP_MS);
            v["limited"][format!("{b}/{cur}")] = until.into();
            v["limited_at"][format!("{b}/{cur}")] = log::now_ms().into();
            save(data, &v)?;
        }
        v
    };
    let from = label(&v, a, &cur);
    let mut target: Option<To> = None;
    let mut kind = "accounts";
    let mut ran = Value::Null;
    let link = crate::workers::link(data, id);
    // A reviewer's limit, or a fix turn's, is its end: never moved, its result goes on [D3026].
    if to.is_none() && pick.is_none() && link.as_ref().is_some_and(|l| !crate::workers::moves(l)) {
        return Ok(
            json!({"ok": false, "error": "review", "message": "A review's turn ends at its limit."}),
        );
    }
    let worker = link.is_some();
    if to.is_some() {
        target = to;
    } else if worker && pick.is_none() && auto {
        // A worker moves within its own job, never by the session switch; out of it, it holds
        // for the user's call [D2037, D2041, D2028].
        if f.hold.is_some() {
            return Ok(
                json!({"ok": false, "error": "held", "message": "It waits on the user's call."}),
            );
        }
        match crate::routing::next(data, id, &spec, &f, &skip)? {
            Some((t, r)) => (target, ran, kind) = (Some(t), r, "job"),
            None => {
                return Ok(
                    json!({"ok": false, "error": "held", "message": "Its job is out; the user decides."}),
                );
            }
        }
    } else if let Some(pick) = pick {
        if (pick == cur && !left) || !accounts_of(&v, b).iter().any(|(x, _)| x == pick) {
            return Ok(
                json!({"ok": false, "error": "bad_account", "message": "Pick another account of this agent."}),
            );
        }
        target = Some((a, pick.to_string(), None, None));
        // A worker's receipt and outcome name the account the user moved it to [D3018].
        if let Some(l) = link.as_ref().filter(|l| l.ran.is_object()) {
            ran = l.ran.clone();
            ran["account"] = Some(pick).filter(|p| !p.is_empty()).into();
            (ran["label"], ran["quota"]) = (
                crate::routing::account_label(&v, b, pick).into(),
                Value::Null,
            );
        }
    } else if why == "unresumable" && (!auto || listed(&v, "auto", b)) {
        target = Some((a, cur.clone(), None, None));
    } else if !auto {
        return Ok(
            json!({"ok": false, "error": "pick", "message": "Pick an account to switch to."}),
        );
    } else {
        if listed(&v, "auto", b) {
            target = pick_account(data, &v, a, &skip, &spec.cwd).map(|id| (a, id, None, None));
        }
        if target.is_none() && v["agents"] == true {
            kind = "agents";
            let now = f
                .models
                .get(b)
                .cloned()
                .or(spec.model.clone())
                .unwrap_or_default();
            target =
                pick_agent(data, &v, b, &now, &spec.cwd).map(|(a, id, m, e)| (a, id, Some(m), e));
        }
    }
    let Some((to, account, model, effort)) = target else {
        return Ok(
            json!({"ok": false, "error": "no_target", "message": "No other account or agent has room."}),
        );
    };
    // Whoever picked it, never onto an account Remove is taking away [C40].
    let leaving =
        |e: &Value| e["agent"] == to.name() && e["id"] == account.as_str() && core::marked(e);
    if v["accounts"].as_array().into_iter().flatten().any(leaving) {
        return Ok(
            json!({"ok": false, "error": "removing", "message": "This account is being removed."}),
        );
    }
    let to_label = label(&v, to, &account);
    let name = (model.as_deref()).and_then(|m| crate::routing::name_of(data, id, to.name(), m));
    // "Opus 5.5 had no account with room, so the next in Write code ran: Codex · GPT-6.1-Sol · High".
    // Only a move this switch made: a user's account pick keeps the start's note in the receipt.
    let moved = ran["note"]
        .as_str()
        .filter(|_| kind == "job" && ran["job"].is_string())
        .map(|n| {
            let words = [
                Some(to.short_label().to_string()),
                name.clone().or(model.clone()),
                effort.as_deref().map(crate::routing::capital),
            ];
            format!(
                "{n}: {}",
                words.into_iter().flatten().collect::<Vec<_>>().join(" · ")
            )
        });
    // Asked again last: a setting turned off meanwhile stops an automatic switch [D51].
    let still = || {
        let v = load(data);
        !auto
            || match kind {
                "agents" => v["agents"] == true,
                "job" => true,
                _ => listed(&v, "auto", b),
            }
    };
    let call = |req| owner::call(data, id, req);
    let target = Target {
        backend: to.name(),
        account: &account,
        model: model.as_deref(),
        effort: effort.as_deref(),
        name: name.as_deref(),
        label: &to_label,
        from: &from,
        moved: moved.as_deref(),
    };
    let told = crate::routing::told(data, &spec);
    let mut reply = switch::switch(&told, &f, &ping, &call, &target, auto, &still);
    // The turn it carries on reports in place of the one cut, by the log [D2041].
    if reply["ok"] == true && worker && !ran.is_null() {
        crate::routing::set_ran(data, id, ran)?;
    }
    reply["to"] = to_label.into();
    Ok(reply)
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

/// The next entry on another agent in the first job that holds the session's model, in the user's
/// order, on its login or, where it switches accounts automatically, an account with room; none
/// and it stays at its limit [D2028, D376]. Sign-in
/// counts only where the model needs it, which the agent's own model list already says [D43, D89].
fn pick_agent(
    data: &Path,
    v: &Value,
    from: &str,
    model: &str,
    cwd: &str,
) -> Option<(&'static dyn Adapter, String, String, Option<String>)> {
    let entries = crate::routing::after(data, from, model);
    entries.into_iter().find_map(|(a, m, e)| {
        let a = agents().find(|x| x.name() == a && x.exe().is_some())?;
        let ids: Vec<String> = accounts_of(v, a.name())
            .into_iter()
            .map(|(id, _)| id)
            .filter(|id| id.is_empty() || listed(v, "auto", a.name()))
            .filter(|id| !recent(v, &format!("{}/{id}", a.name())))
            .collect();
        ids.into_iter().find_map(|id| {
            let c = check(a, data, &id, cwd);
            let listed = (c["models"].as_array().into_iter().flatten()).any(|x| x == m.as_str());
            (c["kept_apart"] == true && listed).then(|| (a, id, m.clone(), e.clone()))
        })
    })
}

/// Whether the settings let the daemon act on a limit of `backend`: read once per limit, so off
/// costs nothing [D51].
/// What automatic switching depends on, without the limit times a switch itself writes, so a
/// setting or account change asks again about a session still at its limit [D51].
pub fn switch_settings(data: &Path) -> Value {
    let mut v = load(data);
    (v["limited"], v["limited_at"]) = (Value::Null, Value::Null);
    v
}

pub fn wants(data: &Path, backend: &str, why: &str) -> bool {
    let v = load(data);
    listed(&v, "auto", backend) || (why == "limited" && v["agents"] == true)
}
