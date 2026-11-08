//! The scripted test agent from crates/fake. Costs no usage.

use super::{
    Accounts, Adapter, Can, Check, Delivery, Done, Event, Launch, Retune, Timing, Tool, base_env, s,
};
use crate::Spec;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

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

    /// Accounts for drills and demos only, when `BRIGADIER_FAKE_ACCOUNTS` is set: each signs in
    /// with a mark in its home, so switching is shown with no real login [D51].
    fn accounts(&self) -> Option<Accounts> {
        std::env::var_os("BRIGADIER_FAKE_ACCOUNTS")?;
        Some(Accounts {
            var: "FAKE_ACCOUNT",
            home: ".brigadier-fake",
            links: &[],
            vendor: "the fake agent's vendor",
            sign_in: &["login"],
            sign_out: &["logout"],
            kinds: &["fake"],
        })
    }

    fn check(&self, spec: &Spec, exe: &Path, _cwd: &Path) -> Result<Check, String> {
        let signed_in = spec
            .account
            .as_ref()
            .is_none_or(|(_, home)| home.join("login").exists());
        Ok(Check {
            version: "fake 1".into(),
            signed_in: Some(signed_in),
            how: if signed_in { "fake" } else { "" }.into(),
            models: if signed_in && exe.exists() {
                vec![("fake".into(), true)]
            } else {
                vec![]
            },
        })
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
        let mut env = base_env(spec, &exe, &[]);
        for (k, v) in &spec.opts {
            env.push((k.clone(), v.clone()));
        }
        Launch {
            argv,
            env,
            keep_stdin: true,
            // Its setup goes first, the way a retune sends it.
            input: text.map(|t| setup_line(spec) + &self.encode(spec, t)),
        }
    }

    fn can(&self) -> Can {
        Can {
            steer: true,
            stop: true,
            resume: true,
            levels: &["ask", "auto", "full"],
        }
    }

    fn retune(&self, _last: &Spec, next: &Spec) -> Retune {
        Retune::Send(Delivery::Stdin(setup_line(next)))
    }

    fn control(&self, _spec: &Spec, msg: &Value) -> Result<Delivery, String> {
        let line = match msg["kind"].as_str() {
            Some("answer") => {
                json!({"answer": {"id": msg["request"]["id"], "decision": msg["decision"], "reason": msg["reason"], "answers": msg["answers"]}})
            }
            Some("steer") => json!({"text": msg["text"], "steer": true}),
            Some("interrupt") => json!({"interrupt": true}),
            _ => return Err("unknown control message".into()),
        };
        Ok(Delivery::Stdin(format!("{line}\n")))
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
                json!({"id": v["id"], "title": null, "items": [
                {"text": v["text"], "options": [{"label": "Yes"}, {"label": "No"}], "recommended": 0, "multiSelect": false}]}),
            )],
            "approve" => vec![Event::Approval(json!({"id": v["id"], "action": "command",
                "reason": null, "command": v["command"], "grant": {"scope": "command", "pattern": v["pattern"]}}))],
            "resolved" => vec![Event::Resolved(s(&v, &["id"]).into())],
            "compact" => vec![Event::Compaction("done")],
            "error" => vec![
                match super::classify(&format!("{} {}", v["code"], s(&v, &["message"]))) {
                    Some(Event::Limited(m, _)) => Event::Limited(m, v["resets"].as_u64()),
                    other => other.unwrap_or(Event::Unknown(line.into())),
                },
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

/// The setup a turn runs with, as the fake agent reads it before the turn's message.
fn setup_line(spec: &Spec) -> String {
    format!("{}\n", json!({"setup": super::setup(spec)}))
}
