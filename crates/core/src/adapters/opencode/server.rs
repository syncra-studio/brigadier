//! OpenCode's helper [D159]: holds `opencode serve` for one session in the session's host, takes the
//! adapter's lines on stdin (each one HTTP request to its V2 API) and prints the server's events
//! for that session as lines, with the result of each request that names an id [D222].

use super::grants::{allow, grant, granted, skipping};
use super::http::Server;
use brigadier_frames::base64;
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::io::{self, BufRead, BufReader, Write};
use std::process::{self, Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use std::{mem, thread};

mod catch_up;
use catch_up::catch_up;

/// What the helper keeps while it runs: never written anywhere [D193].
#[derive(Default)]
pub(super) struct State {
    pub(super) session: String,
    /// Tool calls by session/message/call id: their name and input, which later events lack.
    tools: HashMap<String, Value>,
    /// Its subagents' sessions → the tool call that runs each, so their asks name it.
    children: HashMap<String, String>,
    /// Requests waiting on the user that were printed: permission id → its ask; question form ids.
    pub(super) asked: HashMap<String, Value>,
    forms: HashSet<String>,
    /// The session's grants, `{action, save}`: answered `once` here, never saved [D193].
    pub(super) grants: Vec<Value>,
    /// Parts already printed, so a catch-up after a reconnect doesn't print them twice.
    seen: HashSet<String>,
    newest: String,
    busy: bool,
    /// The session's permission rules as its server last took them.
    pub(super) rules: Value,
    /// Its folder, where its commands and skills are listed.
    dir: String,
}

pub(super) type Shared = Arc<Mutex<State>>;

pub fn run(args: &[String]) -> Result<(), String> {
    let exe = args
        .first()
        .ok_or("usage: brigadier helper opencode <opencode>")?;
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
/// once the lease is dropped or this helper is gone.
pub(super) fn start(
    exe: &str,
    password: &str,
) -> Result<(Arc<Server>, Shared, Option<process::ChildStdin>), String> {
    std::fs::create_dir_all(super::super::home_path(".local/share/opencode"))
        .map_err(|e| e.to_string())?;
    let mut child = Command::new(exe)
        .args(["serve", "--stdio", "--hostname", "127.0.0.1", "--port", "0"])
        .env("OPENCODE_PASSWORD", password)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|e| format!("OpenCode didn't start: {e}"))?;
    let lease = child.stdin.take();
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
    } else if c["prompt"].is_object() || c["command"].is_object() {
        // Under Ask, no turn runs that the user's saved rules would let skip an ask [D166, D266].
        if let Some(why) = skipping(server, state) {
            if let Some(id) = c["id"].as_str() {
                say(json!({"type": "brigadier.reply", "data": {"id": id, "error": why}}));
            }
            return Ok(());
        }
        match c["command"].is_object() {
            // Its own command, the rest of the message its text [D164].
            true => ("POST", at("/command"), c["command"].clone()),
            false => ("POST", at("/prompt"), c["prompt"].clone()),
        }
    } else if c["compact"] == true {
        ("POST", at("/compact"), json!({}))
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
    // Its id for this message is where a later rewind cuts [D384].
    if let (Ok((_, out)), None, true) = (&result, &error, c["prompt"].is_object()) {
        let v: Value = serde_json::from_str(out).unwrap_or_default();
        say(json!({"type": "brigadier.mark", "data": {"start": v["data"]["id"]}}));
    }
    if let Some(e) = error {
        if c["must"] == true {
            return Err(format!("OpenCode refused {method} {path}: {e}"));
        }
        return Ok(());
    }
    if let (Ok((_, out)), true) = (&result, c["open"].is_object()) {
        let v: Value = serde_json::from_str(out).unwrap_or_default();
        let session = super::super::s(&v, &["data", "id"]);
        // A new helper follows from here; earlier conversation turns are already in the log.
        let (code, body) = server
            .request(
                "GET",
                &format!("/api/session/{session}/message?limit=1"),
                &Value::Null,
            )
            .map_err(|e| e.to_string())?;
        if code >= 300 {
            return Err(format!(
                "OpenCode couldn't read the conversation tail: {code} {body}"
            ));
        }
        let tail: Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
        let mut st = state.lock().unwrap();
        st.session = session.into();
        st.newest = super::super::s(&tail["data"][0], &["id"]).into();
        st.grants = c["grants"].as_array().cloned().unwrap_or_default();
        st.dir = super::super::s(&c["open"], &["location", "directory"]).into();
        let dir = st.dir.clone();
        drop(st);
        super::commands::list(server, &dir);
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
        "permission.asked" => {
            let id = d["id"].as_str().unwrap_or("").to_string();
            // OpenCode asks with a pipeline's parts; the card shows the command whole, as typed.
            let src = &d["source"];
            let call = format!(
                "{}/{}/{}",
                d["sessionID"].as_str().unwrap_or(""),
                src["messageID"].as_str().unwrap_or(""),
                src["id"].as_str().unwrap_or("")
            );
            let command = (st.tools.get(&call))
                .and_then(|t| t["input"]["command"].as_str())
                .map(String::from);
            if let Some(call) = (d["sessionID"].as_str()).and_then(|c| st.children.get(c)) {
                v["data"]["parent"] = call.as_str().into();
            }
            if let Some(command) = command {
                v["data"]["command"] = command.into();
            }
            st.asked.insert(id, v["data"].clone());
        }
        "permission.replied" => {
            let id = d["requestID"].as_str().unwrap_or("");
            st.asked.remove(id);
        }
        "form.created" if d["form"]["metadata"]["kind"] == "question" => {
            st.forms
                .insert(d["form"]["id"].as_str().unwrap_or("").into());
        }
        "form.replied" | "form.cancelled" if st.forms.remove(d["id"].as_str().unwrap_or("")) => {}
        "shell.created" => {}
        // A background subagent's report waking its parent: that is when its call ends.
        "session.inbox.enqueued"
            if d["sessionID"] == st.session.as_str()
                && d["item"]["payload"]["metadata"]["source"] == "subagent" =>
        {
            let p = &d["item"]["payload"];
            let child = p["metadata"]["childID"].as_str().unwrap_or("");
            let Some(key) = st.children.get(child).cloned() else {
                return;
            };
            let ok = p["metadata"]["state"] == "completed";
            let t = st.tools.get(&key).cloned().unwrap_or_default();
            let line = json!({"type": if ok { "session.tool.success" } else { "session.tool.failed" },
                "created": v["created"], "data": {"sessionID": st.session, "id": key,
                "name": t["name"], "input": t["input"], "metadata": {"sessionID": child},
                "content": [{"type": "text", "text": p["text"]}],
                "error": {"message": p["text"]}}});
            drop(st);
            return say(line);
        }
        "command.updated" | "skill.updated" => {
            let dir = st.dir.clone();
            drop(st);
            return super::commands::list(server, &dir);
        }
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
                // A subagent run in the background: its call ends when its report comes, above.
                "session.tool.success" if d["metadata"]["status"] == "running" => {
                    if let Some(child) = d["metadata"]["sessionID"].as_str() {
                        st.children.insert(child.into(), key);
                    }
                    return;
                }
                "session.tool.success" | "session.tool.failed" => format!("{key}:ended"),
                "session.tool.progress" => {
                    if let Some(child) = d["metadata"]["sessionID"].as_str() {
                        st.children.insert(child.into(), key.clone());
                    }
                    String::new()
                }
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
