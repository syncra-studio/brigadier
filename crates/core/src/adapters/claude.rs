//! Claude Code: one long-lived `claude -p` per session reading stream-json from stdin, or the
//! interactive CLI on a PTY. Frame names per its public CLI docs and observed output.

use super::{Adapter, Event, Launch, Timing, base_env, classify, home_path, s};
use crate::Spec;
use serde_json::{Value, json};
use std::path::PathBuf;

pub struct Claude;

impl Adapter for Claude {
    fn name(&self) -> &'static str {
        "claude"
    }

    fn exe(&self) -> Option<PathBuf> {
        let exe = home_path(".local/bin/claude");
        exe.exists().then_some(exe)
    }

    fn per_turn(&self) -> bool {
        false
    }

    fn launch(&self, spec: &Spec, resume: Option<&str>, text: Option<&str>) -> Launch {
        let exe = self.exe().unwrap_or_default();
        let model = spec.model.clone().unwrap_or_else(|| "haiku".into());
        let mut argv = vec![exe.display().to_string()];
        if spec.mode != "pty" {
            argv.extend(
                [
                    "-p",
                    "--output-format",
                    "stream-json",
                    "--input-format",
                    "stream-json",
                    "--verbose",
                ]
                .map(String::from),
            );
        }
        argv.extend([
            "--model".into(),
            model,
            "--dangerously-skip-permissions".into(),
        ]);
        if let Some(id) = resume {
            argv.extend(["--resume".into(), id.into()]);
        }
        let pty = spec.mode == "pty";
        if pty && let Some(t) = text {
            argv.push(t.into());
        }
        let input = if pty {
            None
        } else {
            text.map(|t| self.encode(spec, t))
        };
        Launch {
            argv,
            env: base_env(spec, &exe),
            keep_stdin: true,
            input,
        }
    }

    fn encode(&self, spec: &Spec, text: &str) -> String {
        if spec.mode == "pty" {
            return format!("{text}\r");
        }
        format!(
            "{}\n",
            json!({"type": "user", "message": {"role": "user", "content": text}})
        )
    }

    fn parse(&self, line: &str) -> Vec<Event> {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            return vec![Event::Unknown(line.into())];
        };
        let blocks = || {
            v["message"]["content"]
                .as_array()
                .cloned()
                .unwrap_or_default()
        };
        match (s(&v, &["type"]), s(&v, &["subtype"])) {
            ("system", "init") => vec![
                Event::Resume(s(&v, &["session_id"]).into()),
                Event::TurnStart,
            ],
            ("system", "compact_boundary") => vec![Event::Compaction],
            ("system", _) | ("stream_event", _) => vec![],
            ("assistant", _) => blocks()
                .iter()
                .filter_map(|b| match s(b, &["type"]) {
                    "text" => Some(Event::Text(s(b, &["text"]).into())),
                    "tool_use" => Some(Event::ToolStart(
                        s(b, &["id"]).into(),
                        s(b, &["name"]).into(),
                    )),
                    _ => None,
                })
                .collect(),
            ("user", _) => blocks()
                .iter()
                .filter(|b| s(b, &["type"]) == "tool_result")
                .map(|b| Event::ToolEnd(s(b, &["tool_use_id"]).into()))
                .collect(),
            ("rate_limit_event", _) => match s(&v, &["rate_limit_info", "status"]) {
                "rejected" => vec![Event::Limited(line.chars().take(300).collect())],
                _ => vec![],
            },
            ("result", _) => {
                let mut events = vec![Event::Usage(v["usage"].clone())];
                if v["is_error"].as_bool() == Some(true) {
                    events.extend(classify(&format!("{} {}", s(&v, &["result"]), v["errors"])));
                }
                events.push(Event::TurnEnd(v["is_error"].as_bool() != Some(true)));
                events
            }
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
        let dir = project_dir(spec);
        vec![dir.join(format!("{resume}.jsonl")), dir.join(resume)]
    }

    fn shared(&self, spec: &Spec) -> Vec<PathBuf> {
        let dir = project_dir(spec);
        vec![dir.join("memory"), dir]
    }

    fn transcript(&self, spec: &Spec, resume: &str) -> Option<(u64, u64)> {
        let text =
            std::fs::read_to_string(project_dir(spec).join(format!("{resume}.jsonl"))).ok()?;
        let (mut texts, mut tools) = (0, 0);
        for v in text
            .lines()
            .filter_map(|l| serde_json::from_str::<Value>(l).ok())
            .filter(|v| v["type"] == "assistant")
        {
            for b in v["message"]["content"].as_array().into_iter().flatten() {
                match s(b, &["type"]) {
                    "text" => texts += 1,
                    "tool_use" => tools += 1,
                    _ => {}
                }
            }
        }
        Some((texts, tools))
    }
}

/// Where the CLI keeps transcripts for a working folder: its real path with every
/// non-alphanumeric character turned into '-'.
fn project_dir(spec: &Spec) -> PathBuf {
    let real = std::fs::canonicalize(&spec.cwd).unwrap_or_else(|_| PathBuf::from(&spec.cwd));
    let slug: String = real
        .display()
        .to_string()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    home_path(".claude/projects").join(slug)
}
