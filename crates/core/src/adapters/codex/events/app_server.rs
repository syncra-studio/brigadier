//! The app-server's lines as the helper passes them on, in the same shapes as `exec --json` once
//! named alike [D159]. Requests carry what an answer needs under `cli`, as D177 leaves room for.

use super::super::super::{Event, s, under};
use super::{parse, refused, snake};
use serde_json::{Value, json};

pub fn events(v: &Value) -> Vec<Event> {
    let p = &v["params"];
    let d = &v["data"];
    match s(v, &["method"]) {
        "" if s(v, &["type"]) == "brigadier.reply" => vec![Event::Reply {
            id: s(d, &["id"]).into(),
            error: d["error"].as_str().map(String::from),
            level: None,
        }],
        "" if s(v, &["type"]) == "brigadier.skills" => vec![Event::Commands(commands(d))],
        "thread/started" => vec![Event::Resume(s(p, &["thread", "id"]).into())],
        "turn/started" => vec![Event::TurnStart],
        "turn/completed" => completed(p),
        // The reply as it's written; its whole text follows when its item completes [D147].
        "item/agentMessage/delta" => vec![Event::TextDelta(s(p, &["delta"]).into())],
        method @ ("item/started" | "item/completed") => {
            let kind = method.replace('/', ".");
            let exec = json!({"type": kind, "item": exec_item(&p["item"])});
            let mut events = parse(&exec.to_string());
            if let Some(thread) = p["parent"].as_str() {
                under(&mut events, thread);
            }
            events
        }
        "thread/tokenUsage/updated" => {
            let (usage, window) = (
                &p["tokenUsage"]["last"],
                &p["tokenUsage"]["modelContextWindow"],
            );
            let used = Event::Context(usage["totalTokens"].as_u64().unwrap_or(0), window.as_u64());
            vec![Event::Usage(snake_keys(usage)), used]
        }
        "turn/plan/updated" => {
            let steps = p["plan"].as_array().into_iter().flatten();
            vec![Event::Plan(
                steps
                    .map(|x| json!({"text": x["step"], "status": x["status"]}))
                    .collect(),
            )]
        }
        "serverRequest/resolved" => vec![Event::Resolved(s(p, &["requestId"]).into())],
        // A transient error it retries by itself; one it won't retry ends the turn [D487].
        "error" if p["willRetry"] == true => vec![retrying(s(p, &["error", "message"]))],
        "model/rerouted" => vec![Event::Rerouted(
            p["fromModel"].as_str().map(String::from),
            s(p, &["toModel"]).into(),
        )],
        "model/safetyBuffering/updated" => vec![Event::Checking(p["showBufferingUi"] == true)],
        "item/autoApprovalReview/completed" if p["review"]["status"] == "denied" => {
            vec![Event::Denied]
        }
        "item/commandExecution/requestApproval" => vec![asked(p, command(v))],
        "item/fileChange/requestApproval" => vec![asked(p, edit(v))],
        "item/permissions/requestApproval" => vec![asked(p, permissions(v))],
        "mcpServer/elicitation/request" => vec![asked(p, mcp(v))],
        "item/tool/requestUserInput" => vec![asked(p, question(v))],
        _ => vec![],
    }
}

/// A subagent's request names its thread, its row's id, so the card names the subagent [w43 #16].
fn asked(p: &Value, mut e: Event) -> Event {
    if let (Event::Approval(r) | Event::Question(r), Some(t)) = (&mut e, p["parent"].as_str()) {
        r["parent"] = t.into();
    }
    e
}

/// Its compact, which runs at once: all of its list it has before it lists its skills [D2098].
pub fn compact() -> Value {
    json!({"name": "compact", "description": "Summarize conversation to prevent hitting the context limit",
        "kind": "command", "path": null, "instant": true})
}

/// Its compact, then each enabled skill `skills/list` gave, by its file
/// [D2009, D2011]. Its own description of compact, from its TUI's (codex-rs/tui/src/slash_command.rs).
fn commands(list: &Value) -> Vec<Value> {
    let entries = list["data"].as_array().into_iter().flatten();
    let skills = (entries.flat_map(|e| e["skills"].as_array().into_iter().flatten()))
        .filter(|k| k["enabled"] != false)
        .map(|k| {
            json!({"name": k["name"], "description": k["description"], "kind": "skill",
            "path": k["path"], "instant": false})
        });
    std::iter::once(compact()).chain(skills).collect()
}

/// Whether a failed turn hit a usage limit.
pub fn limited(turn: &Value) -> bool {
    if !cause(turn).is_empty() {
        return false;
    }
    let info = s(turn, &["error", "codexErrorInfo"]);
    matches!(info, "usageLimitExceeded" | "rateLimitExceeded")
        || matches!(
            refused(s(turn, &["error", "message"])),
            Some(Event::Limited(..))
        )
}

fn completed(p: &Value) -> Vec<Event> {
    let turn = &p["turn"];
    let status = s(turn, &["status"]);
    let mut events = vec![];
    if status == "failed" {
        let message = s(turn, &["error", "message"]);
        events.push(if p["brigadier"]["credits"] == true {
            Event::OutOfCredits
        } else if !cause(turn).is_empty() {
            Event::Failed(cause(turn), message.into())
        } else if limited(turn) {
            Event::Limited(message.into(), p["brigadier"]["resets"].as_u64())
        } else if s(turn, &["error", "codexErrorInfo"]) == "unauthorized" {
            Event::SignIn(message.into())
        } else {
            refused(message).unwrap_or_else(|| Event::Failed(cause(turn), message.into()))
        });
    }
    if status == "completed" {
        let id = turn["id"].as_str().map(String::from);
        events.push(Event::Mark {
            start: None,
            end: id,
        });
    }
    events.push(Event::TurnEnd(status == "completed"));
    events
}

/// What its error info says a failed turn hit, as Brigadier's causes [D487].
fn cause(turn: &Value) -> &'static str {
    match s(turn, &["error", "codexErrorInfo"]) {
        "serverOverloaded" => "capacity",
        "modelNotFound" => "model",
        "cyberPolicy" => "blocked",
        "misalignmentPolicyViolation" => "ended",
        "tooManyDenials" => "review",
        _ => "",
    }
}

/// Its retry as it words it, "Reconnecting... 2/5", which its own TUI reads the same way; a retry
/// worded otherwise has no count [D74].
fn retrying(message: &str) -> Event {
    let count = message.rsplit(' ').next().and_then(|c| c.split_once('/'));
    let n = |x: &str| x.parse::<u64>().ok();
    let (attempt, max) = count.map_or((None, None), |(a, m)| (n(a), n(m)));
    Event::Retrying {
        attempt,
        max,
        at: None,
    }
}

fn snake_keys(v: &Value) -> Value {
    let keys = v.as_object().into_iter().flatten();
    Value::Object(keys.map(|(k, v)| (snake(k), v.clone())).collect())
}

/// A `camelCase` thread item as `exec --json` names it.
fn exec_item(item: &Value) -> Value {
    let mut e = snake_keys(item);
    for k in ["type", "tool"] {
        if let Some(name) = e[k].as_str().map(snake) {
            e[k] = name.into();
        }
    }
    if e["type"] == "reasoning" {
        let parts = e["summary"].as_array().into_iter().flatten();
        let text: Vec<&str> = parts.filter_map(Value::as_str).collect();
        e["text"] = text.join("\n").into();
    }
    if let Some(states) = e["agents_states"].as_object_mut() {
        for state in states.values_mut() {
            let status = snake(s(state, &["status"]));
            state["status"] = status.into();
        }
    }
    e
}

/// What answering a request takes: its own JSON-RPC id, method, thread and turn.
fn cli(v: &Value) -> Value {
    let p = &v["params"];
    json!({"rid": v["rid"], "method": v["method"], "thread": p["threadId"], "turn": p["turnId"], "cwd": p["cwd"]})
}

fn command(v: &Value) -> Event {
    let p = &v["params"];
    let net = &p["networkApprovalContext"];
    let host = net["host"].as_str();
    let mut a = json!({"id": v["id"], "action": if host.is_some() { "network" } else { "command" },
        "reason": p["reason"], "command": p["command"], "host": net["host"], "cli": cli(v)});
    if p["insideSession"] != true {
        a["cwd"] = p["cwd"].clone();
    }
    if p["canGrant"] == true {
        a["grant"] = match host {
            Some(host) => json!({"scope": "network", "pattern": host}),
            None => json!({"scope": "command", "pattern": p["command"]}),
        };
    }
    Event::Approval(a)
}

/// Its file requests name no files and list no decisions, though they take `acceptForSession`:
/// the helper adds the files from the item they belong to, and the grant covers their folder [D193].
fn edit(v: &Value) -> Event {
    let p = &v["params"];
    let paths: Vec<&str> = (p["files"].as_array().into_iter().flatten())
        .filter_map(Value::as_str)
        .collect();
    let mut a = json!({"id": v["id"], "action": "edit", "reason": p["reason"], "paths": paths, "cli": cli(v)});
    let root = p["grantRoot"].as_str().map(String::from).or(parent(&paths));
    if let Some(root) = root {
        a["grant"] = json!({"scope": "edits", "pattern": root});
    }
    Event::Approval(a)
}

/// The folder that holds every path; None when that would be the root, or nothing was reported.
fn parent(paths: &[&str]) -> Option<String> {
    let dirs: Vec<Vec<&str>> = (paths.iter())
        .map(|p| {
            let mut parts: Vec<&str> = p.split('/').collect();
            parts.pop();
            parts
        })
        .collect();
    let first = dirs.first()?;
    let same = (0..first.len())
        .take_while(|&i| dirs.iter().all(|d| d.get(i) == first.get(i)))
        .count();
    (same > 1).then(|| first[..same].join("/"))
}

/// Codex's request for more permissions: no scope in D177 fits, so no session grant (proposed).
fn permissions(v: &Value) -> Event {
    let p = &v["params"];
    let mut who = cli(v);
    who["permissions"] = p["permissions"].clone();
    Event::Approval(
        json!({"id": v["id"], "action": "permission", "reason": p["reason"],
        "input": p["permissions"].to_string(), "cli": who}),
    )
}

fn mcp(v: &Value) -> Event {
    let p = &v["params"];
    Event::Approval(
        json!({"id": v["id"], "action": "other", "reason": p["request"]["message"],
        "input": p["serverName"], "cli": cli(v)}),
    )
}

fn question(v: &Value) -> Event {
    let p = &v["params"];
    let questions = p["questions"].as_array().cloned().unwrap_or_default();
    let items: Vec<Value> = (questions.iter())
        .map(|q| {
            let options = q["options"].as_array().cloned().unwrap_or_default();
            let options: Vec<Value> = (options.iter())
                .map(|o| json!({"label": o["label"], "description": o["description"]}))
                .collect();
            json!({"text": q["question"], "options": options, "recommended": null, "multiSelect": false})
        })
        .collect();
    let mut who = cli(v);
    who["ids"] = questions.iter().map(|q| q["id"].clone()).collect();
    Event::Question(
        json!({"id": v["id"], "title": questions.first().map(|q| q["header"].clone()),
        "items": items, "cli": who}),
    )
}
