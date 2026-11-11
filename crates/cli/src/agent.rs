//! The commands a session's agent runs as `brigadier …` [D2025, D2026, D3023]. The daemon runs
//! them for a caller it knows as a session's agent, and refuses every other command and flag, so
//! approving `brigadier` is always safe: no command here runs a program, changes a session or
//! prints a secret. Every wait has a timeout, and every reply is capped with a hint to read less.

use crate::models;
use brigadier_core::{self as core, agent::COMMANDS};
use serde_json::{Value, json};
use std::path::Path;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// Proposed: the most any reply prints.
const CAP: usize = 16 << 10;
/// Proposed: `wait`'s default and longest timeout, in seconds.
const WAIT: u64 = 60;
const WAIT_MAX: u64 = 600;

const HELP: &str = "brigadier: your tools for the other sessions in Brigadier.

  brigadier sessions          the sessions, newest first
  brigadier read <id>         a session's last messages; --user for only the user's own words
  brigadier wait <id>         wait until a session stops working, up to a timeout
  brigadier stop <id>         stop a worker you started
  brigadier models            the agents, models and efforts you may use
  brigadier help [command]    this, or one command's help

Every command takes --help, and --json for JSON. Output is capped; each says how to read less.
For a helper on your own agent, use your own subagents: they share your context and cost less.";

/// Each command's help, its value flags and its plain flags.
fn spec(
    cmd: &str,
) -> Option<(
    &'static str,
    &'static [&'static str],
    &'static [&'static str],
)> {
    Some(match cmd {
        "sessions" => (
            "brigadier sessions [--limit N] [--json]\n\nThe sessions in Brigadier, newest first: id, title, agent and model, state, last change. Yours is marked (you). 20 by default, at most 100.",
            &["--limit"],
            &[],
        ),
        "read" => (
            "brigadier read <id> [--last N] [--user] [--json]\n\nA session's last N messages (10 by default), the user's and its agent's, oldest first. --user keeps only the user's own words. Long output is cut from the oldest; --last reads fewer.",
            &["--last"],
            &["--user"],
        ),
        "wait" => (
            "brigadier wait <id> [--timeout S] [--json]\n\nWaits until the session stops working or needs its user, then prints its state and last message. Gives up after S seconds (60 by default, at most 600) and says it is still working. Keep S under your own shell tool's time limit.",
            &["--timeout"],
            &[],
        ),
        "stop" => (
            "brigadier stop <id> [--json]\n\nStops a worker you started. Other sessions are the user's: you can't stop them.",
            &[],
            &[],
        ),
        "models" => (
            "brigadier models [--json]\n\nThe agents, models and efforts the user lets you use; the default effort is marked *.",
            &[],
            &[],
        ),
        "help" => (
            "brigadier help [command]\n\nLists your tools, or shows one command's help.",
            &[],
            &[],
        ),
        _ => return None,
    })
}

fn refuse(message: &str) -> Value {
    json!({"ok": false, "error": message})
}

/// The checked call: the command, its id if it takes one, its flags' values, and its plain flags.
struct Call<'a> {
    cmd: &'a str,
    id: Option<&'a str>,
    values: Vec<(&'a str, &'a str)>,
    flags: Vec<&'a str>,
}

impl Call<'_> {
    fn value(&self, name: &str) -> Option<&str> {
        self.values
            .iter()
            .find(|(k, _)| *k == name)
            .map(|(_, v)| *v)
    }
    fn has(&self, name: &str) -> bool {
        self.flags.contains(&name)
    }
    fn number(&self, name: &str, default: u64, max: u64) -> Result<u64, Value> {
        match self.value(name).map(str::parse::<u64>) {
            None => Ok(default),
            Some(Ok(n)) if n >= 1 => Ok(n.min(max)),
            _ => Err(refuse(&format!(
                "{name} takes a whole number from 1 to {max}."
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
        values: vec![],
        flags: vec![],
    };
    let mut rest = args[1..].iter().map(String::as_str);
    while let Some(a) = rest.next() {
        if values.contains(&a) {
            let v = rest
                .next()
                .ok_or_else(|| refuse(&format!("{a} needs a value.")))?;
            call.values.push((a, v));
        } else if plain.contains(&a) || matches!(a, "--json" | "--help") {
            call.flags.push(a);
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
    let call = match parse(args) {
        Ok(c) => c,
        Err(e) => return e,
    };
    if call.has("--help") || call.cmd == "help" {
        let text = match call.id {
            Some(c) => match spec(c) {
                Some((h, ..)) => h,
                None => return refuse(&format!("No command `{c}`. `brigadier help` lists yours.")),
            },
            None if call.cmd == "help" => HELP,
            None => spec(call.cmd).map_or(HELP, |(h, ..)| h),
        };
        return json!({"ok": true, "text": text});
    }
    let takes_id = matches!(call.cmd, "read" | "wait" | "stop");
    let id = match (takes_id, call.id) {
        (true, None) => return refuse(&format!("`brigadier {}` needs a session id.", call.cmd)),
        (false, Some(extra)) => {
            return refuse(&format!("`brigadier {}` takes no {extra:?}.", call.cmd));
        }
        (_, id) => id.unwrap_or(""),
    };
    if takes_id && (core::check_id(id).is_err() || !rows().iter().any(|r| r["id"] == id)) {
        return refuse(&format!(
            "No session {id:?}. `brigadier sessions` lists them."
        ));
    }
    let reply = match call.cmd {
        "sessions" => call
            .number("--limit", 20, 100)
            .map(|n| sessions(me, n, &rows())),
        "read" => call
            .number("--last", 10, 1000)
            .map(|n| read(data, id, n, call.has("--user"))),
        "wait" if id == me => Err(refuse("You can't wait for yourself.")),
        "wait" => call
            .number("--timeout", WAIT, WAIT_MAX)
            .map(|s| wait(data, id, s, rows, here)),
        // A worker's parent is recorded with 4.3's `start`; until then no session is the caller's.
        "stop" => Err(refuse("You can stop only workers you started.")),
        _ => Ok(self::models(data, me)),
    };
    let mut reply = reply.unwrap_or_else(|e| e);
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
fn cap(text: &str) -> String {
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

fn ago(ms: u64) -> String {
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

fn sessions(me: &str, limit: u64, rows: &[Value]) -> Value {
    let mut rows: Vec<&Value> = (rows.iter())
        .filter(|r| r["archived"].is_null() || r["archived"] == false)
        .collect();
    rows.sort_by_key(|r| std::cmp::Reverse(r["updated"].as_u64().unwrap_or(0)));
    let more = rows.len().saturating_sub(limit as usize);
    rows.truncate(limit as usize);
    let list: Vec<Value> = (rows.iter())
        .map(|r| {
            json!({"id": r["id"], "title": r["title"], "agent": r["backend"], "model": r["model"],
            "state": r["state"], "updated": r["updated"], "you": r["id"] == me})
        })
        .collect();
    let mut text: String = (list.iter())
        .map(|s| {
            let you = if s["you"] == true { " (you)" } else { "" };
            format!(
                "{}{you}  {}  · {} · {} · {}\n",
                str_of(s, "id"),
                s["title"]
                    .as_str()
                    .filter(|t| !t.is_empty())
                    .unwrap_or("Untitled"),
                [str_of(s, "agent"), str_of(s, "model")].join(" ").trim(),
                str_of(s, "state"),
                ago(s["updated"].as_u64().unwrap_or(0)),
            )
        })
        .collect();
    if more > 0 {
        text += &format!(
            "… {more} older; brigadier sessions --limit {}\n",
            limit + more as u64
        );
    }
    json!({"ok": true, "sessions": list, "more": more, "text": text})
}

/// The session's messages on its active branch, oldest first: the user's and other senders'
/// inputs, and its agent's texts.
fn messages(data: &Path, id: &str) -> Vec<(String, String)> {
    let mut all: Vec<(String, String)> = vec![];
    let _ = core::rewind::read_active(&core::session_dir(data, id), |i| match str_of(i, "kind") {
        "input" => all.push((
            i["origin"].as_str().unwrap_or("user").to_string(),
            str_of(i, "text").into(),
        )),
        "text" => all.push(("agent".into(), str_of(i, "text").into())),
        _ => {}
    });
    all.retain(|(_, t)| !t.trim().is_empty());
    all
}

fn read(data: &Path, id: &str, last: u64, user: bool) -> Value {
    let mut all = messages(data, id);
    if user {
        all.retain(|(from, _)| from == "user");
    }
    let earlier = all.len().saturating_sub(last as usize);
    let shown = &all[earlier..];
    let mut text: String = (shown.iter())
        .map(|(from, t)| format!("[{from}]\n{}\n\n", t.trim_end()))
        .collect();
    if earlier > 0 {
        let flag = if user { " --user" } else { "" };
        text = format!(
            "[{earlier} earlier; brigadier read {id} --last {}{flag}]\n\n{text}",
            last + earlier as u64
        );
    }
    let list: Vec<Value> = (shown.iter())
        .map(|(from, t)| json!({"from": from, "text": t}))
        .collect();
    json!({"ok": true, "messages": list, "earlier": earlier, "text": text})
}

fn wait(
    data: &Path,
    id: &str,
    secs: u64,
    rows: &dyn Fn() -> Vec<Value>,
    here: &dyn Fn() -> bool,
) -> Value {
    let started = Instant::now();
    loop {
        let row = rows().into_iter().find(|r| r["id"] == id);
        let Some(row) = row else {
            return refuse(&format!("Session {id} is gone."));
        };
        let state = str_of(&row, "state").to_string();
        if row["running"] != true || state == "waiting_answer" {
            let last = messages(data, id)
                .into_iter()
                .rev()
                .find(|(from, _)| from == "agent");
            let last = last.map(|(_, t)| t).unwrap_or_default();
            let text = format!("{id} is {state}. Its last message:\n{}", last.trim_end());
            return json!({"ok": true, "done": true, "state": state, "last": last, "text": text});
        }
        if started.elapsed() >= Duration::from_secs(secs) || !here() {
            let text = format!(
                "{id} is still working after {secs}s. Wait again, or end your turn and check later."
            );
            return json!({"ok": true, "done": false, "state": state, "text": text});
        }
        thread::sleep(Duration::from_millis(500));
    }
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
                .map(|m| json!({"id": m["id"], "efforts": m["efforts"], "default_effort": m["default_effort"]}))
                .collect();
            json!({"agent": g["provider"], "label": g["label"], "models": models})
        })
        .filter(|a| a["models"].as_array().is_some_and(|m| !m.is_empty()))
        .collect();
    let mut text = String::new();
    for a in &agents {
        text += &format!("{} ({})\n", str_of(a, "label"), str_of(a, "agent"));
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
            let efforts = if efforts.is_empty() {
                String::new()
            } else {
                format!(": {}", efforts.join(", "))
            };
            text += &format!("  {}{efforts}\n", str_of(m, "id"));
        }
    }
    json!({"ok": true, "agents": agents, "text": text})
}
