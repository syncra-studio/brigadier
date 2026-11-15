//! Claude's tool calls as steps: a `tool_use` block as it starts, its `tool_result` as it ends.

use super::super::{Done, Event, Tool, change, counts, s, shell_step};
use serde_json::{Value, json};

/// Tokens a request read: what's in the window as it was sent.
fn read(u: &Value) -> u64 {
    let keys = [
        "input_tokens",
        "cache_read_input_tokens",
        "cache_creation_input_tokens",
    ];
    keys.iter().map(|k| u[k].as_u64().unwrap_or(0)).sum()
}

/// Its window and to-do list [D88, D104]: a main reply's usage as what's in the window; at the
/// turn's end its last request's, and the window of the model that read the most; TodoWrite's list.
pub fn records(v: &Value) -> Vec<Event> {
    match v["type"].as_str() {
        Some("assistant") if v["parent_tool_use_id"].is_null() => {
            let usage = &v["message"]["usage"];
            let blocks = v["message"]["content"].as_array().into_iter().flatten();
            let todos = blocks.filter(|b| b["type"] == "tool_use" && b["name"] == "TodoWrite");
            let plans = todos.map(|b| {
                let todos = b["input"]["todos"].as_array().into_iter().flatten();
                Event::Plan(
                    todos
                        .map(|t| json!({"text": t["content"], "status": t["status"]}))
                        .collect(),
                )
            });
            (usage
                .is_object()
                .then(|| Event::Context(read(usage), None))
                .into_iter())
            .chain(plans)
            .collect()
        }
        Some("result") => {
            let models = v["modelUsage"].as_object().into_iter().flatten();
            let main = models.map(|(_, m)| m).max_by_key(|m| {
                let keys = [
                    "inputTokens",
                    "cacheReadInputTokens",
                    "cacheCreationInputTokens",
                ];
                keys.iter().map(|k| m[k].as_u64().unwrap_or(0)).sum::<u64>()
            });
            let window = main.and_then(|m| m["contextWindow"].as_u64());
            let last = v["usage"]["iterations"].as_array().and_then(|i| i.last());
            last.map(|u| Event::Context(read(u), window))
                .into_iter()
                .collect()
        }
        _ => vec![],
    }
}

/// A `tool_use` block as a step, by Claude Code's tool names [D48, D65].
pub fn tool_start(b: &Value, parent: Option<String>) -> Vec<Event> {
    let (id, name, input) = (s(b, &["id"]), s(b, &["name"]), &b["input"]);
    // Asked on the control channel, where it is answered.
    if name == "AskUserQuestion" {
        return vec![];
    }
    let field = |k: &str| s(input, &[k]).to_string();
    let (step, what) = match name {
        "Read" => ("read", field("file_path")),
        "Edit" | "MultiEdit" | "Write" => ("edit", field("file_path")),
        "NotebookEdit" => ("edit", field("notebook_path")),
        "Grep" | "Glob" => ("search", field("pattern")),
        "LS" => ("list", field("path")),
        "WebFetch" => ("web", field("url")),
        "WebSearch" => ("web", field("query")),
        "Bash" => shell_step(&field("command")),
        "Agent" | "Task" => ("agent", field("description")),
        // Named by the skill, its argument what it acts on [D211].
        "Skill" => ("skill", field("args")),
        "ToolSearch" | "ExitPlanMode" | "TaskOutput" | "BashOutput" | "TodoWrite"
        | "SubagentHandback" => ("", String::new()),
        _ => ("other", input.to_string()),
    };
    // Every edit names its file from the start, so a running or failed one still shows. Whether a
    // write created its file only its result says; until then it reads as modified.
    let changes = match step {
        "edit" => vec![change(&what, "modified", None, None, None)],
        _ => vec![],
    };
    // An MCP tool by its server and own name: `mcp__atlassian__getJiraIssue`, a claude.ai connector's `mcp__claude_ai_Gmail__…`.
    let mcp = name.strip_prefix("mcp__").and_then(|n| n.split_once("__"));
    vec![Event::ToolStart(Tool {
        id: id.into(),
        name: match step {
            "skill" => s(input, &["skill"]),
            _ => mcp.map_or(name, |(_, tool)| tool),
        }
        .into(),
        step,
        input: what,
        parent,
        changes,
        at: None,
        server: mcp.map(|(server, _)| server.trim_start_matches("claude_ai_").into()),
        description: field("description"),
    })]
}

/// A `tool_result` block, with the structured result the CLI puts beside it.
pub fn tool_end(b: &Value, result: &Value, parent: Option<String>) -> Vec<Event> {
    let id = s(b, &["tool_use_id"]);
    let text = |content: &Value| match content {
        Value::String(t) => t.clone(),
        Value::Array(parts) => parts
            .iter()
            .filter_map(|p| p["text"].as_str())
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    };
    if result["questions"].is_array() {
        return vec![];
    }
    if let Some(answers) = result["answers"].as_object() {
        let asked = result["questions"].as_array().cloned().unwrap_or_default();
        return asked
            .iter()
            .enumerate()
            .map(|(k, q)| {
                let answer = answers.get(s(q, &["question"])).map(|a| match a {
                    Value::String(t) => t.clone(),
                    other => other.to_string(),
                });
                Event::Answer(format!("{id}:{k}"), answer)
            })
            .collect();
    }
    let path = s(result, &["filePath"]);
    let changes = if result["type"] == "create" {
        let content = s(result, &["content"]);
        let lines: Vec<String> = content.lines().map(|l| format!("+{l}")).collect();
        let diff = format!("@@ -0,0 +1,{} @@\n{}", lines.len(), lines.join("\n"));
        vec![change(
            path,
            "added",
            Some(diff),
            Some(lines.len() as u64),
            Some(0),
        )]
    } else if result["structuredPatch"]
        .as_array()
        .is_some_and(|h| h.is_empty())
    {
        // A whole-file write can come without hunks: its diff and counts stay unreported.
        vec![change(path, "modified", None, None, None)]
    } else if let Some(hunks) = result["structuredPatch"].as_array() {
        let diff = hunks
            .iter()
            .map(|h| {
                let lines = h["lines"].as_array().into_iter().flatten();
                let body: Vec<&str> = lines.filter_map(Value::as_str).collect();
                format!(
                    "@@ -{},{} +{},{} @@\n{}",
                    h["oldStart"],
                    h["oldLines"],
                    h["newStart"],
                    h["newLines"],
                    body.join("\n")
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
        let (added, removed) = counts(&diff);
        vec![change(
            path,
            "modified",
            Some(diff),
            Some(added),
            Some(removed),
        )]
    } else {
        vec![]
    };
    // A subagent's result carries its answer and id beside the wrapped text. One launched in the
    // background only says so here: its end comes as a task notification.
    let child = result["agentId"].as_str().map(String::from);
    if result["status"] == "async_launched" {
        return vec![];
    }
    let output = match child {
        // Its report handed back as a call of its own is beside it, not in its text.
        Some(_) if result["handbackReport"]["text"].is_string() => {
            s(result, &["handbackReport", "text"]).into()
        }
        // A skill run forked as a subagent hands back its answer as `result` [D211].
        Some(_) if result["result"].is_string() => s(result, &["result"]).into(),
        Some(_) => {
            let answer = text(&result["content"]);
            let tag = "</tools-used-before-summary>";
            match answer.split_once(tag) {
                Some((_, rest)) if answer.starts_with("<tools-used-before-summary>") => {
                    rest.trim_start().to_string()
                }
                _ => answer,
            }
        }
        None => text(&b["content"]),
    };
    // A command sent to the background or interrupted hasn't ended here. One that ended and
    // failed names its code on its first line, as the old app read it; success names none [D74].
    let failed = b["is_error"].as_bool() == Some(true);
    let cut = result["interrupted"] == true || result["backgroundTaskId"].is_string();
    let exit = (failed && !cut)
        .then(|| {
            output
                .lines()
                .next()?
                .strip_prefix("Exit code ")?
                .trim()
                .parse()
                .ok()
        })
        .flatten();
    vec![Event::ToolEnd(Done {
        id: id.into(),
        output,
        ok: !failed,
        exit,
        cut,
        changes,
        child: child.or_else(|| result["backgroundTaskId"].as_str().map(String::from)),
        parent,
        at: None,
    })]
}

/// The folder a Bash call runs in, from the launch's hook that echoes its input [D391].
pub fn cwd(v: &Value) -> Option<Event> {
    let input: Value = serde_json::from_str(s(v, &["stdout"])).ok()?;
    let (tool, cwd) = (s(&input, &["tool_use_id"]), s(&input, &["cwd"]));
    (v["hook_event"] == "PreToolUse" && !tool.is_empty() && !cwd.is_empty())
        .then(|| Event::Cwd(tool.into(), cwd.into()))
}
