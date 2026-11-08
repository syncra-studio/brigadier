//! What Codex prints, as events: the app-server lines its helper passes on, `exec --json` lines in
//! older logs, and rollout lines a terminal's mirror copies. All map to the same shapes [D48, D65].

use super::super::{Done, Event, Tool, change, classify, counts, s, shell_step};
use serde_json::Value;

mod app_server;
pub use app_server::limited;

const TOOLS: [&str; 4] = [
    "command_execution",
    "mcp_tool_call",
    "file_change",
    "web_search",
];

pub fn parse(line: &str) -> Vec<Event> {
    let Ok(v) = serde_json::from_str::<Value>(line) else {
        return vec![Event::Unknown(line.into())];
    };
    if v.get("payload").is_some() {
        return rollout(&v);
    }
    if v.get("method").is_some() || s(&v, &["type"]).starts_with("brigadier.") {
        return app_server::events(&v);
    }
    let item = &v["item"];
    let kind = s(item, &["type"]);
    let done = s(&v, &["type"]) == "item.completed";
    match s(&v, &["type"]) {
        "thread.started" => vec![Event::Resume(s(&v, &["thread_id"]).into())],
        "turn.started" => vec![Event::TurnStart],
        "turn.completed" => vec![Event::Usage(v["usage"].clone()), Event::TurnEnd(true)],
        "turn.failed" => {
            let mut events: Vec<Event> =
                refused(s(&v, &["error", "message"])).into_iter().collect();
            events.push(Event::TurnEnd(false));
            events
        }
        "error" => vec![refused(s(&v, &["message"])).unwrap_or(Event::Unknown(line.into()))],
        // A tool may be reported only once it ended, so its end repeats its start.
        "item.started" | "item.completed"
            if matches!(kind, "collab_tool_call" | "collab_agent_tool_call") =>
        {
            agents(item, done)
        }
        "item.started" | "item.completed" if TOOLS.contains(&kind) => {
            let mut events = vec![Event::ToolStart(tool(item))];
            if done {
                events.push(Event::ToolEnd(end(item)));
            }
            events
        }
        "item.completed" if kind == "agent_message" => {
            vec![Event::Text(s(item, &["text"]).into())]
        }
        "item.completed" if kind == "reasoning" && !s(item, &["text"]).is_empty() => {
            vec![Event::Reasoning(s(item, &["text"]).into())]
        }
        "item.started" if kind == "context_compaction" => vec![Event::Compaction("running")],
        "item.completed" if kind == "context_compaction" => vec![Event::Compaction("done")],
        "item.started" | "item.updated" | "item.completed" => vec![],
        _ => vec![Event::Unknown(line.into())],
    }
}

/// An exec item as a step, by its type [D48, D65].
fn tool(item: &Value) -> Tool {
    let kind = s(item, &["type"]);
    let (name, step, input) = match kind {
        "command_execution" => {
            let (step, what) = shell_step(s(item, &["command"]));
            (kind.to_string(), step, what)
        }
        "file_change" => {
            let path = s(&item["changes"][0], &["path"]);
            (kind.to_string(), "edit", path.to_string())
        }
        "web_search" => (kind.to_string(), "web", s(item, &["query"]).to_string()),
        _ => (
            s(item, &["tool"]).to_string(),
            "other",
            item["arguments"].to_string(),
        ),
    };
    Tool {
        id: s(item, &["id"]).into(),
        name,
        step,
        input,
        changes: changes(item),
        ..Default::default()
    }
}

fn end(item: &Value) -> Done {
    let exit = item["exit_code"].as_i64();
    let output = match s(item, &["type"]) {
        "command_execution" => s(item, &["aggregated_output"]).to_string(),
        "mcp_tool_call" if !item["error"].is_null() => s(item, &["error", "message"]).to_string(),
        "mcp_tool_call" => item["result"].to_string(),
        _ => String::new(),
    };
    Done {
        id: s(item, &["id"]).into(),
        output,
        ok: !matches!(s(item, &["status"]), "failed" | "declined") && exit.is_none_or(|c| c == 0),
        exit,
        changes: changes(item),
        ..Default::default()
    }
}

/// A file change names its files and how each changed; only the app-server also gives a diff [D74, D83].
fn changes(item: &Value) -> Vec<Value> {
    let all = item["changes"].as_array().into_iter().flatten();
    all.map(|c| {
        let how = match [s(c, &["kind"]), s(c, &["kind", "type"])].concat().as_str() {
            "add" => "added",
            "delete" => "deleted",
            _ => "modified",
        };
        // The app-server reports a unified diff for an update, and the whole text otherwise.
        let (diff, added, removed) = match (c["diff"].as_str(), how) {
            (None, _) => (None, None, None),
            (Some(d), "added") => (None, Some(d.lines().count() as u64), Some(0)),
            (Some(d), "deleted") => (None, Some(0), Some(d.lines().count() as u64)),
            (Some(d), _) => {
                let (added, removed) = counts(d);
                (Some(d.to_string()), Some(added), Some(removed))
            }
        };
        change(s(c, &["path"]), how, diff, added, removed)
    })
    .collect()
}

/// Subagents: a spawn starts one per child thread, and any later call that reports a child
/// finished ends it with its answer. The calls themselves (wait and the rest) draw no row [D48, D78].
fn agents(item: &Value, done: bool) -> Vec<Event> {
    let mut events = vec![];
    if s(item, &["tool"]) == "spawn_agent" {
        for child in item["receiver_thread_ids"].as_array().into_iter().flatten() {
            events.push(Event::ToolStart(Tool {
                id: child.as_str().unwrap_or("").into(),
                name: "spawn_agent".into(),
                step: "agent",
                input: s(item, &["prompt"]).into(),
                ..Default::default()
            }));
        }
    }
    if done {
        for (child, state) in item["agents_states"].as_object().into_iter().flatten() {
            let status = s(state, &["status"]);
            if matches!(
                status,
                "completed" | "errored" | "failed" | "shutdown" | "not_found"
            ) {
                events.push(Event::ToolEnd(Done {
                    id: child.clone(),
                    output: s(state, &["message"]).into(),
                    ok: status == "completed",
                    child: Some(child.clone()),
                    ..Default::default()
                }));
            }
        }
    }
    events
}

/// A line of the CLI's rollout, which a terminal's mirror copies [D47]: only its events count,
/// in the same shapes as `exec --json` once named alike.
fn rollout(v: &Value) -> Vec<Event> {
    let p = &v["payload"];
    if s(v, &["type"]) != "event_msg" {
        return vec![];
    }
    match s(p, &["type"]) {
        "task_complete" => vec![Event::TurnEnd(true)],
        "turn_aborted" => vec![Event::TurnEnd(false)],
        "item_completed" => rollout_item(&p["item"]),
        _ => vec![],
    }
}

fn rollout_item(item: &Value) -> Vec<Event> {
    let joined = |v: &Value| {
        let parts = v.as_array().into_iter().flatten();
        let texts: Vec<&str> = parts
            .filter_map(|p| p.as_str().or(p["text"].as_str()))
            .collect();
        texts.join("\n")
    };
    let kind = s(item, &["type"]);
    match kind {
        "UserMessage" => vec![Event::Prompt(
            s(item, &["id"]).into(),
            joined(&item["content"]),
        )],
        "AgentMessage" => vec![Event::Text(joined(&item["content"]))],
        "Reasoning" => {
            let text = joined(&item["summary_text"]);
            if text.is_empty() {
                vec![]
            } else {
                vec![Event::Reasoning(text)]
            }
        }
        _ => {
            // CommandExecution → command_execution, with its command as one line.
            let mut e = item.clone();
            let snake = snake(kind);
            e["type"] = snake.clone().into();
            if let Some(last) = item["command"].as_array().and_then(|c| c.last()) {
                e["command"] = last.clone();
            }
            match snake.as_str() {
                "collab_agent_tool_call" | "collab_tool_call" => agents(&e, true),
                k if TOOLS.contains(&k) => {
                    vec![Event::ToolStart(tool(&e)), Event::ToolEnd(end(&e))]
                }
                _ => vec![],
            }
        }
    }
}

/// `CommandExecution` or `aggregatedOutput` as `command_execution` or `aggregated_output`.
fn snake(name: &str) -> String {
    name.chars()
        .enumerate()
        .flat_map(|(i, c)| {
            let sep = (i > 0 && c.is_ascii_uppercase()).then_some('_');
            sep.into_iter().chain([c.to_ascii_lowercase()])
        })
        .collect()
}

/// A limit or sign-in, or a thread Codex won't resume on this account: its saved reasoning is
/// encrypted for another organisation (openai/codex#13724), so only a new thread goes on (D90 Q4).
fn refused(message: &str) -> Option<Event> {
    if message.contains("invalid_encrypted_content")
        || message.contains("organization_id did not match")
    {
        return Some(Event::Unresumable(message.chars().take(300).collect()));
    }
    classify(message)
}
