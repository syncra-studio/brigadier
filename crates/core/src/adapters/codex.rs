//! Codex CLI: one `codex exec --json` process per turn, continued with `exec resume <thread>`.

use super::{Adapter, Event, Launch, Timing, base_env, classify, home_path, s};
use crate::Spec;
use serde_json::Value;
use std::path::PathBuf;

pub struct Codex;

const TOOLS: [&str; 5] = [
    "command_execution",
    "mcp_tool_call",
    "file_change",
    "web_search",
    "collab_tool_call",
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
        let id = || s(item, &["id"]).to_string();
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
            "item.started" if TOOLS.contains(&kind) => vec![Event::ToolStart(id(), kind.into())],
            "item.completed" if TOOLS.contains(&kind) => {
                vec![Event::ToolStart(id(), kind.into()), Event::ToolEnd(id())]
            }
            "item.completed" if kind == "agent_message" => {
                vec![Event::Text(s(item, &["text"]).into())]
            }
            "item.completed" if kind == "context_compaction" => vec![Event::Compaction],
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

    fn external(&self, _spec: &Spec, resume: &str) -> Vec<PathBuf> {
        // Rollouts live under sessions/YYYY/MM/DD/ with the thread id in the name.
        let mut found = vec![];
        let mut dirs = vec![home_path(".codex/sessions")];
        while let Some(dir) = dirs.pop() {
            for entry in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
                let path = entry.path();
                if path.is_dir() {
                    dirs.push(path);
                } else if path
                    .file_name()
                    .is_some_and(|n| n.to_string_lossy().contains(resume))
                {
                    found.push(path);
                }
            }
        }
        found
    }

    fn transcript(&self, spec: &Spec, resume: &str) -> Option<(u64, u64)> {
        let (mut texts, mut tools) = (0, 0);
        for path in self.external(spec, resume) {
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
}
