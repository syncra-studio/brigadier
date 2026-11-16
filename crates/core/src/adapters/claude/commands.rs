//! Claude Code's own commands and skills, from its init line and its folders [D164, D2098].

use super::super::{Event, cli_home, home_path, s};
use crate::Spec;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

/// Its own commands, from its init line: skills and MCP prompts by name, the rest as commands, less
/// those bound to its terminal; none runs at once, each is sent as text [D164, D2009]. The line
/// names no files: `locate` finds them, knowing the account [D2098].
pub fn commands(v: &Value) -> Option<Event> {
    let names = |key: &str| -> Vec<&str> {
        (v[key].as_array().into_iter().flatten())
            .filter_map(Value::as_str)
            .collect()
    };
    let (skills, terminal) = (names("skills"), names("terminal_slash_commands"));
    let listed = names("slash_commands");
    let unlisted = skills
        .iter()
        .filter(|name| !listed.contains(name))
        .copied()
        .collect::<Vec<_>>();
    let list = (listed.iter().chain(&unlisted))
        .copied()
        .filter(|name| !terminal.contains(name));
    let list = list.map(|name| {
        let kind = if skills.contains(&name) {
            "skill"
        } else if name.starts_with("mcp__") {
            "mcp"
        } else {
            "command"
        };
        json!({"name": name, "description": "", "kind": kind, "path": null, "instant": false})
    });
    v["slash_commands"]
        .is_array()
        .then(|| Event::Commands(list.collect()))
}

/// Where it keeps skills and commands, in the old app's order: the project's `.claude`, then the
/// account's home (its CLAUDE_CONFIG_DIR), else ~/.claude (registry skills.rs, plugins/resolve.rs) [D2098].
fn roots(cwd: Option<&Path>, run: Option<&Spec>) -> Vec<PathBuf> {
    let home = run.map_or_else(
        || home_path(".claude"),
        |spec| cli_home(spec, ".claude", ""),
    );
    cwd.map(|cwd| cwd.join(".claude"))
        .into_iter()
        .chain([home])
        .collect()
}

/// A skill's or command's file under the first root holding it.
fn file_of(roots: &[PathBuf], kind: &str, name: &str) -> Option<PathBuf> {
    let rest = match kind {
        "skill" => format!("skills/{name}/SKILL.md"),
        "command" => format!("commands/{name}.md"),
        _ => return None,
    };
    roots
        .iter()
        .map(|root| root.join(&rest))
        .find(|path| path.is_file())
}

/// Each listed skill's or command's file, the project's before the account's.
pub fn locate(run: &Spec, list: &mut [Value]) {
    let roots = roots(Some(Path::new(&run.cwd)), Some(run));
    for each in list {
        if let Some(path) = file_of(&roots, s(each, &["kind"]), s(each, &["name"])) {
            each["path"] = json!(path);
        }
    }
}

/// Before its first init line: the old app's builtin commands, then the commands and skills its
/// folders hold, each by name once, as the old app scanned them [D2098].
pub fn fixed(cwd: Option<&Path>, run: Option<&Spec>) -> Vec<Value> {
    let builtin = [
        ("compact", "Compact this conversation"),
        ("context", "Show context usage"),
        ("cost", "Show session usage"),
        ("help", "Show Claude Code help"),
    ];
    let mut list: Vec<Value> = (builtin.iter())
        .map(|(name, description)| json!({"name": name, "description": description, "kind": "command", "path": null, "instant": false}))
        .collect();
    let roots = roots(cwd, run);
    for (kind, folder) in [("command", "commands"), ("skill", "skills")] {
        let mut names: Vec<String> = (roots.iter())
            .flat_map(|root| {
                std::fs::read_dir(root.join(folder))
                    .into_iter()
                    .flatten()
                    .flatten()
            })
            .filter_map(|entry| {
                let name = entry.file_name().to_string_lossy().to_string();
                match kind {
                    "skill" => entry.path().join("SKILL.md").is_file().then_some(name),
                    _ => name.strip_suffix(".md").map(String::from),
                }
            })
            .collect();
        names.sort();
        names.dedup();
        for name in names {
            if list.iter().any(|l| l["name"] == *name) {
                continue;
            }
            let path = file_of(&roots, kind, &name);
            list.push(json!({"name": name, "description": "", "kind": kind, "path": path, "instant": false}));
        }
    }
    // shortcut: only user-scope plugins, as `plugin:skill`; a project-scope one's enabling isn't read.
    let home = run.map_or_else(|| home_path(".claude"), |s| cli_home(s, ".claude", ""));
    let installed = std::fs::read(home.join("plugins/installed_plugins.json")).unwrap_or_default();
    let installed: Value = serde_json::from_slice(&installed).unwrap_or_default();
    let plugins =
        (installed["plugins"].as_object().into_iter().flatten()).flat_map(|(key, all)| {
            let at = (all.as_array().into_iter().flatten()).find(|i| i["scope"] == "user");
            let name = key.split('@').next().unwrap_or(key);
            at.map(|i| {
                (
                    PathBuf::from(s(i, &["installPath"])).join("skills"),
                    format!("{name}:"),
                )
            })
        });
    for more in super::super::files::skills_in(plugins.collect::<Vec<_>>()) {
        if !list.iter().any(|l| l["name"] == more["name"]) {
            list.push(more);
        }
    }
    list
}
