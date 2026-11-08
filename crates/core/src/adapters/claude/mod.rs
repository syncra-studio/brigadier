//! Claude Code: one long-lived `claude -p` per session reading stream-json from stdin, with its
//! control channel beside the messages [D159], or the interactive CLI on a PTY. Frame names per
//! its public CLI docs and observed output.

mod control;
mod tools;

use super::setup::{first_field, newest};
use super::{
    Accounts, Adapter, Can, Check, Delivery, Done, Event, Launch, ModelInfo, Retune, Timing,
    base_env, classify, cli_home, drop_lines, file_lines, home_path, in_pty, paste, probe_as, s,
    uuid, version,
};
use crate::Spec;
use crate::terminal::HOOKS;
use serde_json::Value;
use std::path::{Path, PathBuf};
use tools::{tool_end, tool_start};

pub struct Claude;

impl Adapter for Claude {
    fn name(&self) -> &'static str {
        "claude"
    }

    fn label(&self) -> &'static str {
        "Claude Code"
    }

    fn bin(&self) -> (&'static str, &'static [&'static str]) {
        ("claude", &[".local/bin"])
    }

    fn install(&self) -> Option<&'static str> {
        Some("curl -fsSL https://claude.ai/install.sh | bash")
    }

    /// Claude's spark, from Simple Icons (CC0), in its brand colour (a theme token: the CSP refuses a style attribute), as the old app drew it [D123].
    fn mark(&self) -> Option<&'static str> {
        Some(include_str!("claude.svg"))
    }

    fn sign_in(&self) -> Option<(&'static str, &'static [&'static str])> {
        Some(("Sign in", &["auth", "login"]))
    }

    /// "If the browser didn't open, visit: …": that page shows a code to paste back.
    fn code_page(&self) -> bool {
        true
    }

    /// The code as the page shows it (`code#state`). Given only a part, it answers on stderr and
    /// goes on waiting, so a part is refused here, where it can be said.
    fn sign_in_code(&self, code: &str) -> Result<String, String> {
        let code = code.trim();
        match code.split_once('#') {
            Some((c, state)) if !c.is_empty() && !state.is_empty() => Ok(code.into()),
            _ => Err(
                "That isn't the whole code. Copy all of it from the page, then paste it again."
                    .into(),
            ),
        }
    }

    /// `claude auth status` exits 0 when signed in and says how in its JSON. No key variable is
    /// passed on: in print mode one would bill it in place of the user's subscription.
    fn check(&self, spec: &Spec, exe: &Path, cwd: &Path) -> Result<Check, String> {
        let out = probe_as(spec, exe, cwd, &[], &["auth", "status"], 15)?;
        let status: Value = serde_json::from_slice(&out.stdout).unwrap_or_default();
        let signed_in = out.status.success();
        let how = match s(&status, &["authMethod"]) {
            "claude.ai" => "Claude account",
            "api_key" | "api_key_helper" => "API key",
            "oauth_token" => "token",
            "third_party" => "cloud provider",
            _ => "",
        };
        Ok(Check {
            version: version(exe, cwd)?,
            signed_in: Some(signed_in),
            how: how.into(),
            models: if signed_in {
                ["sonnet", "opus", "haiku"]
                    .map(|m| ModelInfo::plain(m, false))
                    .into()
            } else {
                vec![]
            },
        })
    }

    /// `CLAUDE_CONFIG_DIR` keeps a Claude account's login apart, its Keychain entry included. A
    /// Console sign-in without an API key isn't kept apart, so only subscription sign-ins are
    /// allowed (code.claude.com/docs/en/authentication) [D51].
    fn accounts(&self) -> Option<Accounts> {
        Some(Accounts {
            var: "CLAUDE_CONFIG_DIR",
            home: ".claude",
            links: &["projects", "CLAUDE.md"],
            vendor: "Anthropic",
            sign_in: &["auth", "login", "--claudeai"],
            sign_out: &["auth", "logout"],
            kinds: &["Claude account"],
        })
    }

    /// The folder each transcript was written in, from its own record.
    fn projects(&self) -> Vec<PathBuf> {
        newest(&home_path(".claude/projects"), ".jsonl", 1, 300)
            .iter()
            .filter_map(|p| first_field(p, &["cwd"]).map(PathBuf::from))
            .collect()
    }

    fn per_turn(&self) -> bool {
        false
    }

    fn launch(&self, spec: &Spec, resume: Option<&str>, text: Option<&str>) -> Launch {
        let exe = self.exe().unwrap_or_default();
        let model = control::model(spec);
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
        argv.extend(["--model".into(), model]);
        if let Some(effort) = &spec.effort {
            argv.extend(["--effort".into(), effort.clone()]);
        }
        // Its prompts and questions come on the control channel, at the session's level; Full
        // can be taken later without a restart. A terminal asks in its own screen, at the same
        // level [D243].
        if spec.mode != "pty" {
            argv.extend(
                [
                    "--permission-prompt-tool",
                    "stdio",
                    "--allow-dangerously-skip-permissions",
                ]
                .map(String::from),
            );
        }
        let level = spec.level.as_deref().unwrap_or("ask");
        argv.extend(["--permission-mode".into(), control::mode(level).into()]);
        // The session's grants, given again to a child its host starts anew [D193, D238].
        let rules = control::rules(&spec.grants);
        if !rules.is_empty() {
            argv.push("--allowedTools".into());
            argv.extend(rules);
        }
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
            env: base_env(spec, &exe, self.keys()),
            keep_stdin: true,
            input,
        }
    }

    fn encode(&self, spec: &Spec, text: &str) -> String {
        if spec.mode == "pty" {
            return paste(text);
        }
        control::user(text)
    }

    fn can(&self) -> Can {
        Can {
            steer: true,
            stop: true,
            resume: true,
            levels: &["ask", "auto", "full"],
        }
    }

    fn retune(&self, last: &Spec, next: &Spec) -> Retune {
        control::retune(last, next)
    }

    fn control(&self, _spec: &Spec, msg: &Value) -> Result<Delivery, String> {
        control::control(msg)
    }

    fn parse(&self, line: &str) -> Vec<Event> {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            return vec![Event::Unknown(line.into())];
        };
        if let Some(events) = control::parse(&v) {
            return events;
        }
        if v["hook"].is_object() {
            return control::hook(&v["hook"], s(&v, &["id"]));
        }
        let blocks = || {
            v["message"]["content"]
                .as_array()
                .cloned()
                .unwrap_or_default()
        };
        // A subagent's own steps stream here too, under the Agent call that runs it [D78].
        let parent = v["parent_tool_use_id"].as_str().map(String::from);
        // A line of the CLI's own record, which a terminal's mirror copies [D47]: the same
        // messages as stream-json, plus the typed prompt, the turn's end and bookkeeping.
        let record = v.get("sessionId").is_some()
            || matches!(s(&v, &["type"]), "file-history-snapshot" | "summary");
        let typed = v["message"]["content"]
            .as_str()
            .filter(|t| record && v["isMeta"] != true && v["isSidechain"] != true && !synthetic(t));
        match (s(&v, &["type"]), s(&v, &["subtype"])) {
            ("user", _) if typed.is_some() => vec![
                Event::Resume(s(&v, &["sessionId"]).into()),
                Event::Prompt(s(&v, &["uuid"]).into(), typed.unwrap_or("").into()),
            ],
            ("system", "turn_duration") if record => vec![Event::TurnEnd(true)],
            _ if record && v["isSidechain"] == true => vec![],
            ("system", "init") => [
                Some(Event::Resume(s(&v, &["session_id"]).into())),
                Some(Event::TurnStart),
                control::level(&v),
            ]
            .into_iter()
            .flatten()
            .collect(),
            ("system", "status") => control::level(&v).into_iter().collect(),
            ("system", "compact_boundary") => vec![Event::Compaction("done")],
            // A subagent's end, also one that ran in the background past its call's result [D78].
            ("system", "task_notification") if !s(&v, &["tool_use_id"]).is_empty() => {
                vec![Event::ToolEnd(Done {
                    id: s(&v, &["tool_use_id"]).into(),
                    output: s(&v, &["summary"]).into(),
                    ok: s(&v, &["status"]) == "completed",
                    child: v["task_id"].as_str().map(String::from),
                    ..Default::default()
                })]
            }
            ("system", _) | ("stream_event", _) => vec![],
            ("assistant", _) => blocks()
                .iter()
                .flat_map(|b| match s(b, &["type"]) {
                    "text" if parent.is_none() => vec![Event::Text(s(b, &["text"]).into())],
                    "thinking" if parent.is_none() && !s(b, &["thinking"]).is_empty() => {
                        vec![Event::Reasoning(s(b, &["thinking"]).into())]
                    }
                    "tool_use" => tool_start(b, parent.clone(), record),
                    _ => vec![],
                })
                .collect(),
            ("user", _) => blocks()
                .iter()
                .filter(|b| s(b, &["type"]) == "tool_result")
                .flat_map(|b| {
                    let result = match &v["tool_use_result"] {
                        Value::Null => &v["toolUseResult"],
                        r => r,
                    };
                    tool_end(b, result, parent.clone(), record)
                })
                .collect(),
            // Its reset time is in seconds [D74, D220].
            ("rate_limit_event", _) => match s(&v, &["rate_limit_info", "status"]) {
                "rejected" => vec![Event::Limited(
                    line.chars().take(300).collect(),
                    v["rate_limit_info"]["resetsAt"].as_u64().map(|t| t * 1000),
                )],
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
            _ if record => vec![],
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

    /// Its prompt history keeps the terminal's prompts, by conversation id [D35].
    fn forget(&self, spec: &Spec, resume: &str) -> Result<(), String> {
        drop_lines(
            &cli_home(spec, ".claude", "history.jsonl"),
            "sessionId",
            resume,
        )
        .map_err(|e| e.to_string())?;
        purge(self, spec)
    }

    fn terminal(&self, spec: &Spec, resume: Option<&str>) -> Result<(Launch, String), String> {
        let mut launch = self.launch(&in_pty(spec), resume, None);
        // Its hooks tell Brigadier the level it runs at and what it asks in its screen, and let a
        // held session refuse a turn above Ask [D47, D238, D243]. They only add to the user's own.
        let exe = std::env::current_exe()
            .unwrap_or_default()
            .with_file_name("brigadier");
        let data = crate::data_of(spec);
        let command = [data.as_path(), &exe].map(|p| quote(&p.display().to_string()));
        let command = format!(
            "BRIGADIER_DATA={} {} hook {} claude",
            command[0],
            command[1],
            quote(&spec.id)
        );
        let hook = serde_json::json!([{"matcher": "*", "hooks": [{"type": "command", "command": command}]}]);
        let settings =
            serde_json::json!({"hooks": {"UserPromptSubmit": hook, "PermissionRequest": hook}});
        launch
            .argv
            .extend(["--settings".into(), settings.to_string()]);
        let conv = match resume {
            Some(id) => id.to_string(),
            None => {
                let id = uuid();
                launch.argv.extend(["--session-id".into(), id.clone()]);
                id
            }
        };
        Ok((launch, conv))
    }

    /// Its record, then what its hooks kept in the session folder: `<record end>:<hooks end>`.
    fn mirror_from(&self, spec: &Spec, conv: &str) -> Option<String> {
        let len = |p: PathBuf| std::fs::metadata(p).map_or(0, |m| m.len());
        let record = len(project_dir(spec).join(format!("{conv}.jsonl")));
        Some(format!("{record}:{}", len(spec.dir.join(HOOKS))))
    }

    fn mirror(&self, spec: &Spec, conv: &str, cursor: &str) -> (Vec<String>, String) {
        let (record, hooks) = cursor.split_once(':').unwrap_or((cursor, "0"));
        let path = project_dir(spec).join(format!("{conv}.jsonl"));
        let (mut lines, end) = file_lines(&path, record.parse().unwrap_or(0));
        let (more, hooks) = file_lines(&spec.dir.join(HOOKS), hooks.parse().unwrap_or(0));
        lines.extend(more);
        (lines, format!("{end}:{hooks}"))
    }

    /// A held session's terminal starts no turn above Ask: trust taken back while it's open, or
    /// its mode changed there, refuses the next prompt until it's opened again [D166, D243].
    fn hold(&self, hook: &Value) -> Option<String> {
        let above = matches!(
            s(hook, &["permission_mode"]),
            "auto" | "bypassPermissions" | "acceptEdits"
        );
        (s(hook, &["hook_event_name"]) == "UserPromptSubmit" && above).then(|| {
            serde_json::json!({"decision": "block", "reason": "This folder isn't trusted, so its sessions run under Ask. Close this terminal and open it again to go on under Ask."}).to_string()
        })
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

/// A shell word for a hook's command line.
fn quote(text: &str) -> String {
    format!("'{}'", text.replace('\'', "'\\''"))
}

/// A working folder inside the session's own (its worktree) is the session's alone, so Claude's
/// own purge takes what it keeps for that folder, its entry in `.claude.json` among it [D35]. Run
/// only when that entry is there, so a delete never fails on nothing to purge.
fn purge(a: &Claude, spec: &Spec) -> Result<(), String> {
    let Ok(inside) = Path::new(&spec.cwd).strip_prefix(&spec.dir) else {
        return Ok(());
    };
    let dir = std::fs::canonicalize(&spec.dir).unwrap_or_else(|_| spec.dir.clone());
    let folder = dir.join(inside).display().to_string();
    let config = std::fs::read(cli_home(spec, "", ".claude.json")).unwrap_or_default();
    let config: Value = serde_json::from_slice(&config).unwrap_or_default();
    if config["projects"].get(&folder).is_none() {
        return Ok(());
    }
    let exe = a
        .exe()
        .ok_or("Claude Code isn't installed, so its record of the worktree stays")?;
    let out = probe_as(spec, &exe, &dir, &[], &["purge", &folder, "--yes"], 30)?;
    if !out.status.success() {
        return Err(format!(
            "claude purge: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(())
}

/// A user line the CLI writes itself (slash commands, `!` shell runs, reminders), not a prompt.
fn synthetic(text: &str) -> bool {
    const TAGS: [&str; 6] = [
        "<command-",
        "<local-command-",
        "<bash-",
        "<system-reminder>",
        "<task-notification>",
        "<cross-session-message",
    ];
    TAGS.iter().any(|t| text.starts_with(t))
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
