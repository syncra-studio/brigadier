//! Codex's helper [D159]: holds `codex app-server` for one session in the session's host, takes the
//! adapter's lines on stdin and prints the server's lines for that thread, with the result of each
//! line that names an id [D222]. It speaks the server's JSON-RPC, which needs ids a thread only
//! gets once started, so the adapter stays stateless.

use super::events::limited;
use super::grants::{can_grant, covered};
use crate::adapters::{unwrap_shell, uuid};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::io::{self, BufRead, BufReader, Write};
use std::process::{self, ChildStdin, Stdio};
use std::sync::mpsc::{Sender, channel};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

mod child;
mod image;
mod limits;
use child::{activity, child, input};
use limits::{limit_id, merge, out_of_credits, resets, tell_limits};

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
    /// Subagents running, by thread, and each one's latest words [D78].
    running: HashSet<String>,
    said: HashMap<String, String>,
    /// The user stopped the thread: its subagents' ends don't wake it [D95].
    stopped: bool,
    /// The reply being written, which Codex drops from its history if the turn is stopped.
    writing: String,
}

type Shared = Arc<Mutex<State>>;

pub fn run(args: &[String]) -> Result<(), String> {
    let exe = args
        .first()
        .ok_or("usage: brigadier helper codex <codex>")?;
    // `-c`, not `--enable`: a feature a later Codex dropped is then ignored, not fatal.
    let mut child = brigadier_frames::spawn::windowless(exe)
        .args([
            "app-server",
            "-c",
            "features.default_mode_request_user_input=true",
            "-c",
            "suppress_unstable_features_warning=true",
        ])
        .args(&args[1..])
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
        running: HashSet::new(),
        said: HashMap::new(),
        stopped: false,
        writing: String::new(),
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
    // Experimental for its `thread/memoryMode/set` [D469].
    let init = json!({"clientInfo": client, "capabilities": {"experimentalApi": true}});
    call(&state, "initialize", init)?;
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
    // The library's skills, as its one extra root: this server is this session's alone [D2043].
    let mut o = o.clone();
    if let Some(roots) = o.as_object_mut().and_then(|o| o.remove("skillRoots"))
        && let Err(e) = call(state, "skills/extraRoots/set", json!({"extraRoots": roots}))
    {
        eprintln!("Codex took no library skills: {e}");
    }
    let method = if o["threadId"].is_string() {
        "thread/resume"
    } else {
        "thread/start"
    };
    let memory = o["config"]["memories.generate_memories"] == true;
    match call(state, method, o) {
        Ok(r) => {
            let thread = r["thread"]["id"].clone();
            state.lock().unwrap().thread = thread.as_str().unwrap_or("").into();
            // A resume keeps the thread's stored memory mode whatever its config says (codex-rs
            // `ThreadMetadataSync::for_resume`), so the switch is set on it too [D469].
            if method == "thread/resume" {
                let mode = if memory { "enabled" } else { "disabled" };
                let set = json!({"threadId": thread, "mode": mode});
                if let Err(e) = call(state, "thread/memoryMode/set", set) {
                    eprintln!("Codex kept this thread's memory mode: {e}");
                }
            }
            // Its result names the model it runs (`ran.real`).
            say(
                json!({"method": "thread/started", "params": {"thread": {"id": thread, "model": r["model"]}}}),
            );
            skills(state);
            Ok(())
        }
        Err(e) => {
            reply(c["id"].as_str().unwrap_or(""), Some(e.clone()));
            Err(format!("Codex refused {method}: {e}"))
        }
    }
}

/// Its skills for the session's folder, listed again whenever it says they changed [D2009].
fn skills(state: &Shared) {
    let state = state.clone();
    thread::spawn(move || {
        let cwd = state.lock().unwrap().cwd.clone();
        match call(&state, "skills/list", json!({"cwds": [cwd]})) {
            Ok(r) => say(json!({"type": "brigadier.skills", "data": r})),
            Err(e) => eprintln!("Codex listed no skills: {e}"),
        }
    });
}

/// One line from the adapter.
fn command(state: &Shared, c: &Value) -> Result<(), String> {
    if c["open"].is_object() {
        return open(state, c);
    }
    // Waited for, so the next turn has the tools; never under a turn: it restarts every server.
    if c["redial"] == true && state.lock().unwrap().turn.is_empty() {
        let _ = call(state, "config/mcpServer/reload", Value::Null);
    }
    let cid = c["id"].as_str().unwrap_or("").to_string();
    let st = &mut *state.lock().unwrap();
    let of = |k: &str, own: &String| c[k].as_str().map_or(own.clone(), String::from);
    let (thread, turn) = (of("thread", &st.thread), of("turn", &st.turn));
    // A line with a turn and a steer steers the turn that runs, else starts its own [D117].
    let starts = c["turn"].is_object() && (c["steer"].is_null() || turn.is_empty());
    st.stopped = c["interrupt"] == true || (st.stopped && !starts);
    if starts {
        let mut params = c["turn"].clone();
        params["threadId"] = thread.into();
        ask(st, "turn/start", params, Pending::Reply(cid));
    } else if !c["steer"].is_null() || c["interrupt"] == true {
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
    } else if c["compact"] == true {
        ask(
            st,
            "thread/compact/start",
            json!({"threadId": thread}),
            Pending::Reply(cid),
        );
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
            tell_limits(st);
            flush(st);
        }
    }
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
        merge(st, &p["rateLimits"].clone());
        return tell_limits(st);
    }
    if method == "skills/changed" {
        return skills(state);
    }
    if method == "serverRequest/resolved" {
        let id = id_of(&st.nonce, &p["requestId"]);
        v["params"]["requestId"] = id.into();
        return say(v.take());
    }
    // A subagent's own thread is its parent's tool call [D78]; only its requests come through.
    if p["threadId"] != st.thread.as_str() {
        return child(st, &method, v);
    }
    let subagent = method == "item/completed" && p["item"]["type"] == "subAgentActivity";
    // Statuses arriving after their turn ended must never hold the next reply [D492].
    if matches!(
        method.as_str(),
        "error"
            | "model/rerouted"
            | "model/safetyBuffering/updated"
            | "item/autoApprovalReview/completed"
    ) && (st.turn.is_empty() || p["turnId"] != st.turn.as_str())
    {
        return;
    }
    match method.as_str() {
        "turn/started" => st.turn = p["turn"]["id"].as_str().unwrap_or("").into(),
        "turn/completed" => {
            st.turn.clear();
            // A stopped turn's words so far go back into its history, so the next turn carries
            // on from them, as on other agents [D124].
            let writing = std::mem::take(&mut st.writing);
            if p["turn"]["status"] == "interrupted" && !writing.is_empty() {
                let said = json!({"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": writing}]});
                let params = json!({"threadId": st.thread, "items": [said]});
                ask(
                    st,
                    "thread/inject_items",
                    params,
                    Pending::Reply(String::new()),
                );
            }
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
        // A steer cuts the reply being written, and Codex never completes it: it ends as cut, so
        // the reply after the steer is a row of its own, as on other agents [D82].
        "item/started" if p["item"]["type"] == "agentMessage" && !st.writing.is_empty() => {
            let text = std::mem::take(&mut st.writing);
            say(
                json!({"method": "item/completed", "params": {"item": {"type": "agentMessage", "text": text}}}),
            );
        }
        "item/completed" => {
            st.items.remove(p["item"]["id"].as_str().unwrap_or(""));
            if p["item"]["type"] == "agentMessage" {
                st.writing.clear();
            }
        }
        // The reply as it's written, its piece alone: one line per piece adds up [D147].
        "item/agentMessage/delta" => {
            st.writing += p["delta"].as_str().unwrap_or("");
            return say(json!({"method": method, "params": {"delta": p["delta"]}}));
        }
        "thread/tokenUsage/updated"
        | "turn/plan/updated"
        | "error"
        | "model/rerouted"
        | "model/safetyBuffering/updated"
        | "item/started"
        | "item/autoApprovalReview/started"
        | "item/autoApprovalReview/completed" => {}
        _ => return,
    }
    if subagent {
        activity(st, &mut v["params"]["item"]);
    }
    if method == "item/completed" && v["params"]["item"]["type"] == "imageGeneration" {
        image::kept(&st.thread, &mut v["params"]["item"]);
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
    if (p["threadId"].as_str()).is_some_and(|t| t != st.thread) {
        p["parent"] = p["threadId"].clone();
    }
    match method.as_str() {
        "item/commandExecution/requestApproval" => {
            let inside = p["cwd"].as_str().is_some_and(|c| c.starts_with(&st.cwd));
            p["insideSession"] = inside.into();
            p["canGrant"] = can_grant(p).into();
            p["whole"] = p["command"].clone();
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
