//! `brigadier mcp list | tools <server> | call <server> <tool> [<json>]` [D89, D100, D3023]: the
//! user's own MCP servers, read only from each agent's own config, with Brigadier's daemon as their
//! client, the same on every agent (the old app's `cli_mcp.rs`). One connection per caller and
//! server is kept while it is used, so what a server holds for its client stays good for the next
//! call; it closes after `IDLE` unused.

mod http;
mod list;
use list::list;
pub mod serve;

use brigadier_core::{self as core, adapters, projects};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{Receiver, RecvTimeoutError, channel};
use std::sync::{Arc, Mutex, Once};
use std::thread;
use std::time::{Duration, Instant};

/// A kept connection unused this long closes.
const IDLE: Duration = Duration::from_secs(10 * 60);
/// A server's start and handshake (`npx` may download it first).
const START: Duration = Duration::from_secs(60);
/// One tool call.
const CALL: Duration = Duration::from_secs(10 * 60);
/// At most this many pages of a server's tools.
const PAGES: usize = 32;
const VERSION: &str = "2025-06-18";

enum Way {
    Pipe {
        child: Child,
        stdin: ChildStdin,
        lines: Receiver<String>,
    },
    Http {
        url: String,
        /// A 0600 file of its headers, so no secret shows in the process list.
        headers: Option<PathBuf>,
        session: Option<String>,
        /// A library server's data folder, key and the Authorization it was sent with [D417].
        signed: Option<(PathBuf, String, Option<String>)>,
    },
}

struct Conn {
    way: Way,
    next: u64,
    used: Instant,
}

impl Drop for Conn {
    fn drop(&mut self) {
        match &mut self.way {
            Way::Pipe { child, .. } => {
                // Its whole group: an `npx` or shell launcher leaves the server itself behind.
                brigadier_frames::spawn::kill_tree(child.id());
                let _ = child.wait();
            }
            Way::Http { headers, .. } => {
                headers.take().map(std::fs::remove_file);
            }
        }
    }
}

type Slot = Arc<Mutex<Option<Conn>>>;
static POOL: Mutex<Option<HashMap<(String, String), Slot>>> = Mutex::new(None);
static SWEEP: Once = Once::new();

/// The connection slot of `me` to `server`, made empty the first time.
fn slot(me: &str, server: &str) -> Slot {
    SWEEP.call_once(|| {
        thread::spawn(|| {
            loop {
                thread::sleep(Duration::from_secs(30));
                let slots: Vec<Slot> = (POOL.lock().unwrap().iter().flatten())
                    .map(|(_, s)| s.clone())
                    .collect();
                for s in slots {
                    // A busy one is in use; the next pass sees it.
                    if let Ok(mut c) = s.try_lock()
                        && c.as_ref().is_some_and(|c| c.used.elapsed() > IDLE)
                    {
                        *c = None;
                    }
                }
            }
        });
    });
    let mut pool = POOL.lock().unwrap();
    let pool = pool.get_or_insert_with(HashMap::new);
    let key = (me.to_string(), server.to_string());
    pool.entry(key).or_default().clone()
}

fn refuse(message: &str) -> Value {
    json!({"ok": false, "error": message})
}

/// The library's servers on for the caller's project, then those every agent's config holds for
/// its folder (else the caller's own), by name once, the first agent's; switched-off ones left
/// out, and an agent's own copy of a library one [D407].
fn servers(data: &Path, me: &str) -> (Vec<Value>, PathBuf) {
    let spec = core::load(data, me).ok();
    let id = spec.as_ref().and_then(|s| s.project.clone());
    let project = id.as_ref().and_then(|p| projects::get(data, p).ok());
    let cwd = PathBuf::from(spec.map(|s| s.cwd).unwrap_or_default());
    // A project's own files (`.mcp.json`, `.codex/config.toml`) name programs: read only once it's
    // trusted, as Settings › Plugins reads them; else each agent's home alone.
    let folder = (project.filter(|p| p.trusted == Some(true)))
        .map_or_else(|| adapters::home_path(""), |p| PathBuf::from(p.folder));
    let mut all: Vec<Value> = (core::library::on_for(data, id.as_deref()).into_iter())
        .filter(|i| i["kind"] == "server")
        .map(|mut i| {
            i["agent"] = "library".into();
            i
        })
        .collect();
    core::library::with_secrets(data, &mut all);
    let library = |x: &Value, s: &Value| x["key"].is_string() && core::library::same(s, x);
    for a in adapters::all() {
        let own = a.mcp_servers(&folder);
        // One the library found and holds off here stays out, as Settings › Plugins says.
        let off = core::library::own_off(data, id.as_deref(), &own);
        let held = |s: &Value| off.iter().any(|n| s["name"] == n.as_str());
        for mut s in own.into_iter().filter(|s| !held(s)) {
            s["agent"] = a.label().into();
            // One found on this machine runs as the agent has it, with its env [D721].
            let found = |x: &Value| x["found"].is_array() && library(x, &s);
            if s["enabled"] != false
                && let Some(x) = all.iter_mut().find(|x| found(x))
            {
                *x = s;
                continue;
            }
            if s["enabled"] == false || all.iter().any(|x| x["name"] == s["name"] || library(x, &s))
            {
                continue;
            }
            all.push(s);
        }
    }
    (all, cwd)
}

/// Runs `list`, `tools <server>` or `call <server> <tool> [<json>]` for session `me`.
pub fn run(data: &Path, me: &str, words: &[&str]) -> Value {
    let (all, cwd) = servers(data, me);
    let find = |name: &str| all.iter().find(|s| s["name"] == name);
    match words {
        ["list"] => list(&all),
        ["tools", name, only @ ..] if only.len() <= 1 => match find(name) {
            Some(s) => tools(data, me, s, &cwd, only.first().copied()),
            None => refuse(&format!(
                "No MCP server {name:?}. `brigadier mcp list` names them."
            )),
        },
        ["call", name, tool, rest @ ..] if rest.len() <= 1 => {
            let args = match rest.first().map(|a| serde_json::from_str::<Value>(a)) {
                None => json!({}),
                Some(Ok(v)) if v.is_object() => v,
                _ => {
                    return refuse(
                        "Its arguments are one JSON object, in single quotes: '{\"key\": \"value\"}'.",
                    );
                }
            };
            match find(name) {
                Some(s) => call(data, me, s, &cwd, tool, args),
                None => refuse(&format!(
                    "No MCP server {name:?}. `brigadier mcp list` names them."
                )),
            }
        }
        _ => refuse(
            "Use `brigadier mcp list`, `mcp tools <server>` or `mcp call <server> <tool> '<json>'`.",
        ),
    }
}

fn str(v: &Value) -> &str {
    v.as_str().unwrap_or("")
}

/// A server's tools by name and first line; with `only`, that tool whole, its input schema too:
/// every schema at once ran past the reply's cap.
fn tools(data: &Path, me: &str, server: &Value, cwd: &Path, only: Option<&str>) -> Value {
    let mut all: Vec<Value> = vec![];
    let mut cursor = Value::Null;
    for _ in 0..PAGES {
        let params = match &cursor {
            Value::Null => json!({}),
            c => json!({"cursor": c}),
        };
        match request(data, me, server, cwd, "tools/list", params, START) {
            Ok(r) => {
                all.extend(r["tools"].as_array().cloned().unwrap_or_default());
                cursor = r["nextCursor"].clone();
                if !cursor.is_string() {
                    break;
                }
            }
            Err(e) => return refuse(&e),
        }
    }
    let name = str(&server["name"]);
    if let Some(only) = only {
        let Some(t) = all.iter().find(|t| t["name"] == only) else {
            return refuse(&format!(
                "{name} has no tool {only:?}. `brigadier mcp tools {name}` lists them."
            ));
        };
        let text = format!(
            "{only}  {}\n  input: {}\n",
            str(&t["description"]),
            t["inputSchema"]
        );
        return json!({"ok": true, "tools": [t], "text": text});
    }
    let line = |t: &Value| -> String {
        (str(&t["description"])
            .lines()
            .next()
            .unwrap_or("")
            .chars()
            .take(200))
        .collect()
    };
    let text: String = (all.iter())
        .map(|t| format!("{}  {}\n", str(&t["name"]), line(t)))
        .collect();
    let text =
        text + &format!("`brigadier mcp tools {name} <tool>` prints one tool's input schema.");
    let all: Vec<Value> = (all.iter())
        .map(|t| json!({"name": t["name"], "description": line(t)}))
        .collect();
    json!({"ok": true, "tools": all, "text": text})
}

fn call(data: &Path, me: &str, server: &Value, cwd: &Path, tool: &str, args: Value) -> Value {
    let params = json!({"name": tool, "arguments": args});
    let r = match request(data, me, server, cwd, "tools/call", params, CALL) {
        Ok(r) => r,
        Err(e) => return refuse(&e),
    };
    let parts: Vec<String> = (r["content"].as_array().into_iter().flatten())
        .map(|c| match str(&c["type"]) {
            "text" => str(&c["text"]).to_string(),
            "image" | "audio" => format!(
                "[{} {}, {} bytes as base64]",
                str(&c["type"]),
                str(&c["mimeType"]),
                str(&c["data"]).len()
            ),
            "resource" => match c["resource"]["text"].as_str() {
                Some(t) => t.to_string(),
                None => format!("[resource {}]", str(&c["resource"]["uri"])),
            },
            "resource_link" => format!("[link {}]", str(&c["uri"])),
            _ => c.to_string(),
        })
        .collect();
    let mut text = parts.join("\n");
    if text.is_empty() && !r["structuredContent"].is_null() {
        text = r["structuredContent"].to_string();
    }
    match r["isError"] == true {
        true => refuse(&text),
        false => json!({"ok": true, "result": r, "text": text}),
    }
}

/// One request on `me`'s kept connection to `server`, opened first if there is none; a connection
/// that failed is dropped, so the next call opens a fresh one.
fn request(
    data: &Path,
    me: &str,
    server: &Value,
    cwd: &Path,
    method: &str,
    params: Value,
    wait: Duration,
) -> Result<Value, String> {
    let name = str(&server["name"]);
    let slot = slot(me, name);
    let mut held = slot.lock().unwrap();
    if held.is_none() {
        *held = Some(open(data, me, server, cwd)?);
    }
    let conn = held.as_mut().unwrap();
    // Only a broken connection is dropped; the server's own error keeps it.
    let r = match ask(conn, method, params, wait) {
        Ok(answer) => {
            conn.used = Instant::now();
            answer
        }
        Err(e) => {
            *held = None;
            Err(e)
        }
    };
    r.map_err(|e| format!("{name}: {e}"))
}

/// Starts or reaches a server and does the handshake.
fn open(data: &Path, me: &str, server: &Value, cwd: &Path) -> Result<Conn, String> {
    let name = str(&server["name"]);
    let way = match server["url"].as_str() {
        Some(url) => {
            // A library one with its key or the daemon's current token, straight from the daemon.
            let ours = server["agent"] == "library" && server["sign_in"] != "cli";
            let key = server["key"].as_str().filter(|_| ours);
            let (url, own, signed) = match key {
                Some(key) => {
                    let (url, h, _) = crate::signin::reach(data, key, None)?;
                    let used = h
                        .get("Authorization")
                        .and_then(Value::as_str)
                        .map(String::from);
                    (url, Value::Object(h), Some((data.into(), key.into(), used)))
                }
                None => (url.into(), server["headers"].clone(), None),
            };
            let headers = (own.as_object()).filter(|h| !h.is_empty()).map(|h| {
                let path = core::session_dir(data, me)
                    .join(format!("mcp-{}.headers", core::adapters::uuid()));
                (path, http::lines(h))
            });
            let headers = match headers {
                Some((path, text)) => {
                    let mut f = std::fs::OpenOptions::new();
                    #[cfg(unix)]
                    std::os::unix::fs::OpenOptionsExt::mode(&mut f, 0o600);
                    let mut file = f
                        .write(true)
                        .create_new(true)
                        .open(&path)
                        .map_err(|e| e.to_string())?;
                    file.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
                    Some(path)
                }
                None => None,
            };
            Way::Http {
                url,
                headers,
                session: None,
                signed,
            }
        }
        None => {
            let command = server["command"].as_str().filter(|c| !c.is_empty());
            let command = command.ok_or_else(|| format!("{name} has no command or url"))?;
            let login = adapters::setup::login();
            let var = |k: &str| std::env::var(k).unwrap_or_default();
            let mut c = Command::new(command);
            let args = (server["args"].as_array().into_iter().flatten()).filter_map(Value::as_str);
            let env = (server["env"].as_object().into_iter().flatten())
                .map(|(k, v)| (k.clone(), str(v).to_string()));
            c.args(args)
                .current_dir(
                    server["cwd"]
                        .as_str()
                        .map_or(cwd.to_path_buf(), PathBuf::from),
                )
                .env_clear()
                .envs(brigadier_core::adapters::setup::system_env())
                .envs([
                    ("HOME", var("HOME")),
                    ("USER", var("USER")),
                    ("TMPDIR", var("TMPDIR")),
                ])
                .envs([
                    ("LANG", "en_US.UTF-8".to_string()),
                    ("PATH", login.path.clone()),
                ])
                .envs(login.vars)
                .envs(env)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::null());
            // Its own process group, so a Stop of the agent's turn doesn't take it down.
            let mut child = brigadier_frames::spawn::grouped(&mut c)
                .map_err(|e| format!("{name} didn't start: {e}"))?;
            let (stdin, stdout) = (child.stdin.take().unwrap(), child.stdout.take().unwrap());
            let (tx, lines) = channel();
            thread::spawn(move || {
                for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                    if tx.send(line).is_err() {
                        break;
                    }
                }
            });
            Way::Pipe {
                child,
                stdin,
                lines,
            }
        }
    };
    let mut conn = Conn {
        way,
        next: 1,
        used: Instant::now(),
    };
    let hello = json!({"protocolVersion": VERSION, "capabilities": {},
        "clientInfo": {"name": "brigadier", "version": env!("CARGO_PKG_VERSION")}});
    ask(&mut conn, "initialize", hello, START)??;
    send(
        &mut conn,
        &json!({"jsonrpc": "2.0", "method": "notifications/initialized"}),
        START,
    )?;
    Ok(conn)
}

/// One request and its answer, Err inside for the server's own error, outside for a broken
/// connection; a server's own requests meanwhile are answered: a ping, and "not served" for the rest.
fn ask(
    conn: &mut Conn,
    method: &str,
    params: Value,
    wait: Duration,
) -> Result<Result<Value, String>, String> {
    let id = conn.next;
    conn.next += 1;
    let msg = json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params});
    let end = Instant::now() + wait;
    let mut answers = send(conn, &msg, wait)?;
    loop {
        for v in answers.drain(..) {
            if v["id"] == id && v.get("method").is_none() {
                return Ok(match v.get("error") {
                    Some(e) => Err(e["message"]
                        .as_str()
                        .map_or_else(|| e.to_string(), String::from)),
                    None => Ok(v["result"].clone()),
                });
            }
            if let (Some(m), Some(rid)) = (v["method"].as_str(), v.get("id")) {
                let reply = match m {
                    "ping" => json!({"jsonrpc": "2.0", "id": rid, "result": {}}),
                    _ => {
                        json!({"jsonrpc": "2.0", "id": rid, "error": {"code": -32601, "message": "Brigadier doesn't serve this."}})
                    }
                };
                send(conn, &reply, wait)?;
            }
        }
        let Way::Pipe { lines, .. } = &conn.way else {
            return Err("it gave no answer".into());
        };
        let left = end.saturating_duration_since(Instant::now());
        match lines.recv_timeout(left) {
            Ok(line) => answers.extend(serde_json::from_str::<Value>(&line).ok()),
            Err(RecvTimeoutError::Timeout) => {
                return Err(format!("no answer in {}s", wait.as_secs()));
            }
            Err(RecvTimeoutError::Disconnected) => return Err("it ended".into()),
        }
    }
}

/// Sends one message: on a pipe, its line; over HTTP, its POST, whose answers come back at once.
fn send(conn: &mut Conn, msg: &Value, wait: Duration) -> Result<Vec<Value>, String> {
    match &mut conn.way {
        Way::Pipe { stdin, .. } => {
            writeln!(stdin, "{msg}")
                .and_then(|_| stdin.flush())
                .map_err(|_| "it ended".to_string())?;
            Ok(vec![])
        }
        Way::Http {
            url,
            headers,
            session,
            signed,
        } => http::send(url, headers, session, signed, msg, wait),
    }
}
