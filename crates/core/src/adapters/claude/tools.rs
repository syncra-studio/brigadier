//! Claude's tool calls as steps: a `tool_use` block as it starts, its `tool_result` as it ends.

use super::super::{Done, Event, Tool, change, counts, s, shell_step};
use serde_json::Value;

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
        "LS" => ("search", field("path")),
        "WebFetch" => ("web", field("url")),
        "WebSearch" => ("web", field("query")),
        "Bash" => shell_step(&field("command")),
        "Agent" | "Task" => ("agent", field("description")),
        "ToolSearch" | "ExitPlanMode" | "TaskOutput" | "BashOutput" => ("", String::new()),
        _ => ("other", input.to_string()),
    };
    // Every edit names its file from the start, so a running or failed one still shows. Whether a
    // write created its file only its result says; until then it reads as modified.
    let changes = match step {
        "edit" => vec![change(&what, "modified", None, None, None)],
        _ => vec![],
    };
    vec![Event::ToolStart(Tool {
        id: id.into(),
        name: name.into(),
        step,
        input: what,
        parent,
        changes,
        at: None,
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
    vec![Event::ToolEnd(Done {
        id: id.into(),
        output,
        ok: b["is_error"].as_bool() != Some(true),
        exit: None,
        changes,
        child,
        parent,
        at: None,
    })]
}
