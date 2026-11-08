//! OpenCode's helper [D159]: holds `opencode serve` for one session in the session's host, takes the
//! adapter's lines on stdin (each one HTTP request to its V2 API) and prints the server's events
//! for that session as lines, with the result of each request that names an id [D222].

use super::grants::{allow, grant, granted, skipping};
use super::http::Server;
use brigadier_frames::base64;
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{self, BufRead, BufReader, Write};
use std::process::{self, Child, Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use std::{mem, thread};

/// What the helper keeps while it runs: never written anywhere [D193].
#[derive(Default)]
pub(super) struct State {
    pub(super) session: String,
    /// Tool calls by session/message/call id: their name and input, which later events lack.
    tools: HashMap<String, Value>,
    /// Requests waiting on the user that were printed: permission id → its ask; question form ids.
    pub(super) asked: HashMap<String, Value>,
    forms: HashSet<String>,
    /// The session's grants, `{action, save}`: answered `once` here, never saved [D193].
    pub(super) grants: Vec<Value>,
    /// Parts already printed, so a catch-up after a reconnect doesn't print them twice.
    seen: HashSet<String>,
    newest: String,
    busy: bool,
    /// Permission ids the terminal's "Allow always" was turned into a session grant for [D193].
    pub(super) always: HashSet<String>,
    /// The session's permission rules as its server last took them.
    pub(super) rules: Value,
}

pub(super) type Shared = Arc<Mutex<State>>;

/// Where the helper's lines go: its stdout, or the session's hooks file when its stdout is a
/// terminal's screen [D47].
pub(super) static SINK: OnceLock<Mutex<File>> = OnceLock::new();

pub fn run(args: &[String]) -> Result<(), String> {
    let exe = args
        .first()
        .ok_or("usage: brigadier helper opencode <opencode>")?;
    if args.get(1).is_some_and(|a| a == "--terminal") {
        return super::terminal::run(exe, &args[2..]);
    }
    let password = super::super::uuid();
    let (server, state, _lease) = start(exe, &password)?;
    for line in io::stdin().lock().lines() {
        let Ok(c) = serde_json::from_str::<Value>(&line.map_err(|e| e.to_string())?) else {
            continue;
        };
        command(&server, &state, &c)?;
    }
    Ok(())
}

/// Starts its server and follows its events. The returned lease keeps the server alive: it stops
/// once the lease is dropped or this helper is gone. A terminal's server keeps its output off the
/// screen.
pub(super) fn start(
    exe: &str,
    password: &str,
) -> Result<(Arc<Server>, Shared, Option<process::ChildStdin>), String> {
    let quiet = SINK.get().is_some();
    let mut child = Command::new(exe)
        .args(["serve", "--stdio", "--hostname", "127.0.0.1", "--port", "0"])
        .env("OPENCODE_PASSWORD", password)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(if quiet {
            Stdio::null()
        } else {
            Stdio::inherit()
        })
        .spawn()
        .map_err(|e| format!("OpenCode didn't start: {e}"))?;
    let lease = child.stdin.take();
    let mut out = BufReader::new(child.stdout.take().ok_or("no stdout")?);
    let mut first = String::new();
    out.read_line(&mut first).map_err(|e| e.to_string())?;
    let url: Value =
        serde_json::from_str(&first).map_err(|_| format!("OpenCode said {first:?}"))?;
    let addr = super::super::s(&url, &["url"]).trim_start_matches("http://");
    thread::spawn(move || match quiet {
        true => io::copy(&mut out, &mut io::sink()),
        false => io::copy(&mut out, &mut io::stderr()),
    });
    let server = Arc::new(Server {
        addr: addr.into(),
        auth: base64(format!("opencode:{password}").as_bytes()),
    });
    let state = Shared::default();
    let child = Arc::new(Mutex::new(child));
    let (ready, connected) = std::sync::mpsc::channel();
    let (sv, st) = (server.clone(), state.clone());
    thread::spawn(move || listen(&sv, &st, &child, ready));
    connected
        .recv_timeout(Duration::from_secs(60))
        .map_err(|_| "OpenCode's events never connected")?;
    Ok((server, state, lease))
}

/// One line from the adapter. A failed `must` line (the setup before a first message) ends the
/// helper, so no message runs on a setup it didn't take [D222].
pub(super) fn command(server: &Server, state: &Shared, c: &Value) -> Result<(), String> {
    let session = state.lock().unwrap().session.clone();
    let at = |rest: &str| format!("/api/session/{session}{rest}");
    let (p, f) = (&c["permission"], &c["form"]);
    let (method, path, body) = if c["open"].is_object() {
        ("POST", "/api/session".into(), c["open"].clone())
    } else if c["model"].is_object() {
        ("POST", at("/model"), json!({"model": c["model"]}))
    } else if c["permissions"].is_array() {
        ("PATCH", at(""), json!({"permissions": c["permissions"]}))
    } else if c["prompt"].is_object() {
        // Under Ask, no turn runs that the user's saved rules would let skip an ask [D166, D266].
        if let Some(why) = skipping(server, state) {
            if let Some(id) = c["id"].as_str() {
                say(json!({"type": "brigadier.reply", "data": {"id": id, "error": why}}));
            }
            return Ok(());
        }
        ("POST", at("/prompt"), c["prompt"].clone())
    } else if c["interrupt"] == true {
        ("POST", at("/interrupt"), Value::Null)
    } else if p.is_object() {
        let mut body = json!({"decision": p["decision"]});
        if p["message"].is_string() {
            body["message"] = p["message"].clone();
        }
        let path = format!(
            "/api/session/{}/permission/{}/reply",
            p["session"].as_str().unwrap_or(""),
            p["id"].as_str().unwrap_or("")
        );
        ("POST", path, body)
    } else if f.is_object() {
        let path = format!(
            "/api/session/{}/form/{}/reply",
            f["session"].as_str().unwrap_or(""),
            f["id"].as_str().unwrap_or("")
        );
        ("POST", path, json!({"answer": f["answer"]}))
    } else {
        return Ok(());
    };
    let result = server.request(method, &path, &body);
    let id = c["id"].as_str();
    let error = match &result {
        Ok((code, _)) if *code < 300 => None,
        Ok((code, body)) if *code < 500 => {
            let v: Value = serde_json::from_str(body).unwrap_or_default();
            Some(
                v["message"]
                    .as_str()
                    .map_or(format!("OpenCode said {code}: {body}"), String::from),
            )
        }
        // A server error or a lost connection says nothing about whether it applied: no reply, so
        // it stays uncertain [D222].
        _ => {
            eprintln!("OpenCode {method} {path}: {result:?}");
            if c["must"] == true {
                process::exit(1);
            }
            return Ok(());
        }
    };
    if let Some(id) = id {
        say(json!({"type": "brigadier.reply", "data": {"id": id, "error": error}}));
    }
    if let Some(e) = error {
        if c["must"] == true {
            return Err(format!("OpenCode refused {method} {path}: {e}"));
        }
        return Ok(());
    }
    if let (Ok((_, out)), true) = (&result, c["open"].is_object()) {
        let v: Value = serde_json::from_str(out).unwrap_or_default();
        let mut st = state.lock().unwrap();
        st.session = super::super::s(&v, &["data", "id"]).into();
        st.grants = c["grants"].as_array().cloned().unwrap_or_default();
    }
    if c["grant"].is_object() {
        grant(server, state, c["grant"].clone());
    }
    if c["permissions"].is_array() {
        state.lock().unwrap().rules = c["permissions"].clone();
    }
    Ok(())
}

pub(super) fn say(v: Value) {
    if let Some(sink) = SINK.get() {
        // One write a line, so the mirror never reads half of one.
        let _ = sink.lock().unwrap().write_all(format!("{v}\n").as_bytes());
        return;
    }
    let mut out = io::stdout().lock();
    let _ = writeln!(out, "{v}").and_then(|_| out.flush());
}

/// Follows the event stream for good. After a drop it catches up from the session's own record
/// and lists the waiting requests again, since the stream keeps nothing for a client that was away.
fn listen(
    server: &Server,
    state: &Shared,
    child: &Mutex<Child>,
    ready: std::sync::mpsc::Sender<()>,
) {
    let mut first = true;
    loop {
        let result = server.events(|v| {
            if v["type"] == "server.connected" {
                if !mem::take(&mut first) {
                    catch_up(server, state);
                }
                let _ = ready.send(());
            } else {
                event(server, state, v);
            }
        });
        if let Ok(Some(status)) = child.lock().unwrap().try_wait() {
            eprintln!("OpenCode's server ended ({status}); last stream error: {result:?}");
            process::exit(status.code().unwrap_or(1));
        }
        thread::sleep(Duration::from_millis(300));
    }
}

/// One event: the session's own (but its deltas), and the requests of any of its sessions.
fn event(server: &Server, state: &Shared, mut v: Value) {
    let mut st = state.lock().unwrap();
    let d = &v["data"];
    let kind = v["type"].as_str().unwrap_or("").to_string();
    match kind.as_str() {
        "permission.asked" if granted(&st.grants, d) => {
            let d = d.clone();
            drop(st);
            return allow(server, &d);
        }
        "permission.asked" => drop(
            st.asked
                .insert(d["id"].as_str().unwrap_or("").into(), d.clone()),
        ),
        "permission.replied" => {
            let id = d["requestID"].as_str().unwrap_or("");
            let ask = st.asked.remove(id);
            if st.always.remove(id) && d["reply"] != "reject" {
                v["data"]["grant"] = true.into();
                drop(st);
                say(v);
                if let Some(ask) = ask {
                    grant(
                        server,
                        state,
                        json!({"action": ask["action"], "save": ask["save"]}),
                    );
                }
                return;
            }
        }
        "form.created" if d["form"]["metadata"]["kind"] == "question" => {
            st.forms
                .insert(d["form"]["id"].as_str().unwrap_or("").into());
        }
        "form.replied" | "form.cancelled" if st.forms.remove(d["id"].as_str().unwrap_or("")) => {}
        "shell.created" => {}
        k if k.starts_with("session.")
            && !st.session.is_empty()
            && d["sessionID"] == st.session.as_str() =>
        {
            let msg = d["assistantMessageID"].as_str().unwrap_or("");
            let key = format!("{}/{msg}/{}", st.session, d["id"].as_str().unwrap_or(""));
            if msg > st.newest.as_str() {
                st.newest = msg.into();
            }
            let seen = match k {
                "session.tool.input.started" => {
                    return drop(st.tools.insert(key, json!({"name": d["name"]})));
                }
                "session.tool.called" => {
                    let t = st.tools.entry(key.clone()).or_default();
                    t["input"] = d["input"].clone();
                    format!("{key}:called")
                }
                "session.tool.success" | "session.tool.failed" => format!("{key}:ended"),
                "session.text.ended" | "session.reasoning.ended" => {
                    format!("{k}:{msg}:{}", d["ordinal"])
                }
                // A prompt typed in the terminal, by its message id [D47].
                "session.inbox.enqueued" if SINK.get().is_some() => {
                    let item = &d["item"];
                    let id = d["inboxID"].as_str().unwrap_or("").to_string();
                    if item["type"] == "user" && st.seen.insert(format!("prompt:{id}")) {
                        let text = item["payload"]["text"].clone();
                        drop(st);
                        say(json!({"type": "brigadier.prompt", "data": {"id": id, "text": text}}));
                    }
                    return;
                }
                "session.execution.started" => return busy(&mut st, true, v),
                "session.execution.succeeded"
                | "session.execution.failed"
                | "session.execution.interrupted" => {
                    return busy(&mut st, false, v);
                }
                k if k.ends_with(".delta") || k.starts_with("session.tool.input.") => return,
                _ => String::new(),
            };
            if !seen.is_empty() && !st.seen.insert(seen) {
                return;
            }
            if k.starts_with("session.tool.") {
                let t = st.tools.get(&key).cloned().unwrap_or_default();
                v["data"]["id"] = key.into();
                v["data"]["name"] = t["name"].clone();
                v["data"]["input"] = t["input"].clone();
            }
        }
        _ => return,
    }
    drop(st);
    say(v);
}

fn busy(st: &mut State, busy: bool, v: Value) {
    st.busy = busy;
    say(v);
}

/// After a reconnect: what the session recorded meanwhile (from its messages, its own record),
/// printed once each, the turn's real outcome if it ended, then the requests still waiting.
fn catch_up(server: &Server, state: &Shared) {
    let session = state.lock().unwrap().session.clone();
    if session.is_empty() {
        return;
    }
    let get = |rest: &str| -> Vec<Value> {
        let path = format!("/api/session/{session}{rest}");
        let v: Value = (server.request("GET", &path, &Value::Null).ok())
            .and_then(|(_, body)| serde_json::from_str(&body).ok())
            .unwrap_or_default();
        v["data"].as_array().cloned().unwrap_or_default()
    };
    let newest = state.lock().unwrap().newest.clone();
    let mut messages = get("/message?limit=50");
    messages.reverse();
    for m in messages
        .iter()
        .filter(|m| m["id"].as_str().unwrap_or("") >= newest.as_str())
    {
        let msg = m["id"].as_str().unwrap_or("");
        let base = json!({"sessionID": session, "assistantMessageID": msg});
        match m["type"].as_str() {
            // A message sent while away began a turn; one typed in the terminal shows in chat by
            // its id, once [D5, D47, D251].
            Some("user") => {
                let mut st = state.lock().unwrap();
                st.busy = true;
                if SINK.get().is_some() && st.seen.insert(format!("prompt:{msg}")) {
                    drop(st);
                    say(
                        json!({"type": "brigadier.prompt", "data": {"id": msg, "text": m["text"]}}),
                    );
                }
            }
            Some("assistant") => {
                for (i, part) in m["content"].as_array().into_iter().flatten().enumerate() {
                    let mut d = base.clone();
                    let kind = match part["type"].as_str() {
                        Some("text") => "session.text.ended",
                        Some("reasoning") => "session.reasoning.ended",
                        Some("tool") => {
                            let s = &part["state"];
                            d["id"] = part["id"].clone();
                            let started = json!({"sessionID": session, "assistantMessageID": msg, "id": part["id"], "name": part["name"]});
                            event(
                                server,
                                state,
                                json!({"type": "session.tool.input.started", "data": started}),
                            );
                            d["input"] = s["input"].clone();
                            event(
                                server,
                                state,
                                json!({"type": "session.tool.called", "data": d.clone()}),
                            );
                            let end = match s["status"].as_str() {
                                Some("completed") => "session.tool.success",
                                Some("error") => "session.tool.failed",
                                _ => continue,
                            };
                            d["content"] = s["content"].clone();
                            d["metadata"] = s["metadata"].clone();
                            d["error"] = s["error"].clone();
                            event(server, state, json!({"type": end, "data": d}));
                            continue;
                        }
                        _ => continue,
                    };
                    d["ordinal"] = i.into();
                    d["text"] = part["text"].clone();
                    event(server, state, json!({"type": kind, "data": d}));
                }
            }
            // The turn ended while away: its outcome as the session recorded it, never guessed.
            Some("idle") if state.lock().unwrap().busy => {
                let outcome = m["outcome"].as_str().unwrap_or("failed");
                event(
                    server,
                    state,
                    json!({"type": format!("session.execution.{outcome}"), "data": base}),
                );
            }
            _ => {}
        }
    }
    let permissions = get("/permission");
    let forms: Vec<Value> = get("/form")
        .into_iter()
        .filter(|f| f["metadata"]["kind"] == "question")
        .collect();
    let gone: Vec<String> = {
        let st = state.lock().unwrap();
        let listed = |id: &String| {
            permissions
                .iter()
                .chain(&forms)
                .any(|r| r["id"] == id.as_str())
        };
        st.asked
            .keys()
            .chain(&st.forms)
            .filter(|id| !listed(id))
            .cloned()
            .collect()
    };
    for id in gone {
        let mut st = state.lock().unwrap();
        st.asked.remove(&id);
        st.forms.remove(&id);
        drop(st);
        say(json!({"type": "brigadier.gone", "data": {"id": id}}));
    }
    for p in permissions {
        if !state
            .lock()
            .unwrap()
            .asked
            .contains_key(p["id"].as_str().unwrap_or(""))
        {
            event(
                server,
                state,
                json!({"type": "permission.asked", "data": p}),
            );
        }
    }
    for f in forms {
        if !state
            .lock()
            .unwrap()
            .forms
            .contains(f["id"].as_str().unwrap_or(""))
        {
            event(
                server,
                state,
                json!({"type": "form.created", "data": {"form": f}}),
            );
        }
    }
}
