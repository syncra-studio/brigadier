//! The model picker's data and its one change [D129, D190]: every agent's models from its last
//! check, grouped with its mark and efforts so the list shows at once [D123, D128], and `set`,
//! which records the model and effort the next turn takes, or the agent the next message goes to.

use crate::{owner, setup};
use brigadier_core as core;
use serde_json::{Value, json};
use std::io;
use std::path::Path;

fn flag<'a>(args: &'a [String], name: &str) -> Option<&'a str> {
    let i = args.iter().position(|a| a == name)?;
    args.get(i + 1).map(String::as_str)
}

/// The folder a session runs in, or `--cwd`.
fn cwd_of(data: &Path, args: &[String]) -> io::Result<String> {
    match flag(args, "--session") {
        Some(id) => {
            core::check_id(id)?;
            Ok(core::load(data, id)?.cwd)
        }
        None => Ok(flag(args, "--cwd").unwrap_or("").into()),
    }
}

/// One agent's check as a picker group. Not installed: no CLI found. Not signed in: nothing to
/// pick and no sign-in found (a CLI with free or local models lists them signed out) [D45].
/// A model from a check kept before efforts were reported has none, never guessed [D74].
fn group(check: &Value) -> Value {
    let unavailable = if check["path"].is_null() && check.get("path").is_some() {
        json!("install")
    } else if check["models"].as_array().is_none_or(Vec::is_empty) && check["signed_in"] == false {
        json!("sign-in")
    } else {
        Value::Null
    };
    let models: Vec<Value> = (check["models"].as_array().into_iter().flatten())
        .map(|m| {
            json!({"id": m["id"], "name": m.get("name").unwrap_or(&m["id"]), "local": m["local"],
                "efforts": m.get("efforts").cloned().unwrap_or_else(|| json!([])),
                "default_effort": m["default_effort"]})
        })
        .collect();
    json!({"provider": check["name"], "label": check["label"], "mark": check["mark"],
        "unavailable": unavailable, "models": models, "error": check["error"]})
}

/// `models [--session ID | --cwd D] [--fresh]`: the groups from each agent's last check in that
/// folder, at once; `--fresh` checks again first, for the page to ask after the first answer.
pub fn models(data: &Path, args: &[String]) -> io::Result<Value> {
    let mut ask = vec!["agents".to_string(), "--cwd".into(), cwd_of(data, args)?];
    if !args.iter().any(|a| a == "--fresh") {
        ask.push("--cached".into());
    }
    let reply = setup::run(data, &ask)?;
    let groups: Vec<Value> = reply["agents"]
        .as_array()
        .into_iter()
        .flatten()
        .map(group)
        .collect();
    Ok(json!({"ok": true, "groups": groups}))
}

/// `set <session> --agent B --model M [--effort E] --op OP` [D129, D218]: the conversation's own
/// agent takes M and E from its next turn; another agent is picked, and the next message goes to
/// it in a new conversation with the hand-off [D90]. Checked against B's last check in the
/// session's folder. One note in the log carries it, with the app's op id to reconcile by [D30].
pub fn set(data: &Path, args: &[String]) -> io::Result<Value> {
    let id = args.get(1).map_or("", String::as_str);
    let op = flag(args, "--op").unwrap_or("");
    let refuse = |error: &str, message: &str| {
        Ok(json!({"ok": false, "op": op, "error": error, "message": message}))
    };
    let (Some(b), Some(m)) = (flag(args, "--agent"), flag(args, "--model")) else {
        return Err(io::Error::other(
            "usage: brigadier set <session> --agent B --model M [--effort E] --op OP",
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
    let g = group(&checks["agents"][0]);
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
    let f = core::fold(&spec.dir, true)?.fold;
    let current = if f.backend.is_empty() {
        &spec.backend
    } else {
        &f.backend
    };
    if b != current && !f.turns.is_empty() {
        return refuse("busy", "Switch once this turn ends.");
    }
    owner::ensure(data, &spec)?;
    let note = json!({"event": "setup", "op": op, "backend": b, "model": m, "effort": effort});
    owner::call(data, id, json!({"op": "note", "data": note}))?;
    Ok(json!({"ok": true, "op": op}))
}
