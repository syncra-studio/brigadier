//! `settings [KEY VALUE]`: the app's settings, each value and its default Rust's [D71, D2004]. They
//! live in `settings.json`; Keep awake stays in its own `awake` file, which the daemon reads each
//! pass [D88, D2016].

use brigadier_core as core;
use serde_json::{Map, Value, json};
use std::fs;
use std::io;
use std::path::Path;
use std::sync::Mutex;

static SETTINGS: Mutex<()> = Mutex::new(());

const SWITCH: &[&str] = &["true", "false"];

/// Each setting: its key, its choices and its default, the first.
const KEYS: [(&str, &[&str]); 6] = [
    // What a message sent while a turn runs does [D188].
    ("follow_up", &["queue", "steer"]),
    // The level a new session starts on where its project is trusted [D187].
    ("default_level", &["auto", "ask", "full"]),
    // When a finished session sends a notice [D200, D2022].
    ("notify_finished", &["background", "always", "never"]),
    ("notify_needs_you", SWITCH),
    // macOS's own notification sound with each notice [D2012, D2020].
    ("sound", SWITCH),
    // What the last notice did: none sent yet, shown, or refused by macOS [D2024].
    ("notices", &["unasked", "sent", "blocked"]),
];

/// Every setting, read or Rust's default for one unset or unknown.
pub fn read(data: &Path) -> Value {
    let saved: Value = fs::read(data.join("settings.json"))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();
    let mut all: Map<String, Value> = KEYS
        .iter()
        .map(|(key, choices)| {
            let picked = choices
                .iter()
                .find(|c| saved[key].as_str() == Some(c))
                .unwrap_or(&choices[0]);
            let value = match *choices == SWITCH {
                true => json!(*picked == "true"),
                false => json!(picked),
            };
            (key.to_string(), value)
        })
        .collect();
    all.insert("awake".into(), core::awake_mode(data).into());
    Value::Object(all)
}

/// One setting's value as Rust reads it: the stored choice, else its default.
pub fn get(data: &Path, key: &str) -> String {
    match &read(data)[key] {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

pub fn run(data: &Path, args: &[String]) -> io::Result<Value> {
    if let [_, key, value] = args {
        let _one = SETTINGS.lock().unwrap();
        if key == "awake" {
            if !core::AWAKE_MODES.contains(&value.as_str()) {
                return Err(io::Error::other(format!("awake can't be {value:?}")));
            }
            core::write_atomic(&data.join("awake"), value.as_bytes())?;
        } else {
            let Some((_, choices)) = KEYS.iter().find(|(k, _)| k == key) else {
                return Err(io::Error::other(format!("no setting {key:?}")));
            };
            if !choices.contains(&value.as_str()) {
                return Err(io::Error::other(format!("{key} can't be {value:?}")));
            }
            let mut saved = read(data);
            saved.as_object_mut().map(|o| o.remove("awake"));
            saved[key.as_str()] = value.as_str().into();
            // Switches are kept as the words they're set with, so one read rule covers every key.
            for (k, choices) in KEYS.iter().filter(|(_, c)| *c == SWITCH) {
                if let Some(on) = saved[*k].as_bool() {
                    saved[*k] = choices[usize::from(!on)].into();
                }
            }
            fs::create_dir_all(data)?;
            core::write_atomic(&data.join("settings.json"), saved.to_string().as_bytes())?;
        }
    } else if args.len() != 1 {
        return Err(io::Error::other("usage: brigadier settings [KEY VALUE]"));
    }
    let mut all = read(data);
    all["ok"] = true.into();
    Ok(all)
}
