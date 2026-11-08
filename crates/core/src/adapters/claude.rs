//! Claude Code: one long-lived `claude -p` per session reading stream-json from stdin, or the
//! interactive CLI on a PTY. Frame names per its public CLI docs and observed output.

use super::setup::{first_field, newest};
use super::{
    Accounts, Adapter, Check, Done, Event, Launch, ModelInfo, Timing, Tool, base_env, change,
    classify, cli_home, counts, drop_lines, file_lines, home_path, in_pty, paste, probe_as, s,
    shell_step, uuid, version,
};
use crate::Spec;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

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
        argv.extend(["--model".into(), model]);
        // A terminal runs in the CLI's normal permission mode, so it asks there.
        if spec.mode != "pty" {
            argv.push("--dangerously-skip-permissions".into());
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
            ("system", "init") => vec![
                Event::Resume(s(&v, &["session_id"]).into()),
                Event::TurnStart,
            ],
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
                    "tool_use" => tool_start(b, parent.clone()),
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
                    tool_end(b, result, parent.clone())
                })
                .collect(),
            ("rate_limit_event", _) => match s(&v, &["rate_limit_info", "status"]) {
                "rejected" => vec![Event::Limited(line.chars().take(300).collect(), None)],
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
        .map(drop)
        .map_err(|e| e.to_string())
    }

    fn terminal(&self, spec: &Spec, resume: Option<&str>) -> Result<(Launch, String), String> {
        let mut launch = self.launch(&in_pty(spec), resume, None);
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

    fn mirror_from(&self, spec: &Spec, conv: &str) -> Option<String> {
        let path = project_dir(spec).join(format!("{conv}.jsonl"));
        Some(std::fs::metadata(path).map_or(0, |m| m.len()).to_string())
    }

    fn mirror(&self, spec: &Spec, conv: &str, cursor: &str) -> (Vec<String>, String) {
        let path = project_dir(spec).join(format!("{conv}.jsonl"));
        let (lines, end) = file_lines(&path, cursor.parse().unwrap_or(0));
        (lines, end.to_string())
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

/// A `tool_use` block as a step, by Claude Code's tool names [D48, D65].
fn tool_start(b: &Value, parent: Option<String>) -> Vec<Event> {
    let (id, name, input) = (s(b, &["id"]), s(b, &["name"]), &b["input"]);
    if name == "AskUserQuestion" {
        // Per its docs: questions, each with options by label. Only an interactive CLI shows it.
        let questions = input["questions"].as_array().cloned().unwrap_or_default();
        return questions
            .iter()
            .enumerate()
            .map(|(k, q)| {
                let options = q["options"].as_array().into_iter().flatten();
                let options: Vec<String> = options.map(|o| s(o, &["label"]).to_string()).collect();
                super::question(&format!("{id}:{k}"), s(q, &["question"]), &options)
            })
            .collect();
    }
    let field = |k: &str| s(input, &[k]).to_string();
    let (step, what) = match name {
        "Read" => ("read", field("file_path")),
        "Edit" | "MultiEdit" | "Write" => ("edit", field("file_path")),
        "NotebookEdit" => ("edit", field("notebook_path")),
        "Grep" | "Glob" => ("search", field("pattern")),
        "LS" => ("search", field("path")),
        "WebFetch" => ("web", field("url")),
        "WebSearch" => ("web", field("query")),
        "Bash" => shell_step(&field("command")),
        "Agent" | "Task" => ("agent", field("description")),
        "ToolSearch" | "ExitPlanMode" | "TaskOutput" | "BashOutput" => ("", String::new()),
        _ => ("other", input.to_string()),
    };
    // Every edit names its file from the start, so a running or failed one still shows. Whether a
    // write created its file only its result says; until then it reads as modified.
    let changes = match step {
        "edit" => vec![change(&what, "modified", None, None, None)],
        _ => vec![],
    };
    vec![Event::ToolStart(Tool {
        id: id.into(),
        name: name.into(),
        step,
        input: what,
        parent,
        changes,
        at: None,
    })]
}

/// A `tool_result` block, with the structured result the CLI puts beside it.
fn tool_end(b: &Value, result: &Value, parent: Option<String>) -> Vec<Event> {
    let id = s(b, &["tool_use_id"]);
    let text = |content: &Value| match content {
        Value::String(t) => t.clone(),
        Value::Array(parts) => parts
            .iter()
            .filter_map(|p| p["text"].as_str())
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    };
    if let Some(answers) = result["answers"].as_object() {
        let asked = result["questions"].as_array().cloned().unwrap_or_default();
        return asked
            .iter()
            .enumerate()
            .map(|(k, q)| {
                let answer = answers.get(s(q, &["question"])).map(|a| match a {
                    Value::String(t) => t.clone(),
                    other => other.to_string(),
                });
                Event::Answer(format!("{id}:{k}"), answer)
            })
            .collect();
    }
    let path = s(result, &["filePath"]);
    let changes = if result["type"] == "create" {
        let content = s(result, &["content"]);
        let lines: Vec<String> = content.lines().map(|l| format!("+{l}")).collect();
        let diff = format!("@@ -0,0 +1,{} @@\n{}", lines.len(), lines.join("\n"));
        vec![change(
            path,
            "added",
            Some(diff),
            Some(lines.len() as u64),
            Some(0),
        )]
    } else if result["structuredPatch"]
        .as_array()
        .is_some_and(|h| h.is_empty())
    {
        // A whole-file write can come without hunks: its diff and counts stay unreported.
        vec![change(path, "modified", None, None, None)]
    } else if let Some(hunks) = result["structuredPatch"].as_array() {
        let diff = hunks
            .iter()
            .map(|h| {
                let lines = h["lines"].as_array().into_iter().flatten();
                let body: Vec<&str> = lines.filter_map(Value::as_str).collect();
                format!(
                    "@@ -{},{} +{},{} @@\n{}",
                    h["oldStart"],
                    h["oldLines"],
                    h["newStart"],
                    h["newLines"],
                    body.join("\n")
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
        let (added, removed) = counts(&diff);
        vec![change(
            path,
            "modified",
            Some(diff),
            Some(added),
            Some(removed),
        )]
    } else {
        vec![]
    };
    // A subagent's result carries its answer and id beside the wrapped text. One launched in the
    // background only says so here: its end comes as a task notification.
    let child = result["agentId"].as_str().map(String::from);
    if result["status"] == "async_launched" {
        return vec![];
    }
    let output = match child {
        Some(_) => {
            let answer = text(&result["content"]);
            let tag = "</tools-used-before-summary>";
            match answer.split_once(tag) {
                Some((_, rest)) if answer.starts_with("<tools-used-before-summary>") => {
                    rest.trim_start().to_string()
                }
                _ => answer,
            }
        }
        None => text(&b["content"]),
    };
    vec![Event::ToolEnd(Done {
        id: id.into(),
        output,
        ok: b["is_error"].as_bool() != Some(true),
        exit: None,
        changes,
        child,
        parent,
        at: None,
    })]
}
