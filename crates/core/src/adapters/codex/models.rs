//! Requests to a short-lived app-server: Codex's own model list [D128, D129], `model/list` being its
//! documented list, paged, with each model's efforts; and its thread delete [D35].

use super::super::{Failed, ModelInfo, base_env};
use crate::Spec;
use serde_json::{Value, json};
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::mpsc::channel;
use std::thread;
use std::time::{Duration, Instant};

/// The name Codex records as a thread's originator.
const CLIENT: &str = "brigadier";

/// One request's result, or the server's error message; the same for no answer in time.
type Call<'a> = &'a mut dyn FnMut(&str, Value) -> Result<Value, String>;

/// Runs `work` against an app-server of its own; None when it wouldn't start. Bounded to `secs` in all.
fn short_lived<T>(
    spec: &Spec,
    exe: &Path,
    cwd: &Path,
    secs: u64,
    work: impl FnOnce(Call) -> T,
) -> Option<T> {
    let mut child = Command::new(exe)
        .args(["app-server"])
        .env_clear()
        .envs(base_env(spec, exe, &[]))
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut server = child.stdin.take()?;
    let out = BufReader::new(child.stdout.take()?);
    let (tx, rx) = channel::<Value>();
    thread::spawn(move || {
        for v in out
            .lines()
            .map_while(Result::ok)
            .filter_map(|l| serde_json::from_str(&l).ok())
        {
            if tx.send(v).is_err() {
                break;
            }
        }
    });
    let deadline = Instant::now() + Duration::from_secs(secs);
    let mut id = 0_u64;
    let mut call = |method: &str, params: Value| -> Result<Value, String> {
        id += 1;
        writeln!(
            server,
            "{}",
            json!({"id": id, "method": method, "params": params})
        )
        .map_err(|e| e.to_string())?;
        loop {
            let late = || format!("Codex didn't answer {method}");
            let left = (deadline.checked_duration_since(Instant::now())).ok_or_else(late)?;
            let v = rx.recv_timeout(left).map_err(|_| late())?;
            if v["id"] != id || v.get("method").is_some() {
                continue;
            }
            return match v["error"]["message"].as_str() {
                Some(e) => Err(e.to_string()),
                None => v.get("result").cloned().ok_or_else(late),
            };
        }
    };
    let client = json!({"clientInfo": {"name": CLIENT, "version": env!("CARGO_PKG_VERSION")}});
    let done = call("initialize", client).ok().map(|_| work(&mut call));
    let _ = child.kill();
    let _ = child.wait();
    done
}

/// Its models, the default first; None when the probe failed. Bounded to `secs` in all.
pub fn list(spec: &Spec, exe: &Path, cwd: &Path, secs: u64) -> Option<Vec<ModelInfo>> {
    let found = short_lived(spec, exe, cwd, secs, |call| {
        let (mut models, mut cursor) = (vec![], Value::Null);
        loop {
            let page = call("model/list", json!({"cursor": cursor})).ok()?;
            models.extend(page["data"].as_array().cloned().unwrap_or_default());
            cursor = page["nextCursor"].clone();
            if cursor.is_null() {
                return Some(models);
            }
        }
    });
    let mut models = found??;
    models.sort_by_key(|m| m["isDefault"] != true);
    Some(models.iter().map(info).collect())
}

/// Codex's own delete of a thread and the agents it spawned. Ok only on its word that they're gone:
/// done now, or one of its two "unknown thread" answers, given only with no row and no rollout left.
/// A spawned agent's row goes in the one transaction with its root's [D35, D244]. Anything else
/// keeps the session, to try again.
pub fn delete(spec: &Spec, exe: &Path, cwd: &Path, thread: &str) -> Result<(), String> {
    let done = short_lived(spec, exe, cwd, 30, |call| {
        call("thread/delete", json!({"threadId": thread}))
    });
    match done {
        Some(Ok(_)) => Ok(()),
        Some(Err(e)) if e.starts_with("thread not found") || e.starts_with("no rollout found") => {
            Ok(())
        }
        Some(Err(e)) => Err(format!("Codex couldn't delete thread {thread}: {e}")),
        None => Err(format!(
            "Codex's server didn't start, so thread {thread} can't be removed."
        )),
    }
}

/// A new thread holding `conv` up to its completed turn `turn`, inclusive; `conv` itself is left
/// as it was, so the same message can be rewound to again [D384]. No answer can't say it wasn't made.
pub fn fork(spec: &Spec, exe: &Path, cwd: &Path, conv: &str, turn: &str) -> Result<String, Failed> {
    let params = json!({"threadId": conv, "lastTurnId": turn, "excludeTurns": true});
    let made = short_lived(spec, exe, cwd, 30, |call| {
        call("thread/fork", params).map_err(|e| (e.starts_with("Codex didn't answer"), e))
    });
    match made {
        Some(Ok(v)) => (v["thread"]["id"].as_str().map(String::from))
            .ok_or_else(|| Failed::Uncertain("Codex's fork named no thread".into())),
        Some(Err((true, e))) => Err(Failed::Uncertain(e)),
        Some(Err((false, e))) => Err(Failed::Refused(e)),
        None => Err(Failed::Refused("Codex's server didn't start".into())),
    }
}

/// A fork that was never heard about goes, so nothing is left behind unrecorded [D35]. Only what
/// Brigadier forked goes: a fork made elsewhere isn't ours to delete. The original is untouched
/// either way; a list that fails, or names no originator, can leave one fork, which nothing resumes.
pub fn drop_fork(spec: &Spec, exe: &Path, cwd: &Path, conv: &str, resume: &str, at: u64) {
    let found = short_lived(spec, exe, cwd, 30, |call| {
        let page = call("thread/list", json!({"limit": 50})).ok()?;
        let made = (page["data"]
            .as_array()
            .cloned()
            .unwrap_or_default()
            .into_iter())
        .filter(|t| t["forkedFromId"] == conv && t["id"] != resume && t["originator"] == CLIENT)
        .filter(|t| t["createdAt"].as_u64().is_some_and(|s| s >= at / 1000));
        for thread in made {
            let _ = call("thread/delete", json!({"threadId": thread["id"]}));
        }
        Some(())
    });
    if found.flatten().is_none() {
        eprintln!("Codex: couldn't list threads to clear a fork of {conv}");
    }
}

fn info(m: &Value) -> ModelInfo {
    let efforts = m["supportedReasoningEfforts"]
        .as_array()
        .into_iter()
        .flatten();
    ModelInfo {
        id: m["id"].as_str().unwrap_or("").into(),
        name: m["displayName"].as_str().unwrap_or("").into(),
        local: false,
        efforts: efforts
            .filter_map(|e| e["reasoningEffort"].as_str().map(String::from))
            .collect(),
        default_effort: m["defaultReasoningEffort"].as_str().map(String::from),
        // Its upgrade info: a move it advises, with a retirement time where it has one [D487].
        retiring: m["upgradeInfo"].as_object().map(|u| {
            let at = u.get("retirementAt").and_then(Value::as_u64);
            // A Unix time, in seconds unless it's already as large as milliseconds.
            let at = at.map(|t| if t < 100_000_000_000 { t * 1000 } else { t });
            json!({"at": at, "to": u.get("model")})
        }),
    }
}
