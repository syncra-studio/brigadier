//! `brigadier`: the one way in for every drill. Each command prints one JSON line.
//!
//! The daemon says who is calling [D3030]: the app or a drill runs its command here, as it always
//! has; a session's agent gets only the agent commands, answered by the daemon; anyone it can't
//! tell is refused.

use brigadier_frames::{procs, wire};
use serde_json::{Value, json};
use std::fmt::Display;
use std::io::Write;
use std::path::Path;
use std::time::Duration;
use std::{env, process};

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    let data = brigadier_core::data_dir();
    // An agent's helper process (an adapter's channel to its CLI's server), not a command. Only a
    // session's host starts it, as its own child: an agent's `brigadier helper` is a call.
    if args.first().is_some_and(|a| a == "helper") && host_child() {
        let helper = brigadier_core::adapters::get(args.get(1).map_or("", String::as_str));
        let done = helper.map_or(Err("unknown agent".into()), |a| a.helper(&args[2..]));
        if let Err(e) = done {
            complain(e);
            process::exit(1);
        }
        return;
    }
    // Claude's `Stop` hook: it only judges the reply on stdin and counts it [D529]. Its edit
    // hook keeps a folder chat's edits out of the repos' own checkouts [D494].
    let hook = args
        .get(1)
        .filter(|_| args.first().is_some_and(|a| a == "hook"));
    // Every tool call's hook on an agent that can veto it: refused while a summary turn runs [D92].
    if hook.is_some_and(|h| h == "tool") {
        let _ = std::io::copy(&mut std::io::stdin(), &mut std::io::sink());
        let dir = env::var_os(brigadier_core::agent::SESSION).map(std::path::PathBuf::from);
        if let Some(why) = brigadier_core::summary::tool_hook(dir.as_deref()) {
            eprintln!("{why}");
            process::exit(2);
        }
        return;
    }
    if let Some(hook @ ("stop" | "edit")) = hook.map(String::as_str) {
        let input = serde_json::from_reader(std::io::stdin()).unwrap_or_default();
        let dir = env::var_os(brigadier_core::agent::SESSION).map(std::path::PathBuf::from);
        let agent = args.get(2).map_or("", String::as_str);
        let out = match hook {
            "stop" => brigadier_core::rules::stop_hook(&input, agent, dir.as_deref()),
            _ => dir.and_then(|d| brigadier_core::folder::edit_hook(&input, &d)),
        };
        if let Some(out) = out {
            print(out);
        }
        return;
    }
    // Brigadier's own MCP server, which its CLI starts for the agent [D529].
    if args.first().is_some_and(|a| a == "mcp-server") {
        return brigadier::mcp::serve::run();
    }
    let args = typed(args);
    let out = match agent_call(&data, &args) {
        None => brigadier::run(&data, &args)
            .unwrap_or_else(|e| json!({"ok": false, "error": e.to_string()})),
        Some(mut reply) => {
            reply.as_object_mut().map(|o| o.remove("re"));
            match reply["text"].as_str() {
                Some(text) => print(text.trim_end()),
                None if reply["ok"] == false => {
                    complain(reply["error"].as_str().unwrap_or("refused"))
                }
                None => print(&reply),
            }
            process::exit(if reply["ok"] == true { 0 } else { 1 });
        }
    };
    if !out.is_null() {
        print(&out);
    }
    process::exit(if out["ok"] == false { 1 } else { 0 });
}

/// Prints a command's answer; one that can't be written (a full disk) is a failure.
fn print(text: impl Display) {
    if let Err(e) = brigadier::heard(writeln!(std::io::stdout(), "{text}")) {
        complain(format!("The answer couldn't be written: {e}"));
        process::exit(1);
    }
}

/// `eprintln!`, but for its panic where nobody reads what a command says went wrong.
fn complain(text: impl Display) {
    let _ = writeln!(std::io::stderr(), "{text}");
}

/// `computer type` takes its text on stdin, never on the command line, where others could read it [D902].
/// A stdin left open with nothing on it gives up after 5 s [D2026].
fn typed(mut args: Vec<String>) -> Vec<String> {
    use std::io::{IsTerminal, Read};
    // A `run` with a type step takes it the same way.
    let typing = args.first().is_some_and(|a| a == "computer")
        && match args.get(1).map(String::as_str) {
            Some("type") => true,
            Some("run") => args[2..]
                .iter()
                .any(|s| s.trim_start().starts_with("type ")),
            _ => false,
        };
    if !typing {
        return args;
    }
    // Text named on the command line is dropped: `type` then asks for it on stdin.
    if let Some(i) = args.iter().position(|a| a == "--stdin") {
        args.drain(i..(i + 2).min(args.len()));
    }
    if std::io::stdin().is_terminal() {
        return args;
    }
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut text = String::new();
        let read = std::io::stdin().take(64 << 10).read_to_string(&mut text);
        let _ = tx.send(read.map(|_| text));
    });
    if let Ok(Ok(text)) = rx.recv_timeout(Duration::from_secs(5)) {
        // `echo` ends its text with a newline the agent didn't mean to type; --submit presses Return.
        let text = text.strip_suffix('\n').unwrap_or(&text).to_string();
        args.extend(["--stdin".into(), text]);
    }
    args
}

fn host_child() -> bool {
    let parent = procs::info(process::id() as i32).map_or(0, |p| p.ppid);
    // Under no host at all it is no agent's: the daemon's message writer and test prompt [D617].
    procs::hosts_above(process::id() as i32)
        .is_some_and(|h| h.first().is_none_or(|h| h.0 == parent))
}

/// None for the app's and drills' own run here; else the daemon's answer for an agent, or a refusal.
fn agent_call(data: &Path, args: &[String]) -> Option<Value> {
    let ask = || -> std::io::Result<(wire::Conn, Value)> {
        let mut conn = wire::connect_daemon(&data.join("daemon.sock"), Duration::from_secs(5))?;
        let who = conn.call(&json!({"id": 1, "op": "who"}))?;
        Ok((conn, who))
    };
    let (mut conn, who) = match ask() {
        Ok(asked) => asked,
        Err(e) => return no_daemon(data, e.kind() == std::io::ErrorKind::PermissionDenied),
    };
    // A sign-in lives in the daemon, past this process [wave4 D2030].
    let signing = matches!(
        args.get(1).map(String::as_str),
        Some("signin" | "wait" | "cancel" | "signout")
    );
    // So does computer use's helper connection [D913].
    // So do computer use's and the browser's cards: answered elsewhere, they'd go without a decision.
    let held = args.first().is_some_and(|a| a == "computer")
        || args.first().is_some_and(|a| a == "answer")
            && (args.get(2))
                .is_some_and(|r| r.starts_with("computer-") || r.starts_with("browser-"));
    // And remote access's state: offers, devices and the gateway [beat-competitors D62].
    let remote = args.first().is_some_and(|a| a == "remote");
    if who["app"] == true
        && (held || remote || args.first().is_some_and(|a| a == "plugins") && signing)
    {
        let _ = conn.set_timeout(Some(Duration::from_secs(660)));
        let reply = conn.call(&json!({"id": 2, "op": "run", "args": args}));
        return Some(reply.unwrap_or_else(
            |e| json!({"ok": false, "error": format!("Brigadier stopped answering: {e}")}),
        ));
    }
    if who["app"] == true {
        return None;
    }
    if who["agent"].is_null() {
        return Some(who);
    }
    // A wait's own timeout ends it first; this only bounds a daemon that stopped answering.
    let _ = conn.set_timeout(Some(Duration::from_secs(660)));
    let reply = conn.call(&json!({"id": 2, "op": "agent", "args": args}));
    Some(reply.unwrap_or_else(|e| match args.first().map(String::as_str) {
        // Its record may be written: the daemon delivers it once when it's back [D2034].
        Some("send") => {
            let to = args.get(1).map_or("it", String::as_str);
            json!({"ok": false, "error": format!("Brigadier stopped while sending. Your message may already be on its way. Check with `brigadier read {to}` before sending it again.")})
        }
        _ => json!({"ok": false, "error": format!("Brigadier stopped answering: {e}")}),
    }))
}

/// With no daemon to ask, only a caller the kernel shows outside every session of this data
/// folder runs here; a session's agent, or a walk that can't finish, is refused. Paths only: no
/// session file is read. A sandbox that blocks the socket (Codex's) is named, so the agent asks
/// to run it outside, and that one approval covers every `brigadier` call [D2026].
fn no_daemon(data: &Path, blocked: bool) -> Option<Value> {
    if blocked {
        return Some(
            json!({"ok": false, "error": "Your shell's sandbox blocks Brigadier's socket. Run this `brigadier` command outside the sandbox (ask for that if you must); one approval covers every `brigadier` command."}),
        );
    }
    let sessions = data.join("sessions");
    let ours = |dir: &str| Path::new(dir).parent().is_some_and(|p| p == sessions);
    let marked = env::var(brigadier_core::agent::SESSION).is_ok_and(|m| ours(&m));
    match procs::hosts_above(process::id() as i32) {
        Some(hosts) if !marked && !hosts.iter().any(|h| ours(&h.2)) => None,
        _ => Some(
            json!({"ok": false, "error": "Brigadier isn't running, so `brigadier` can't answer now."}),
        ),
    }
}
