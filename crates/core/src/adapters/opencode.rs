//! OpenCode: chat holds its own server (`opencode serve`) for the session through Brigadier's helper,
//! never the owner's own service [D86, D159]. It uses OpenCode's own store, so a key the user saved there
//! works in every session, and delete removes the session through OpenCode itself [D35, D89].

mod commands;
mod control;
mod events;
mod grants;
mod http;
mod rewind;
mod server;

use super::setup::run as bounded;
use super::{
    Adapter, Can, Check, Cut, Delivery, Event, Failed, Landing, Launch, ModelInfo, Retune, Rewound,
    Timing, base_env, home_path, mark_superseded, probe, s, sha1, uuid, version,
};
use crate::Spec;
use control::{answers, before_2, message, model, model_info, model_ref, prompt, rules, stopped};
use events::tool_use;
use serde_json::{Value, json};
use std::path::{Component, Path, PathBuf};
use std::process::Command;

pub struct OpenCode;

/// Providers that run on this Mac: OpenCode finds their servers by itself [D68].
const LOCAL: [&str; 3] = ["ollama", "lmstudio", "vllm"];

impl OpenCode {
    fn env(&self, spec: &Spec) -> Vec<(String, String)> {
        let mut env = base_env(spec, &self.exe().unwrap_or_default(), self.keys());
        // Keep credentials in its normal database; even output missed during a stream drop is
        // session-owned and removed on delete [D35, D89].
        env.extend([
            (
                "XDG_DATA_HOME".into(),
                spec.dir.join("runtime").display().to_string(),
            ),
            (
                "XDG_STATE_HOME".into(),
                spec.dir.join("state").display().to_string(),
            ),
            (
                "OPENCODE_DB".into(),
                home_path(".local/share/opencode/opencode.db")
                    .display()
                    .to_string(),
            ),
        ]);
        // The commit style the message writer follows, so the agent's own commits match [D1029], and the `brigadier` line [D2025]:
        // an instructions file in the session's folder, given as inline config, which OpenCode
        // merges with the user's own and loads beside AGENTS.md.
        let style = spec.dir.join("commit-style.md");
        if std::fs::write(&style, crate::agent::standing(spec)).is_ok() {
            let config = control::config(spec, &style, &mut env);
            env.push(("OPENCODE_CONFIG_CONTENT".into(), config.to_string()));
        }
        env
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

    // Its subagents take a model from its config, never an effort [D376].
    fn subagent_rules(&self) -> &'static [&'static str] {
        &["model"]
    }

    fn bin(&self) -> (&'static str, &'static [&'static str]) {
        ("opencode", &[".opencode/bin"])
    }

    fn install(&self) -> Option<&'static str> {
        Some("curl -fsSL https://opencode.ai/v2/install | bash")
    }

    /// `opencode upgrade` (opencode.ai/v2/docs/cli/commands); OpenCode 1's stays on 1 unless given
    /// `--major`, which OpenCode 2's refuses and a 1 before it lacks, so only where its help offers
    /// it; an older 1 first updates to the newest 1 [D2115].
    fn update(&self, exe: Option<&Path>) -> Option<&'static [&'static str]> {
        let offers = |e: &Path| {
            probe(e, Path::new("/"), &[], &["upgrade", "--help"], 10).is_ok_and(|o| {
                String::from_utf8_lossy(&[o.stdout, o.stderr].concat()).contains("--major")
            })
        };
        let old = exe
            .is_some_and(|e| version(e, Path::new("/")).is_ok_and(|v| before_2(&v)) && offers(e));
        Some(if old {
            &["upgrade", "--major"]
        } else {
            &["upgrade"]
        })
    }

    fn latest(&self) -> Option<String> {
        super::setup::npm_latest("@opencode/cli", "latest")
    }

    /// The frame of its mark (opencode.ai/favicon.svg), in the current colour, as the old app drew it [D123].
    fn mark(&self) -> Option<&'static str> {
        Some(
            r#"<svg viewBox="96 96 320 320" fill="currentColor"><path d="M384 416H128V96H384V416ZM320 160H192V352H320V160Z"/></svg>"#,
        )
    }

    /// Its own picker, every provider and method it offers (a subscription's sign-in, a device
    /// code or an API key), in its own prompt [D45, D51, D2078].
    fn sign_in(&self) -> Option<(&'static str, &'static [&'static str])> {
        Some(("Sign in", &["auth", "login", "--standalone"]))
    }

    fn sign_in_prompts(&self) -> bool {
        true
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
        let version = version(exe, cwd)?;
        // Every command here takes flags version 2 added; an older one answers them with its help.
        if before_2(&version) {
            return Err(format!(
                "This version of OpenCode ({version}) is too old. Brigadier needs OpenCode 2 or newer: update it, then check again."
            ));
        }
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
            // A key read from the environment is listed too, but saves nothing: not a sign-in.
            .filter(|p| {
                p["connections"]
                    .as_array()
                    .is_some_and(|c| c.iter().any(|c| c["type"] != "environment"))
            })
            .map(|p| s(p, &["name"]))
            .collect();
        let local = |id: &str| LOCAL.iter().any(|p| id.starts_with(&format!("{p}/")));
        // Its server's list, as the old app read it; where that can't be read, its plain list of ids.
        let listed = text(&["api", "--standalone", "GET", "/api/model"]).ok();
        let listed: Value = (listed
            .and_then(|t| serde_json::from_str(&t[t.find('{').unwrap_or(0)..]).ok()))
        .unwrap_or_default();
        let mut models: Vec<ModelInfo> = (listed["data"].as_array().into_iter().flatten())
            .filter(|m| m["enabled"] != false)
            .map(|m| model_info(m, &local))
            .collect();
        models.sort_by(|a, b| a.id.cmp(&b.id));
        mark_superseded(&mut models);
        if models.is_empty() {
            models = text(&["models", "--standalone"])?
                .lines()
                .filter(|l| l.contains('/') && !l.contains(' '))
                .map(|l| ModelInfo::plain(l, local(l)))
                .collect();
        }
        Ok(Check {
            version,
            signed_in: Some(!saved.is_empty()),
            how: saved.join(", "),
            logins: saved.iter().map(|n| n.to_string()).collect(),
            models,
            ..Default::default()
        })
    }

    fn per_turn(&self) -> bool {
        false
    }

    /// Its PTY daemon, started at the first shell command; the commands run under it.
    fn helpers(&self) -> &[&str] {
        &["opencode-pty"]
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
    /// session's grants [D159, D193]. Chat talks to it through the helper's stdin.
    fn launch(&self, spec: &Spec, resume: Option<&str>, text: Option<&str>) -> Launch {
        let exe = self.exe().unwrap_or_default().display().to_string();
        let env = self.env(spec);
        let helper = std::env::current_exe()
            .unwrap_or_default()
            .with_file_name("brigadier");
        let argv = vec![
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
        lines.push(json!({"permissions": rules(spec), "must": true}));
        lines.extend(text.map(|t| message(spec, t)));
        Launch {
            argv,
            env,
            keep_stdin: true,
            input: Some(lines.iter().map(|l| format!("{l}\n")).collect()),
        }
    }

    fn encode(&self, spec: &Spec, text: &str) -> String {
        format!("{}\n", message(spec, text))
    }

    /// Auto as its own per-tool rules [D130].
    fn can(&self) -> Can {
        Can {
            steer: true,
            stop: true,
            resume: true,
            levels: &["ask", "auto", "full"],
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
            "steer" => {
                let mut p = prompt(spec, s(msg, &["text"]));
                p["delivery"] = "steer".into();
                json!({"prompt": p})
            }
            "interrupt" => json!({"interrupt": true}),
            "stop_task" => json!({"prompt": stopped(spec, msg)}),
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
                        p["message"] = super::denied(msg).into();
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

    fn fixed_commands(&self, cwd: Option<&Path>, _run: Option<&Spec>) -> Vec<Value> {
        commands::fixed(cwd)
    }

    fn command(&self, spec: &Spec, name: &str) -> Result<Delivery, String> {
        commands::command(spec, name)
    }

    fn mcp_servers(&self, folder: &Path) -> Vec<Value> {
        commands::mcp_servers(folder)
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
            "step_start" => events.push(Event::TurnStart),
            "step_finish" => {}
            "text" => events.push(Event::Text(s(part, &["text"]).into())),
            "tool_use" => events.extend(tool_use(part)),
            "error" => {
                events.push(events::refusal(&v["error"]).unwrap_or(Event::Unknown(line.into())))
            }
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
        // The worktree its record holds, its own or one handed on to it [D1080].
        let made = (spec.dir.join("worktree.json").exists()).then(|| {
            std::fs::canonicalize(&spec.dir)
                .unwrap_or(spec.dir.clone())
                .join("worktree")
        });
        if let Some(worktree) = crate::worktrees::folder(&spec.dir).or(made) {
            // Named by the SHA-1 of the worktree's real path, under each project's folder.
            let name = sha1(worktree.to_string_lossy().as_bytes());
            let projects = std::fs::read_dir(home_path(".local/share/opencode/snapshot"));
            let snapshots =
                (projects.into_iter().flatten().flatten()).map(|p| p.path().join(&name));
            files.extend(snapshots);
        }
        files
    }

    /// Deletes the session and its child sessions from OpenCode's store; one already gone counts
    /// as deleted. Never touches credentials or other sessions.
    /// Its small model: on the session model's own provider, the first its list names by a
    /// small model's word, in the list's order [D1029].
    fn cheap(&self, current: Option<&str>, models: &[ModelInfo]) -> Option<String> {
        const SMALL: [&str; 6] = ["haiku", "mini", "nano", "flash", "lite", "small"];
        let provider = current?.split_once('/')?.0;
        (models.iter())
            .filter(|m| m.id.split_once('/').is_some_and(|(p, _)| p == provider))
            .find(|m| (m.id.split(['/', '-', '.', ':', '_'])).any(|w| SMALL.contains(&w)))
            .map(|m| m.id.clone())
    }

    fn forget(&self, spec: &Spec, resume: &str) -> Result<(), String> {
        match self.run(spec, &["session", "delete", resume]) {
            Err(e) if !e.contains("Session not found") => Err(format!("OpenCode: {}", e.trim())),
            _ => Ok(()),
        }
    }

    fn can_cut(&self, cut: &Cut) -> bool {
        cut.dropped.start.is_some()
    }

    fn rewind(&self, spec: &Spec, resume: &str, cut: &Cut) -> Result<Rewound, Failed> {
        rewind::cut(self.exe(), self.env(spec), spec, resume, cut)
    }

    fn landed(&self, spec: &Spec, resume: &str, cut: &Cut, _at: u64) -> Landing {
        rewind::landed(self.exe(), self.env(spec), spec, resume, cut)
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
