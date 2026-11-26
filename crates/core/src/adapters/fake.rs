//! The scripted test agent from crates/fake. Costs no usage.

use super::Seed;
use super::{
    Accounts, Adapter, Can, Check, Cut, Delivery, Done, Event, Failed, Landing, Launch, ModelInfo,
    Retune, Rewound, Timing, Tool, Who, base_env, change, s, shell_step,
};
use crate::Spec;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

pub struct Fake;

impl Adapter for Fake {
    fn name(&self) -> &'static str {
        "fake"
    }

    // Two models per job where it has them, so a drill shows the next entry and the ladder.
    fn seeds(&self) -> &'static [Seed] {
        &[
            ("Write code", "fake-large", Some("high")),
            ("Write code", "fake", Some("high")),
            ("Look into the codebase", "fake", Some("low")),
            ("Research the web", "fake", None),
            ("Plan and orchestrate", "fake-large", Some("high")),
            ("Quick actions", "fake", Some("low")),
            ("Review", "fake-large", Some("high")),
            ("Review", "fake", Some("high")),
        ]
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
            trust: None,
        })
    }

    fn check(&self, spec: &Spec, exe: &Path, _cwd: &Path) -> Result<Check, String> {
        // The computer's login is signed in unless a drill left `accounts/signed-out` [C36].
        let signed_in = spec.account.as_ref().map_or_else(
            || !crate::data_of(spec).join("accounts/signed-out").exists(),
            |(_, home)| home.join("login").exists(),
        );
        Ok(Check {
            version: "fake 1".into(),
            signed_in: Some(signed_in),
            how: if signed_in { "fake" } else { "" }.into(),
            // Who each signed-in account is, named by its home, for the accounts' demo.
            who: Who {
                email: signed_in.then(|| match &spec.account {
                    Some((_, home)) => format!(
                        "{}@example.com",
                        home.file_name().unwrap_or_default().display()
                    ),
                    None => "you@example.com".into(),
                }),
                plan: signed_in.then(|| "pro".into()),
                org: None,
            },
            models: if signed_in && exe.exists() {
                // Efforts of its own, so the picker's effort row shows running.
                let level = |all: &[&str], default: &str| ModelInfo {
                    efforts: all.iter().map(|e| e.to_string()).collect(),
                    default_effort: Some(default.into()),
                    ..ModelInfo::plain("fake", true)
                };
                // Its default [D2075].
                vec![
                    // Makes images (`image:<file>`), for the image routing's demo [D298].
                    ModelInfo {
                        default: true,
                        draws: Some(true),
                        ..level(&["low", "medium", "high"], "medium")
                    },
                    ModelInfo {
                        id: "fake-large".into(),
                        name: "fake-large".into(),
                        // Retiring with no date, for the notice's demo [D487].
                        retiring: Some(json!({"at": null, "to": "fake"})),
                        // Takes no images, for the held Send's demo [D2022 #14].
                        images: Some(false),
                        ..level(&["low", "medium", "high", "xhigh"], "high")
                    },
                ]
            } else {
                vec![]
            },
            usage: signed_in.then(|| limits(spec)).flatten(),
            ..Default::default()
        })
    }

    fn per_turn(&self) -> bool {
        false
    }

    /// It names each message and steer it takes, by its id, as a CLI's ack [D66].
    fn acks(&self) -> bool {
        true
    }

    /// An answer, its images, a setup or a stop is taken as written.
    fn acks_control(&self, msg: &Value) -> bool {
        msg["kind"] == "steer" && !msg["request"].is_object()
    }

    /// Its record notes each input it takes before acting on it.
    fn accepted(&self, spec: &Spec, resume: &str, cid: &str) -> bool {
        let log = std::fs::read_to_string(spec.dir.join("fake").join(format!("{resume}.log")));
        log.is_ok_and(|l| l.lines().any(|l| l.strip_prefix("took ") == Some(cid)))
    }

    /// That note's write failing stops it, so a record read without it proves it never took it; one
    /// that can't be read proves nothing.
    fn missed(&self, spec: &Spec, resume: &str, cid: &str) -> bool {
        let log = std::fs::read_to_string(spec.dir.join("fake").join(format!("{resume}.log")));
        log.is_ok_and(|l| !l.lines().any(|l| l.strip_prefix("took ") == Some(cid)))
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
        env.push(("FAKE_USAGE".into(), usage_file(spec).display().to_string()));
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

    fn control(&self, spec: &Spec, msg: &Value) -> Result<Delivery, String> {
        let line = match msg["kind"].as_str() {
            Some("answer") => {
                // A plain message that answers a question reads as its one answer.
                let answers = msg["reply"]
                    .as_str()
                    .map_or(msg["answers"].clone(), |r| json!([r]));
                json!({"answer": {"id": msg["request"]["id"], "decision": msg["decision"], "reason": msg["reason"], "answers": answers}})
            }
            // An answer's images: the fake takes them with it.
            Some("steer") if msg["request"].is_object() => json!({"before": spec.images}),
            Some("steer") => {
                json!({"text": msg["text"], "steer": true, "images": spec.images, "id": spec.cid})
            }
            Some("interrupt") => json!({"interrupt": true}),
            _ => return Err("unknown control message".into()),
        };
        Ok(Delivery::Stdin(format!("{line}\n")))
    }

    fn encode(&self, spec: &Spec, text: &str) -> String {
        format!(
            "{}\n",
            json!({"text": text, "images": spec.images, "id": spec.cid})
        )
    }

    fn parse(&self, line: &str) -> Vec<Event> {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            return vec![Event::Unknown(line.into())];
        };
        match s(&v, &["t"]) {
            "hello" => vec![Event::Resume(s(&v, &["session"]).into())],
            "turn" => vec![Event::TurnStart],
            "took" => vec![Event::Reply {
                id: s(&v, &["id"]).into(),
                error: v["error"].as_str().map(String::from),
                level: None,
            }],
            "say" => vec![Event::Text(s(&v, &["text"]).into())],
            "image" => vec![Event::Image(
                json!({"id": v["id"], "progress": v["progress"],
                "attachment": v["attachment"], "name": v["name"], "prompt": null, "error": v["error"]}),
            )],
            // `write:` reports an edit step with its file change; every other tool is "other".
            "tool" if v["path"].is_string() => vec![Event::ToolStart(Tool {
                id: s(&v, &["id"]).into(),
                name: s(&v, &["name"]).into(),
                step: "edit",
                input: s(&v, &["path"]).into(),
                changes: vec![change(
                    s(&v, &["path"]),
                    s(&v, &["change"]),
                    None,
                    None,
                    None,
                )],
                ..Default::default()
            })],
            // `agent:N`'s subagent, whose own steps name it as their parent [D78].
            "tool" if v["agent"].is_string() => vec![Event::ToolStart(Tool {
                id: s(&v, &["id"]).into(),
                name: "Agent".into(),
                step: "agent",
                input: s(&v, &["agent"]).into(),
                ..Default::default()
            })],
            "tool" if v["command"].is_string() => vec![Event::ToolStart(Tool {
                id: s(&v, &["id"]).into(),
                name: s(&v, &["name"]).into(),
                // Read by what it does, as a real CLI's command [D116]; a `brigadier start` and the like are no row [D3044].
                step: shell_step(s(&v, &["command"])).0,
                input: shell_step(s(&v, &["command"])).1,
                command: s(&v, &["command"]).into(),
                parent: v["parent"].as_str().map(String::from),
                ..Default::default()
            })],
            "tool" => vec![Event::ToolStart(Tool {
                id: s(&v, &["id"]).into(),
                name: s(&v, &["name"]).into(),
                step: "other",
                input: v.get("input").map_or(String::new(), Value::to_string),
                server: v["server"].as_str().map(String::from),
                ..Default::default()
            })],
            "tool_done" => vec![Event::ToolEnd(Done {
                id: s(&v, &["id"]).into(),
                ok: v["ok"].as_bool().unwrap_or(true),
                exit: v["exit"].as_i64(),
                output: s(&v, &["output"]).into(),
                parent: v["parent"].as_str().map(String::from),
                ..Default::default()
            })],
            "mark" => vec![Event::Mark {
                start: v["start"].as_str().map(String::from),
                end: v["end"].as_str().map(String::from),
            }],
            "beat" | "child" => vec![],
            "done" => vec![Event::TurnEnd(v["ok"].as_bool().unwrap_or(true))],
            "ask" if v["items"].is_array() => vec![Event::Question(
                json!({"id": v["id"], "title": v["title"], "items": v["items"]}),
            )],
            "ask" => vec![Event::Question(
                json!({"id": v["id"], "title": null, "items": [
                {"text": v["text"], "options": [{"label": "Yes"}, {"label": "No"}], "recommended": 0, "multiSelect": false}]}),
            )],
            "approve" => vec![Event::Approval(json!({"id": v["id"], "action": "command",
                "reason": null, "command": v["command"], "grant": {"scope": "command", "pattern": v["pattern"]}}))],
            "resolved" => vec![Event::Resolved(s(&v, &["id"]).into())],
            "compact" => vec![Event::Compaction("done")],
            "retry" => vec![Event::Retrying {
                attempt: v["attempt"].as_u64(),
                max: v["max"].as_u64(),
                at: v["at"].as_u64(),
            }],
            "reroute" => vec![Event::Rerouted(
                v["from"].as_str().map(String::from),
                s(&v, &["to"]).into(),
            )],
            "check" => vec![Event::Checking(v["on"] == true)],
            "context" => vec![Event::Context(
                v["used"].as_u64().unwrap_or(0),
                v["window"].as_u64(),
                v["opens"] == true,
            )],
            "deny" => vec![Event::Denied],
            "plan" => vec![Event::Plan(
                v["steps"].as_array().cloned().unwrap_or_default(),
            )],
            "limits" => serde_json::from_value(v["windows"].clone()).map_or_else(
                |_| vec![Event::Unknown(line.into())],
                |l| vec![Event::Limits(l)],
            ),
            // Another agent's own line, through that agent's parser: its error shapes, on screen [D339].
            "as" => super::get(s(&v, &["backend"])).map_or_else(
                || vec![Event::Unknown(line.into())],
                |a| a.parse(s(&v, &["line"])),
            ),
            "fail" => vec![Event::Failed(
                match s(&v, &["why"]) {
                    "capacity" => "capacity",
                    "model" => "model",
                    "blocked" => "blocked",
                    "ended" => "ended",
                    "review" => "review",
                    "timeout" => "timeout",
                    "connection" => "connection",
                    _ => "",
                },
                s(&v, &["message"]).into(),
            )],
            "error" => vec![
                match super::classify(&format!("{} {}", v["code"], s(&v, &["message"]))) {
                    Some(Event::Limited(m, _)) => Event::Limited(m, v["resets"].as_u64()),
                    other => other.unwrap_or(Event::Unknown(line.into())),
                },
            ],
            _ => vec![Event::Unknown(line.into())],
        }
    }

    /// Its API's stand-in for a demo of the network coming back [D339].
    fn api_host(&self) -> Option<String> {
        std::env::var("BRIGADIER_FAKE_API").ok()
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

    fn can_cut(&self, cut: &Cut) -> bool {
        cut.dropped.start.is_some()
    }

    /// Its record is one line per turn: the cut keeps the lines before the first turn dropped.
    fn rewind(&self, spec: &Spec, resume: &str, cut: &Cut) -> Result<Rewound, Failed> {
        let path = conv(spec, resume);
        let keep = turns_before(cut);
        let text = std::fs::read_to_string(&path).map_err(|e| Failed::Refused(e.to_string()))?;
        let kept: String = text.lines().take(keep).map(|l| format!("{l}\n")).collect();
        std::fs::write(&path, kept).map_err(|e| Failed::Uncertain(e.to_string()))?;
        Ok(Rewound::default())
    }

    fn landed(&self, spec: &Spec, resume: &str, cut: &Cut, _at: u64) -> Landing {
        match std::fs::read_to_string(conv(spec, resume)) {
            Ok(text) if text.lines().count() == turns_before(cut) => {
                Landing::Applied(Rewound::default())
            }
            Ok(_) => Landing::NotApplied,
            Err(e) => Landing::Unknown(e.to_string()),
        }
    }
}

/// The usage a drill gives an account: `usage.json` in its home beside its `login` mark, or in
/// the accounts folder for the computer's login; a list of `Limit`s. None without the file.
fn usage_file(spec: &Spec) -> PathBuf {
    match &spec.account {
        Some((_, home)) => home.join("usage.json"),
        None => crate::data_of(spec).join("accounts/usage.json"),
    }
}

fn limits(spec: &Spec) -> Option<Vec<super::Limit>> {
    serde_json::from_slice(&std::fs::read(usage_file(spec)).ok()?).ok()
}

fn conv(spec: &Spec, resume: &str) -> PathBuf {
    spec.dir.join("fake").join(format!("{resume}.conv"))
}

fn turns_before(cut: &Cut) -> usize {
    cut.dropped
        .start
        .as_deref()
        .and_then(|s| s.parse().ok())
        .unwrap_or(0)
}

/// The setup a turn runs with, as the fake agent reads it before the turn's message.
fn setup_line(spec: &Spec) -> String {
    format!("{}\n", json!({"setup": super::setup(spec)}))
}
