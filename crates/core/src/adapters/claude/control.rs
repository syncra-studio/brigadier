//! Claude Code's control channel on stdin and stdout [D159]: its permission prompts and questions
//! come as `can_use_tool` requests and are answered by their `request_id`; Brigadier's own
//! requests (a stop, a new level or model) get a reply by theirs. Shapes per the Agent SDK's
//! public docs and types (code.claude.com/docs/en/agent-sdk/user-input).

use super::super::{Delivery, Event, Retune, s, uuid};
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

/// What a session grant allowed, as launch-time rules for a child started anew [D193].
pub fn rules(grants: &[Value]) -> Vec<String> {
    (grants.iter())
        .filter_map(|g| {
            let r = &g["cli"]["rule"];
            let (tool, content) = (s(r, &["toolName"]), s(r, &["ruleContent"]));
            (!tool.is_empty() && !content.is_empty()).then(|| format!("{tool}({content})"))
        })
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
    let mut a =
        json!({"id": id, "action": "other", "reason": (!reason.is_empty()).then_some(reason)});
    let mut grant = |scope: &str, pattern: &str, rule: Value| {
        a["grant"] = json!({"scope": scope, "pattern": pattern});
        a["cli"] = json!({"rule": rule});
    };
    match tool {
        "Bash" => {
            if let Some(c) = content.filter(|c| !c.is_empty()) {
                let prefix = c.trim_end_matches(" *").trim_end_matches(":*");
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
            "updatedPermissions": [{"type": "addRules", "rules": [r["cli"]["rule"]], "behavior": "allow", "destination": "session"}]}),
        "deny" => {
            let message = match s(msg, &["reason"]).trim() {
                "" => "The user denied this.".to_string(),
                why => format!("The user denied this: {why}"),
            };
            json!({"behavior": "deny", "message": message})
        }
        other => return Err(format!("no such decision here: {other:?}")),
    })
}
