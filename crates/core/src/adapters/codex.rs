//! Codex CLI: one `codex exec --json` process per turn, continued with `exec resume <thread>`.

use super::setup::{first_field, newest};
use super::{
    Adapter, Check, Done, Event, Launch, Timing, Tool, base_env, change, classify, drop_lines,
    file_lines, home_path, in_pty, paste, probe, s, shell_step, version,
};
use crate::Spec;
use serde_json::Value;
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

pub struct Codex;

const MODEL: &str = "gpt-5.6-luna";

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

    fn label(&self) -> &'static str {
        "Codex"
    }

    fn bin(&self) -> (&'static str, &'static [&'static str]) {
        ("codex", &[".local/bin"])
    }

    fn install(&self) -> Option<&'static str> {
        Some("curl -fsSL https://chatgpt.com/codex/install.sh | sh")
    }

    fn sign_in(&self) -> Option<(&'static str, &'static [&'static str])> {
        Some(("Sign in", &["login"]))
    }

    /// `codex login status` exits 0 when signed in and says how on stderr. Only the kind of
    /// sign-in is kept: its API-key line shows part of the key.
    fn check(&self, exe: &Path, cwd: &Path) -> Result<Check, String> {
        let out = probe(exe, cwd, &[], &["login", "status"], 15)?;
        let said = String::from_utf8_lossy(&out.stderr).to_string()
            + &String::from_utf8_lossy(&out.stdout);
        let signed_in = out.status.success();
        let how = if !signed_in {
            ""
        } else if said.contains("ChatGPT") {
            "ChatGPT account"
        } else if said.contains("API key") {
            "API key"
        } else {
            "signed in"
        };
        Ok(Check {
            version: version(exe, cwd)?,
            signed_in: Some(signed_in),
            how: how.into(),
            models: if signed_in {
                vec![(MODEL.into(), false)]
            } else {
                vec![]
            },
        })
    }

    /// The folder each rollout ran in, from its first line.
    fn projects(&self) -> Vec<PathBuf> {
        newest(&home_path(".codex/sessions"), ".jsonl", 3, 300)
            .iter()
            .filter_map(|p| first_field(p, &["payload", "cwd"]).map(PathBuf::from))
            .collect()
    }

    fn per_turn(&self) -> bool {
        true
    }

    fn launch(&self, spec: &Spec, resume: Option<&str>, text: Option<&str>) -> Launch {
        let exe = self.exe().unwrap_or_default();
        let model = spec.model.clone().unwrap_or_else(|| MODEL.into());
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
        } else {
            // Its TUI would otherwise join a shared background server, outside this session's
            // process group [D60]; the sandbox flag also skips its trust screen.
            argv.extend(["--no-daemon", "--sandbox", "workspace-write"].map(String::from));
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
            env: base_env(spec, &exe, self.keys()),
            keep_stdin: spec.mode == "pty",
            input: None,
        }
    }

    fn encode(&self, _spec: &Spec, text: &str) -> String {
        paste(text)
    }

    fn parse(&self, line: &str) -> Vec<Event> {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            return vec![Event::Unknown(line.into())];
        };
        if v.get("payload").is_some() {
            return rollout(&v);
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

    /// Its prompt history keeps the terminal's prompts by thread id, and a TUI that was killed
    /// leaves its writer lock; one a live writer holds stays, by Codex's own rule [D35].
    fn forget(&self, _spec: &Spec, resume: &str) -> Result<(), String> {
        drop_lines(&home_path(".codex/history.jsonl"), "session_id", resume)
            .map_err(|e| e.to_string())?;
        let lock = home_path(".codex/thread-writer-locks").join(format!("{resume}.lock"));
        if let Ok(f) = std::fs::File::open(&lock)
            && f.try_lock().is_ok()
        {
            let _ = std::fs::remove_file(&lock);
        }
        Ok(())
    }

    /// Its TUI resumes a thread by id; a new thread's id can't be picked, so the first message of
    /// a session goes through chat (proposed).
    fn terminal(&self, spec: &Spec, resume: Option<&str>) -> Result<(Launch, String), String> {
        let id = resume.ok_or("Send the first message in chat. The terminal then opens on it.")?;
        Ok((self.launch(&in_pty(spec), Some(id), None), id.into()))
    }

    fn mirror_from(&self, _spec: &Spec, conv: &str) -> Option<String> {
        let path = rollouts(&[format!("-{conv}.jsonl")]).pop()?;
        let len = std::fs::metadata(&path).ok()?.len();
        Some(format!("{len}\t{}", path.display()))
    }

    fn mirror(&self, _spec: &Spec, _conv: &str, cursor: &str) -> (Vec<String>, String) {
        let (from, path) = cursor.split_once('\t').unwrap_or(("0", ""));
        let (lines, end) = file_lines(std::path::Path::new(path), from.parse().unwrap_or(0));
        (lines, format!("{end}\t{path}"))
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
        let how = match [s(c, &["kind"]), s(c, &["kind", "type"])].concat().as_str() {
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

/// Rollouts whose names end with one of `names`: they live under sessions/YYYY/MM/DD/.
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
            let snake: String = kind
                .chars()
                .enumerate()
                .flat_map(|(i, c)| {
                    let sep = (i > 0 && c.is_ascii_uppercase()).then_some('_');
                    sep.into_iter().chain([c.to_ascii_lowercase()])
                })
                .collect();
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
