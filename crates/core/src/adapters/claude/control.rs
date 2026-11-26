//! Claude Code's control channel on stdin and stdout [D159]: its permission prompts and questions
//! come as `can_use_tool` requests and are answered by their `request_id`; Brigadier's own
//! requests (a stop, a new level or model) get a reply by theirs. Shapes per the Agent SDK's
//! public docs and types (code.claude.com/docs/en/agent-sdk/user-input).

use super::super::{Delivery, Event, Retune, s, uuid, uuid_of};
use crate::Spec;
use serde_json::{Map, Value, json};
use std::path::{Path, PathBuf};

/// A level as Claude's own permission mode: Auto is its real auto mode [D175].
pub fn mode(level: &str) -> &'static str {
    match level {
        "full" => "bypassPermissions",
        "auto" => "auto",
        _ => "default",
    }
}

/// An action its rule or reviewer turned down [D487]; or one its auto mode's check gave no verdict
/// on (unavailable, an outage, no check this session), never judged: the turn asks instead [D455].
// shortcut: a single outage denial has no code, only its words; match a code if the CLI gives one.
pub fn denied(v: &Value) -> Event {
    let unchecked = v["decision_reason_type"] == "classifier"
        && (s(v, &["decision_reason_code"]).starts_with("auto_mode_")
            || s(v, &["decision_reason"]) == "Classifier unavailable"
            || s(v, &["message"]).contains("cannot determine the safety"));
    if unchecked {
        Event::Unchecked
    } else {
        Event::Denied
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

/// A user message on stdin, its images as Claude's own base64 blocks [D2008]. Under its command id's
/// UUID, which the turn that takes it echoes (the Agent SDK's `SDKUserMessage.uuid`) [D66].
pub fn user(text: &str, images: &[PathBuf], cid: Option<&str>) -> String {
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
    let mut line = json!({"type": "user", "message": {"role": "user", "content": content}});
    if let Some(cid) = cid {
        line["uuid"] = uuid_of(cid).into();
    }
    format!("{line}\n")
}

/// A request of Brigadier's own, and the id its reply will carry.
fn request(body: Value) -> (String, String) {
    let id = format!("brigadier-{}", uuid());
    let line = json!({"type": "control_request", "request_id": id, "request": body});
    (format!("{line}\n"), id)
}

/// Asks Claude to connect again each server the session's proxy couldn't answer its connect for
/// (the Agent SDK's `reconnectMcpServer`), before the message: it never dials a failed one itself.
pub fn redial(spec: &Spec) -> String {
    (crate::library::unreached(spec).iter())
        .map(|name| request(json!({"subtype": "mcp_reconnect", "serverName": name})).0)
        .collect()
}

/// A level or model change goes to the idle child as its own requests, confirmed before the
/// message [D222]; an effort, or its subagents' allowlist, has no such request, so the child starts
/// again with it [D376].
pub fn retune(last: &Spec, next: &Spec) -> Retune {
    if last.effort != next.effort || last.ruled.models != next.ruled.models {
        return Retune::Restart;
    }
    let mut changes = vec![];
    if let Some(level) = next.level.as_deref().filter(|_| last.level != next.level) {
        changes.push(json!({"subtype": "set_permission_mode", "mode": mode(level)}));
    }
    if last.model != next.model {
        // With none picked, the alias of its own default.
        let model = next.model.as_deref().unwrap_or("default");
        changes.push(json!({"subtype": "set_model", "model": model}));
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
/// A worker's launch: no MCP servers, skills or user settings, only the project's [D89], and
/// `servers`, Slack's when its project has it on [D586].
pub fn naked(argv: &mut Vec<String>, servers: Map<String, Value>) {
    let servers = json!({ "mcpServers": servers }).to_string();
    let flags = ["--strict-mcp-config", "--mcp-config", &servers];
    let more = [
        "--disable-slash-commands",
        "--setting-sources",
        "project,local",
    ];
    argv.extend(flags.into_iter().chain(more).map(String::from));
}

/// Every launch's own env: no compaction, as Brigadier's rebirth stands in for it and `/compact`
/// still works [D88]; its to-do tool on every model, as TodoWrite's whole list
/// (code.claude.com/docs/en/tools-reference) [D104, D116]; its auto memory as the switch says, `0`
/// even over the user's `autoMemoryEnabled: false` (code.claude.com/docs/en/env-vars) [D2049].
pub fn own(spec: &Spec, env: &mut Vec<(String, String)>) {
    env.push(("DISABLE_AUTO_COMPACT".into(), "1".into()));
    let memory = if super::super::memory(spec) { "0" } else { "1" };
    env.push(("CLAUDE_CODE_DISABLE_AUTO_MEMORY".into(), memory.into()));
    if crate::rebirth::todo() {
        let todo = [
            ("CLAUDE_CODE_ENABLE_TODO_TOOLS", "1"),
            ("CLAUDE_CODE_ENABLE_TASKS", "0"),
        ];
        env.extend(todo.map(|(k, v)| (k.into(), v.into())));
    }
}

/// TodoWrite is deferred; `ENABLE_TOOL_SEARCH=false` loads it but costs 16-31k tokens [D250].
/// The text is rendered fresh, as its record would pin a conversation's first for good, on CLIs
/// that know the flag; one whose version can't be read doesn't get it [D526].
pub fn standing(spec: &Spec) -> Vec<String> {
    let load = concat!("\n\n", include_str!("../../standing/claude-todo.txt"));
    let fresh = crate::adapters::setup::newer(&crate::cli_version(spec, &super::Claude), "2.1.321");
    // Its `Stop` hook sends a reply that asks in prose back once, inside the turn [D529], and
    // `show_draft` shows a message for someone as a card [D529, D530].
    let me = (std::env::current_exe().unwrap_or_default()).with_file_name("brigadier");
    let stop = format!(
        "'{}' hook stop claude",
        me.display().to_string().replace('\'', r"'\''")
    );
    // Brigadier's own tools, always loaded and never asked about: they only show the user things.
    let tools = json!({"mcpServers": {"brigadier": {"command": me, "args": ["mcp-server"], "alwaysLoad": true}}});
    // Its thinking as summaries, so thoughts are lines of the work [D752].
    // The desktop app's synced computer-use skill says computer use is missing; here it's
    // `brigadier computer`, so that skill is refused with the way to it [D922].
    let skill = "grep -q 'computer-use\"' || exit 0; echo 'Not here: in Brigadier the user'\\''s Mac apps are `brigadier computer`; `brigadier help computer` says how.' >&2; exit 2";
    // osascript to System Events or an app, and cliclick, drive the user's apps in front of them:
    // refused, with the way that stays behind (proposed) [D929].
    let drive = "i=$(cat); case \"$i\" in *cliclick*) ;; *osascript*) printf %s \"$i\" | grep -qiE 'system +events|tell +app|application *\\(' || exit 0;; *) exit 0;; esac; echo 'Refused: osascript to System Events or an app, and cliclick, drive the user'\\''s apps in front of them. Use `brigadier computer` (in the background); `brigadier help computer` says how.' >&2; exit 2";
    let mut settings = json!({"attribution": {"commit": "", "pr": ""}, "crossSessionInbound": "refuse", "showThinkingSummaries": true, "hooks": {
        "PreToolUse": [{"matcher": "Bash", "hooks": [{"type": "command", "command": "cat"}]},
            {"matcher": "Bash", "hooks": [{"type": "command", "command": drive}]},
            {"matcher": "Skill", "hooks": [{"type": "command", "command": skill}]}]},
        "permissions": {"allow": ["mcp__brigadier__show_draft"]}});
    // A worker's last words go to its lead as its result, a question included.
    if !spec.naked {
        settings["hooks"]["Stop"] = json!([{"hooks": [{"type": "command", "command": stop}]}]);
    }
    // A folder chat reads the repos where they are, and its edit hook keeps it out of them [D494].
    let home = crate::folder::of(spec).map(|p| p.folder);
    if home.is_some() {
        let edit = stop.replace("hook stop", "hook edit");
        // Every tool but the ones known to only read, so an editor it adds is kept out too; the hook
        // passes one that names no file.
        let guard = json!({"matcher": "^(?!(Read|Grep|Glob|LS|LSP|NotebookRead|Bash|WebFetch|WebSearch)$).*", "hooks": [{"type": "command", "command": edit}]});
        if let Some(hooks) = settings["hooks"]["PreToolUse"].as_array_mut() {
            hooks.push(guard);
        }
        // A claim only makes the chat's own copy: Auto's classifier refused it once in the drill.
        if let Some(allow) = settings["permissions"]["allow"].as_array_mut() {
            allow.push("Bash(brigadier repo:*)".into());
        }
    }
    // A worker's launch leaves the user's settings out, and their global rules file with them:
    // given here, as the plan says a worker has it [D89, D99].
    // An added account's home links it only if it was there when the account was made.
    let files = [
        super::super::cli_home(spec, ".claude", "CLAUDE.md"),
        crate::adapters::home_path(".claude/CLAUDE.md"),
    ];
    let rules = files.iter().find_map(|f| std::fs::read_to_string(f).ok());
    let rules =
        (rules.filter(|_| spec.naked)).map_or(String::new(), |r| format!("\n\n{}", r.trim()));
    let mut args = vec![
        "--append-system-prompt".into(),
        crate::agent::standing(spec) + if crate::rebirth::todo() { load } else { "" } + &rules,
        "--settings".into(),
        settings.to_string(),
        "--disallowedTools".into(),
        "ListAgents,SendMessage".into(),
    ];
    // A run with no tools gets none of Brigadier's either: `--tools ""` leaves MCP's [D771].
    if !spec.opts.contains_key("no_tools") {
        args.extend(["--mcp-config".into(), tools.to_string()]);
    }
    if fresh {
        args.extend(["--system-prompt-snapshot".into(), "off".into()]);
    }
    let dirs = home.into_iter().chain(crate::background::writable(spec));
    args.extend(dirs.flat_map(|d| ["--add-dir".into(), d]));
    args
}

/// What a session grant allowed, as launch-time rules for a child started anew [D193].
pub fn rules(grants: &[Value]) -> Vec<String> {
    (grants.iter())
        .flat_map(|g| (g["cli"]["rules"].as_array().into_iter().flatten()).flat_map(widen))
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
    // `mcp call` and `mcp tools` follow the session's level, so its grant covers only the list
    // [D3023]; the browser asks on its own card [D533].
    let prefixes = (crate::agent::COMMANDS.iter()).map(|c| match *c {
        "mcp" => "mcp list".to_string(),
        c => c.to_string(),
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
        // A request of a kind it adds: shown, and either choice tells it there's no answer, so its
        // turn never waits on one unseen.
        "control_request" => vec![Event::Approval(
            json!({"id": id(), "action": "other", "reason": "Brigadier can't answer this request. Either choice turns it down.",
            "input": s(r, &["subtype"]), "cli": {"unknown": true}}),
        )],
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

/// A permission prompt as D177's PendingApproval. Its grant is the rule Claude suggests, else the
/// narrowest that allows this request again, kept for this session only [D167]; the rule rides
/// along for the answer.
fn approval(id: &str, r: &Value) -> Event {
    let (tool, input) = (s(r, &["tool_name"]), &r["input"]);
    let field = |k: &str| s(input, &[k]).to_string();
    let reason = match s(r, &["decision_reason"]) {
        "" if tool == "Bash" => field("description"),
        why => why.to_string(),
    };
    let suggested: Vec<Value> = (r["permission_suggestions"].as_array().into_iter().flatten())
        .filter(|u| u["type"] == "addRules")
        .flat_map(|u| u["rules"].as_array().cloned().unwrap_or_default())
        .filter(|rule| rule["toolName"] == tool && !s(rule, &["ruleContent"]).is_empty())
        .collect();
    let content = (suggested.first()).map(|rule| s(rule, &["ruleContent"]).to_string());
    // The ask names its step, for the thread to find it: allowed, the step reads after its ask.
    let mut a = json!({"id": id, "action": "other", "reason": (!reason.is_empty()).then_some(reason), "tool": r["tool_use_id"]});
    let mut grant = |scope: &str, pattern: &str, rules: Vec<Value>| {
        a["grant"] = json!({"scope": scope, "pattern": pattern});
        a["cli"] = json!({"rules": rules});
    };
    match tool {
        "Bash" => {
            let (command, agent) = (field("command"), crate::agent::call(&field("command")));
            // Claude matches no rule to a nested command or a variable: Brigadier answers repeats [D389].
            let rules = match agent {
                true => vec![json!({"toolName": tool, "ruleContent": command})],
                false if command.contains(['$', '`']) => vec![],
                false => match crate::agent::mcp_prefix(&command) {
                    Some(p) => vec![json!({"toolName": tool, "ruleContent": format!("{p}:*")})],
                    // Nor `brigadier mcp *` for one part of a longer command.
                    None => (suggested.into_iter())
                        .filter(|r| {
                            let first = s(r, &["ruleContent"]).split([' ', ':']).next();
                            !first.is_some_and(|w| w.rsplit('/').next() == Some("brigadier"))
                        })
                        .collect(),
                },
            };
            let first = (rules.first()).map(|r| s(r, &["ruleContent"]).trim_end_matches(" *"));
            let first = first.map(|p| p.trim_end_matches(":*").to_string());
            let pattern = (agent.then(|| "brigadier".into()))
                .or(first)
                .unwrap_or(command.clone());
            if !command.is_empty() {
                grant("command", &pattern, rules);
            }
            a["action"] = "command".into();
            a["command"] = field("command").into();
            a["whole"] = a["command"].clone();
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
                grant("edits", &dir, vec![rule]);
            }
            a["action"] = "edit".into();
            a["paths"] = json!([path]);
        }
        "WebFetch" => {
            let url = field("url");
            let host = content.as_deref().and_then(|c| c.strip_prefix("domain:"));
            if let Some(host) = host.or(Some(self::host(&url))).filter(|h| !h.is_empty()) {
                grant(
                    "network",
                    host,
                    vec![json!({"toolName": tool, "ruleContent": format!("domain:{host}")})],
                );
            }
            a["action"] = "network".into();
            a["host"] = self::host(&url).into();
        }
        // Its plan mode's end: build the plan, or reply to change it; nothing to grant [D177, §6].
        "ExitPlanMode" => {
            a["action"] = "plan".into();
            a["body"] = field("plan").into();
        }
        _ => {
            let pattern = content.as_deref().filter(|c| !c.is_empty());
            let pattern = pattern.map_or(tool.to_string(), |c| format!("{tool}({c})"));
            grant(
                "tool",
                &pattern,
                vec![(suggested.first().cloned()).unwrap_or(json!({"toolName": tool}))],
            );
            a["input"] = format!("{tool} {input}").into();
        }
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
        Some("steer") => {
            let cid = spec.cid.as_deref();
            return Ok(Delivery::Stdin(user(s(msg, &["text"]), &spec.images, cid)));
        }
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
            if r["cli"]["unknown"] == true {
                let error = "Brigadier doesn't handle this request.";
                let line = json!({"type": "control_response", "response": {"subtype": "error", "request_id": r["id"], "error": error}});
                return Ok(Delivery::Stdin(format!("{line}\n")));
            }
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
    // A reply to a plan keeps Claude planning: its deny with what to change [D177]. A reviewer's
    // findings come framed already.
    if let Some(reply) = msg["reply"].as_str().filter(|_| r["action"] == "plan") {
        let message = match msg["by"] == "review" {
            true => reply.to_string(),
            false => super::super::denied(&json!({"by": msg["by"], "reason": reply})),
        };
        return Ok(json!({"behavior": "deny", "message": message}));
    }
    Ok(match s(msg, &["decision"]) {
        "allow" => json!({"behavior": "allow"}),
        "allowSession" if r["grant"].is_object() => {
            let rules: Vec<Value> = (r["cli"]["rules"].as_array().into_iter().flatten())
                .flat_map(widen)
                .collect();
            let add = json!({"type": "addRules", "rules": rules, "behavior": "allow", "destination": "session"});
            // No rule: an exact command Brigadier remembers, and answers its repeats itself [D389].
            json!({"behavior": "allow", "updatedPermissions": if rules.is_empty() { vec![] } else { vec![add] }})
        }
        "deny" => json!({"behavior": "deny", "message": super::super::denied(msg)}),
        other => return Err(format!("no such decision here: {other:?}")),
    })
}

/// An assistant message the CLI wrote for an API error, by the error its SDK types, never the
/// agent's words [D339]: a limit's own words (its time comes from its rate_limit_event), no
/// credits, no capacity, no such model, a 5xx or no connection, a sign-in, or any other. A reply
/// cut at its output cap is the agent's own words.
pub fn api_error(v: &Value, text: String) -> Option<Event> {
    Some(match s(v, &["error"]) {
        "" | "max_output_tokens" => return None,
        "rate_limit" => Event::Limited(text, None),
        "billing_error" => Event::OutOfCredits,
        "overloaded" => Event::Failed("capacity", text),
        "model_not_found" => Event::Failed("model", text),
        "server_error" => Event::Failed("connection", text),
        "authentication_failed" => Event::SignIn(text),
        _ => super::super::classify(&text).unwrap_or(Event::Failed("", text)),
    })
}
