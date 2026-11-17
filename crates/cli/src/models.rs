//! The model picker's data and its one change [D129, D190]: every agent's models from its last
//! check, grouped with its mark and efforts so the list shows at once [D123, D128], and `set`,
//! which records the model and effort the next turn takes, or the agent the next message goes to.

use crate::{flag, owner, setup};
use brigadier_core::adapters::{self, Adapter, s};
use brigadier_core::fold::Fold;
use brigadier_core::{self as core, Spec};
use serde_json::{Value, json};
use std::io;
use std::path::Path;

/// The folder a session runs in, a project's folder, or `--cwd`; and whether that project holds
/// its turns to Ask.
fn cwd_of(data: &Path, args: &[String]) -> io::Result<(String, bool)> {
    if let Some(id) = flag(args, "--session") {
        core::check_id(id)?;
        let spec = core::load(data, id)?;
        let held = core::projects::held(data, &spec);
        return Ok((spec.cwd, held));
    }
    let project = flag(args, "--project");
    let folder = project
        .and_then(|p| {
            core::projects::list(data)
                .ok()?
                .into_iter()
                .find(|r| r.id == p)
        })
        .map(|r| r.folder);
    let cwd = flag(args, "--cwd").map(String::from).or(folder);
    Ok((cwd.unwrap_or_default(), held(data, project)))
}

/// Whether a project holds its sessions' turns to Ask: untrusted or unanswered [D166]. No project
/// doesn't; records that can't be read do.
pub fn held(data: &Path, project: Option<&str>) -> bool {
    project.is_some_and(|id| core::projects::list(data).map_or(true, |all| held_in(&all, id)))
}

/// The same, from records already read.
pub fn held_in(projects: &[core::projects::Project], id: &str) -> bool {
    projects
        .iter()
        .any(|p| p.id == id && p.trusted != Some(true))
}

/// The level a new session starts on [D187, D201]: Ask while held, else the chosen default where
/// the agent has it, else its most restrictive (Ask on an agent with no auto mode).
pub fn default_level(a: &dyn Adapter, held: bool, chosen: &str) -> Option<&'static str> {
    let levels = a.can().levels;
    let want = if held { "ask" } else { chosen };
    match levels.iter().find(|l| **l == want) {
        None if held => None,
        found => found.or(levels.first()).copied(),
    }
}

/// The agent a session's next message goes to: one the user picked, else its own [D90, D225].
pub fn next_agent<'a>(spec: &'a Spec, f: &'a Fold) -> &'a str {
    match &f.picked {
        Some(p) => &p.backend,
        None if f.backend.is_empty() => &spec.backend,
        None => &f.backend,
    }
}

/// An agent's levels and the one its new session starts on there [D129, D175, D187].
fn levels(name: &Value, held: bool, chosen: &str) -> (Value, Value) {
    match adapters::get(name.as_str().unwrap_or("")) {
        Some(a) => (json!(a.can().levels), json!(default_level(a, held, chosen))),
        None => (json!([]), Value::Null),
    }
}

/// One agent's check as a picker group. Not installed: no CLI found. Not signed in: nothing to
/// pick and no sign-in found (a CLI with free or local models lists them signed out) [D45].
/// A model from a check kept before efforts were reported has none, never guessed [D74]. Models
/// named in `hidden` (`<agent>/<id>`) are left out [D2082].
fn group(check: &Value, held: bool, chosen: &str, hidden: &[Value]) -> Value {
    let unavailable = if check["path"].is_null() && check.get("path").is_some() {
        json!("install")
    } else if check["models"].as_array().is_none_or(Vec::is_empty) && check["signed_in"] == false {
        json!("sign-in")
    } else {
        Value::Null
    };
    let models: Vec<Value> = (check["models"].as_array().into_iter().flatten())
        .filter(|m| {
            let id = format!("{}/{}", s(check, &["name"]), s(m, &["id"]));
            !hidden.iter().any(|h| *h == id)
        })
        .map(|m| {
            json!({"id": m["id"], "name": m.get("name").unwrap_or(&m["id"]), "local": m["local"],
                "efforts": m.get("efforts").cloned().unwrap_or_else(|| json!([])),
                "default_effort": m["default_effort"], "retiring": m["retiring"], "images": m["images"],
                "fast": m["fast"], "legacy": m["legacy"] == true,
                "top": m["top"] == true, "default": m["default"] == true})
        })
        .collect();
    let (levels, level) = levels(&check["name"], held, chosen);
    json!({"provider": check["name"], "label": check["label"], "short": check["short"], "mark": check["mark"],
        "unavailable": unavailable, "models": models, "error": check["error"],
        "levels": levels, "level": level, "held": held})
}

/// `models [--session ID | --project P | --cwd D] [--fresh] [--all]`: the groups from each agent's last
/// check in that folder, at once; `--fresh` checks again first, for the page to ask after the first
/// answer. Each carries its levels and the one a new session there starts on. Agents turned off
/// and models hidden are left out, and those a rule bars unless `--all`.
pub fn run(data: &Path, args: &[String]) -> io::Result<Value> {
    if args[0] == "set" {
        return set(data, args);
    }
    let (cwd, held) = cwd_of(data, args)?;
    // A folder that's gone has no agent to check: it says so, never that no model is there.
    if let Some(why) = Some(&cwd)
        .filter(|c| !c.is_empty())
        .and_then(|c| brigadier_frames::procs::gone(c))
    {
        return Err(io::Error::other(why));
    }
    let mut ask = vec!["agents".to_string()];
    // No folder (a chat with no project): the home folder's check.
    if !cwd.is_empty() {
        ask.extend(["--cwd".into(), cwd]);
    }
    if !args.iter().any(|a| a == "--fresh") {
        ask.push("--cached".into());
    }
    let reply = setup::run(data, &ask)?;
    let chosen = crate::settings::get(data, "default_level");
    // An agent turned off or a model hidden is left out, but a session keeps those it is on [D2079, D2082].
    let (own, on) = match flag(args, "--session") {
        Some(id) => {
            let spec = core::load(data, id)?;
            let f = core::fold(&spec.dir, true)?.fold;
            let mut on: Vec<String> = f.models.iter().map(|(b, m)| format!("{b}/{m}")).collect();
            on.extend(
                f.picked
                    .as_ref()
                    .map(|p| format!("{}/{}", p.backend, p.model)),
            );
            on.extend(spec.model.as_ref().map(|m| format!("{}/{m}", spec.backend)));
            let agents = vec![next_agent(&spec, &f).to_string(), f.backend, spec.backend];
            (agents, on)
        }
        None => (vec![], vec![]),
    };
    let mut hidden = crate::settings::read(data)["models_off"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    hidden.retain(|h| !on.iter().any(|m| h == m));
    let mut groups: Vec<Value> = reply["agents"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|check| check["enabled"] == true || own.iter().any(|b| check["name"] == *b))
        .map(|check| {
            let mut g = group(check, held, &chosen, &hidden);
            g["usage"] = crate::usage::of_agent(data, check["name"].as_str().unwrap_or(""));
            g
        })
        .collect();
    // The pickers never offer what a rule bars; `--all` is Settings › Routing's own list [D376].
    if !args.iter().any(|a| a == "--all") {
        crate::routing::picks(data, &mut groups);
    }
    Ok(json!({"ok": true, "groups": groups}))
}

/// `set <session> --agent B --model M [--effort E] [--fast] --op OP` [D129, D557]: the
/// conversation's own agent takes M, E and the fast tier (where M has one) from its next turn;
/// another agent is picked, and the next message goes to it in a new conversation with the
/// hand-off [D90]. Checked against B's last check in the
/// session's folder. One note in the log carries it, with the app's op id to reconcile by [D30].
fn set(data: &Path, args: &[String]) -> io::Result<Value> {
    let id = args.get(1).map_or("", String::as_str);
    let op = flag(args, "--op").unwrap_or("");
    let refuse = |error: &str, message: &str| {
        Ok(json!({"ok": false, "op": op, "error": error, "message": message}))
    };
    // Switch now: the agent picked mid-turn stops the turn and carries on from there [D557].
    if args.iter().any(|a| a == "--now") {
        let spec = core::load(data, id)?;
        if core::fold(&spec.dir, true)?.fold.picked.is_none() {
            return refuse("no_pick", "No other agent is picked.");
        }
        let note = json!({"event": "switch_now", "op": op});
        owner::ensure(data, &spec)?;
        owner::call(data, id, json!({"op": "note", "data": note}))?;
        return Ok(json!({"ok": true, "op": op}));
    }
    let (Some(b), Some(m)) = (flag(args, "--agent"), flag(args, "--model")) else {
        return Err(io::Error::other(
            "usage: brigadier set <session> --agent B --model M [--effort E] [--fast] --op OP",
        ));
    };
    let effort = flag(args, "--effort");
    let spec = core::load(data, id)?;
    let checks = setup::run(
        data,
        &[
            "agents".into(),
            b.into(),
            "--cwd".into(),
            spec.cwd.clone(),
            "--cached".into(),
        ],
    )?;
    let g = group(&checks["agents"][0], false, "", &[]);
    if !g["unavailable"].is_null() {
        return refuse(
            "not_set_up",
            &format!("{} isn't set up.", g["label"].as_str().unwrap_or(b)),
        );
    }
    let Some(model) = g["models"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|x| x["id"] == m)
    else {
        return refuse("no_model", "That model isn't available here.");
    };
    let efforts = model["efforts"].as_array().cloned().unwrap_or_default();
    // No effort: the CLI's own default.
    if effort.is_some_and(|e| !efforts.iter().any(|x| x == e)) {
        return refuse("no_effort", "That effort isn't one this model has.");
    }
    let fast = args.iter().any(|a| a == "--fast");
    if fast && model["fast"].is_null() {
        return refuse("no_fast", "This model has no fast tier.");
    }
    let f = core::fold(&spec.dir, true)?.fold;
    let current = if f.backend.is_empty() {
        &spec.backend
    } else {
        &f.backend
    };
    // The thread's line names both sides as the picker does [D76].
    let name = |id: &str| {
        let models = g["models"].as_array().into_iter().flatten();
        models
            .into_iter()
            .find(|x| x["id"] == id)
            .map(|x| x["name"].clone())
    };
    let label = |b: &str| adapters::get(b).map_or_else(|| b.to_string(), |a| a.label().into());
    let now = f
        .models
        .get(b)
        .cloned()
        .or_else(|| spec.model.clone().filter(|_| *b == spec.backend));
    let note = json!({"event": "setup", "op": op, "backend": b, "model": m, "effort": effort,
        "fast": fast, "pick": b != current, "name": model["name"], "was": now.and_then(|n| name(&n)),
        "from_label": label(current), "to_label": label(b)});
    owner::ensure(data, &spec)?;
    owner::call(data, id, json!({"op": "note", "data": note}))?;
    Ok(json!({"ok": true, "op": op}))
}
