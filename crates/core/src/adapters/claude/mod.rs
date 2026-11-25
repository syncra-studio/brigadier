//! Claude Code: one long-lived `claude -p` per session reading stream-json from stdin, with its
//! control channel beside the messages [D159]. Frame names per
//! its public CLI docs and observed output.

mod cleanup;
mod commands;
mod control;
pub mod mcp;
mod models;
mod tools;
mod trust;
mod updates;

use super::setup::{first_field, newest};
use super::{
    Accounts, Adapter, Can, Check, Cut, Delivery, Done, Event, Failed, Fork, Launch, ModelInfo,
    Retune, Rewound, Seed, Timing, Who, base_env, classify, home_path, probe_as, s, version,
};
use crate::Spec;
use cleanup::project_dir;
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

    fn short_label(&self) -> &'static str {
        "Claude"
    }

    fn seeds(&self) -> &'static [Seed] {
        models::SEEDS
    }

    fn plans(&self) -> bool {
        true
    }

    fn subagents(&self) -> super::Subagents {
        super::Subagents::Barred
    }

    fn bin(&self) -> (&'static str, &'static [&'static str]) {
        ("claude", &[".local/bin"])
    }

    fn install(&self) -> Option<&'static str> {
        Some("curl -fsSL https://claude.ai/install.sh | bash")
    }

    /// `claude update` (code.claude.com/docs/en/setup#update-manually).
    fn update(&self, _: Option<&Path>) -> Option<&'static [&'static str]> {
        Some(&["update"])
    }

    fn latest(&self) -> Option<String> {
        updates::latest()
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
        let listed = match signed_in {
            true => models::list(spec, exe, cwd),
            false => Check::default(),
        };
        // Its plan as the CLI shows it, else by its short name.
        let who = Who::read(&status, ["email", "subscriptionType", "orgName"]);
        Ok(Check {
            version: version(exe, cwd)?,
            signed_in: Some(signed_in),
            how: how.into(),
            who: Who {
                plan: listed.who.plan.clone().or(who.plan),
                ..who
            },
            ..listed
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
            trust: Some(trust::TRUST),
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

    /// A message written to it mid-turn joins the turn that runs (its steer is that same message),
    /// so only a steer goes then; taken as the next turn's too, it ran twice [D324].
    fn queues(&self) -> bool {
        false
    }

    fn launch(&self, spec: &Spec, resume: Option<&str>, text: Option<&str>) -> Launch {
        let exe = self.exe().unwrap_or_default();
        let mut argv = vec![exe.display().to_string()];
        argv.extend(
            [
                "-p",
                "--output-format",
                "stream-json",
                "--input-format",
                "stream-json",
                "--verbose",
                "--include-partial-messages",
            ]
            .map(String::from),
        );
        if let Some(model) = &spec.model {
            argv.extend(["--model".into(), model.clone()]);
        }
        if let Some(effort) = &spec.effort {
            argv.extend(["--effort".into(), effort.clone()]);
        }
        // Its prompts and questions come on the control channel, at the session's level; Full
        // can be taken later without a restart.
        argv.extend(
            [
                "--permission-prompt-tool",
                "stdio",
                "--allow-dangerously-skip-permissions",
            ]
            .map(String::from),
        );
        let level = spec.level.as_deref().unwrap_or("ask");
        argv.extend(["--permission-mode".into(), control::mode(level).into()]);
        // The session's grants, given again to a child its host starts anew [D193, D238].
        let rules = control::rules(&spec.grants);
        if !rules.is_empty() {
            argv.push("--allowedTools".into());
            argv.extend(rules);
        }
        // The standing text [D181], and its own messages between sessions off. Its hook echoes each
        // Bash call's input, whose folder its ask lacks, into the stream [D391].
        argv.extend(models::bar(spec, control::standing(spec)));
        argv.push("--include-hook-events".into());
        // A note chat reads the session's checkout beside its own folder [D282].
        if let Some(dir) = spec.opts.get("reads") {
            argv.extend(["--add-dir".into(), dir.clone()]);
        }
        if let Some(id) = resume {
            argv.extend(["--resume".into(), id.into()]);
            // shortcut: this flag isn't in the CLI reference, only Anthropic's open-source SDK; replace it if the CLI documents another.
            argv.extend(
                spec.resume_at
                    .iter()
                    .map(|at| format!("--resume-session-at={at}")),
            );
            // A fork's first launch: the CLI writes the copy under a new id, in the fork's folder.
            if spec.branch {
                argv.push("--fork-session".into());
            }
        }
        let input = text.map(|t| control::user(t, &spec.images));
        let mut env = base_env(spec, &exe, &self.keys());
        control::own(spec, &mut env);
        mcp::launch(spec, &mut argv, &mut env);
        // The queue's judge has no tools (code.claude.com/docs/en/cli-reference) [D771].
        if spec.opts.contains_key("no_tools") {
            argv.extend(["--tools".into(), "".into()]);
        }
        Launch {
            argv,
            env,
            keep_stdin: true,
            input,
        }
    }

    fn encode(&self, spec: &Spec, text: &str) -> String {
        control::redial(spec) + &control::user(text, &spec.images)
    }

    /// Anthropic's own limits for an image in a message: 5 MB, 8,000 pixels a side.
    fn image_limits(&self) -> (Option<u64>, Option<u32>) {
        (Some(5 << 20), Some(8000))
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

    fn control(&self, spec: &Spec, msg: &Value) -> Result<Delivery, String> {
        control::control(spec, msg)
    }

    fn fixed_commands(&self, cwd: Option<&Path>, run: Option<&Spec>) -> Vec<Value> {
        commands::fixed(cwd, run)
    }
    fn own_skill_wins(&self) -> bool {
        true
    }
    fn mcp_servers(&self, folder: &Path) -> Vec<Value> {
        mcp::mcp_servers(folder)
    }
    fn locate(&self, run: &Spec, list: &mut [Value]) {
        commands::locate(run, list)
    }
    fn parse(&self, line: &str) -> Vec<Event> {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            return vec![Event::Unknown(line.into())];
        };
        if let Some(events) = control::parse(&v) {
            return events;
        }
        let blocks = || {
            v["message"]["content"]
                .as_array()
                .cloned()
                .unwrap_or_default()
        };
        // A subagent's own steps stream here too, under the Agent call that runs it [D78].
        let parent = v["parent_tool_use_id"].as_str().map(String::from);
        let kind = s(&v, &["type"]);
        // The main chain's latest entry: the resume point SDK docs say to cut at, not only replies.
        let mark = (parent.is_none() && matches!(kind, "assistant" | "user"))
            .then(|| v["uuid"].as_str())
            .flatten()
            .map(|id| Event::Mark {
                start: None,
                end: Some(id.into()),
            });
        let mut events: Vec<Event> = match (kind, s(&v, &["subtype"])) {
            ("system", "init") => [
                Some(Event::Resume(s(&v, &["session_id"]).into())),
                v["model"].as_str().map(|m| Event::Model(m.into())),
                Some(Event::TurnStart),
                control::level(&v),
                commands::commands(&v),
            ]
            .into_iter()
            .flatten()
            .collect(),
            ("system", "status") => control::level(&v).into_iter().collect(),
            ("system", "compact_boundary") => vec![Event::Compaction("done")],
            // A background subagent still listed with work of its own [D67].
            ("system", "background_tasks_changed") => {
                let tasks = v["tasks"].as_array().cloned().unwrap_or_default();
                let listed = |id: &Value| tasks.iter().any(|t| t["task_id"] == *id);
                let parents = tasks.iter().map(|t| &t["parent_task_id"]);
                let mut awaiting: Vec<String> = (parents.filter(|p| listed(p)))
                    .filter_map(|p| p.as_str().map(String::from))
                    .collect();
                awaiting.dedup();
                let ids = tasks.iter().filter_map(|t| t["task_id"].as_str());
                vec![Event::Awaiting(ids.map(String::from).collect(), awaiting)]
            }
            // A Bash command run in the background or a Monitor watch, by its description [D187].
            ("system", "task_started") if v["is_backgrounded"] == true => vec![Event::Background(
                s(&v, &["task_id"]).into(),
                s(&v, &["description"]).into(),
            )],
            // A subagent's end, also one that ran in the background past its call's result [D78].
            ("system", "task_notification") if !s(&v, &["tool_use_id"]).is_empty() => {
                // Its report, where it handed one back; a stopped one's summary is only its title.
                let report = match s(&v, &["handback_report", "text"]) {
                    "" if v["status"] == "completed" => s(&v, &["summary"]),
                    report => report,
                };
                vec![Event::ToolEnd(Done {
                    id: s(&v, &["tool_use_id"]).into(),
                    output: report.into(),
                    ok: s(&v, &["status"]) == "completed",
                    child: v["task_id"].as_str().map(String::from),
                    ..Default::default()
                })]
            }
            // Its own retries, its reroute past a refusal, a reply withheld, an action its rule turned
            // down: as its SDK types them [D487].
            ("system", "api_retry") => vec![Event::Retrying {
                attempt: v["attempt"].as_u64(),
                max: v["max_retries"].as_u64(),
                at: None,
            }],
            ("system", "model_refusal_fallback") if v["scope"] != "local" => vec![Event::Rerouted(
                v["original_model"].as_str().map(String::from),
                s(&v, &["fallback_model"]).into(),
            )],
            ("system", "model_refusal_no_fallback") => {
                vec![Event::Failed("blocked", s(&v, &["content"]).into())]
            }
            ("system", "permission_denied") => vec![control::denied(&v)],
            // The reply as it's written; its whole text follows in its message [D147].
            ("stream_event", _)
                if parent.is_none() && v["event"]["delta"]["type"] == "text_delta" =>
            {
                vec![Event::TextDelta(s(&v, &["event", "delta", "text"]).into())]
            }
            ("system", "hook_response") => tools::cwd(&v).into_iter().collect(),
            // A running subagent's heartbeat says nothing to show.
            ("system", _) | ("stream_event", _) | ("tool_progress", _) => vec![],
            // An API error the CLI answers for, as its SDK types it [D74].
            ("assistant", _)
                if parent.is_none() && control::api_error(&v, String::new()).is_some() =>
            {
                let text = blocks()
                    .iter()
                    .filter_map(|b| b["text"].as_str())
                    .collect::<Vec<_>>()
                    .join("\n");
                control::api_error(&v, text).into_iter().collect()
            }
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
            ("rate_limit_event", _) => models::rate_limit(&v["rate_limit_info"]),
            ("result", _) => {
                // With its cost so far, as the CLI reports it [D221].
                let mut usage = v["usage"].clone();
                if let Some(u) = usage.as_object_mut() {
                    u.insert("cost_usd".into(), v["total_cost_usd"].clone());
                }
                let mut events = vec![Event::Usage(usage)];
                if v["is_error"].as_bool() == Some(true) {
                    let said = format!("{} {}", s(&v, &["result"]), v["errors"]);
                    // Its errors as lines, without the CLI's own diagnostics ("[lede_diagnostic] …",
                    // "[ede_diagnostic] …" for a turn it was told to stop), which no user can read [D85].
                    let diagnostic = |e: &str| {
                        (e.split_once(']')).is_some_and(|(tag, _)| {
                            tag.starts_with('[') && tag.ends_with("_diagnostic")
                        })
                    };
                    let text = match s(&v, &["result"]) {
                        "" => (v["errors"].as_array().into_iter().flatten())
                            .filter_map(Value::as_str)
                            .filter(|e| !diagnostic(e))
                            .collect::<Vec<_>>()
                            .join("\n"),
                        text => text.into(),
                    };
                    events.push(if v["api_error_status"] == 529 {
                        Event::Failed("capacity", text)
                    } else if v["api_error_status"] == 429 {
                        Event::Limited(text, None)
                    } else {
                        classify(&said).unwrap_or(Event::Failed("", text))
                    });
                }
                events.push(Event::TurnEnd(v["is_error"].as_bool() != Some(true)));
                events
            }
            _ => vec![Event::Unknown(line.into())],
        };
        events.extend(mark);
        events.extend(tools::records(&v));
        events
    }

    fn timing(&self) -> Timing {
        Timing {
            silent_ms: 20_000,
            stall_ms: 120_000,
            no_start_ms: 30_000,
        }
    }

    /// In one conversation, cut at a transcript entry; before the first turn, a new one.
    fn can_cut(&self, cut: &Cut) -> bool {
        cut.kept
            .is_none_or(|k| k.end.is_some() && k.conv == cut.dropped.conv)
    }

    fn rewind(&self, spec: &Spec, resume: &str, cut: &Cut) -> Result<Rewound, Failed> {
        cleanup::rewind(spec, resume, cut)
    }

    fn forking(&self) -> Option<&dyn Fork> {
        Some(self)
    }

    fn external(&self, spec: &Spec, resume: &str) -> Vec<PathBuf> {
        cleanup::external(spec, resume)
    }

    /// Its small model, by its family's name [D1029].
    fn cheap(&self, _current: Option<&str>, models: &[ModelInfo]) -> Option<String> {
        ModelInfo::of_family(models, "haiku").map(|m| m.id.clone())
    }

    fn forget(&self, spec: &Spec, resume: &str) -> Result<(), String> {
        cleanup::forget(spec, resume).map_err(|e| e.to_string())
    }

    fn shared(&self, spec: &Spec) -> Vec<PathBuf> {
        let dir = project_dir(spec);
        let mut dirs = vec![dir.join("memory"), dir];
        dirs.extend(cleanup::scratch(spec));
        dirs
    }

    fn transcript(&self, spec: &Spec, resume: &str) -> Option<(u64, u64)> {
        cleanup::counts(spec, resume)
    }

    fn api_host(&self) -> Option<String> {
        Some("api.anthropic.com:443".into())
    }
}
