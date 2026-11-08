//! The scripted test agent from crates/fake. Costs no usage.

use super::{Adapter, Done, Event, Launch, Timing, Tool, base_env, s};
use crate::Spec;
use serde_json::{Value, json};
use std::path::PathBuf;

pub struct Fake;

impl Adapter for Fake {
    fn name(&self) -> &'static str {
        "fake"
    }

    fn exe(&self) -> Option<PathBuf> {
        let exe = std::env::current_exe()
            .ok()?
            .with_file_name("brigadier-fake");
        exe.exists().then_some(exe)
    }

    fn per_turn(&self) -> bool {
        false
    }

    fn launch(&self, spec: &Spec, resume: Option<&str>, text: Option<&str>) -> Launch {
        let exe = self.exe().unwrap_or_default();
        let mut argv = vec![
            exe.display().to_string(),
            "agent".into(),
            "--home".into(),
            spec.dir.join("fake").display().to_string(),
        ];
        if let Some(id) = resume {
            argv.extend(["--resume".into(), id.into()]);
        }
        let mut env = base_env(spec, &exe);
        for (k, v) in &spec.opts {
            env.push((k.clone(), v.clone()));
        }
        Launch {
            argv,
            env,
            keep_stdin: true,
            input: text.map(|t| self.encode(spec, t)),
        }
    }

    fn encode(&self, spec: &Spec, text: &str) -> String {
        if spec.mode == "pty" {
            format!("{text}\r")
        } else {
            format!("{}\n", json!({"text": text}))
        }
    }

    /// Its terminal is its own PTY mode, with no record to mirror: for drills and demos.
    fn terminal(&self, spec: &Spec, resume: Option<&str>) -> Result<(Launch, String), String> {
        Ok((
            self.launch(&super::in_pty(spec), resume, None),
            resume.unwrap_or("").into(),
        ))
    }

    fn parse(&self, line: &str) -> Vec<Event> {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            return vec![Event::Unknown(line.into())];
        };
        match s(&v, &["t"]) {
            "hello" => vec![Event::Resume(s(&v, &["session"]).into())],
            "turn" => vec![Event::TurnStart],
            "say" => vec![Event::Text(s(&v, &["text"]).into())],
            "tool" => vec![Event::ToolStart(Tool {
                id: s(&v, &["id"]).into(),
                name: s(&v, &["name"]).into(),
                step: "other",
                ..Default::default()
            })],
            "tool_done" => vec![Event::ToolEnd(Done {
                id: s(&v, &["id"]).into(),
                ok: true,
                ..Default::default()
            })],
            "beat" | "child" => vec![],
            "done" => vec![Event::TurnEnd(v["ok"].as_bool().unwrap_or(true))],
            "ask" => vec![Event::Question(
                String::new(),
                s(&v, &["text"]).into(),
                vec![],
            )],
            "compact" => vec![Event::Compaction("done")],
            "error" => vec![
                super::classify(&format!("{} {}", v["code"], s(&v, &["message"])))
                    .unwrap_or(Event::Unknown(line.into())),
            ],
            _ => vec![Event::Unknown(line.into())],
        }
    }

    fn timing(&self) -> Timing {
        Timing {
            silent_ms: 3_000,
            stall_ms: 4_000,
            no_start_ms: 3_000,
        }
    }

    fn transcript(&self, spec: &Spec, resume: &str) -> Option<(u64, u64)> {
        let text =
            std::fs::read_to_string(spec.dir.join("fake").join(format!("{resume}.log"))).ok()?;
        let count = |k: &str| text.lines().filter(|l| l.starts_with(k)).count() as u64;
        Some((count("say "), count("tool ")))
    }
}
