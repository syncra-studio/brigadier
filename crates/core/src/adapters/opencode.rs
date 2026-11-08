//! OpenCode: chat holds its own server (`opencode serve`) for the session through Brigadier's helper,
//! never the owner's own service [D86, D159]. It uses OpenCode's own store, so a key the user saved there
//! works in every session, and delete removes the session through OpenCode itself [D35, D89].

mod control;
mod events;
mod grants;
mod http;
mod server;
mod terminal;

use super::setup::run as bounded;
use super::{
    Adapter, Can, Check, Delivery, Event, Launch, ModelInfo, Retune, Timing, base_env, classify,
    file_lines, home_path, in_pty, paste, probe, s, sha1, uuid, version,
};
use crate::Spec;
use control::{answers, denied, model, model_ref, rules};
use events::{mirrored, tool_use};
use serde_json::{Value, json};
use std::path::{Component, Path, PathBuf};
use std::process::Command;

pub struct OpenCode;

/// Providers that run on this Mac: OpenCode finds their servers by itself [D68].
const LOCAL: [&str; 3] = ["ollama", "lmstudio", "vllm"];

impl OpenCode {
    fn env(&self, spec: &Spec) -> Vec<(String, String)> {
        base_env(spec, &self.exe().unwrap_or_default(), self.keys())
    }

    /// Its own command on a private server, bounded; what it printed, or why it failed.
    fn run(&self, spec: &Spec, args: &[&str]) -> Result<String, String> {
        let mut command = Command::new(self.exe().ok_or("OpenCode is not installed")?);
        command
            .args(args)
            .arg("--standalone")
            .env_clear()
            .envs(self.env(spec))
            // A project folder since moved or removed must not block deleting its session.
            .current_dir(match Path::new(&spec.cwd) {
                cwd if cwd.is_dir() => cwd,
                _ => spec.dir.as_path(),
            });
        let out = bounded(&mut command, 60)?;
        let text = String::from_utf8_lossy(&out.stdout).into_owned();
        if out.status.success() {
            Ok(text)
        } else {
            Err(text + &String::from_utf8_lossy(&out.stderr))
        }
    }
}

impl Adapter for OpenCode {
    fn name(&self) -> &'static str {
        "opencode"
    }

    fn label(&self) -> &'static str {
        "OpenCode"
    }

    fn bin(&self) -> (&'static str, &'static [&'static str]) {
        ("opencode", &[".opencode/bin"])
    }

    fn install(&self) -> Option<&'static str> {
        Some("curl -fsSL https://opencode.ai/v2/install | bash")
    }

    /// The frame of its mark (opencode.ai/favicon.svg), in the current colour, as the old app drew it [D123].
    fn mark(&self) -> Option<&'static str> {
        Some(
            r#"<svg viewBox="96 96 320 320" fill="currentColor"><path d="M384 416H128V96H384V416ZM320 160H192V352H320V160Z"/></svg>"#,
        )
    }

    /// Its own picker: an API key for any provider it knows, typed into its prompt [D45, D51].
    fn sign_in(&self) -> Option<(&'static str, &'static [&'static str])> {
        Some(("Add an API key", &["auth", "login", "--standalone"]))
    }

    /// The models.dev variables of the providers people most often use with it; a saved account
    /// wins over a variable.
    fn keys(&self) -> &'static [&'static str] {
        &[
            "ANTHROPIC_API_KEY",
            "OPENAI_API_KEY",
            "GOOGLE_GENERATIVE_AI_API_KEY",
            "GOOGLE_API_KEY",
            "GEMINI_API_KEY",
            "OPENROUTER_API_KEY",
            "GROQ_API_KEY",
            "DEEPSEEK_API_KEY",
            "MISTRAL_API_KEY",
            "XAI_API_KEY",
            "OPENCODE_API_KEY",
        ]
    }

    /// Signed in means a saved account (`auth list`); usable means `models` lists something for
    /// this folder: a saved or variable key, a local server it found, or its free models.
    fn check(&self, _spec: &Spec, exe: &Path, cwd: &Path) -> Result<Check, String> {
        let text = |args: &[&str]| -> Result<String, String> {
            let out = probe(exe, cwd, self.keys(), args, 30)?;
            let said = String::from_utf8_lossy(&out.stdout).into_owned();
            match out.status.success() {
                true => Ok(said),
                false => Err(said + &String::from_utf8_lossy(&out.stderr)),
            }
        };
        let auth = text(&["auth", "list", "--format", "json", "--standalone"])?;
        let auth: Value =
            serde_json::from_str(&auth[auth.find('[').unwrap_or(0)..]).unwrap_or_default();
        let saved: Vec<&str> = auth
            .as_array()
            .into_iter()
            .flatten()
            .filter(|p| p["connections"].as_array().is_some_and(|c| !c.is_empty()))
            .map(|p| s(p, &["name"]))
            .collect();
        let models = text(&["models", "--standalone"])?
            .lines()
            .filter(|l| l.contains('/') && !l.contains(' '))
            .map(|l| ModelInfo::plain(l, LOCAL.iter().any(|p| l.starts_with(&format!("{p}/")))))
            .collect();
        Ok(Check {
            version: version(exe, cwd)?,
            signed_in: Some(!saved.is_empty()),
            how: saved.join(", "),
            models,
        })
    }

    fn per_turn(&self) -> bool {
        false
    }

    /// Each line to the helper is one request to its server, applied only once its reply names it.
    fn acks(&self) -> bool {
        true
    }

    /// A message sent to its session mid-turn joins the turn that runs, so only a steer goes then.
    fn queues(&self) -> bool {
        false
    }

    fn helper(&self, args: &[String]) -> Result<(), String> {
        server::run(args)
    }

    /// Its server runs in Brigadier's helper, on the session's level and model, with the
    /// session's grants [D159, D193]. Chat talks to it through the helper's stdin; a terminal is
    /// its TUI attached to that same server, at the level the helper sets [D47, D243].
    fn launch(&self, spec: &Spec, resume: Option<&str>, text: Option<&str>) -> Launch {
        let exe = self.exe().unwrap_or_default().display().to_string();
        let mut env = self.env(spec);
        let helper = std::env::current_exe()
            .unwrap_or_default()
            .with_file_name("brigadier");
        let mut argv = vec![
            helper.display().to_string(),
            "helper".into(),
            "opencode".into(),
            exe,
        ];
        let mut open = json!({"location": {"directory": spec.cwd}});
        if let Some(id) = resume {
            open["id"] = id.into();
        }
        let grants: Vec<Value> = (spec.grants.iter())
            .map(|g| json!({"action": g["cli"]["action"], "save": g["cli"]["save"]}))
            .collect();
        let mut lines = vec![
            json!({"open": open, "grants": grants, "must": true}),
            json!({"model": model_ref(spec), "must": true}),
        ];
        if spec.mode == "pty" {
            // Its TUI takes no -m: the model comes from its documented inline config instead.
            env.push((
                "OPENCODE_CONFIG_CONTENT".into(),
                json!({ "model": model(spec) }).to_string(),
            ));
            let data = crate::data_of(spec).display().to_string();
            let setup = json!({"lines": lines, "prompt": text});
            argv.extend([
                "--terminal".into(),
                data,
                spec.id.clone(),
                setup.to_string(),
            ]);
            return Launch {
                argv,
                env,
                keep_stdin: true,
                input: None,
            };
        }
        lines.push(json!({"permissions": rules(spec), "must": true}));
        lines.extend(text.map(|t| json!({"prompt": {"text": t}, "id": spec.cid})));
        Launch {
            argv,
            env,
            keep_stdin: true,
            input: Some(lines.iter().map(|l| format!("{l}\n")).collect()),
        }
    }

    fn encode(&self, spec: &Spec, text: &str) -> String {
        if spec.mode == "pty" {
            return paste(text);
        }
        format!("{}\n", json!({"prompt": {"text": text}, "id": spec.cid}))
    }

    /// No auto mode, so Auto isn't offered [D175, D187].
    fn can(&self) -> Can {
        Can {
            steer: true,
            stop: true,
            resume: true,
            levels: &["ask", "full"],
        }
    }

    /// A new model, effort or level goes to the idle session as its own requests, each confirmed
    /// before the message [D222].
    fn retune(&self, last: &Spec, next: &Spec) -> Retune {
        let mut lines = vec![];
        if (model(last), &last.effort) != (model(next), &next.effort) {
            lines.push(json!({"model": model_ref(next)}));
        }
        if last.level != next.level {
            lines.push(json!({"permissions": rules(next)}));
        }
        if lines.is_empty() {
            return Retune::InMessage;
        }
        let ids: Vec<String> = lines
            .iter()
            .map(|_| format!("brigadier-{}", uuid()))
            .collect();
        let lines = lines.into_iter().zip(&ids).map(|(mut l, id)| {
            l["id"] = id.as_str().into();
            format!("{l}\n")
        });
        Retune::Confirm(Delivery::Stdin(lines.collect()), ids)
    }

    /// A control message as the helper's line, named by its command id [D159, D192, D193].
    fn control(&self, spec: &Spec, msg: &Value) -> Result<Delivery, String> {
        let r = &msg["request"];
        let mut line = match s(msg, &["kind"]) {
            "steer" => json!({"prompt": {"text": msg["text"], "delivery": "steer"}}),
            "interrupt" => json!({"interrupt": true}),
            "answer" if r["items"].is_array() => {
                json!({"form": {"session": r["cli"]["session"], "id": r["id"], "answer": answers(r, msg)}})
            }
            "answer" => {
                let mut p =
                    json!({"session": r["cli"]["session"], "id": r["id"], "decision": "once"});
                let mut line = json!({});
                match s(msg, &["decision"]) {
                    "allow" => {}
                    // Held by the helper for this session; its `always` saves lasting rules [D193].
                    "allowSession" if r["grant"].is_object() => {
                        line["grant"] =
                            json!({"action": r["cli"]["action"], "save": r["cli"]["save"]});
                    }
                    "deny" => {
                        p["decision"] = "reject".into();
                        p["message"] = denied(s(msg, &["reason"])).into();
                    }
                    other => return Err(format!("no such decision here: {other:?}")),
                }
                line["permission"] = p;
                line
            }
            _ => return Err("unknown control message".into()),
        };
        line["id"] = spec.cid.clone().into();
        Ok(Delivery::Stdin(format!("{line}\n")))
    }

    fn parse(&self, line: &str) -> Vec<Event> {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            return vec![Event::Unknown(line.into())];
        };
        if let Some(events) = events::server(&v) {
            return events;
        }
        // A turn of `run`, as sessions before its server logged them.
        let part = &v["part"];
        let mut events: Vec<Event> = v["sessionID"]
            .as_str()
            .map(|id| Event::Resume(id.into()))
            .into_iter()
            .collect();
        match s(&v, &["type"]) {
            "mirror" => return mirrored(&v["message"]),
            "step_start" => events.push(Event::TurnStart),
            "step_finish" => {}
            "text" => events.push(Event::Text(s(part, &["text"]).into())),
            "tool_use" => events.extend(tool_use(part)),
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

    /// Its commands' output files, as the session recorded them, only ever in its shell folder;
    /// and the snapshot repo of the session's own worktree. One of a folder others use stays.
    fn external(&self, spec: &Spec, _resume: &str) -> Vec<PathBuf> {
        let mut files = vec![];
        let _ = crate::read(&spec.dir, |item| {
            if item["kind"] == "external" {
                files.push(PathBuf::from(s(item, &["path"])));
            }
        });
        files.retain(|p| {
            let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
            let shell = p.parent().and_then(Path::parent).and_then(Path::file_name);
            let plain =
                (p.components()).all(|c| matches!(c, Component::RootDir | Component::Normal(_)));
            p.is_absolute()
                && plain
                && name.starts_with("sh_")
                && name.ends_with(".out")
                && shell == Some("shell".as_ref())
        });
        if spec.dir.join("worktree.json").exists() {
            // Named by the SHA-1 of the worktree's real path, under each project's folder.
            let dir = std::fs::canonicalize(&spec.dir).unwrap_or(spec.dir.clone());
            let name = sha1(dir.join("worktree").to_string_lossy().as_bytes());
            let projects = std::fs::read_dir(home_path(".local/share/opencode/snapshot"));
            files.extend(
                projects
                    .into_iter()
                    .flatten()
                    .flatten()
                    .map(|p| p.path().join(&name)),
            );
        }
        files
    }

    /// Deletes the session and its child sessions from OpenCode's store; one already gone counts
    /// as deleted. Never touches credentials or other sessions.
    fn forget(&self, spec: &Spec, resume: &str) -> Result<(), String> {
        match self.run(spec, &["session", "delete", resume]) {
            Err(e) if !e.contains("Session not found") => Err(format!("OpenCode: {}", e.trim())),
            _ => Ok(()),
        }
    }

    /// Its TUI on the session's own server, by the session's id (proposed: the first message goes
    /// through chat, so the id exists).
    fn terminal(&self, spec: &Spec, resume: Option<&str>) -> Result<(Launch, String), String> {
        let id = resume.ok_or("Send the first message in chat. The terminal then opens on it.")?;
        Ok((self.launch(&in_pty(spec), Some(id), None), id.into()))
    }

    /// What the terminal's helper wrote to the session's hooks file: its server's events.
    fn mirror_from(&self, spec: &Spec, _conv: &str) -> Option<String> {
        let len = std::fs::metadata(spec.dir.join(crate::terminal::HOOKS)).map_or(0, |m| m.len());
        Some(len.to_string())
    }

    fn mirror(&self, spec: &Spec, _conv: &str, cursor: &str) -> (Vec<String>, String) {
        let path = spec.dir.join(crate::terminal::HOOKS);
        let (lines, end) = file_lines(&path, cursor.parse().unwrap_or(0));
        (lines, end.to_string())
    }

    fn transcript(&self, spec: &Spec, resume: &str) -> Option<(u64, u64)> {
        let out = self.run(spec, &["session", "export", resume]).ok()?;
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
