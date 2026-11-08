//! OpenCode's helper [D159]: holds `opencode serve` for one session in the session's host, takes the
//! adapter's lines on stdin (each one HTTP request to its V2 API) and prints the server's events
//! for that session as lines, with the result of each request that names an id [D222].

use super::http::Server;
use brigadier_frames::base64;
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::io::{self, BufRead, BufReader, Write};
use std::process::{self, Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use std::{mem, thread};

/// What the helper keeps while it runs: never written anywhere [D193].
#[derive(Default)]
struct State {
    session: String,
    /// Tool calls by session/message/call id: their name and input, which later events lack.
    tools: HashMap<String, Value>,
    /// Requests waiting on the user that were printed: permission id → its ask; question form ids.
    asked: HashMap<String, Value>,
    forms: HashSet<String>,
    /// The session's grants, `{action, save}`: answered `once` here, never saved [D193].
    grants: Vec<Value>,
    /// Parts already printed, so a catch-up after a reconnect doesn't print them twice.
    seen: HashSet<String>,
    newest: String,
    busy: bool,
}

type Shared = Arc<Mutex<State>>;

pub fn run(args: &[String]) -> Result<(), String> {
    let exe = args
        .first()
        .ok_or("usage: brigadier helper opencode <opencode>")?;
    let password = super::super::uuid();
    let mut child = Command::new(exe)
        .args(["serve", "--stdio", "--hostname", "127.0.0.1", "--port", "0"])
        .env("OPENCODE_PASSWORD", &password)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .map_err(|e| format!("OpenCode didn't start: {e}"))?;
    // Its stdin is the server's lease: it stops once this helper is gone.
    let _lease = child.stdin.take();
    let mut out = BufReader::new(child.stdout.take().ok_or("no stdout")?);
    let mut first = String::new();
    out.read_line(&mut first).map_err(|e| e.to_string())?;
    let url: Value =
        serde_json::from_str(&first).map_err(|_| format!("OpenCode said {first:?}"))?;
    let addr = super::super::s(&url, &["url"]).trim_start_matches("http://");
    thread::spawn(move || io::copy(&mut out, &mut io::stderr()));
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
    for line in io::stdin().lock().lines() {
        let Ok(c) = serde_json::from_str::<Value>(&line.map_err(|e| e.to_string())?) else {
            continue;
        };
        command(&server, &state, &c)?;
    }
    Ok(())
}

/// One line from the adapter. A failed `must` line (the setup before a first message) ends the
/// helper, so no message runs on a setup it didn't take [D222].
fn command(server: &Server, state: &Shared, c: &Value) -> Result<(), String> {
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
    // A new grant also answers the asks already waiting that it covers, as OpenCode's own lasting
    // answer would, but only for this session [D193].
    if c["grant"].is_object() {
        let mut st = state.lock().unwrap();
        st.grants.push(c["grant"].clone());
        let covered: Vec<Value> = (st.asked.values())
            .filter(|a| granted(&st.grants, a))
            .cloned()
            .collect();
        drop(st);
        covered.iter().for_each(|a| allow(server, a));
    }
    Ok(())
}

fn say(v: Value) {
    let mut out = io::stdout().lock();
    let _ = writeln!(out, "{v}").and_then(|_| out.flush());
}

/// Answers an ask `once` for a grant that covers it.
fn allow(server: &Server, ask: &Value) {
    let (session, id) = (
        ask["sessionID"].as_str().unwrap_or(""),
        ask["id"].as_str().unwrap_or(""),
    );
    let path = format!("/api/session/{session}/permission/{id}/reply");
    if let Err(e) = server.request("POST", &path, &json!({"decision": "once"})) {
        eprintln!("OpenCode {path}: {e}");
    }
}

/// Whether a grant covers every resource of an ask, by OpenCode's own matching rules.
fn granted(grants: &[Value], ask: &Value) -> bool {
    let resources = ask["resources"].as_array().cloned().unwrap_or_default();
    grants.iter().any(|g| {
        let save = g["save"].as_array().cloned().unwrap_or_default();
        g["action"] == ask["action"]
            && resources.iter().all(|r| {
                save.iter()
                    .any(|p| matches(p.as_str().unwrap_or(""), r.as_str().unwrap_or("")))
            })
    })
}

/// OpenCode's whole-value wildcard: `*` any run, `?` one character; `cmd *` also matches `cmd`.
fn matches(pattern: &str, value: &str) -> bool {
    fn go(p: &[char], v: &[char]) -> bool {
        match (p.first(), v.first()) {
            (None, None) => true,
            (Some('*'), _) => go(&p[1..], v) || (!v.is_empty() && go(p, &v[1..])),
            (Some('?'), Some(_)) => go(&p[1..], &v[1..]),
            (Some(a), Some(b)) => a == b && go(&p[1..], &v[1..]),
            _ => false,
        }
    }
    let (p, v): (Vec<char>, Vec<char>) = (pattern.chars().collect(), value.chars().collect());
    go(&p, &v) || pattern.strip_suffix(" *").is_some_and(|bare| bare == value)
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
        "permission.replied" => drop(st.asked.remove(d["requestID"].as_str().unwrap_or(""))),
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
