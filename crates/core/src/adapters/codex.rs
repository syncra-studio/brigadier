//! Codex CLI: one `codex exec --json` process per turn, continued with `exec resume <thread>`.

use super::{
    Adapter, Done, Event, Launch, Timing, Tool, base_env, change, classify, home_path, s,
    shell_step,
};
use crate::Spec;
use serde_json::Value;
use std::{collections::BTreeSet, path::PathBuf};

pub struct Codex;

const TOOLS: [&str; 4] = [
    "command_execution",
    "mcp_tool_call",
    "file_change",
    "web_search",
];

impl Adapter for Codex {
    fn name(&self) -> &'static str {
        "codex"
    }

    fn exe(&self) -> Option<PathBuf> {
        let exe = home_path(".local/bin/codex");
        exe.exists().then_some(exe)
    }

    fn per_turn(&self) -> bool {
        true
    }

    fn launch(&self, spec: &Spec, resume: Option<&str>, text: Option<&str>) -> Launch {
        let exe = self.exe().unwrap_or_default();
        let model = spec.model.clone().unwrap_or_else(|| "gpt-5.6-luna".into());
        let mut argv = vec![exe.display().to_string()];
        if spec.mode != "pty" {
            argv.extend(
                [
                    "exec",
                    "--json",
                    "--skip-git-repo-check",
                    "--sandbox",
                    "workspace-write",
                ]
                .map(String::from),
            );
        }
        argv.extend([
            "-m".into(),
            model,
            "-c".into(),
            "model_reasoning_effort=\"low\"".into(),
        ]);
        if let Some(id) = resume {
            argv.extend(["resume".into(), id.into()]);
        }
        argv.extend(text.map(String::from));
        Launch {
            argv,
            env: base_env(spec, &exe),
            keep_stdin: spec.mode == "pty",
            input: None,
        }
    }

    fn encode(&self, _spec: &Spec, text: &str) -> String {
        format!("{text}\r")
    }

    fn parse(&self, line: &str) -> Vec<Event> {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            return vec![Event::Unknown(line.into())];
        };
        let item = &v["item"];
        let kind = s(item, &["type"]);
        let done = s(&v, &["type"]) == "item.completed";
        match s(&v, &["type"]) {
            "thread.started" => vec![Event::Resume(s(&v, &["thread_id"]).into())],
            "turn.started" => vec![Event::TurnStart],
            "turn.completed" => vec![Event::Usage(v["usage"].clone()), Event::TurnEnd(true)],
            "turn.failed" => {
                let mut events: Vec<Event> =
                    classify(s(&v, &["error", "message"])).into_iter().collect();
                events.push(Event::TurnEnd(false));
                events
            }
            "error" => vec![classify(s(&v, &["message"])).unwrap_or(Event::Unknown(line.into()))],
            // A tool may be reported only once it ended, so its end repeats its start.
            "item.started" | "item.completed" if kind == "collab_tool_call" => agents(item, done),
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

    fn timing(&self) -> Timing {
        Timing {
            silent_ms: 20_000,
            stall_ms: 120_000,
            no_start_ms: 30_000,
        }
    }

    fn external(&self, spec: &Spec, resume: &str) -> Vec<PathBuf> {
        let mut ids = BTreeSet::from([resume.to_string()]);
        let mut backend = String::new();
        let _ = crate::read(&spec.dir, |item| {
            if let Some(b) = item["backend"].as_str() {
                backend = b.into();
            }
            if backend == self.name() && item["kind"] == "tool" && item["name"] == "spawn_agent" {
                ids.insert(s(item, &["id"]).into());
            }
        });
        let names: Vec<String> = ids
            .into_iter()
            .filter(|id| crate::check_id(id).is_ok())
            .map(|id| format!("-{id}.jsonl"))
            .collect();
        rollouts(&names)
    }

    fn transcript(&self, spec: &Spec, resume: &str) -> Option<(u64, u64)> {
        let (mut texts, mut tools) = (0, 0);
        for path in self.external(spec, resume) {
            if !path
                .file_name()?
                .to_string_lossy()
                .ends_with(&format!("-{resume}.jsonl"))
            {
                continue;
            }
            for v in std::fs::read_to_string(path)
                .ok()?
                .lines()
                .filter_map(|l| serde_json::from_str::<Value>(l).ok())
            {
                if v["type"] != "response_item" {
                    continue;
                }
                match s(&v, &["payload", "type"]) {
                    "message" if s(&v, &["payload", "role"]) == "assistant" => texts += 1,
                    t if t.ends_with("_call") => tools += 1,
                    _ => {}
                }
            }
        }
        Some((texts, tools))
    }

    fn diffs(&self, resume: &str, turn: u64) -> Option<Vec<Vec<(String, String)>>> {
        crate::check_id(resume).ok()?;
        let path = rollouts(&[format!("-{resume}.jsonl")]).pop()?;
        let (mut turns, mut edits) = (0, vec![]);
        for v in std::fs::read_to_string(path)
            .ok()?
            .lines()
            .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        {
            let p = &v["payload"];
            match s(p, &["type"]) {
                "task_started" => turns += 1,
                "item_completed" if turns == turn + 1 && p["item"]["type"] == "FileChange" => {
                    let files = p["item"]["changes"].as_object()?;
                    edits.push(files.iter().map(|(f, c)| (f.clone(), diff(c))).collect());
                }
                _ => {}
            }
        }
        (turns > turn).then_some(edits)
    }
}

/// Rollouts live under sessions/YYYY/MM/DD/ with the thread id in the name.
fn rollouts(names: &[String]) -> Vec<PathBuf> {
    let mut found = vec![];
    let mut dirs = vec![home_path(".codex/sessions")];
    while let Some(dir) = dirs.pop() {
        for entry in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
            let path = entry.path();
            if path.is_dir() {
                dirs.push(path);
            } else if path
                .file_name()
                .is_some_and(|n| names.iter().any(|id| n.to_string_lossy().ends_with(id)))
            {
                found.push(path);
            }
        }
    }
    found
}

/// A rollout's change to one file as a unified diff: an update's own, or a whole added or deleted file.
fn diff(c: &Value) -> String {
    let lines = |sign: char| {
        let all: Vec<String> = s(c, &["content"])
            .lines()
            .map(|l| format!("{sign}{l}"))
            .collect();
        (all.len(), all.join("\n"))
    };
    match s(c, &["type"]) {
        "add" => {
            let (n, body) = lines('+');
            format!("@@ -0,0 +1,{n} @@\n{body}")
        }
        "delete" => {
            let (n, body) = lines('-');
            format!("@@ -1,{n} +0,0 @@\n{body}")
        }
        _ => s(c, &["unified_diff"]).to_string(),
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

/// A file change names its files and how each changed, never a diff [D74, D83].
fn changes(item: &Value) -> Vec<Value> {
    let all = item["changes"].as_array().into_iter().flatten();
    all.map(|c| {
        let how = match s(c, &["kind"]) {
            "add" => "added",
            "delete" => "deleted",
            _ => "modified",
        };
        change(s(c, &["path"]), how, None, None, None)
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
