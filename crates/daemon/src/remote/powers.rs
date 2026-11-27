//! The five phone powers of D57 (remote design §4.7): a switch per device, saved in
//! `devices.json` as `powers` (each on unless set off, Mac only), and a log of each use in
//! `data/remote-log.jsonl`, kept under 1 MB. Settings › Connections shows both (lane B's M6b).

use super::devices;
use serde_json::{Value, json};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

pub(super) const POWERS: [&str; 5] = ["shell", "level", "overnight", "settings", "paths"];
const LOG: &str = "remote-log.jsonl";
const MOST: u64 = 1 << 20;
const SHOWN: usize = 500;

pub(super) fn on(device: &Value, power: &str) -> bool {
    device["powers"][power] != false
}

pub(super) fn shown(device: &Value) -> Value {
    POWERS
        .iter()
        .map(|p| (p.to_string(), Value::Bool(on(device, p))))
        .collect()
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

/// One use, appended; past 1 MB only the newest entries within half of it are kept.
pub(super) fn log(data: &Path, device: &str, power: &str, argv: &[String]) {
    let path = data.join(LOG);
    let line = json!({"at": now_ms(), "device": device, "power": power, "argv": argv});
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(file, "{line}");
    }
    if fs::metadata(&path).is_ok_and(|m| m.len() > MOST)
        && let Ok(text) = fs::read_to_string(&path)
    {
        let mut room = MOST / 2;
        let mut kept: Vec<&str> = (text.lines().rev())
            .take_while(|l| {
                let fits = (l.len() as u64) < room;
                room = room.saturating_sub(l.len() as u64 + 1);
                fits
            })
            .collect();
        kept.reverse();
        let kept: String = kept.iter().map(|l| format!("{l}\n")).collect();
        let _ = brigadier_core::write_atomic(&path, kept.as_bytes());
    }
}

/// `remote device <id> power <p> on|off`.
pub(super) fn set(data: &Path, id: &str, power: &str, value: &str) -> Value {
    let (true, Some(on)) = (
        POWERS.contains(&power),
        [("on", true), ("off", false)]
            .into_iter()
            .find(|(w, _)| *w == value)
            .map(|(_, b)| b),
    ) else {
        return json!({"ok": false, "error": "usage: remote device <id> power <shell|level|overnight|settings|paths> on|off"});
    };
    let mut all = match devices::list(data) {
        Ok(all) => all,
        Err(e) => return json!({"ok": false, "error": e.to_string()}),
    };
    let Some(device) = all.iter_mut().find(|d| d["id"] == id) else {
        return json!({"ok": false, "error": "No such device."});
    };
    if !device["powers"].is_object() {
        device["powers"] = json!({});
    }
    device["powers"][power] = on.into();
    let powers = shown(device);
    match devices::save(data, &all) {
        Ok(()) => json!({"ok": true, "powers": powers}),
        Err(e) => json!({"ok": false, "error": e.to_string()}),
    }
}

/// `remote log <device>`: its uses, newest first, at most 500.
pub(super) fn entries(data: &Path, device: &str) -> Value {
    let text = fs::read_to_string(data.join(LOG)).unwrap_or_default();
    let entries: Vec<Value> = (text.lines().rev())
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .filter(|e| e["device"] == device)
        .take(SHOWN)
        .map(|e| json!({"at": e["at"], "power": e["power"], "argv": e["argv"]}))
        .collect();
    json!({"ok": true, "entries": entries})
}
