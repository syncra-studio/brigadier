//! `settings [KEY VALUE]`: the app's settings, each value and its default Rust's [D71, D2004]. They
//! live in `settings.json`; Keep awake stays in its own `awake` file, which the daemon reads each
//! pass [D88, D2016]. `settings agent NAME on|off` turns an agent on or off, kept as the list
//! of those off [D2079]; `settings agent-path NAME PATH` runs it from another CLI once that one
//! proves to be it [D2082].

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
    let paths = saved["agent_paths"]
        .as_object()
        .cloned()
        .unwrap_or_default();
    all.insert("agent_paths".into(), paths.into());
    Value::Object(all)
}

/// Whether `path` is agent `a`'s CLI: a program whose `--version` answers and names it, in the
/// old app's words when it isn't [D2082].
fn check_path(a: &dyn adapters::Adapter, path: &Path) -> io::Result<()> {
    let shown = path.display();
    let refuse = |why: String| Err(io::Error::other(why));
    if !path.is_absolute() {
        return refuse("Choose the file by its full path.".into());
    }
    let Ok(meta) = fs::metadata(path) else {
        return refuse(format!("{shown} doesn't exist."));
    };
    if !meta.is_file() {
        return refuse(format!("{shown} is a folder, not a program."));
    }
    if std::os::unix::fs::PermissionsExt::mode(&meta.permissions()) & 0o111 == 0 {
        return refuse(format!("{shown} isn't a program that can run."));
    }
    let out = adapters::probe(path, &adapters::home_path(""), &[], &["--version"], 10)
        .map_err(|e| io::Error::other(format!("{shown} didn't run: {e}")))?;
    let first = String::from_utf8_lossy(&out.stdout)
        .lines()
        .next()
        .unwrap_or("")
        .to_lowercase();
    // Its version line or its file name names it ("2.1.0 (Claude Code)", "codex-cli 0.9", opencode).
    let bin = a.bin().0;
    let named = first.contains(bin) || path.file_name().is_some_and(|n| n == bin);
    match out.status.success() && named && first.contains(|c: char| c.is_ascii_digit()) {
        true => Ok(()),
        false => refuse(format!("{shown} isn't {}.", a.label())),
    }
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
        [_, key, name, path] if key == "agent-path" && adapters::get(name).is_some() => {
            check_path(adapters::get(name).unwrap(), Path::new(path))?;
            saved["agent_paths"][name.as_str()] = path.as_str().into();
            save(data, saved)?;
        }
        _ => {
            return Err(io::Error::other(
                "usage: brigadier settings [KEY VALUE | agent NAME on|off | agent-path NAME PATH]",
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
