//! The commands a session's agent runs as `brigadier …` [D2025, D2026, D3023]. The daemon runs
//! them for a caller it knows as a session's agent, and refuses every other command and flag, so
//! approving `brigadier` is always safe: no command here runs a program past the session's
//! level, changes a session or prints a secret. Every wait has a timeout, and every reply is
//! capped with a hint to read less.

mod keep;
pub(crate) mod new;
pub(crate) mod read;
mod wait;
use crate::{models, peers, workers};
use brigadier_core::{self as core, agent::COMMANDS};
use serde_json::{Value, json};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

/// Proposed: the most any reply prints.
pub(crate) const CAP: usize = 16 << 10;
/// Proposed: `wait`'s default and longest timeout, in seconds.
pub(crate) const WAIT: u64 = 60;
const WAIT_MAX: u64 = 600;
/// The most `read --last`/`--around` and `sessions --limit` take.
pub(crate) const LAST_MOST: u64 = 1000;
const LIMIT_MOST: u64 = 100;

const HELP: &str = "brigadier: your tools for the other sessions in Brigadier.

  brigadier sessions          the sessions, newest first
  brigadier read <id>[#n]     a session's last messages, or around one reference; --user for only the user's own words
  brigadier send <id> \"…\"    message another session; --wait for its answer
  brigadier wait [<id>]       wait until a session, else one of your workers, stops working, up to a timeout
  brigadier start \"<brief>\"   start a worker: another agent, a worktree of its own, or a long job
  brigadier stop <id>         stop a worker you started
  brigadier new \"<message>\"   only when the user asks for a new session, or a fork: starts theirs, not a worker
  brigadier models            the agents, models and efforts you may use
  brigadier skill [name]      the user's skills, or one whole
  brigadier notes [id]        the user's notes in your project, or one whole
  brigadier keep \"<line>\"     keep a goal change or a decision for good; it starts every fresh conversation
  brigadier search \"…\"        every session's past: messages, tool calls, errors holding these words
  brigadier show <file|url>   show the user a file at its line, or a web page, in your session's tabs
  brigadier terminal …        the user's terminal tabs and ! commands: list, read their output; open one for the user
  brigadier mcp list|tools|call  the user's MCP servers: list them, their tools, call one
  brigadier browser …         Brigadier's browser: open a page, snapshot it, click and type, its console and requests
  brigadier computer …        the user's Mac apps, in the background, when files, shell and CLIs can't; never osascript
  brigadier mockup \"<what>\"   before a big UI change, never a small fix: offer the user a mockup first
  brigadier overnight …       the user's Overnight, only once they turned it on: ready, decided, proven, left, report
  brigadier repo <name>       in a chat on a folder of repos: your own copy of a repo, before your first edit there
  brigadier help [command]    this, or one command's help

Every command takes --help, and --json for JSON. Output is capped; each says how to read less.
Do small work yourself, code changes of a few files with their checks too; start no worker for it. A worker (`start`) is for independent parallel parts, long jobs (a build, a live run, research, an audit), work needing its own worktree or another agent, and computer use, web pages aside (`brigadier browser`). Your own subagents are for read-only look-ups. If the user says who does a job, that wins.";

/// Each command's help, its value flags and its plain flags.
fn spec(cmd: &str) -> Option<crate::relay::Spec> {
    Some(match cmd {
        "sessions" => (
            "brigadier sessions [--limit N] [--json]\n\nThe sessions in Brigadier, newest first: id, title, agent and model, state, last change. Yours is marked (you). 20 by default, at most 100.",
            &["--limit"],
            &[],
        ),
        "read" => (
            include_str!("agent/read.txt"),
            &["--last", "--around", "--to"],
            &["--user", "--raw"],
        ),
        "send" => (
            "brigadier send <id> \"<message>\" [--wait] [--timeout S] [--json]
brigadier send <worker> --allow | --deny \"<reason>\"

Sends another session a message. It shows in both threads as from you, never as its user, and can't
approve anything there. A busy session gets it after its turn, or in it where its user lets messages
steer. --wait waits for the end of the turn that takes it and prints that turn's last message, giving
up after S seconds (60 by default, at most 600). Without --wait, its answer comes only if it sends one.
A back-and-forth between sessions stops after 8 hops, and a session after 20 messages a minute; only
the user can let a stopped message through. Batch what you have to say into one message.
Your worker's permission prompt or question waits on you alone: --allow or --deny answers the
prompt, and a message answers the question.",
            &["--timeout", "--deny"],
            &["--wait", "--allow"],
        ),
        "wait" => (
            "brigadier wait [<id>] [--timeout S] [--json]\n\nWaits until the session stops working or needs its user, then prints its state and last message; with no id, the first of your workers to. Gives up after S seconds (60 by default, at most 600) and says it is still working. On your own workers it looks once and returns, since their results and questions come to you by themselves. Keep S under your own shell tool's time limit.",
            &["--timeout"],
            &[],
        ),
        "start" => (
            include_str!("agent/start.txt"),
            &["--job", "--agent", "--model", "--effort", "--title", "--retry", "--reviewing"],
            &["--images"],
        ),
        "new" => (
            include_str!("agent/new.txt"),
            &["--title", "--model", "--agent", "--effort"],
            &["--fork", "--branch"],
        ),
        "stop" => (
            "brigadier stop <id> [--json]\n\nStops a worker you started. Other sessions are the user's: you can't stop them.",
            &[],
            &[],
        ),
        "models" => (
            "brigadier models [--json]\n\nThe agents, models and efforts the user lets you use; the default effort is marked *. Then the user's jobs and rules, which `start --job` follows.",
            &[],
            &[],
        ),
        "keep" => (keep::HELP, &["--replace", "--drop"], &[]),
        "help" => (
            "brigadier help [command]\n\nLists your tools, or shows one command's help.",
            &[],
            &[],
        ),
        _ => return crate::relay::spec(cmd),
    })
}

pub(crate) fn refuse(message: &str) -> Value {
    json!({"ok": false, "error": message})
}

/// The checked call: the command, its id if it takes one, its flags' values, and its plain flags.
struct Call<'a> {
    cmd: &'a str,
    id: Option<&'a str>,
    /// `send`'s message, after its id.
    text: Option<&'a str>,
    values: Vec<(&'a str, &'a str)>,
    flags: Vec<&'a str>,
}

impl Call<'_> {
    fn value(&self, name: &str) -> Option<&str> {
        self.values
            .iter()
            .find_map(|&(k, v)| (k == name).then_some(v))
    }
    fn has(&self, name: &str) -> bool {
        self.flags.contains(&name)
    }
    fn number(&self, name: &str, default: u64, max: u64) -> Result<u64, Value> {
        // `--around 0` opens the one reference alone.
        let min = u64::from(name != "--around");
        match self.value(name).map(str::parse::<u64>) {
            None => Ok(default),
            Some(Ok(n)) if n >= min => Ok(n.min(max)),
            _ => Err(refuse(&format!(
                "{name} takes a whole number from {min} to {max}."
            ))),
        }
    }
}

/// Checks a call against the allowlist: a known command, only its own flags, at most one id.
fn parse(args: &[String]) -> Result<Call<'_>, Value> {
    let cmd = args.first().map_or("help", String::as_str);
    let Some((_, values, plain)) = spec(cmd).filter(|_| COMMANDS.contains(&cmd)) else {
        return Err(refuse(&format!(
            "`brigadier {cmd}` isn't a command you can run. `brigadier help` lists yours."
        )));
    };
    let mut call = Call {
        cmd,
        id: None,
        text: None,
        values: vec![],
        flags: vec![],
    };
    let mut rest = args.iter().skip(1).map(String::as_str);
    while let Some(a) = rest.next() {
        if values.contains(&a) {
            let v = rest
                .next()
                .ok_or_else(|| refuse(&format!("{a} needs a value.")))?;
            call.values.push((a, v));
        } else if plain.contains(&a) || matches!(a, "--json" | "--help") {
            call.flags.push(a);
        } else if cmd == "start" && a == "--row" {
            // Rows became jobs [D388 Q8].
            return Err(refuse(
                "--row is gone: name a job with --job \"<job>\". brigadier models lists them.",
            ));
        } else if cmd == "send" && call.id.is_some() && call.text.is_none() {
            // A message may start with a dash.
            call.text = Some(a);
        } else if a.starts_with('-') || call.id.is_some() {
            return Err(refuse(&format!(
                "`{a}` isn't an option of `brigadier {cmd}`. `brigadier {cmd} --help` shows its options."
            )));
        } else {
            call.id = Some(a);
        }
    }
    Ok(call)
}

/// Runs one agent call for session `me`. `rows` gives the daemon's session rows now; `here` is
/// false once the caller has gone, which ends a wait.
pub fn run(
    data: &Path,
    me: &str,
    args: &[String],
    rows: &dyn Fn() -> Vec<Value>,
    here: &dyn Fn() -> bool,
) -> Value {
    let help = args.iter().any(|a| a == "--help");
    match args.first().map(String::as_str) {
        Some("mcp" | "terminal") => return crate::relay::worded(data, me, args),
        Some("overnight") => return crate::overnight::agent::run(data, me, args),
        Some("browser") if help => return json!({"ok": true, "text": crate::browser::HELP}),
        Some("browser") => return crate::browser::agent(data, me, args, here),
        _ => {}
    }
    let call = match parse(args) {
        Ok(c) => c,
        Err(e) => return e,
    };
    if call.has("--help") || call.cmd == "help" {
        let text = match call.id {
            Some("reviews") => include_str!("agent/reviews.txt"),
            Some("browser") => crate::browser::HELP,
            Some("overnight") => crate::overnight::agent::HELP,
            Some("computer") => crate::computer::HELP,
            Some(c) => match spec(c) {
                Some((h, ..)) => h,
                None => return refuse(&format!("No command `{c}`. `brigadier help` lists yours.")),
            },
            None if call.cmd == "help" => HELP,
            None => spec(call.cmd).map_or(HELP, |(h, ..)| h),
        };
        return json!({"ok": true, "text": text});
    }
    if call.cmd == "start" {
        let flag = |name: &str| {
            (call.value(name).map(String::from)).or_else(|| call.has(name).then(String::new))
        };
        let running = |id: &str| rows().iter().any(|r| r["id"] == id && r["running"] == true);
        let reply = workers::start(data, me, call.id.unwrap_or(""), &flag, &running);
        return finish(&call, reply);
    }
    let value = |name: &str| call.value(name).map(String::from);
    if call.cmd == "new" {
        let reply = new::new(data, me, call.id.unwrap_or(""), &value, &|f| call.has(f));
        return finish(&call, reply);
    }
    if call.cmd == "keep" {
        return finish(&call, keep::run(data, me, call.id, &value));
    }
    if let Some(reply) = crate::relay::run(data, me, call.cmd, call.id, &value, &rows(), here) {
        return finish(&call, reply);
    }
    let takes_id = matches!(call.cmd, "read" | "send" | "wait" | "stop");
    let id = match (takes_id, call.id) {
        (true, None) if call.cmd != "wait" => {
            return refuse(&format!("`brigadier {}` needs a session id.", call.cmd));
        }
        (false, Some(extra)) => {
            return refuse(&format!("`brigadier {}` takes no {extra:?}.", call.cmd));
        }
        (_, id) => id.unwrap_or(""),
    };
    // `read` opens a reference: `<id>#<at>`.
    let (id, at) = match id.split_once('#') {
        Some((id, at)) if call.cmd == "read" => (id, Some(at)),
        _ => (id, None),
    };
    if !id.is_empty()
        && (core::check_id(id).is_err() || !rows().iter().any(|r| r["id"] == id))
        && !(call.cmd == "wait" && core::check_id(id).is_ok() && wait::making(data, me, id))
    {
        if core::check_id(id).is_ok() && core::load(data, id).is_ok() {
            return refuse(&format!(
                "{id} isn't in Brigadier's list yet. Try again in a moment."
            ));
        }
        return refuse(&format!(
            "No session {id:?}. `brigadier sessions` lists them."
        ));
    }
    let reply = match call.cmd {
        "sessions" => call
            .number("--limit", 20, LIMIT_MOST)
            .map(|n| sessions(data, me, n, &rows())),
        "read" => {
            let row = rows().into_iter().find(|r| r["id"] == id);
            read::run(data, me, id, at, &call, &row.unwrap_or_default())
        }
        "wait" if id == me => Err(refuse("You can't wait for yourself.")),
        "wait" => workers::waited(data, me, id).and_then(|ids| {
            call.number("--timeout", WAIT, WAIT_MAX)
                .map(|s| wait::wait(data, me, &ids, s, rows, here))
        }),
        "stop" => Ok(workers::stop(data, me, id)),
        "send" if crate::routing::held(data, id) => {
            Err(refuse(&workers::for_user(data, me, id).unwrap_or_default()))
        }
        "send"
            if call.has("--allow")
                || call.value("--deny").is_some()
                || workers::asks_parent(data, me, id) =>
        {
            let text = call.text.unwrap_or("");
            Ok(workers::answer(
                data,
                me,
                id,
                call.has("--allow"),
                call.value("--deny"),
                text,
            ))
        }
        "send" => {
            let row = rows()
                .into_iter()
                .find(|r| r["id"] == id)
                .unwrap_or_default();
            let wait = call
                .has("--wait")
                .then(|| call.number("--timeout", WAIT, WAIT_MAX));
            match wait.transpose() {
                Ok(wait) => Ok(peers::send(
                    data,
                    me,
                    &row,
                    call.text.unwrap_or(""),
                    wait,
                    here,
                )),
                Err(e) => Err(e),
            }
        }
        _ => Ok(self::models(data, me)),
    };
    finish(&call, reply.unwrap_or_else(|e| e))
}

/// A reply as asked: JSON without its text, or its text capped.
fn finish(call: &Call, mut reply: Value) -> Value {
    if call.has("--json") {
        if let Some(o) = reply.as_object_mut() {
            o.remove("text");
        }
    } else if reply["ok"] == true {
        reply = json!({"ok": true, "text": cap(reply["text"].as_str().unwrap_or(""))});
    }
    reply
}

/// Cuts text to the cap from its start, so the newest lines stay.
pub(crate) fn cap(text: &str) -> String {
    if text.len() <= CAP {
        return text.to_string();
    }
    let mut from = text.len() - CAP;
    while !text.is_char_boundary(from) {
        from += 1;
    }
    format!(
        "[cut: the first {from} bytes; ask for less]\n{}",
        &text[from..]
    )
}

pub(crate) fn ago(ms: u64) -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64);
    match now.saturating_sub(ms) / 1000 {
        s if s < 60 => "just now".into(),
        s if s < 3600 => format!("{}m ago", s / 60),
        s if s < 86_400 => format!("{}h ago", s / 3600),
        s => format!("{}d ago", s / 86_400),
    }
}

fn str_of<'a>(v: &'a Value, k: &str) -> &'a str {
    v[k].as_str().unwrap_or("")
}

fn sessions(data: &Path, me: &str, limit: u64, rows: &[Value]) -> Value {
    let mut rows: Vec<Value> = (rows.iter())
        .filter(|r| r["archived"].is_null() || r["archived"] == false)
        .map(|r| {
            let mut r = r.clone();
            let dir = core::session_dir(data, str_of(&r, "id"));
            r["updated"] = match crate::index::touched(&dir.join("log")) {
                0 => Value::Null,
                ms => ms.into(),
            };
            r
        })
        .collect();
    rows.sort_by_key(|r| std::cmp::Reverse(r["updated"].as_u64().unwrap_or(0)));
    let more = rows.len().saturating_sub(limit as usize);
    rows.truncate(limit as usize);
    let all = brigadier_frames::procs::all();
    let list: Vec<Value> = (rows.iter())
        .map(|r| {
            // A first turn can call us before the daemon's next index pass.
            let status = crate::status_of(data, str_of(r, "id"), &all).ok();
            let state = status.as_ref().map_or(&r["state"], |s| &s["state"]);
            json!({"id": r["id"], "title": r["title"], "agent": r["backend"], "model": r["model"],
            "state": state, "updated": r["updated"], "you": r["id"] == me})
        })
        .collect();
    let mut text: String = (list.iter())
        .map(|s| {
            let you = if s["you"] == true { " (you)" } else { "" };
            let age = s["updated"]
                .as_u64()
                .map(|ms| format!(" · {}", ago(ms)))
                .unwrap_or_default();
            format!(
                "{}{you}  {}  · {} · {}{age}\n",
                str_of(s, "id"),
                s["title"]
                    .as_str()
                    .filter(|t| !t.is_empty())
                    .unwrap_or("Untitled"),
                [str_of(s, "agent"), str_of(s, "model")].join(" ").trim(),
                str_of(s, "state"),
            )
        })
        .collect();
    if more > 0 {
        let n = (limit + more as u64).min(LIMIT_MOST);
        text += &match n > limit {
            true => format!("… {more} older; brigadier sessions --limit {n}\n"),
            false => format!("… {more} older, past the most it lists\n"),
        };
    }
    json!({"ok": true, "sessions": list, "more": more, "text": text})
}

fn models(data: &Path, me: &str) -> Value {
    let args = ["models", "--session", me].map(String::from);
    let groups = match models::run(data, &args) {
        Ok(r) => r["groups"].as_array().cloned().unwrap_or_default(),
        Err(e) => return refuse(&e.to_string()),
    };
    let agents: Vec<Value> = (groups.iter())
        .filter(|g| g["unavailable"].is_null())
        .map(|g| {
            let models: Vec<Value> = (g["models"].as_array().into_iter().flatten())
                .map(|m| json!({"id": m["id"], "efforts": m["efforts"], "default_effort": m["default_effort"], "draws": m["draws"]}))
                .collect();
            json!({"agent": g["provider"], "label": g["label"], "models": models, "levels": g["levels"], "from": g["from"]})
        })
        .collect();
    let mut text = String::new();
    for a in &agents {
        text += &format!("{} ({})\n", str_of(a, "label"), str_of(a, "agent"));
        let levels = a["levels"].as_array().into_iter().flatten();
        let levels: Vec<&str> = levels.filter_map(Value::as_str).collect();
        if !levels.is_empty() {
            text += &format!("  Levels: {}\n", levels.join(", "));
        }
        // (proposed) Home's list stands in until this folder is checked [C27].
        if a["from"] == "home" {
            text += "  This folder hasn't been checked yet; these are your home folder's models.\n";
        }
        if a["models"].as_array().is_none_or(Vec::is_empty) {
            text += "  No models listed.\n";
        }
        for m in a["models"].as_array().into_iter().flatten() {
            let efforts: Vec<String> = (m["efforts"].as_array().into_iter().flatten())
                .filter_map(Value::as_str)
                .map(|e| {
                    if m["default_effort"] == e {
                        format!("{e}*")
                    } else {
                        e.into()
                    }
                })
                .collect();
            let efforts = Some(efforts.join(", ")).filter(|e| !e.is_empty());
            let mut efforts = efforts.map_or(String::new(), |e| format!(": {e}"));
            if m["draws"] == true {
                efforts += " (makes images)";
            }
            text += &format!("  {}{efforts}\n", str_of(m, "id"));
        }
    }
    if agents.is_empty() {
        text += "No agents are available.\n";
    }
    let routing = crate::routing::current(data);
    text += &crate::routing::said(&routing);
    json!({"ok": true, "agents": agents, "routing": routing, "text": text})
}
