//! What Codex's app-server is told: the session's level as its own policy, turns and answers.

use super::super::{Delivery, s};
use crate::Spec;
use serde_json::{Value, json};

/// A level as Codex's approval policy, reviewer and sandbox [D175, D187], set per thread and turn,
/// never in its config [D215]. Ask asks before every edit and command [D153]; Auto asks only to
/// leave the sandbox, and its auto reviewer answers.
fn level(spec: &Spec) -> (&'static str, &'static str, &'static str, &'static str) {
    match spec.level.as_deref() {
        Some("full") => ("never", "user", "danger-full-access", "dangerFullAccess"),
        Some("auto") => (
            "on-request",
            "auto_review",
            "workspace-write",
            "workspaceWrite",
        ),
        _ => ("untrusted", "user", "workspace-write", "workspaceWrite"),
    }
}

/// Codex's own Default mode says to assume rather than ask, so its question tool is named [D484].
const ASK: &str = include_str!("../../standing/codex-ask.txt");

/// Its sandbox blocks the daemon's socket, and weak models stop at that refusal instead of asking
/// to leave it, so it's said before the first call [D2026].
const ESCALATE: &str = include_str!("../../standing/codex-escalate.txt");

/// `thread/start` or `thread/resume`'s settings.
pub fn open(spec: &Spec, resume: Option<&str>) -> Value {
    let (policy, reviewer, sandbox, _) = level(spec);
    let escalate = if sandbox == "danger-full-access" {
        String::new()
    } else {
        format!(" {ESCALATE}")
    };
    // The commit style the message writer follows, so the agent's own commits match [D1029], and the `brigadier` line [D2025].
    let mut open = json!({"cwd": spec.cwd, "approvalPolicy": policy, "approvalsReviewer": reviewer, "sandbox": sandbox,
        "developerInstructions": format!("{}\n\n{ASK}{escalate}", crate::agent::standing(spec))});
    if let Some(model) = &spec.model {
        open["model"] = model.as_str().into();
    }
    if let Some(id) = resume {
        open["threadId"] = id.into();
    }
    open["config"] = match spec.naked {
        true => naked(spec),
        false => library(spec, &mut open),
    };
    // The ChatGPT app's computer-use plugins (`<plugin>@<marketplace>` in its plugin cache) go
    // around `brigadier computer` and its worker hand-off: off for this thread only [D943].
    let cache = super::super::cli_home(spec, ".codex", "plugins/cache");
    for market in (std::fs::read_dir(cache).into_iter()).flatten().flatten() {
        let plugins = (std::fs::read_dir(market.path()).into_iter())
            .flatten()
            .flatten();
        let market = market.file_name();
        for name in plugins.map(|p| p.file_name()) {
            let (name, market) = (name.to_string_lossy(), market.to_string_lossy());
            if name.contains("computer-use") {
                open["config"][format!("plugins.{name}@{market}.enabled")] = false.into();
            }
        }
    }
    // Brigadier's own `show_draft`, never asked about: it only shows the user a message [D529, D530].
    let me = (std::env::current_exe().unwrap_or_default()).with_file_name("brigadier");
    open["config"]["mcp_servers.brigadier.command"] = me.display().to_string().into();
    open["config"]["mcp_servers.brigadier.args"] = json!(["mcp-server"]);
    open["config"]["mcp_servers.brigadier.tools.show_draft.approval_mode"] = "approve".into();
    // Its memory as the switch says; `generate_memories` off keeps the thread out of its later
    // extraction too (codex-rs `thread_persistence_metadata`) [D2049].
    let memory = super::super::memory(spec);
    open["config"]["features.memories"] = memory.into();
    open["config"]["memories.generate_memories"] = memory.into();
    // Its compaction can't be turned off: as late as it lets, so Brigadier's rebirth comes first [D88, D98].
    open["config"]["model_auto_compact_token_limit"] = 1_000_000_000u64.into();
    // Its plan tool, off unless asked for (codex-rs config `tools.update_plan`) [D104, D116].
    open["config"]["tools.update_plan.enabled"] = crate::rebirth::todo().into();
    // Where a rule names Codex, its subagents start on the session's model and capped effort; its
    // `spawn_agent` can still name others [D376].
    if spec.ruled.touched {
        for (key, v) in [("model", &spec.model), ("reasoning_effort", &spec.effort)] {
            if let Some(v) = v {
                open["config"][format!("agents.default_subagent_{key}")] = v.as_str().into();
            }
        }
    }
    open
}

/// A worker's overrides: no plugins, apps, skills or MCP servers of its own [D89].
/// Codex can't turn its compaction off, so it keeps its own late one [D98].
fn naked(spec: &Spec) -> Value {
    let mut config = json!({"features.plugins": false,
        "features.apps": false, "skills.include_instructions": false, "skills.bundled.enabled": false});
    // Its servers can only be turned off by name: the user's and the project's; its plugins' go
    // with `features.plugins`.
    let home = super::super::cli_home(spec, ".codex", "");
    for server in servers(&home, std::path::Path::new(&spec.cwd)) {
        let name = server["name"].as_str().unwrap_or("");
        if !name.starts_with("plugin:") {
            config[format!("mcp_servers.{name}.enabled")] = false.into();
        }
    }
    config
}

/// The library for a session's thread [D2043]: its skills' folder as an extra root, which the
/// helper sets, its local servers by their Brigadier names, and the user's own copy of each, a
/// server by name and a skill by its file, off for this thread [D407].
fn library(spec: &Spec, open: &mut Value) -> Value {
    let mut config = json!({});
    let Some(kit) = crate::library::kit(spec, &[]) else {
        return config;
    };
    open["skillRoots"] = json!([kit.skills]);
    let (home, cwd) = (
        super::super::cli_home(spec, ".codex", ""),
        std::path::Path::new(&spec.cwd),
    );
    let (given, off) = crate::library::split(&kit.servers, &servers(&home, cwd));
    for s in &given {
        let name = crate::library::named(s["name"].as_str().unwrap_or(""));
        // A remote one at its `to`, with its headers (the proxy's bearer) [wave4 D2043].
        let keys: &[(&str, &str)] = match s["to"].is_string() {
            true => &[("to", "url"), ("headers", "http_headers")],
            false => &[("command", "command"), ("args", "args"), ("env", "env")],
        };
        for (from, key) in keys {
            if !s[*from].is_null() {
                config[format!("mcp_servers.{name}.{key}")] = s[*from].clone();
            }
        }
    }
    // shortcut: a plugin's own copy stays on, as only its whole plugin turns off; upgrade if asked.
    for name in off.iter().filter(|n| !n.starts_with("plugin:")) {
        config[format!("mcp_servers.{name}.enabled")] = false.into();
    }
    // A skill only by its app-server's own launch flag: a thread's config doesn't reach its list.
    let own = super::super::Adapter::fixed_commands(&super::Codex, Some(cwd), Some(spec));
    let off: Vec<String> = (own.iter())
        .filter(|k| k["kind"] == "skill" && kit.names.iter().any(|n| k["name"] == **n))
        .filter_map(|k| std::fs::canonicalize(k["path"].as_str()?).ok())
        .map(|p| format!("{{path = {}, enabled = false}}", json!(p)))
        .collect();
    if !off.is_empty() {
        // The flag replaces the user's own list, so theirs goes first.
        let mut all = skills_config(&home, cwd);
        all.extend(off);
        open["launch"] = json!(["-c", format!("skills.config=[{}]", all.join(", "))]);
    }
    config
}

/// The user's own `[[skills.config]]` entries, the folder's then its home's, as inline tables.
fn skills_config(home: &std::path::Path, folder: &std::path::Path) -> Vec<String> {
    let files = [folder.join(".codex/config.toml"), home.join("config.toml")];
    let docs = files.iter().filter_map(|f| {
        let text = std::fs::read_to_string(f).ok()?;
        text.parse::<toml_edit::DocumentMut>().ok()
    });
    let mut all = vec![];
    for doc in docs {
        let entries = doc.get("skills").and_then(|s| s.get("config"));
        let entries = entries
            .and_then(|c| c.as_array_of_tables())
            .into_iter()
            .flatten();
        all.extend(entries.map(|t| t.clone().into_inline_table().to_string()));
    }
    all
}

/// Its MCP servers in the folder's `.codex/config.toml` and its home's, read only, each as the
/// relay takes it [D100], and those of the plugins on in them, each with the file or plugin it
/// comes from [D565].
// shortcut: `env_vars` and `bearer_token_env_var` aren't passed; upgrade with the library (4.12).
pub fn servers(home: &std::path::Path, folder: &std::path::Path) -> Vec<Value> {
    let (mut all, mut on) = (vec![], std::collections::BTreeMap::new());
    for file in [folder.join(".codex/config.toml"), home.join("config.toml")] {
        let text = std::fs::read_to_string(&file).unwrap_or_default();
        let Ok(doc) = text.parse::<toml_edit::DocumentMut>() else {
            continue;
        };
        let servers = doc.get("mcp_servers").and_then(|t| t.as_table_like());
        for (name, item) in servers.into_iter().flat_map(|t| t.iter()) {
            let mut d = json_of(item);
            d["name"] = name.into();
            d["headers"] = d["http_headers"].take();
            d["source"] = file.display().to_string().into();
            all.push(d);
        }
        // Its plugins, `[plugins."<plugin>@<marketplace>"] enabled = …`, the folder's word first.
        let plugins = doc.get("plugins").and_then(|t| t.as_table_like());
        for (key, item) in plugins.into_iter().flat_map(|t| t.iter()) {
            if let Some(enabled) = item.get("enabled").and_then(|e| e.as_bool()) {
                on.entry(key.to_string()).or_insert(enabled);
            }
        }
    }
    for (key, _) in on.iter().filter(|(_, on)| **on) {
        let (plugin, market) = key.split_once('@').unwrap_or((key, ""));
        // shortcut: the last version folder by name; upgrade if Codex records the one in use.
        let dir = home.join("plugins/cache").join(market).join(plugin);
        let mut versions: Vec<_> = (std::fs::read_dir(dir).into_iter().flatten())
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.join(".codex-plugin/plugin.json").is_file())
            .collect();
        versions.sort();
        if let Some(root) = versions.last() {
            let manifest = ".codex-plugin/plugin.json";
            all.extend(crate::adapters::files::plugin_servers(
                root, manifest, key, None,
            ));
        }
    }
    all
}

/// Its servers but those that work only inside Codex, not shared with other agents: its bundled
/// plugins' (codex_app, cua_repl) and the ChatGPT app's (node_repl) [D722].
pub fn shared(home: &std::path::Path, folder: &std::path::Path) -> Vec<Value> {
    let mut all = servers(home, folder);
    let app = |c: &str| c.contains("/ChatGPT.app/") || c.contains("/Codex.app/");
    all.retain(|s| {
        let source = s["source"].as_str().unwrap_or("");
        !source.ends_with("@openai-bundled") && !s["command"].as_str().is_some_and(app)
    });
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
        // Codex has no channel for it: the note steers the turn that runs, else starts the wake
        // that joins the block [D117].
        Some("stop_task") => {
            let mut line = turn(spec, &super::super::stopped(msg));
            line["steer"] = line["turn"]["input"].clone();
            line
        }
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
    // A folder chat's copies commit into their repos' own git folders [D494].
    let mut roots = crate::folder::git_dirs(spec);
    roots.push(crate::background::tmp(&spec.dir).display().to_string());
    if sandbox == "workspaceWrite" {
        turn["sandboxPolicy"]["writableRoots"] = roots.into();
    }
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

/// A reload ahead of the message when the session's proxy couldn't connect Codex to a server: it
/// never dials a failed one again itself, and a reload dials them all.
pub fn redial(spec: &Spec) -> &'static str {
    match crate::library::unreached(spec).is_empty() {
        true => "",
        false => "{\"redial\":true}\n",
    }
}
