//! `brigadier`: the one way in for every drill. Each command prints one JSON line.
//!
//! The daemon says who is calling [D3030]: the app or a drill runs its command here, as it always
//! has; a session's agent gets only the agent commands, answered by the daemon; anyone it can't
//! tell is refused.

use brigadier_frames::{procs, wire};
use serde_json::{Value, json};
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
            eprintln!("{e}");
            process::exit(1);
        }
        return;
    }
    let out = match agent_call(&data, &args) {
        None => brigadier::run(&data, &args)
            .unwrap_or_else(|e| json!({"ok": false, "error": e.to_string()})),
        Some(mut reply) => {
            reply.as_object_mut().map(|o| o.remove("re"));
            match reply["text"].as_str() {
                Some(text) => println!("{}", text.trim_end()),
                None if reply["ok"] == false => {
                    eprintln!("{}", reply["error"].as_str().unwrap_or("refused"))
                }
                None => println!("{reply}"),
            }
            process::exit(if reply["ok"] == true { 0 } else { 1 });
        }
    };
    if !out.is_null() {
        println!("{out}");
    }
    process::exit(if out["ok"] == false { 1 } else { 0 });
}

fn host_child() -> bool {
    let parent = unsafe { libc::getppid() };
    procs::hosts_above(process::id() as i32)
        .is_some_and(|h| h.first().is_some_and(|h| h.0 == parent))
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
    if who["app"] == true {
        return None;
    }
    if who["agent"].is_null() {
        return Some(who);
    }
    // A wait's own timeout ends it first; this only bounds a daemon that stopped answering.
    let _ = conn.set_timeout(Some(Duration::from_secs(660)));
    let reply = conn.call(&json!({"id": 2, "op": "agent", "args": args}));
    Some(reply.unwrap_or_else(
        |e| json!({"ok": false, "error": format!("Brigadier stopped answering: {e}")}),
    ))
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
