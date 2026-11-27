//! `plugins show|reveal <key>`: View, the old app's Open [D582, D600].

use super::{catalog, is, refuse, str};
use brigadier_core::library;
use serde_json::{Map, Value, json};
use std::io;
use std::path::{Path, PathBuf};

/// What View draws, the old app's Open [D582, D600]: each skill's SKILL.md, `own` where the user
/// added it; or a server's settings as `<name>.json`, every header and env value hidden.
pub(super) fn show(data: &Path, key: &str) -> io::Result<Value> {
    let items = library::items(data);
    let gone = || refuse("That item is no longer in the library.");
    let files: Vec<Value> = match items.iter().find(|i| i["key"] == key) {
        Some(i) if i["kind"] == "server" => {
            let hide = |names: &Value| -> Map<String, Value> {
                (names.as_array().into_iter().flatten())
                    .filter_map(Value::as_str)
                    .map(|n| (n.to_string(), json!("••••••••")))
                    .collect()
            };
            let mut s = match i["url"].is_string() {
                true => json!({"url": i["url"]}),
                false => json!({"command": i["command"], "args": i["args"]}),
            };
            for (field, names) in [("headers", &i["headers"]), ("env", &i["secrets"])] {
                if names.as_array().is_some_and(|n| !n.is_empty()) {
                    s[field] = hide(names).into();
                }
            }
            let text = serde_json::to_string_pretty(&s)? + "\n";
            vec![
                json!({"name": i["name"], "path": format!("{}.json", str(&i["name"])), "text": text}),
            ]
        }
        None if !key.starts_with("skillset:") => return Err(gone()),
        _ => (items.iter().filter(|i| i["kind"] == "skill" && is(i, key)))
            .map(|i| {
                let path = skill_md(data, i);
                let text = std::fs::read_to_string(&path).unwrap_or_default();
                let own = catalog::id(i).is_null();
                json!({"name": i["name"], "path": path, "text": text, "own": own})
            })
            .collect(),
    };
    match files.is_empty() {
        true => Err(gone()),
        false => Ok(json!({"ok": true, "files": files})),
    }
}

fn skill_md(data: &Path, i: &Value) -> PathBuf {
    library::skill_dir(data, i).join("SKILL.md")
}

/// A skill's SKILL.md in Finder: only one the user added, to edit it in their own editor [D600].
pub(super) fn reveal(data: &Path, key: &str) -> io::Result<Value> {
    let items = library::items(data);
    let i = (items.iter())
        .find(|i| i["key"] == key && i["kind"] == "skill" && catalog::id(i).is_null())
        .ok_or_else(|| refuse("Only a skill you added shows in Finder."))?;
    let shown = crate::reveal(skill_md(data, i))?;
    match shown.success() {
        true => Ok(json!({"ok": true})),
        false => Err(refuse(&format!(
            "Couldn't show {} in Finder.",
            str(&i["name"])
        ))),
    }
}

/// Each session's project, when its proxy last noted a connect, and the servers it couldn't
/// reach then (`plugins/unreached.json`).
pub(super) fn unreached(data: &Path) -> Vec<(Option<String>, std::time::SystemTime, Vec<String>)> {
    let sessions = std::fs::read_dir(data.join("sessions"))
        .into_iter()
        .flatten()
        .flatten();
    sessions
        .filter_map(|s| {
            let file = s.path().join("plugins/unreached.json");
            let at = file.metadata().ok()?.modified().ok()?;
            let names = serde_json::from_slice(&std::fs::read(&file).ok()?).ok()?;
            let spec = brigadier_core::load(data, &s.file_name().to_string_lossy()).ok()?;
            Some((spec.project, at, names))
        })
        .collect()
}
