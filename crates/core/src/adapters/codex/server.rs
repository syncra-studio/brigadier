//! Codex's helper [D159]: holds `codex app-server` for one session in the session's host, takes the
//! adapter's lines on stdin and prints the server's lines for that thread, with the result of each
//! line that names an id [D222]. It speaks the server's JSON-RPC, which needs ids a thread only
//! gets once started, so the adapter stays stateless.

use super::events::limited;
use crate::adapters::{unwrap_shell, uuid};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::io::{self, BufRead, BufReader, Write};
use std::process::{self, ChildStdin, Command, Stdio};
use std::sync::mpsc::{Sender, channel};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

/// How long the limit read may hold back a turn's end (proposed).
const LIMIT_WAIT: Duration = Duration::from_secs(5);

/// What to do with the reply to a request this helper sent.
enum Pending {
    Wait(Sender<Result<Value, String>>),
    Reply(String),
    /// The reason went in; now the deny itself.
    Deny(String, Value, Value),
    Limits,
}

/// What the helper keeps while it runs: never written anywhere [D193].
struct State {
    server: ChildStdin,
    next: u64,
    pending: HashMap<u64, Pending>,
    /// Keeps a request's id unique across children: the server's own restart at 0.
    nonce: String,
    thread: String,
    turn: String,
    cwd: String,
    /// The session's grants, as the D177 requests they answered.
    grants: Vec<Value>,
    /// File changes under way by item id: their requests don't name their files.
    items: HashMap<String, Value>,
    /// The account's rate limits by limit id; a turn's end waiting for them.
    limits: HashMap<String, Value>,
    held: Option<Value>,
}

type Shared = Arc<Mutex<State>>;

pub fn run(args: &[String]) -> Result<(), String> {
    let exe = args
        .first()
        .ok_or("usage: brigadier helper codex <codex>")?;
    // `-c`, not `--enable`: a feature a later Codex dropped is then ignored, not fatal.
    let mut child = Command::new(exe)
        .args([
            "app-server",
            "-c",
            "features.default_mode_request_user_input=true",
            "-c",
            "suppress_unstable_features_warning=true",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Codex didn't start: {e}"))?;
    let out = BufReader::new(child.stdout.take().ok_or("no stdout")?);
    let state: Shared = Arc::new(Mutex::new(State {
        server: child.stdin.take().ok_or("no stdin")?,
        next: 0,
        pending: HashMap::new(),
        nonce: uuid()[..8].into(),
        thread: String::new(),
        turn: String::new(),
        cwd: String::new(),
        grants: vec![],
        items: HashMap::new(),
        limits: HashMap::new(),
        held: None,
    }));
    let st = state.clone();
    thread::spawn(move || {
        for line in out.lines().map_while(Result::ok) {
            if let Ok(v) = serde_json::from_str::<Value>(&line) {
                from_server(&st, v);
            }
        }
        // Its stdout closed: the server is gone, and with it this session's channel.
        let status = child.wait().ok().and_then(|s| s.code());
        process::exit(status.unwrap_or(1));
    });
    let client =
        json!({"name": "brigadier", "title": "Brigadier", "version": env!("CARGO_PKG_VERSION")});
    call(&state, "initialize", json!({"clientInfo": client}))?;
    write(&mut state.lock().unwrap(), json!({"method": "initialized"}));
    for line in io::stdin().lock().lines() {
        let line = line.map_err(|e| e.to_string())?;
        if let Ok(c) = serde_json::from_str::<Value>(&line) {
            command(&state, &c)?;
        }
    }
    Ok(())
}

fn say(v: Value) {
    let mut out = io::stdout().lock();
    let _ = writeln!(out, "{v}").and_then(|_| out.flush());
}

fn reply(id: &str, error: Option<String>) {
    if !id.is_empty() {
        say(json!({"type": "brigadier.reply", "data": {"id": id, "error": error}}));
    }
}

fn write(st: &mut State, v: Value) {
    if let Err(e) = writeln!(st.server, "{v}").and_then(|_| st.server.flush()) {
        eprintln!("Codex's server: {e}");
    }
}

fn ask(st: &mut State, method: &str, params: Value, then: Pending) {
    st.next += 1;
    st.pending.insert(st.next, then);
    let id = st.next;
    write(st, json!({"id": id, "method": method, "params": params}));
}

fn call(state: &Shared, method: &str, params: Value) -> Result<Value, String> {
    let (tx, rx) = channel();
    ask(
        &mut state.lock().unwrap(),
        method,
        params,
        Pending::Wait(tx),
    );
    (rx.recv_timeout(Duration::from_secs(60)))
        .map_err(|_| format!("Codex didn't answer {method}"))?
}

/// A failed open ends the helper with the first message's refusal: no turn runs on a setup that
/// didn't take [D222].
fn open(state: &Shared, c: &Value) -> Result<(), String> {
    let o = &c["open"];
    {
        let mut st = state.lock().unwrap();
        st.cwd = o["cwd"].as_str().unwrap_or("").into();
        st.grants = c["grants"].as_array().cloned().unwrap_or_default();
    }
    let method = if o["threadId"].is_string() {
        "thread/resume"
    } else {
        "thread/start"
    };
    match call(state, method, o.clone()) {
        Ok(r) => {
            let thread = r["thread"]["id"].clone();
            state.lock().unwrap().thread = thread.as_str().unwrap_or("").into();
            say(json!({"method": "thread/started", "params": {"thread": {"id": thread}}}));
            Ok(())
        }
        Err(e) => {
            reply(c["id"].as_str().unwrap_or(""), Some(e.clone()));
            Err(format!("Codex refused {method}: {e}"))
        }
    }
}

fn input(text: &Value) -> Value {
    json!([{"type": "text", "text": text}])
}

/// One line from the adapter.
fn command(state: &Shared, c: &Value) -> Result<(), String> {
    if c["open"].is_object() {
        return open(state, c);
    }
    let cid = c["id"].as_str().unwrap_or("").to_string();
    let st = &mut *state.lock().unwrap();
    let (thread, turn) = (st.thread.clone(), st.turn.clone());
    if c["turn"].is_object() {
        let mut params = c["turn"].clone();
        params["threadId"] = thread.into();
        ask(st, "turn/start", params, Pending::Reply(cid));
    } else if c["steer"].is_string() || c["interrupt"] == true {
        if turn.is_empty() {
            reply(&cid, Some("No turn is running.".into()));
        } else if c["interrupt"] == true {
            let params = json!({"threadId": thread, "turnId": turn});
            ask(st, "turn/interrupt", params, Pending::Reply(cid));
        } else {
            let params =
                json!({"threadId": thread, "expectedTurnId": turn, "input": input(&c["steer"])});
            ask(st, "turn/steer", params, Pending::Reply(cid));
        }
    } else if c["answer"].is_object() {
        let (rid, result) = (c["answer"]["rid"].clone(), c["answer"]["result"].clone());
        if c["grant"].is_object() {
            st.grants.push(c["grant"].clone());
        }
        if c["before"].is_string() {
            let params = json!({"threadId": c["thread"], "expectedTurnId": c["turn"], "input": input(&c["before"])});
            ask(st, "turn/steer", params, Pending::Deny(cid, rid, result));
        } else {
            write(st, json!({"id": rid, "result": result}));
            reply(&cid, None);
        }
    }
    Ok(())
}

fn from_server(state: &Shared, mut v: Value) {
    if v["method"].is_string() {
        if v.get("id").is_some() {
            request(state, v);
        } else {
            notification(state, &mut v);
        }
        return;
    }
    let st = &mut *state.lock().unwrap();
    let Some(then) = v["id"].as_u64().and_then(|id| st.pending.remove(&id)) else {
        return;
    };
    let result = match v["error"]["message"].as_str() {
        Some(e) => Err(e.to_string()),
        None if v.get("error").is_some() => Err(v["error"].to_string()),
        None => Ok(v["result"].take()),
    };
    match then {
        Pending::Wait(tx) => drop(tx.send(result)),
        Pending::Reply(cid) => reply(&cid, result.err()),
        Pending::Deny(cid, rid, deny) => {
            if let Err(e) = result {
                eprintln!("Codex took no deny reason: {e}");
            }
            write(st, json!({"id": rid, "result": deny}));
            reply(&cid, None);
        }
        Pending::Limits => {
            if let Ok(r) = result {
                let by_id = r["rateLimitsByLimitId"].as_object().cloned();
                for snap in by_id
                    .into_iter()
                    .flat_map(|m| m.into_iter().map(|(_, s)| s))
                    .chain([r["rateLimits"].clone()])
                {
                    st.limits.insert(limit_id(&snap), snap);
                }
            }
            flush(st);
        }
    }
}

fn limit_id(snap: &Value) -> String {
    snap["limitId"].as_str().unwrap_or("codex").into()
}

/// A limit update is sparse: what it leaves out or null stays as last known.
fn merge(st: &mut State, snap: &Value) {
    let known = st.limits.entry(limit_id(snap)).or_insert_with(|| json!({}));
    for (k, v) in snap.as_object().into_iter().flatten() {
        if !v.is_null() {
            known[k.as_str()] = v.clone();
        }
    }
}

/// When the limit that was hit resets (ms): of the buckets marked as reached, or all if none is,
/// the windows used up, the latest reset among them; None when none says (proposed) [D74, D220].
fn resets(limits: &HashMap<String, Value>) -> Option<u64> {
    let reached = limits
        .values()
        .any(|s| !s["rateLimitReachedType"].is_null());
    (limits.values())
        .filter(|s| !reached || !s["rateLimitReachedType"].is_null())
        .flat_map(|s| [&s["primary"], &s["secondary"]])
        .filter(|w| w["usedPercent"].as_i64().is_some_and(|u| u >= 100))
        .filter_map(|w| w["resetsAt"].as_u64())
        .max()
        .map(|secs| secs * 1000)
}

/// Whether Codex marks the account out of credits, which no reset lifts. Only its main bucket
/// carries the mark, read fresh once a limited turn ends. A spend cap is another value and stays a limit.
fn out_of_credits(limits: &HashMap<String, Value>) -> bool {
    matches!(
        limits
            .get("codex")
            .and_then(|s| s["rateLimitReachedType"].as_str()),
        Some("workspace_owner_credits_depleted" | "workspace_member_credits_depleted")
    )
}

fn flush(st: &mut State) {
    if let Some(mut end) = st.held.take() {
        end["params"]["brigadier"] =
            json!({"resets": resets(&st.limits), "credits": out_of_credits(&st.limits)});
        say(end);
    }
}

fn notification(state: &Shared, v: &mut Value) {
    let method = v["method"].as_str().unwrap_or("").to_string();
    let st = &mut *state.lock().unwrap();
    let p = &v["params"];
    if method == "account/rateLimits/updated" {
        return merge(st, &p["rateLimits"].clone());
    }
    if method == "serverRequest/resolved" {
        let id = id_of(&st.nonce, &p["requestId"]);
        v["params"]["requestId"] = id.into();
        return say(v.take());
    }
    // A subagent's own thread is its parent's tool call [D78]; only its requests come through.
    if p["threadId"] != st.thread.as_str() {
        return;
    }
    match method.as_str() {
        "turn/started" => st.turn = p["turn"]["id"].as_str().unwrap_or("").into(),
        "turn/completed" => {
            st.turn.clear();
            if limited(&p["turn"]) {
                st.held = Some(v.take());
                ask(st, "account/rateLimits/read", Value::Null, Pending::Limits);
                let state = state.clone();
                thread::spawn(move || {
                    thread::sleep(LIMIT_WAIT);
                    flush(&mut state.lock().unwrap());
                });
                return;
            }
        }
        "item/started" if p["item"]["type"] == "fileChange" => {
            let id = p["item"]["id"].as_str().unwrap_or("").to_string();
            st.items.insert(id, p["item"].clone());
        }
        "item/completed" => drop(st.items.remove(p["item"]["id"].as_str().unwrap_or(""))),
        "thread/tokenUsage/updated"
        | "error"
        | "model/rerouted"
        | "model/safetyBuffering/updated"
        | "item/started"
        | "item/autoApprovalReview/started"
        | "item/autoApprovalReview/completed" => {}
        _ => return,
    }
    say(v.take());
}

fn id_of(nonce: &str, rid: &Value) -> String {
    let id = rid.as_str().map_or(rid.to_string(), String::from);
    format!("{nonce}-{id}")
}

/// A request from the server: answered here when a session grant covers it or it can't be shown,
/// else printed for the user. Never left unanswered, or its turn would hang.
fn request(state: &Shared, mut v: Value) {
    let method = v["method"].as_str().unwrap_or("").to_string();
    let st = &mut *state.lock().unwrap();
    let rid = v["id"].take();
    let p = &mut v["params"];
    match method.as_str() {
        "item/commandExecution/requestApproval" => {
            let inside = p["cwd"].as_str().is_some_and(|c| c.starts_with(&st.cwd));
            p["insideSession"] = inside.into();
            p["canGrant"] = can_grant(p).into();
            if let Some(words) = p["command"].as_str().map(unwrap_shell) {
                p["command"] = words.into();
            }
        }
        "item/fileChange/requestApproval" => {
            let item = st.items.get(p["itemId"].as_str().unwrap_or(""));
            let changes = item.and_then(|i| i["changes"].as_array());
            let files: Vec<Value> = changes
                .into_iter()
                .flatten()
                .map(|c| c["path"].clone())
                .collect();
            p["files"] = files.into();
        }
        "item/permissions/requestApproval" => {}
        "item/tool/requestUserInput" => {
            // Answers go to the session's log in plain text, so a secret is never collected.
            if let Some(q) = p["questions"].as_array_mut() {
                q.retain(|q| q["isSecret"] != true);
                if q.is_empty() {
                    return write(st, json!({"id": rid, "result": {"answers": {}}}));
                }
            }
        }
        "mcpServer/elicitation/request"
            if p["request"]["_meta"]["codex_approval_kind"] == "mcp_tool_call" => {}
        "mcpServer/elicitation/request" => {
            eprintln!("Codex's MCP form declined: Brigadier shows only tool approvals.");
            return write(st, json!({"id": rid, "result": {"action": "decline"}}));
        }
        _ => {
            eprintln!("Codex asked for {method}, which Brigadier doesn't answer.");
            let error =
                json!({"code": -32601, "message": "Brigadier doesn't handle this request."});
            return write(st, json!({"id": rid, "error": error}));
        }
    }
    if let Some(decision) = covered(&st.grants, &method, p) {
        return write(st, json!({"id": rid, "result": {"decision": decision}}));
    }
    v["id"] = id_of(&st.nonce, &rid).into();
    v["rid"] = rid;
    say(v);
}

/// Whether this command can be allowed for the session. Codex now lists a saved rule instead of a
/// session answer for most commands, but still honours the session answer, and only that one stays
/// out of its files [D193]. A request for extra permissions gets neither, so it's asked every time.
fn can_grant(p: &Value) -> bool {
    p["availableDecisions"].as_array().is_none_or(|d| {
        d.iter()
            .any(|o| o == "acceptForSession" || o.get("acceptWithExecpolicyAmendment").is_some())
    })
}

/// Codex's answer for a request a session grant covers, as its own session answer so it caches it
/// as well [D193, D247]. A command by its exact words and folder, as Codex keys its own cache.
fn covered(grants: &[Value], method: &str, p: &Value) -> Option<&'static str> {
    if method == "item/commandExecution/requestApproval" && p["canGrant"] != true {
        return None;
    }
    let host = p["networkApprovalContext"]["host"].as_str();
    let hit = |g: &Value| {
        let (scope, pattern) = (&g["grant"]["scope"], g["grant"]["pattern"].as_str());
        match method {
            "item/commandExecution/requestApproval" if host.is_some() => {
                scope == "network" && pattern == host
            }
            "item/commandExecution/requestApproval" => {
                scope == "command"
                    && pattern == p["command"].as_str()
                    && g["cli"]["cwd"] == p["cwd"]
            }
            "item/fileChange/requestApproval" => {
                let files = p["files"].as_array().filter(|f| !f.is_empty());
                let inside = |root: &str| {
                    files.is_some_and(|f| {
                        f.iter().filter_map(Value::as_str).all(|f| {
                            f.strip_prefix(root)
                                .is_some_and(|rest| rest.starts_with('/'))
                        })
                    })
                };
                scope == "edits" && pattern.is_some_and(inside)
            }
            _ => false,
        }
    };
    grants.iter().any(hit).then_some("acceptForSession")
}
