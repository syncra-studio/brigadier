//! `settings [KEY VALUE]`: the app's settings, each value and its default Rust's [D71, D2004]. They
//! live in `settings.json`; Keep awake stays in its own `awake` file, which the daemon reads each
//! pass [D88, D2016]. `settings agent NAME on|off` turns an agent on or off, kept as the list
//! of those off [D2079]; `settings agent-path NAME PATH` runs it from another CLI once that one
//! proves to be it, `settings model NAME ID on|off` hides a model from pickers [D2082], and
//! `settings star NAME ID on|off` stars one in the model picker, kept as `models_starred`.

use brigadier_core::{self as core, adapters};
use serde_json::{Map, Value, json};
use std::fs;
use std::io;
use std::path::Path;
use std::sync::Mutex;

static SETTINGS: Mutex<()> = Mutex::new(());

const SWITCH: &[&str] = &["true", "false"];
const SWITCH_OFF: &[&str] = &["false", "true"];

/// Each setting: its key, its choices and its default, the first.
const KEYS: [(&str, &[&str]); 16] = [
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
    // How many workers a session and all its workers may run at once [D3001, D3007]; its place in
    // Configuration is proposed [D3029].
    (
        "workers",
        &[
            "6", "1", "2", "3", "4", "5", "7", "8", "9", "10", "11", "12",
        ],
    ),
    // Each CLI's own memory in sessions, read at each launch; workers never [D2049, D89].
    ("memory", SWITCH_OFF),
    // Where a web link and a local dev URL open: Brigadier's browser or the default one [D507].
    ("web_links_in", &["system", "brigadier"]),
    ("local_links_in", &["brigadier", "system"]),
    // Agents may use the apps on this Mac; off until the user turns it on [D911, D912].
    ("computer_use", SWITCH_OFF),
    // An agent cursor shows where computer use acts; on unless turned off [D956].
    (crate::computer::CURSOR, SWITCH),
    // Computer use leaves a browser's web pages to Brigadier's browser, unless the user names
    // theirs in the chat; on unless turned off [D2032].
    (crate::computer::WEB, SWITCH),
    // The thread's column: centred at the reading width, or the pane's full width; and its messages in
    // bubbles on both sides, or stacked in one column, the user's still in bubbles [D914, D915].
    ("thread_width", &["centered", "full"]),
    ("message_layout", &["bubbles", "stacked"]),
    // Keeping awake holds with the lid closed too, off until turned on [D333].
    ("awake_lid", SWITCH_OFF),
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
            let value = match choices.contains(&"true") {
                true => json!(*picked == "true"),
                false => json!(picked),
            };
            (key.to_string(), value)
        })
        .collect();
    all.insert("awake".into(), core::awake_mode(data).into());
    for key in ["agents_off", "models_off", "models_starred", "older_seen"] {
        let off = saved[key].as_array().cloned().unwrap_or_default();
        all.insert(key.into(), off.into());
    }
    let paths = saved["agent_paths"]
        .as_object()
        .cloned()
        .unwrap_or_default();
    all.insert("agent_paths".into(), paths.into());
    Value::Object(all)
}

/// The ids of an agent's models hidden from new sessions' pickers, kept as `<agent>/<id>` [D2082].
pub fn models_off(data: &Path, agent: &str) -> Vec<String> {
    let all = read(data)["models_off"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let mine = all
        .iter()
        .filter_map(|m| m.as_str()?.strip_prefix(agent)?.strip_prefix('/'));
    mine.map(String::from).collect()
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

/// An agent's older models (`<id>`s its check marks legacy) start hidden, each once, as the old
/// app's did: the first check that lists one adds it to `models_off` and to `older_seen`, and the
/// user's choice stands from then on.
pub fn older_off(data: &Path, agent: &str, ids: &[&str]) -> io::Result<()> {
    let _one = SETTINGS.lock().unwrap();
    let mut saved = read(data);
    saved.as_object_mut().map(|o| o.remove("awake"));
    let seen = saved["older_seen"].as_array().cloned().unwrap_or_default();
    let new: Vec<Value> = (ids.iter().map(|id| json!(format!("{agent}/{id}"))))
        .filter(|m| !seen.contains(m))
        .collect();
    if new.is_empty() {
        return Ok(());
    }
    for key in ["older_seen", "models_off"] {
        let list = saved[key].as_array_mut().unwrap();
        list.retain(|m| !new.contains(m));
        list.extend(new.iter().cloned());
    }
    save(data, saved)
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

/// `awake [off|work|always]`: the keep-awake mode alone, as the sidebar's bulb sets it [D88];
/// `awake lid`, `awake lid-setup` and `awake lid-seen AT`, with the lid closed too [D333].
pub fn awake(data: &Path, args: &[String]) -> io::Result<Value> {
    let mode = args.get(1);
    match mode.map(String::as_str) {
        Some("lid") => return core::lid::status(data),
        Some("lid-setup") => return core::lid::set_up(data),
        Some("lid-seen") => return core::lid::seen(data, args.get(2)),
        _ => {}
    }
    if let Some(mode) = mode {
        run(data, &["settings".into(), "awake".into(), mode.clone()])?;
    }
    Ok(json!({"ok": true, "awake": core::awake_mode(data)}))
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
        // Settings › General's one Chat layout row: both thread keys in one save, so they never land apart.
        [_, key, mode] if key == "chat-layout" => {
            let width = match mode.as_str() {
                "bubbles" => "centered",
                "stacked" => "full",
                _ => return Err(io::Error::other(format!("chat-layout can't be {mode:?}"))),
            };
            saved["thread_width"] = width.into();
            saved["message_layout"] = mode.as_str().into();
            save(data, saved)?;
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
            if key == crate::computer::CURSOR {
                crate::computer::cursor_switched(data);
            }
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
        [_, key, name, id, on]
            if (key == "model" || key == "star") && adapters::get(name).is_some() =>
        {
            let model = format!("{name}/{id}");
            // A hidden model is listed while off, a starred one while on.
            let (key, listed) = match key.as_str() {
                "model" => ("models_off", "off"),
                _ => ("models_starred", "on"),
            };
            if on != "on" && on != "off" {
                return Err(io::Error::other(format!(
                    "{model} is on or off, not {on:?}"
                )));
            }
            let list = saved[key].as_array_mut().unwrap();
            list.retain(|m| *m != model);
            if on == listed {
                list.push(model.into());
            }
            save(data, saved)?;
        }
        _ => {
            return Err(io::Error::other(
                "usage: brigadier settings [KEY VALUE | agent NAME on|off | agent-path NAME PATH | model NAME ID on|off | star NAME ID on|off]",
            ));
        }
    }
    let mut all = read(data);
    all["ok"] = true.into();
    Ok(all)
}

fn save(data: &Path, mut saved: Value) -> io::Result<()> {
    // Switches are kept as the words they're set with, so one read rule covers every key.
    for (k, _) in KEYS.iter().filter(|(_, c)| c.contains(&"true")) {
        if let Some(on) = saved[*k].as_bool() {
            saved[*k] = on.to_string().into();
        }
    }
    fs::create_dir_all(data)?;
    core::write_atomic(&data.join("settings.json"), saved.to_string().as_bytes())
}
