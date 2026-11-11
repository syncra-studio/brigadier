//! `settings [KEY VALUE]`: the app's settings, each value and its default Rust's [D71, D2004]. They
//! live in `settings.json`; Keep awake stays in its own `awake` file, which the daemon reads each
//! pass [D88, D2016]. `settings agent NAME on|off` turns an agent on or off, kept as the list
//! of those off [D2079].

use brigadier_core::{self as core, adapters};
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
    let off = saved["agents_off"].as_array().cloned().unwrap_or_default();
    all.insert("agents_off".into(), off.into());
    Value::Object(all)
}

/// Whether an agent is on: one turned off is left out of new sessions, onboarding and switching,
/// while its sessions keep working and Settings › Providers still shows it [D2079].
pub fn enabled(data: &Path, agent: &str) -> bool {
    !read(data)["agents_off"]
        .as_array()
        .is_some_and(|off| off.iter().any(|a| a == agent))
}

/// One setting's value as Rust reads it: the stored choice, else its default.
pub fn get(data: &Path, key: &str) -> String {
    match &read(data)[key] {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

pub fn run(data: &Path, args: &[String]) -> io::Result<Value> {
    let _one = SETTINGS.lock().unwrap();
    let mut saved = read(data);
    saved.as_object_mut().map(|o| o.remove("awake"));
    match args {
        [_] => {}
        [_, key, value] if key == "awake" => {
            if !core::AWAKE_MODES.contains(&value.as_str()) {
                return Err(io::Error::other(format!("awake can't be {value:?}")));
            }
            core::write_atomic(&data.join("awake"), value.as_bytes())?;
        }
        [_, key, value] => {
            let Some((_, choices)) = KEYS.iter().find(|(k, _)| k == key) else {
                return Err(io::Error::other(format!("no setting {key:?}")));
            };
            if !choices.contains(&value.as_str()) {
                return Err(io::Error::other(format!("{key} can't be {value:?}")));
            }
            saved[key.as_str()] = value.as_str().into();
            save(data, saved)?;
        }
        [_, agent, name, on] if agent == "agent" && adapters::get(name).is_some() => {
            let off = saved["agents_off"].as_array_mut().unwrap();
            off.retain(|a| a != name.as_str());
            match on.as_str() {
                "on" => {}
                "off" => off.push(name.as_str().into()),
                _ => return Err(io::Error::other(format!("{name} is on or off, not {on:?}"))),
            }
            save(data, saved)?;
        }
        _ => {
            return Err(io::Error::other(
                "usage: brigadier settings [KEY VALUE | agent NAME on|off]",
            ));
        }
    }
    let mut all = read(data);
    all["ok"] = true.into();
    Ok(all)
}

fn save(data: &Path, mut saved: Value) -> io::Result<()> {
    // Switches are kept as the words they're set with, so one read rule covers every key.
    for (k, choices) in KEYS.iter().filter(|(_, c)| *c == SWITCH) {
        if let Some(on) = saved[*k].as_bool() {
            saved[*k] = choices[usize::from(!on)].into();
        }
    }
    fs::create_dir_all(data)?;
    core::write_atomic(&data.join("settings.json"), saved.to_string().as_bytes())
}
