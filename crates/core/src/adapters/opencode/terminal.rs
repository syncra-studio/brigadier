//! OpenCode's terminal [D47]: its TUI attached to the session's own server, which this helper holds
//! in the host just as it does for chat [D60]. The server's lines go to the session's hooks file for
//! the mirror. The TUI reaches the server only through a pass-through here, which re-checks the
//! hold before a prompt is admitted and turns "Allow always" into a session grant [D166, D193, D243,
//! stream D2]. The TUI keeps its own state in the session folder, so delete removes it [D35].

use super::OpenCode;
use super::control::rules;
use super::grants::{grant, skipping};
use super::server::{self, SINK, Shared, command, say};
use crate::Spec;
use serde_json::{Value, json};
use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::path::Path;
use std::process::{self, Command};
use std::sync::{Arc, Mutex};
use std::thread;

/// The paths of a session that start or join a turn, after `/api/session/<id>/`.
const TURNS: [&str; 7] = [
    "prompt",
    "command",
    "shell",
    "skill",
    "synthetic",
    "compact",
    "inbox",
];

/// `<data> <session id> <setup>`: the setup is `{lines, prompt?}`, chat's own setup lines.
pub fn run(exe: &str, args: &[String]) -> Result<(), String> {
    let [data, id, setup] = args else {
        return Err(
            "usage: brigadier helper opencode <opencode> --terminal <data> <id> <setup>".into(),
        );
    };
    let data = Path::new(data);
    let spec = crate::load(data, id).map_err(|e| e.to_string())?;
    let hooks = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(spec.dir.join(crate::terminal::HOOKS))
        .map_err(|e| e.to_string())?;
    let _ = SINK.set(Mutex::new(hooks));
    let password = super::super::uuid();
    let (server, state, _lease) = server::start(exe, &password)?;
    let setup: Value = serde_json::from_str(setup).map_err(|e| e.to_string())?;
    for line in setup["lines"].as_array().into_iter().flatten() {
        command(&server, &state, line)?;
    }
    let held = Arc::new(Mutex::new(None));
    gate(&server, &state, &held, data, id)?;
    let session = state.lock().unwrap().session.clone();
    let proxy = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let addr = proxy.local_addr().map_err(|e| e.to_string())?;
    let (data, id) = (data.to_path_buf(), id.clone());
    thread::spawn(move || {
        for client in proxy.incoming().flatten() {
            let (server, state, held, data, id) = (
                server.clone(),
                state.clone(),
                held.clone(),
                data.clone(),
                id.clone(),
            );
            thread::spawn(move || {
                let gate = || gate(&server, &state, &held, &data, &id);
                let _ = pass(client, &server.addr, &state, &server, gate);
            });
        }
    });
    let mut tui = Command::new(exe);
    tui.args(["--server", &format!("http://{addr}"), "-s", &session])
        .env("OPENCODE_PASSWORD", &password)
        // Its own "auto accept" would answer every ask itself: here Ask means Ask [D243].
        .env(
            "OPENCODE_CLI_CONFIG_CONTENT",
            r#"{"session":{"permissions":"prompt"}}"#,
        )
        .env("XDG_STATE_HOME", spec.dir.join("tui"));
    if let Some(text) = setup["prompt"].as_str() {
        tui.arg(format!("--prompt={text}"));
    }
    let status = tui
        .status()
        .map_err(|e| format!("OpenCode didn't open: {e}"))?;
    process::exit(status.code().unwrap_or(1));
}

/// The level the terminal's next turn runs at, confirmed by its server before the turn is let in:
/// the session's, held to Ask while its project isn't trusted [D166, D246, D247]. The level now
/// set is kept in `held`; each change is recorded as the level it runs at.
fn gate(
    server: &super::http::Server,
    state: &Shared,
    held: &Mutex<Option<Option<String>>>,
    data: &Path,
    id: &str,
) -> Result<(), String> {
    let spec = crate::load(data, id).map_err(|e| e.to_string())?;
    let level = crate::terminal::level(&spec, &OpenCode)
        .map_err(|refusal| super::super::s(&refusal, &["message"]).to_string())?;
    let mut now = held.lock().unwrap();
    if now.as_ref() == Some(&level) {
        return Ok(());
    }
    let session = state.lock().unwrap().session.clone();
    let rules = rules(&Spec {
        level: level.clone(),
        ..spec
    });
    match server.request(
        "PATCH",
        &format!("/api/session/{session}"),
        &json!({"permissions": rules}),
    ) {
        Ok((code, _)) if code < 300 => {}
        other => {
            return Err(format!(
                "OpenCode didn't take the permission level: {other:?}"
            ));
        }
    }
    state.lock().unwrap().rules = rules;
    *now = Some(level.clone());
    say(json!({"type": "brigadier.level", "data": {"level": level}}));
    Ok(())
}

/// One connection from the TUI, passed to the server as it is, one request per connection so each
/// one is seen. A request that starts a turn waits for the gate, and is refused with its reason if
/// the level can't be set; one on another session is refused, as this terminal is its session's
/// alone. An "always" reply becomes "once" plus a grant held here [D193]. Upgrades and the event
/// stream pass untouched.
fn pass(
    mut client: TcpStream,
    up: &str,
    state: &Shared,
    server: &super::http::Server,
    gate: impl Fn() -> Result<(), String>,
) -> io::Result<()> {
    let mut r = BufReader::new(client.try_clone()?);
    let mut lines = vec![];
    loop {
        let mut line = String::new();
        if r.read_line(&mut line)? == 0 {
            return Ok(());
        }
        if line == "\r\n" {
            break;
        }
        lines.push(line);
    }
    let first = lines.first().cloned().unwrap_or_default();
    let mut words = first.split(' ');
    let (method, path) = (words.next().unwrap_or(""), words.next().unwrap_or(""));
    let path = path.split('?').next().unwrap_or("");
    let header = |name: &str| {
        lines.iter().find_map(|l| {
            let (k, v) = l.split_once(':')?;
            k.eq_ignore_ascii_case(name).then(|| v.trim().to_string())
        })
    };
    let upgrade = header("upgrade").is_some();
    let parts: Vec<&str> = path.trim_start_matches('/').split('/').collect();
    let at = |i: usize| parts.get(i).copied().unwrap_or("");
    let ours = state.lock().unwrap().session.clone();
    // `api/session/<id>/<turn>` or `api/experimental/session/<id>/skill`.
    let target = match (at(1), at(2)) {
        ("session", _) => Some((at(2), at(3))),
        ("experimental", "session") => Some((at(3), at(4))),
        _ => None,
    };
    let starts = matches!(method, "POST" | "PATCH" | "PUT")
        && target.is_some_and(|(_, what)| TURNS.contains(&what));
    if starts && target.is_some_and(|(id, _)| id != ours) {
        return refuse(client, "This terminal runs its Brigadier session only.");
    }
    if starts && let Some(why) = gate().err().or_else(|| skipping(server, state)) {
        return refuse(client, &why);
    }
    let mut body = vec![];
    let reply = method == "POST" && at(3) == "permission" && at(5) == "reply";
    if reply {
        let n = header("content-length").and_then(|n| n.parse().ok());
        let Some(n) = n else {
            return refuse(client, "Brigadier couldn't read this answer.");
        };
        body.resize(n, 0);
        r.read_exact(&mut body)?;
        let mut v: Value = serde_json::from_slice(&body).unwrap_or_default();
        if v["decision"] == "always" {
            // Held for the session here, never saved as OpenCode's lasting rule [D193].
            let ask = state.lock().unwrap().asked.get(at(4)).cloned();
            let Some(ask) = ask else {
                return refuse(client, "This request isn't waiting any more.");
            };
            v["decision"] = "once".into();
            state.lock().unwrap().always.insert(at(4).into());
            grant(
                server,
                state,
                json!({"action": ask["action"], "save": ask["save"]}),
            );
            body = v.to_string().into_bytes();
        }
    }
    let mut head: String = (lines.iter())
        .filter(|l| {
            let k = l.split(':').next().unwrap_or("").to_ascii_lowercase();
            upgrade || !matches!(k.as_str(), "connection" | "keep-alive" | "content-length")
        })
        .cloned()
        .collect();
    if !upgrade {
        head.push_str("Connection: close\r\n");
        let n = if reply {
            Some(body.len().to_string())
        } else {
            header("content-length")
        };
        head.extend(n.map(|n| format!("Content-Length: {n}\r\n")));
    }
    let mut upstream = TcpStream::connect(up)?;
    upstream.write_all(head.as_bytes())?;
    upstream.write_all(b"\r\n")?;
    upstream.write_all(&body)?;
    let mut to = upstream.try_clone()?;
    thread::spawn(move || {
        let _ = io::copy(&mut r, &mut to);
        let _ = to.shutdown(Shutdown::Write);
    });
    let _ = io::copy(&mut upstream, &mut client);
    let _ = client.shutdown(Shutdown::Both);
    Ok(())
}

/// The TUI is told no, with the reason it shows.
fn refuse(mut client: TcpStream, why: &str) -> io::Result<()> {
    let body = json!({"name": "BrigadierRefused", "message": why}).to_string();
    let head = format!(
        "HTTP/1.1 403 Forbidden\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    client.write_all((head + &body).as_bytes())?;
    client.shutdown(Shutdown::Both)
}
