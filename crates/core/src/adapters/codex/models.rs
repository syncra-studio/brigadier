//! Requests to a short-lived app-server: Codex's own model list [D128, D129], `model/list` being its
//! documented list, paged, with each model's efforts; and its thread delete [D35].

use super::super::{ModelInfo, base_env};
use crate::Spec;
use serde_json::{Value, json};
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::mpsc::channel;
use std::thread;
use std::time::{Duration, Instant};

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
    let client = json!({"clientInfo": {"name": "brigadier", "version": env!("CARGO_PKG_VERSION")}});
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
    }
}
