//! Who is on a connection [D2026, D3030], decided here from the kernel and the session folders,
//! never by the client: the app or a drill, a session's agent, or a caller that can't be told,
//! which is refused. A session's agent is any process below its host, with or without its grant,
//! or one that carries a session's marker and its grant; a marker with a wrong or missing grant,
//! or naming another session than its tree, is refused. An agent's connection gets only `who`
//! and `agent`, so it never reaches the app's commands.
//!
//! shortcut: a same-user process that drops the marker and leaves its session's tree (a double
//! fork) reads as the app. It isn't a `brigadier …` call, so its agent's CLI asks the user before
//! running it, and a process that can do that could edit the data folder anyway. Close it with a
//! signed per-launch token if an agent CLI ever runs such commands unasked.

use super::Shared;
use brigadier_core::agent::{GRANT, SESSION, granted};
use brigadier_frames::{procs, wire};
use serde_json::{Value, json};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Sender;
use std::{fs, thread};

pub(super) enum Caller {
    App,
    Agent(String),
    Refused(String),
}

/// The session id a session folder path names, if it is one of this data folder's.
/// A marker of another Brigadier's data folder is that one's, not this one's.
fn ours(data: &Path, dir: &str) -> Option<String> {
    let dir = Path::new(dir);
    let sessions = fs::canonicalize(data.join("sessions")).ok()?;
    (fs::canonicalize(dir.parent()?).ok()? == sessions)
        .then(|| dir.file_name()?.to_str().map(String::from))
        .flatten()
}

pub(super) fn of(stream: &UnixStream, data: &Path) -> Caller {
    let unknown = || Caller::Refused("Brigadier can't tell who is calling, so it refuses.".into());
    let Ok(pid) = wire::peer_pid(stream) else {
        return unknown();
    };
    let (Some(hosts), Some((_, env))) = (procs::hosts_above(pid), procs::args(pid)) else {
        return unknown();
    };
    let mut tree = None;
    for (host, start, dir) in hosts {
        let Some(id) = ours(data, &dir) else { continue };
        let owner: Value = fs::read(PathBuf::from(&dir).join("owner.json"))
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        if owner["pid"] != host || owner["start_us"] != start {
            return unknown();
        }
        tree = Some(id);
        break;
    }
    let var = |k: &str| {
        let prefix = format!("{k}=");
        env.iter()
            .find_map(|e| e.strip_prefix(&prefix).map(String::from))
    };
    let (marker, grant) = (var(SESSION), var(GRANT));
    let marked = marker.as_deref().and_then(|m| ours(data, m));
    let valid = |id: &str| {
        granted(
            &data.join("sessions").join(id),
            grant.as_deref().unwrap_or(""),
        )
    };
    let refused = || {
        Caller::Refused("This session's grant doesn't match; Brigadier refuses the call.".into())
    };
    match (tree, marked) {
        (Some(t), Some(m)) if m != t || !valid(&m) => refused(),
        (Some(t), _) => Caller::Agent(t),
        (None, Some(m)) if valid(&m) => Caller::Agent(m),
        (None, Some(_)) => refused(),
        (None, None) if grant.is_some() && marker.is_none() => refused(),
        (None, None) => Caller::App,
    }
}

/// Answers `who` and `agent` for any caller, and refuses an agent's or an unknown caller's other
/// ops. False when the request is the app's to serve as before.
pub(super) fn serve(
    caller: &Caller,
    req: &Value,
    out: &Sender<String>,
    data: &Path,
    state: &Shared,
    here: &Arc<AtomicBool>,
) -> bool {
    let op = req["op"].as_str().unwrap_or("");
    let re = req["id"].clone();
    let reply = match (caller, op) {
        (Caller::App, "who") => json!({"ok": true, "app": true}),
        (Caller::App, _) => return false,
        (Caller::Refused(why), _) => json!({"ok": false, "error": why}),
        (Caller::Agent(id), "who") => json!({"ok": true, "agent": id}),
        (Caller::Agent(id), "agent") => {
            let args: Vec<String> = (req["args"].as_array().into_iter().flatten())
                .filter_map(|a| a.as_str().map(String::from))
                .collect();
            let (id, out, data, state, here) = (
                id.clone(),
                out.clone(),
                data.to_path_buf(),
                state.clone(),
                here.clone(),
            );
            // A wait may take minutes: never hold up this connection's reads.
            thread::spawn(move || {
                let rows = || state.lock().unwrap().rows.values().cloned().collect();
                let here = || here.load(Ordering::SeqCst);
                let mut reply = match args.first().map(String::as_str) {
                    Some("computer") => brigadier::computer::agent(&data, &id, &args, &rows, &here),
                    _ => brigadier::agent::run(&data, &id, &args, &rows, &here),
                };
                reply["re"] = re;
                let _ = out.send(reply.to_string());
            });
            return true;
        }
        (Caller::Agent(_), _) => {
            json!({"ok": false, "error": "A session's agent can run only `brigadier` agent commands."})
        }
    };
    let mut reply = reply;
    reply["re"] = re;
    let _ = out.send(reply.to_string());
    true
}
