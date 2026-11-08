//! OpenCode: one `opencode run --format json` per turn, each on a private server (`--standalone`),
//! never the owner's own service [D86]. It uses OpenCode's own store, so a key the user saved there
//! works in every session, and delete removes the session through OpenCode itself [D35, D89].

use super::setup::run as bounded;
use super::{
    Adapter, Check, Done, Event, Launch, Timing, Tool, base_env, change, classify, counts, in_pty,
    paste, probe, s, shell_step, version,
};
use crate::Spec;
use serde_json::Value;
use std::path::Path;
use std::process::Command;

pub struct OpenCode;

/// Providers that run on this Mac: OpenCode finds their servers by itself [D68].
const LOCAL: [&str; 3] = ["ollama", "lmstudio", "vllm"];

impl OpenCode {
    fn env(&self, spec: &Spec) -> Vec<(String, String)> {
        base_env(spec, &self.exe().unwrap_or_default(), self.keys())
    }

    /// A session's newest messages, newest first.
    // shortcut: one page of 100; a terminal turn writing more between two reads loses the rest.
    fn messages(&self, spec: &Spec, conv: &str) -> Option<Vec<Value>> {
        let id = format!("sessionID={conv}");
        let args = [
            "api",
            "session.message.list",
            "--param",
            &id,
            "--param",
            "limit=100",
        ];
        let out = self.run(spec, &args).ok()?;
        let v: Value = serde_json::from_str(&out[out.find('{')?..]).ok()?;
        v["data"].as_array().cloned()
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
            .map(|l| {
                (
                    l.to_string(),
                    LOCAL.iter().any(|p| l.starts_with(&format!("{p}/"))),
                )
            })
            .collect();
        Ok(Check {
            version: version(exe, cwd)?,
            signed_in: Some(!saved.is_empty()),
            how: saved.join(", "),
            models,
        })
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
        argv.push("--standalone".into());
        let mut env = self.env(spec);
        // Its TUI takes no -m: the model comes from its documented inline config instead.
        if spec.mode == "pty" {
            env.push((
                "OPENCODE_CONFIG_CONTENT".into(),
                serde_json::json!({ "model": model }).to_string(),
            ));
        } else {
            argv.extend(["-m".into(), model]);
        }
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
            env,
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

    /// Deletes the session and its child sessions from OpenCode's store; one already gone counts
    /// as deleted. Never touches credentials or other sessions.
    fn forget(&self, spec: &Spec, resume: &str) -> Result<(), String> {
        match self.run(spec, &["session", "delete", resume]) {
            Err(e) if !e.contains("Session not found") => Err(format!("OpenCode: {}", e.trim())),
            _ => Ok(()),
        }
    }

    /// Its TUI opens a session by id, on the same private server data as `run` (proposed: the
    /// first message goes through chat, so the id exists).
    fn terminal(&self, spec: &Spec, resume: Option<&str>) -> Result<(Launch, String), String> {
        let id = resume.ok_or("Send the first message in chat. The terminal then opens on it.")?;
        Ok((self.launch(&in_pty(spec), Some(id), None), id.into()))
    }

    fn mirror_from(&self, spec: &Spec, conv: &str) -> Option<String> {
        let all = self.messages(spec, conv)?;
        Some(all.iter().map(|m| s(m, &["id"])).max().unwrap_or("").into())
    }

    /// Its record is SQLite, so the mirror asks its own API, read-only, on a private server over
    /// the session's data; never the owner's own service.
    fn mirror(&self, spec: &Spec, conv: &str, cursor: &str) -> (Vec<String>, String) {
        let Some(mut all) = self.messages(spec, conv) else {
            return (vec![], cursor.into());
        };
        all.retain(|m| s(m, &["id"]) > cursor);
        all.sort_by(|a, b| s(a, &["id"]).cmp(s(b, &["id"])));
        let (mut lines, mut next) = (vec![], cursor.to_string());
        for m in all {
            // An answer still being written comes whole on a later read, and so does all after it.
            if s(&m, &["type"]) == "assistant" && m["time"]["completed"].is_null() {
                break;
            }
            next = s(&m, &["id"]).into();
            lines.push(serde_json::json!({"type": "mirror", "message": m}).to_string());
        }
        (lines, next)
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

/// A tool part as a step, by OpenCode's tool names [D48, D65]. It comes once it ended, with its
/// own start and end times; there is no running state to show.
fn tool_use(part: &Value) -> Vec<Event> {
    let id = [s(part, &["callID"]), s(part, &["id"])]
        .into_iter()
        .find(|i| !i.is_empty())
        .unwrap_or("")
        .to_string();
    let (name, state) = (s(part, &["tool"]), &part["state"]);
    // 2.2 nests the tool's own metadata one level down.
    let meta = match &state["metadata"]["metadata"] {
        Value::Object(_) => &state["metadata"]["metadata"],
        _ => &state["metadata"],
    };
    let input = &state["input"];
    let status = s(state, &["status"]);
    let finished = matches!(status, "completed" | "error");
    let field = |keys: &[&str]| {
        keys.iter()
            .map(|k| s(input, &[k]))
            .find(|v| !v.is_empty())
            .unwrap_or("")
            .to_string()
    };
    if name == "question" {
        let questions = input["questions"].as_array().cloned().unwrap_or_default();
        let mut events = vec![];
        for (k, q) in questions.iter().enumerate() {
            let options = q["options"].as_array().into_iter().flatten();
            let qid = format!("{id}:{k}");
            events.push(Event::Question(
                qid.clone(),
                s(q, &["question"]).into(),
                options.map(|o| s(o, &["label"]).to_string()).collect(),
            ));
            if finished {
                let answer = meta["answers"][k].as_array().map(|a| {
                    let labels: Vec<&str> = a.iter().filter_map(Value::as_str).collect();
                    labels.join(", ")
                });
                events.push(Event::Answer(qid, answer));
            }
        }
        return events;
    }
    let path = field(&["filePath", "path"]);
    let (step, what) = match name {
        "read" => ("read", path.clone()),
        "edit" | "write" | "patch" | "multiedit" | "apply_patch" => ("edit", path.clone()),
        "grep" | "glob" => ("search", field(&["pattern"])),
        "list" => ("search", path.clone()),
        "bash" | "shell" => shell_step(&field(&["command"])),
        "webfetch" => ("web", field(&["url"])),
        "websearch" | "codesearch" => ("web", field(&["query"])),
        "task" | "subagent" => ("agent", field(&["description"])),
        _ => ("other", input.to_string()),
    };
    let changes: Vec<Value> = match meta["files"].as_array() {
        Some(files) => files
            .iter()
            .map(|f| {
                let patch = s(f, &["patch"]);
                let (added, removed) = match (f["additions"].as_u64(), f["deletions"].as_u64()) {
                    (Some(a), Some(d)) => (a, d),
                    _ => counts(patch),
                };
                let how = match s(f, &["status"]) {
                    "added" | "created" => "added",
                    "deleted" => "deleted",
                    _ => "modified",
                };
                let path = [s(f, &["file"]), s(f, &["filePath"])]
                    .into_iter()
                    .find(|p| !p.is_empty());
                let diff = (!patch.is_empty()).then(|| patch.to_string());
                change(path.unwrap_or(""), how, diff, Some(added), Some(removed))
            })
            .collect(),
        None if step == "edit" => {
            let how = match meta["exists"].as_bool() {
                Some(false) => "added",
                _ => "modified",
            };
            vec![change(&path, how, None, None, None)]
        }
        None => vec![],
    };
    let mut events = vec![Event::ToolStart(Tool {
        id: id.clone(),
        name: name.into(),
        step,
        input: what,
        at: state["time"]["start"].as_u64(),
        ..Default::default()
    })];
    if finished {
        let mut output = s(state, &["output"]).to_string();
        if status == "error" {
            output = s(state, &["error"]).into();
        }
        let child = meta["sessionID"].as_str().map(String::from);
        if child.is_some() {
            // `<subagent sessionID=… state=…>\nanswer\n</subagent>`: the answer alone.
            let inner = output.split_once('\n').map_or("", |(_, rest)| rest);
            output = inner
                .trim_end()
                .trim_end_matches("</subagent>")
                .trim_end()
                .to_string();
        }
        events.push(Event::ToolEnd(Done {
            id,
            output,
            ok: status == "completed" && meta["exit"].as_i64().is_none_or(|c| c == 0),
            exit: meta["exit"].as_i64(),
            changes,
            child,
            parent: None,
            at: state["time"]["end"].as_u64(),
        }));
    }
    events
}

/// A message the mirror read from OpenCode's API [D47]: a typed prompt, an answer's parts, or the
/// idle mark that ends a turn.
fn mirrored(m: &Value) -> Vec<Event> {
    match s(m, &["type"]) {
        "user" => vec![Event::Prompt(s(m, &["id"]).into(), s(m, &["text"]).into())],
        "idle" => vec![Event::TurnEnd(s(m, &["outcome"]) == "succeeded")],
        "assistant" => m["content"]
            .as_array()
            .into_iter()
            .flatten()
            .flat_map(|c| match s(c, &["type"]) {
                "text" => vec![Event::Text(s(c, &["text"]).into())],
                "reasoning" if !s(c, &["text"]).is_empty() => vec![Event::Reasoning(s(c, &["text"]).into())],
                // In the shape `run` gives a tool part, so the same reading applies.
                "tool" => {
                    let state = &c["state"];
                    let parts = state["content"].as_array().into_iter().flatten();
                    let output: Vec<&str> = parts.filter_map(|p| p["text"].as_str()).collect();
                    let part = serde_json::json!({"callID": c["id"], "tool": c["name"], "state": {
                        "status": state["status"], "input": state["input"], "output": output.join("\n"),
                        "error": state["error"], "metadata": state["metadata"],
                        "time": {"start": c["time"]["ran"], "end": c["time"]["completed"]}}});
                    tool_use(&part)
                }
                _ => vec![],
            })
            .collect(),
        _ => vec![],
    }
}
