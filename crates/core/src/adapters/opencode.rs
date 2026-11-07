//! OpenCode: one `opencode run --format json` per turn on a private server, with all its data under
//! the session folder, so the owner's own server and sessions are never touched.

use super::{Adapter, Event, Launch, Timing, base_env, classify, home_path, s};
use crate::Spec;
use serde_json::Value;
use std::path::PathBuf;
use std::process::{Command, Stdio};

pub struct OpenCode;

impl OpenCode {
    fn env(&self, spec: &Spec) -> Vec<(String, String)> {
        let mut env = base_env(spec, &self.exe().unwrap_or_default());
        let root = spec.dir.join("opencode");
        for (k, d) in [
            ("XDG_DATA_HOME", "data"),
            ("XDG_CONFIG_HOME", "config"),
            ("XDG_STATE_HOME", "state"),
            ("XDG_CACHE_HOME", "cache"),
        ] {
            env.push((k.into(), root.join(d).display().to_string()));
        }
        env
    }

    fn run(&self, spec: &Spec, args: &[&str]) -> Option<String> {
        let mut command = Command::new(self.exe()?);
        command
            .args(args)
            .arg("--standalone")
            .env_clear()
            .envs(self.env(spec))
            .current_dir(&spec.cwd);
        let out = command
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()
            .ok()?;
        out.status
            .success()
            .then(|| String::from_utf8_lossy(&out.stdout).into_owned())
    }
}

impl Adapter for OpenCode {
    fn name(&self) -> &'static str {
        "opencode"
    }

    fn exe(&self) -> Option<PathBuf> {
        let exe = home_path(".opencode/bin/opencode");
        exe.exists().then_some(exe)
    }

    fn per_turn(&self) -> bool {
        true
    }

    fn launch(&self, spec: &Spec, resume: Option<&str>, text: Option<&str>) -> Launch {
        let model = spec
            .model
            .clone()
            .unwrap_or_else(|| "opencode/deepseek-v4.1-flash-free".into());
        let mut argv = vec![self.exe().unwrap_or_default().display().to_string()];
        if spec.mode != "pty" {
            argv.extend(["run", "--format", "json", "--auto"].map(String::from));
        }
        argv.extend(["--standalone".into(), "-m".into(), model]);
        if let Some(id) = resume {
            argv.extend(["-s".into(), id.into()]);
        }
        if spec.mode == "pty" {
            argv.extend(text.map(|t| format!("--prompt={t}")));
        } else {
            argv.extend(text.map(String::from));
        }
        Launch {
            argv,
            env: self.env(spec),
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
        let part = &v["part"];
        let mut events: Vec<Event> = v["sessionID"]
            .as_str()
            .map(|id| Event::Resume(id.into()))
            .into_iter()
            .collect();
        match s(&v, &["type"]) {
            "step_start" => events.push(Event::TurnStart),
            "step_finish" => {}
            "text" => events.push(Event::Text(s(part, &["text"]).into())),
            "tool_use" => {
                let id = [s(part, &["callID"]), s(part, &["id"])]
                    .into_iter()
                    .find(|i| !i.is_empty())
                    .unwrap_or("")
                    .to_string();
                events.push(Event::ToolStart(id.clone(), s(part, &["tool"]).into()));
                if matches!(s(part, &["state", "status"]), "completed" | "error") {
                    events.push(Event::ToolEnd(id));
                }
            }
            "error" => events
                .push(classify(&v["error"].to_string()).unwrap_or(Event::Unknown(line.into()))),
            _ => events.push(Event::Unknown(line.into())),
        }
        events
    }

    fn timing(&self) -> Timing {
        Timing {
            silent_ms: 20_000,
            stall_ms: 120_000,
            no_start_ms: 30_000,
        }
    }

    fn forget(&self, spec: &Spec, resume: &str) {
        self.run(spec, &["session", "delete", resume]);
    }

    fn transcript(&self, spec: &Spec, resume: &str) -> Option<(u64, u64)> {
        let out = self.run(spec, &["session", "export", resume])?;
        let v: Value = serde_json::from_str(&out[out.find('{')?..]).ok()?;
        let (mut texts, mut tools) = (0, 0);
        for m in v["messages"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|m| s(m, &["type"]) == "assistant")
        {
            for p in m["content"].as_array().into_iter().flatten() {
                match s(p, &["type"]) {
                    "text" => texts += 1,
                    "tool" => tools += 1,
                    _ => {}
                }
            }
        }
        Some((texts, tools))
    }
}
