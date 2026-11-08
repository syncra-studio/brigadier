//! Codex's own model list [D128, D129], from a short-lived app-server: `model/list` is its documented
//! list, paged, with each model's efforts.

use super::super::{ModelInfo, base_env};
use crate::Spec;
use serde_json::{Value, json};
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::mpsc::channel;
use std::thread;
use std::time::{Duration, Instant};

/// Its models, the default first; None when the probe failed. Bounded to `secs` in all.
pub fn list(spec: &Spec, exe: &Path, cwd: &Path, secs: u64) -> Option<Vec<ModelInfo>> {
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
    let mut send = |id: u64, method: &str, params: Value| {
        writeln!(
            server,
            "{}",
            json!({"id": id, "method": method, "params": params})
        )
        .ok()
    };
    let wait = |id: u64| -> Option<Value> {
        loop {
            let left = deadline.checked_duration_since(Instant::now())?;
            let v = rx.recv_timeout(left).ok()?;
            if v["id"] == id && v.get("method").is_none() {
                return v.get("result").cloned();
            }
        }
    };
    let found = (|| {
        send(
            0,
            "initialize",
            json!({"clientInfo": {"name": "brigadier", "version": env!("CARGO_PKG_VERSION")}}),
        )?;
        wait(0)?;
        let (mut models, mut cursor, mut id) = (vec![], Value::Null, 1);
        loop {
            send(id, "model/list", json!({"cursor": cursor}))?;
            let page = wait(id)?;
            models.extend(page["data"].as_array().cloned().unwrap_or_default());
            cursor = page["nextCursor"].clone();
            id += 1;
            if cursor.is_null() {
                return Some(models);
            }
        }
    })();
    let _ = child.kill();
    let _ = child.wait();
    let mut models = found?;
    models.sort_by_key(|m| m["isDefault"] != true);
    Some(models.iter().map(info).collect())
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
