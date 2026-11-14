//! Claude Code's control channel on stdin and stdout [D159]: its permission prompts and questions
//! come as `can_use_tool` requests and are answered by their `request_id`; Brigadier's own
//! requests (a stop, a new level or model) get a reply by theirs. Shapes per the Agent SDK's
//! public docs and types (code.claude.com/docs/en/agent-sdk/user-input).

use super::super::{Delivery, Event, Retune, cli_home, home_path, s, uuid};
use crate::Spec;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

/// A level as Claude's own permission mode: Auto is its real auto mode [D175].
pub fn mode(level: &str) -> &'static str {
    match level {
        "full" => "bypassPermissions",
        "auto" => "auto",
        _ => "default",
    }
}

/// The level a permission mode Claude reports runs at; None for a mode no level names.
fn level_of(mode: &str) -> Option<&'static str> {
    match mode {
        "default" => Some("ask"),
        "auto" => Some("auto"),
        "bypassPermissions" => Some("full"),
        _ => None,
    }
}

/// The model a session runs, as launch and a retune name it.
pub fn model(spec: &Spec) -> String {
    spec.model.clone().unwrap_or_else(|| "haiku".into())
}

/// A user message on stdin, its images as Claude's own base64 blocks [D2008].
pub fn user(text: &str, images: &[PathBuf]) -> String {
    let mut content = json!(text);
    if !images.is_empty() {
        let blocks = images.iter().filter_map(|p| {
            let data = brigadier_frames::base64(&std::fs::read(p).ok()?);
            Some(json!({"type": "image", "source": {"type": "base64", "media_type": crate::message::mime(p), "data": data}}))
        });
        content = std::iter::once(json!({"type": "text", "text": text}))
            .chain(blocks)
            .collect();
    }
    format!(
        "{}\n",
        json!({"type": "user", "message": {"role": "user", "content": content}})
    )
}

/// A request of Brigadier's own, and the id its reply will carry.
fn request(body: Value) -> (String, String) {
    let id = format!("brigadier-{}", uuid());
    let line = json!({"type": "control_request", "request_id": id, "request": body});
    (format!("{line}\n"), id)
}

/// A level or model change goes to the idle child as its own requests, confirmed before the
/// message [D222]; an effort has no such request, so the child starts again with it.
pub fn retune(last: &Spec, next: &Spec) -> Retune {
    if last.effort != next.effort {
        return Retune::Restart;
    }
    let mut changes = vec![];
    if let Some(level) = next.level.as_deref().filter(|_| last.level != next.level) {
        changes.push(json!({"subtype": "set_permission_mode", "mode": mode(level)}));
    }
    if model(last) != model(next) {
        changes.push(json!({"subtype": "set_model", "model": model(next)}));
    }
    if changes.is_empty() {
        return Retune::InMessage;
    }
    let (lines, ids): (Vec<String>, Vec<String>) = changes.into_iter().map(request).unzip();
    Retune::Confirm(Delivery::Stdin(lines.concat()), ids)
}

/// The commit style the message writer follows, so the agent's own commits match [D1029], and
/// the `brigadier` line [D2025]. Its own messages between sessions off, so every one goes through
/// Brigadier and shows in the thread [D2035]: none come in, and it can't list or message the
/// others. A subagent's final result comes back without `SendMessage` [D311].
/// A worker's launch: no MCP servers, skills or user settings, only the project's, and its own
/// memory off (code.claude.com/docs/en/env-vars) [D89].
pub fn naked(argv: &mut Vec<String>, env: &mut Vec<(String, String)>) {
    let flags = [
        "--strict-mcp-config",
        "--mcp-config",
        r#"{"mcpServers":{}}"#,
    ];
    let more = [
        "--disable-slash-commands",
        "--setting-sources",
        "project,local",
    ];
    argv.extend(flags.into_iter().chain(more).map(String::from));
    env.push(("CLAUDE_CODE_DISABLE_AUTO_MEMORY".into(), "1".into()));
}

/// Every launch's own env: no compaction, as Brigadier's rebirth stands in for it and `/compact`
/// still works [D88]; its to-do tool on every model, as TodoWrite's whole list
/// (code.claude.com/docs/en/tools-reference) [D104, D116].
pub fn own(env: &mut Vec<(String, String)>) {
    env.push(("DISABLE_AUTO_COMPACT".into(), "1".into()));
    if crate::rebirth::todo() {
        let todo = [
            ("CLAUDE_CODE_ENABLE_TODO_TOOLS", "1"),
            ("CLAUDE_CODE_ENABLE_TASKS", "0"),
        ];
        env.extend(todo.map(|(k, v)| (k.into(), v.into())));
    }
}

/// TodoWrite is deferred; `ENABLE_TOOL_SEARCH=false` loads it but costs 16-31k tokens [D250].
pub fn standing(spec: &Spec) -> [String; 6] {
    let load = "\n\nYour to-do tool, TodoWrite, is deferred: load it with ToolSearch `select:TodoWrite` before its first use.";
    [
        "--append-system-prompt".into(),
        crate::agent::standing(spec) + if crate::rebirth::todo() { load } else { "" },
        "--settings".into(),
        r#"{"attribution":{"commit":"","pr":""},"crossSessionInbound":"refuse"}"#.into(),
        "--disallowedTools".into(),
        "ListAgents,SendMessage".into(),
    ]
}

/// What a session grant allowed, as launch-time rules for a child started anew [D193].
pub fn rules(grants: &[Value]) -> Vec<String> {
    (grants.iter())
        .flat_map(|g| widen(&g["cli"]["rule"]))
        .filter_map(|r| {
            let (tool, content) = (s(&r, &["toolName"]), s(&r, &["ruleContent"]));
            (!tool.is_empty() && !content.is_empty()).then(|| format!("{tool}({content})"))
        })
        .collect()
}

/// A rule for one `brigadier` agent command, as every agent command's, so one approval covers
/// them all and nothing else [D2026].
fn widen(rule: &Value) -> Vec<Value> {
    let content = s(rule, &["ruleContent"]);
    if rule["toolName"] != "Bash" || !crate::agent::call(content) {
        return vec![rule.clone()];
    }
    // `mcp call` follows the session's level, so its grant covers only `list` and `tools` [D3023].
    let prefixes = (crate::agent::COMMANDS.iter()).flat_map(|c| match *c {
        "mcp" => vec!["mcp list".to_string(), "mcp tools".into()],
        c => vec![c.to_string()],
    });
    prefixes
        .map(|c| json!({"toolName": "Bash", "ruleContent": format!("brigadier {c}:*")}))
        .collect()
}

/// A line of the control channel, or None for any other line.
pub fn parse(v: &Value) -> Option<Vec<Event>> {
    let id = || s(v, &["request_id"]).to_string();
    let r = &v["request"];
    Some(match s(v, &["type"]) {
        "control_request" if s(r, &["subtype"]) == "can_use_tool" => match s(r, &["tool_name"]) {
            "AskUserQuestion" => vec![question(&id(), r)],
            _ => vec![approval(&id(), r)],
        },
        "control_request" => vec![Event::Unknown(v.to_string())],
        "control_cancel_request" => vec![Event::Resolved(id())],
        "control_response" => {
            let r = &v["response"];
            let error = (s(r, &["subtype"]) == "error").then(|| s(r, &["error"]).to_string());
            let level = s(r, &["response", "mode"]);
            vec![Event::Reply {
                id: s(r, &["request_id"]).into(),
                error,
                level: level_of(level).map(String::from),
            }]
        }
        _ => return None,
    })
}

/// The level a `system` line says the CLI runs at, if it says one.
pub fn level(v: &Value) -> Option<Event> {
    level_of(s(v, &["permissionMode"])).map(|l| Event::Level(l.into()))
}

/// A round of questions as D177's PendingQuestion; the questions as asked ride along, since the
/// answer must carry them back.
fn question(id: &str, r: &Value) -> Event {
    let asked = r["input"]["questions"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let items: Vec<Value> = (asked.iter())
        .map(|q| {
            let options: Vec<Value> = (q["options"].as_array().into_iter().flatten())
                .map(|o| json!({"label": o["label"], "description": o["description"]}))
                .collect();
            json!({"text": q["question"], "options": options, "recommended": null,
                   "multiSelect": q["multiSelect"] == true})
        })
        .collect();
    Event::Question(json!({"id": id, "title": null, "items": items, "cli": {"questions": asked}}))
}

/// A permission prompt as D177's PendingApproval. Its grant is the rule Claude suggests, kept for
/// this session only; the rule rides along for the answer.
fn approval(id: &str, r: &Value) -> Event {
    let (tool, input) = (s(r, &["tool_name"]), &r["input"]);
    let field = |k: &str| s(input, &[k]).to_string();
    let reason = match s(r, &["decision_reason"]) {
        "" if tool == "Bash" => field("description"),
        why => why.to_string(),
    };
    let suggested = (r["permission_suggestions"].as_array().into_iter().flatten())
        .filter(|u| u["type"] == "addRules")
        .flat_map(|u| u["rules"].as_array().cloned().unwrap_or_default())
        .find(|rule| rule["toolName"] == tool);
    let content = suggested
        .as_ref()
        .map(|rule| s(rule, &["ruleContent"]).to_string());
    // The ask names its step, for the thread to find it: allowed, the step reads after its ask.
    let mut a = json!({"id": id, "action": "other", "reason": (!reason.is_empty()).then_some(reason), "tool": r["tool_use_id"]});
    let mut grant = |scope: &str, pattern: &str, rule: Value| {
        a["grant"] = json!({"scope": scope, "pattern": pattern});
        a["cli"] = json!({"rule": rule});
    };
    match tool {
        "Bash" => {
            if let Some(c) = content.filter(|c| !c.is_empty()) {
                let prefix = c.trim_end_matches(" *").trim_end_matches(":*");
                let prefix = if crate::agent::call(&c) {
                    "brigadier"
                } else {
                    prefix
                };
                grant(
                    "command",
                    prefix,
                    json!({"toolName": tool, "ruleContent": c}),
                );
            }
            a["action"] = "command".into();
            a["command"] = field("command").into();
            if let Some(p) = r["blocked_path"].as_str() {
                a["paths"] = json!([p]);
            }
        }
        "Edit" | "MultiEdit" | "Write" | "NotebookEdit" => {
            let path = [field("file_path"), field("notebook_path")].concat();
            // Edits inside the file's folder, by Claude's absolute-path rule (`//path/**`).
            let dir = Path::new(&path).parent().map(|d| d.display().to_string());
            if let Some(dir) = dir.filter(|d| d.starts_with('/')) {
                let rule = json!({"toolName": "Edit", "ruleContent": format!("/{dir}/**")});
                grant("edits", &dir, rule);
            }
            a["action"] = "edit".into();
            a["paths"] = json!([path]);
        }
        "WebFetch" => {
            if let Some(host) = content.as_deref().and_then(|c| c.strip_prefix("domain:")) {
                grant(
                    "network",
                    host,
                    json!({"toolName": tool, "ruleContent": format!("domain:{host}")}),
                );
            }
            a["action"] = "network".into();
            a["host"] = host(&field("url")).into();
        }
        _ => a["input"] = format!("{tool} {input}").into(),
    }
    Event::Approval(a)
}

fn host(url: &str) -> &str {
    let rest = url.split_once("://").map_or(url, |(_, r)| r);
    rest.split(['/', ':', '?', '#']).next().unwrap_or("")
}

/// What a skipped question tells the agent; the model reads only the answer's text.
const SKIPPED: &str = "The user skipped this question. Use your own judgment.";

/// A control message as the line Claude reads [D159, D192, D193].
pub fn control(spec: &Spec, msg: &Value) -> Result<Delivery, String> {
    let line = match msg["kind"].as_str() {
        Some("steer") => return Ok(Delivery::Stdin(user(s(msg, &["text"]), &spec.images))),
        Some("interrupt") => {
            // Messages Claude still holds would run after a stop: they go with it.
            let (line, _) = request(json!({"subtype": "interrupt", "cancel_queued": true}));
            return Ok(Delivery::Stdin(line));
        }
        // Stopped through its own channel, it knows the user did it and doesn't wake to restart it [D117].
        Some("stop_task") if msg["task"].is_string() => {
            let (line, _) = request(json!({"subtype": "stop_task", "task_id": msg["task"]}));
            return Ok(Delivery::Stdin(line));
        }
        Some("answer") => {
            let r = &msg["request"];
            let response = if r["items"].is_array() {
                answers(r, msg)
            } else {
                decision(r, msg)?
            };
            json!({"type": "control_response", "response": {"subtype": "success", "request_id": r["id"], "response": response}})
        }
        _ => return Err("unknown control message".into()),
    };
    Ok(Delivery::Stdin(format!("{line}\n")))
}

/// A question's answers by question text, or the user's own message as a reply to the round.
fn answers(r: &Value, msg: &Value) -> Value {
    let asked = &r["cli"]["questions"];
    if let Some(reply) = msg["reply"].as_str() {
        return json!({"behavior": "allow", "updatedInput": {"questions": asked, "answers": {}, "response": reply}});
    }
    let given = msg["answers"].as_array().cloned().unwrap_or_default();
    let by_text: serde_json::Map<String, Value> = (asked.as_array().into_iter().flatten())
        .zip(given.iter().map(Some).chain(std::iter::repeat(None)))
        .map(|(q, a)| {
            let a = a.and_then(Value::as_str).unwrap_or(SKIPPED);
            (s(q, &["question"]).to_string(), a.into())
        })
        .collect();
    json!({"behavior": "allow", "updatedInput": {"questions": asked, "answers": by_text}})
}

/// An approval's decision. A session grant is held in the agent's memory only, never saved.
fn decision(r: &Value, msg: &Value) -> Result<Value, String> {
    Ok(match s(msg, &["decision"]) {
        "allow" => json!({"behavior": "allow"}),
        "allowSession" if r["cli"]["rule"].is_object() => json!({"behavior": "allow",
            "updatedPermissions": [{"type": "addRules", "rules": widen(&r["cli"]["rule"]), "behavior": "allow", "destination": "session"}]}),
        "deny" => json!({"behavior": "deny", "message": super::super::denied(msg)}),
        other => return Err(format!("no such decision here: {other:?}")),
    })
}

/// Its own commands, from its init line: skills and MCP prompts by name, the rest as commands, less
/// those bound to its terminal; none runs at once, each is sent as text [D164, D2009]. The line
/// names no files: `locate` finds them, knowing the account [D2098].
pub fn commands(v: &Value) -> Option<Event> {
    let names = |key: &str| -> Vec<&str> {
        (v[key].as_array().into_iter().flatten())
            .filter_map(Value::as_str)
            .collect()
    };
    let (skills, terminal) = (names("skills"), names("terminal_slash_commands"));
    let listed = names("slash_commands");
    let unlisted = skills
        .iter()
        .filter(|name| !listed.contains(name))
        .copied()
        .collect::<Vec<_>>();
    let list = (listed.iter().chain(&unlisted))
        .copied()
        .filter(|name| !terminal.contains(name));
    let list = list.map(|name| {
        let kind = if skills.contains(&name) {
            "skill"
        } else if name.starts_with("mcp__") {
            "mcp"
        } else {
            "command"
        };
        json!({"name": name, "description": "", "kind": kind, "path": null, "instant": false})
    });
    v["slash_commands"]
        .is_array()
        .then(|| Event::Commands(list.collect()))
}

/// Where it keeps skills and commands, in the old app's order: the project's `.claude`, then the
/// account's home (its CLAUDE_CONFIG_DIR), else ~/.claude (registry skills.rs, plugins/resolve.rs) [D2098].
fn roots(cwd: Option<&Path>, run: Option<&Spec>) -> Vec<PathBuf> {
    let home = run.map_or_else(
        || home_path(".claude"),
        |spec| cli_home(spec, ".claude", ""),
    );
    cwd.map(|cwd| cwd.join(".claude"))
        .into_iter()
        .chain([home])
        .collect()
}

/// A skill's or command's file under the first root holding it.
fn file_of(roots: &[PathBuf], kind: &str, name: &str) -> Option<PathBuf> {
    let rest = match kind {
        "skill" => format!("skills/{name}/SKILL.md"),
        "command" => format!("commands/{name}.md"),
        _ => return None,
    };
    roots
        .iter()
        .map(|root| root.join(&rest))
        .find(|path| path.is_file())
}

/// Each listed skill's or command's file, the project's before the account's.
pub fn locate(run: &Spec, list: &mut [Value]) {
    let roots = roots(Some(Path::new(&run.cwd)), Some(run));
    for each in list {
        if let Some(path) = file_of(&roots, s(each, &["kind"]), s(each, &["name"])) {
            each["path"] = json!(path);
        }
    }
}

/// Before its first init line: the old app's builtin commands, then the commands and skills its
/// folders hold, each by name once, as the old app scanned them [D2098].
pub fn fixed(cwd: Option<&Path>, run: Option<&Spec>) -> Vec<Value> {
    let builtin = [
        ("compact", "Compact this conversation"),
        ("context", "Show context usage"),
        ("cost", "Show session usage"),
        ("help", "Show Claude Code help"),
    ];
    let mut list: Vec<Value> = (builtin.iter())
        .map(|(name, description)| json!({"name": name, "description": description, "kind": "command", "path": null, "instant": false}))
        .collect();
    let roots = roots(cwd, run);
    for (kind, folder) in [("command", "commands"), ("skill", "skills")] {
        let mut names: Vec<String> = (roots.iter())
            .flat_map(|root| {
                std::fs::read_dir(root.join(folder))
                    .into_iter()
                    .flatten()
                    .flatten()
            })
            .filter_map(|entry| {
                let name = entry.file_name().to_string_lossy().to_string();
                match kind {
                    "skill" => entry.path().join("SKILL.md").is_file().then_some(name),
                    _ => name.strip_suffix(".md").map(String::from),
                }
            })
            .collect();
        names.sort();
        names.dedup();
        for name in names {
            if list.iter().any(|l| l["name"] == *name) {
                continue;
            }
            let path = file_of(&roots, kind, &name);
            list.push(json!({"name": name, "description": "", "kind": kind, "path": path, "instant": false}));
        }
    }
    // shortcut: only user-scope plugins, as `plugin:skill`; a project-scope one's enabling isn't read.
    let home = run.map_or_else(|| home_path(".claude"), |s| cli_home(s, ".claude", ""));
    let installed = std::fs::read(home.join("plugins/installed_plugins.json")).unwrap_or_default();
    let installed: Value = serde_json::from_slice(&installed).unwrap_or_default();
    let plugins =
        (installed["plugins"].as_object().into_iter().flatten()).flat_map(|(key, all)| {
            let at = (all.as_array().into_iter().flatten()).find(|i| i["scope"] == "user");
            let name = key.split('@').next().unwrap_or(key);
            at.map(|i| {
                (
                    PathBuf::from(s(i, &["installPath"])).join("skills"),
                    format!("{name}:"),
                )
            })
        });
    for more in super::super::files::skills_in(plugins.collect::<Vec<_>>()) {
        if !list.iter().any(|l| l["name"] == more["name"]) {
            list.push(more);
        }
    }
    list
}

/// An assistant message the CLI wrote for an API error, by the error its SDK types: a limit's own
/// words (its time comes from its rate_limit_event), no credits, no capacity or no such model.
pub fn api_error(v: &Value, text: String) -> Option<Event> {
    Some(match s(v, &["error"]) {
        "rate_limit" => Event::Limited(text, None),
        "billing_error" => Event::OutOfCredits,
        "overloaded" => Event::Failed("capacity", text),
        "model_not_found" => Event::Failed("model", text),
        _ => return None,
    })
}

/// A limit hit, from its rate_limit_event: its reset time is in seconds [D74, D220]. Rejected while
/// extra usage still pays, the turn carries on.
pub fn rate_limit(info: &Value) -> Vec<Event> {
    let overage = matches!(s(info, &["overageStatus"]), "allowed" | "allowed_warning");
    if info["status"] != "rejected" || overage {
        return vec![];
    }
    let words = match s(info, &["rateLimitType"]) {
        "five_hour" => "5-hour limit reached",
        t if t.starts_with("seven_day") => "Weekly limit reached",
        _ => "Usage limit reached",
    };
    vec![Event::Limited(
        words.into(),
        info["resetsAt"].as_u64().map(|t| t * 1000),
    )]
}
