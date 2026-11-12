//! What Codex's app-server is told: the session's level as its own policy, turns and answers.

use super::super::{Delivery, s};
use crate::Spec;
use serde_json::{Value, json};

/// A level as Codex's approval policy, reviewer and sandbox [D175, D187]. Auto is the same policy
/// and sandbox as Ask with its auto reviewer, set per thread and turn, never in its config [D215].
fn level(spec: &Spec) -> (&'static str, &'static str, &'static str, &'static str) {
    match spec.level.as_deref() {
        Some("full") => ("never", "user", "danger-full-access", "dangerFullAccess"),
        Some("auto") => (
            "on-request",
            "auto_review",
            "workspace-write",
            "workspaceWrite",
        ),
        _ => ("on-request", "user", "workspace-write", "workspaceWrite"),
    }
}

/// `thread/start` or `thread/resume`'s settings.
pub fn open(spec: &Spec, resume: Option<&str>) -> Value {
    let (policy, reviewer, sandbox, _) = level(spec);
    // The commit style the message writer follows, so the agent's own commits match [D1029], and the `brigadier` line [D2025].
    let mut open = json!({"cwd": spec.cwd, "approvalPolicy": policy, "approvalsReviewer": reviewer, "sandbox": sandbox,
        "developerInstructions": crate::agent::standing()});
    if let Some(model) = &spec.model {
        open["model"] = model.as_str().into();
    }
    if let Some(id) = resume {
        open["threadId"] = id.into();
    }
    open["config"] = match spec.naked {
        true => naked(spec),
        false => json!({}),
    };
    // Its compaction can't be turned off: as late as it lets, so Brigadier's rebirth comes first [D88, D98].
    open["config"]["model_auto_compact_token_limit"] = 1_000_000_000u64.into();
    // Its plan tool, off unless asked for (codex-rs config `tools.update_plan`) [D104, D116].
    open["config"]["tools.update_plan.enabled"] = crate::rebirth::todo().into();
    open
}

/// A worker's overrides: no memory, plugins, apps, skills or MCP servers of its own [D89].
/// Codex can't turn its compaction off, so it keeps its own late one [D98].
fn naked(spec: &Spec) -> Value {
    let mut config = json!({"features.memories": false, "features.plugins": false,
        "features.apps": false, "skills.include_instructions": false, "skills.bundled.enabled": false});
    // Its servers can only be turned off by name: the user's and the project's.
    let home = super::super::cli_home(spec, ".codex", "");
    for server in servers(&home, std::path::Path::new(&spec.cwd)) {
        let name = server["name"].as_str().unwrap_or("");
        config[format!("mcp_servers.{name}.enabled")] = false.into();
    }
    config
}

/// Its MCP servers in the folder's `.codex/config.toml` and its home's, read only, each as the
/// relay takes it [D100].
// shortcut: `env_vars` and `bearer_token_env_var` aren't passed; upgrade with the library (4.12).
pub fn servers(home: &std::path::Path, folder: &std::path::Path) -> Vec<Value> {
    let mut all = vec![];
    for file in [folder.join(".codex/config.toml"), home.join("config.toml")] {
        let text = std::fs::read_to_string(file).unwrap_or_default();
        let Ok(doc) = text.parse::<toml_edit::DocumentMut>() else {
            continue;
        };
        let servers = doc.get("mcp_servers").and_then(|t| t.as_table_like());
        for (name, item) in servers.into_iter().flat_map(|t| t.iter()) {
            let mut d = json_of(item);
            d["name"] = name.into();
            d["headers"] = d["http_headers"].take();
            all.push(d);
        }
    }
    all
}

/// A TOML item as JSON: tables, arrays, strings, numbers and booleans.
fn json_of(item: &toml_edit::Item) -> Value {
    if let Some(t) = item.as_table_like() {
        let map: serde_json::Map<String, Value> =
            t.iter().map(|(k, v)| (k.to_string(), json_of(v))).collect();
        return map.into();
    }
    match item.as_value() {
        Some(toml_edit::Value::String(s)) => s.value().clone().into(),
        Some(toml_edit::Value::Boolean(b)) => (*b.value()).into(),
        Some(toml_edit::Value::Integer(i)) => (*i.value()).into(),
        Some(toml_edit::Value::Array(a)) => (a.iter())
            .map(|v| json_of(&toml_edit::Item::Value(v.clone())))
            .collect::<Vec<_>>()
            .into(),
        _ => Value::Null,
    }
}

/// A message as Codex's input: its text, then each image by its path [D2008], then each skill its
/// chips name by its name and file [D2009].
pub fn input(spec: &Spec, text: &str) -> Value {
    let images = (spec.images.iter()).map(|p| json!({"type": "localImage", "path": p}));
    let skills = (spec.commands.iter())
        .filter(|c| c["kind"] == "skill" && c["path"].is_string())
        .map(|c| json!({"type": "skill", "name": c["name"], "path": c["path"]}));
    std::iter::once(json!({"type": "text", "text": text}))
        .chain(images)
        .chain(skills)
        .collect()
}

/// A control message as the line for the helper [D159].
pub fn control(spec: &Spec, msg: &Value) -> Result<Delivery, String> {
    let line = match msg["kind"].as_str() {
        Some("answer") => answer(spec, msg)?,
        Some("steer") => json!({"id": spec.cid, "steer": input(spec, s(msg, &["text"]))}),
        Some("interrupt") => json!({"id": spec.cid, "interrupt": true}),
        _ => return Err("Codex takes no such control message.".into()),
    };
    Ok(Delivery::Stdin(format!("{line}\n")))
}

/// A command that runs at once: its compact, as `thread/compact/start` on the live thread [D2011].
pub fn command(spec: &Spec, name: &str) -> Result<Delivery, String> {
    match name {
        "compact" => Ok(Delivery::Stdin(format!(
            "{}\n",
            json!({"id": spec.cid, "compact": true})
        ))),
        _ => Err("This agent has no command by that name".into()),
    }
}

/// One line for the helper to send as `turn/start`. Level, model and effort ride on every turn, so
/// Codex checks them with the prompt and refuses it whole if it can't apply them [D222].
pub fn turn(spec: &Spec, text: &str) -> Value {
    let (policy, reviewer, _, sandbox) = level(spec);
    let mut turn = json!({"input": input(spec, text), "approvalPolicy": policy,
        "approvalsReviewer": reviewer, "sandboxPolicy": {"type": sandbox}, "clientUserMessageId": spec.cid});
    if let Some(model) = &spec.model {
        turn["model"] = model.as_str().into();
    }
    if let Some(effort) = &spec.effort {
        turn["effort"] = effort.as_str().into();
    }
    // Always named, so the thread never keeps a tier the session didn't pick; "default" is its
    // standard speed.
    let tier = if spec.fast {
        super::models::FAST_TIER
    } else {
        "default"
    };
    turn["serviceTier"] = tier.into();
    json!({"id": spec.cid, "turn": turn})
}

/// An answer as the line that carries Codex's own result. A deny's reason goes into the turn just
/// before the deny, so the agent reads it with the refusal [D192].
pub fn answer(spec: &Spec, msg: &Value) -> Result<Value, String> {
    let r = &msg["request"];
    let cli = &r["cli"];
    let decision = msg["decision"].as_str().unwrap_or("");
    let allowed = decision != "deny";
    let result = if r["items"].is_array() {
        answers(cli, msg)
    } else {
        match cli["method"].as_str().unwrap_or("") {
            "item/permissions/requestApproval" => match allowed {
                true => json!({"permissions": cli["permissions"], "scope": "turn"}),
                false => json!({"permissions": {}, "scope": "turn"}),
            },
            "mcpServer/elicitation/request" => match allowed {
                true => json!({"action": "accept", "content": {}}),
                false => json!({"action": "decline"}),
            },
            _ => json!({"decision": match decision {
                "allowSession" => "acceptForSession",
                "deny" => "decline",
                _ => "accept",
            }}),
        }
    };
    let mut line = json!({"id": spec.cid, "answer": {"rid": cli["rid"], "result": result}});
    if decision == "allowSession" {
        line["grant"] = r.clone();
    }
    let why = msg["reason"].as_str().map_or("", str::trim);
    if !allowed && !why.is_empty() {
        line["before"] = crate::adapters::denied(msg).into();
        line["thread"] = cli["thread"].clone();
        line["turn"] = cli["turn"].clone();
    }
    Ok(line)
}

/// A round's answers by question id, or the user's own message as the first one; a skipped
/// question stays out.
fn answers(cli: &Value, msg: &Value) -> Value {
    let ids = cli["ids"].as_array().cloned().unwrap_or_default();
    let given = match msg["reply"].as_str() {
        Some(reply) => vec![reply.into()],
        None => msg["answers"].as_array().cloned().unwrap_or_default(),
    };
    let mut out = serde_json::Map::new();
    for (id, a) in ids.iter().zip(&given) {
        if let (Some(id), Some(a)) = (id.as_str(), a.as_str()) {
            out.insert(id.into(), json!({"answers": [a]}));
        }
    }
    json!({"answers": out})
}
