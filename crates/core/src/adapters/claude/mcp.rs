//! The user's own MCP servers in Claude Code's config, for the relay [D100], and the library at
//! launch [D2043].

use crate::adapters::{files, home_path};
use crate::{Spec, library};
use serde_json::{Map, Value, json};
use std::io;
use std::path::{Path, PathBuf};

/// The user's MCP servers in its global config, user scope, this folder's local scope, its
/// `.mcp.json` and its plugins', read only, the local first (code.claude.com/docs/en/mcp) [D100];
/// each with its `source`, the file or plugin it comes from [D565].
// shortcut: `${VAR}` in values isn't expanded; upgrade when a relay call needs one.
pub fn mcp_servers(folder: &Path) -> Vec<Value> {
    let (config, mcp) = (home_path(".claude.json"), folder.join(".mcp.json"));
    let (v, project) = (read(&config), read(&mcp));
    let local = &v["projects"][folder.display().to_string()]["mcpServers"];
    let (config, mcp) = (config.display().to_string(), mcp.display().to_string());
    let all = [
        (local, &config),
        (&project["mcpServers"], &mcp),
        (&v["mcpServers"], &config),
    ];
    let mut found: Vec<Value> = (all.into_iter())
        .flat_map(|(m, from)| (m.as_object().into_iter().flatten()).map(move |s| (s, from)))
        .map(|((name, d), from)| {
            let mut d = d.clone();
            (d["name"], d["source"]) = (name.as_str().into(), from.as_str().into());
            d
        })
        .collect();
    found.extend(plugin_servers(folder));
    found
}

fn read(path: &Path) -> Value {
    serde_json::from_slice(&std::fs::read(path).unwrap_or_default()).unwrap_or_default()
}

/// Whether Claude Code has plugin `key` installed, at home or for a project [D608].
pub fn has_plugin(key: &str) -> bool {
    let installed = read(&home_path(".claude/plugins/installed_plugins.json"));
    installed["plugins"][key]
        .as_array()
        .is_some_and(|a| !a.is_empty())
}

/// Turns plugin `key` on, as `enabledPlugins` [D608]: in the user's settings for every project,
/// or in each folder's own local settings. A file that isn't JSON is left as it is.
pub fn plugin_on(key: &str, folders: Option<&[PathBuf]>) -> io::Result<()> {
    let files: Vec<PathBuf> = match folders {
        None => vec![home_path(".claude/settings.json")],
        Some(f) => (f.iter())
            .map(|f| f.join(".claude/settings.local.json"))
            .collect(),
    };
    for f in files {
        let text = std::fs::read(&f).unwrap_or_default();
        let bad = || io::Error::other(format!("{} isn't JSON Brigadier can change.", f.display()));
        let mut v: Value = match text.iter().all(u8::is_ascii_whitespace) {
            true => json!({}),
            false => serde_json::from_slice(&text).map_err(|_| bad())?,
        };
        let on = v.get("enabledPlugins").unwrap_or(&Value::Null);
        if !v.is_object() || !(on.is_object() || on.is_null()) {
            return Err(bad());
        }
        v["enabledPlugins"][key] = true.into();
        std::fs::create_dir_all(f.parent().unwrap_or(Path::new(".")))?;
        // Through a link to the file the link points at, so a dotfiles link stays one.
        let to = std::fs::canonicalize(&f).unwrap_or(f);
        crate::write_atomic(&to, format!("{v:#}\n").as_bytes())?;
    }
    Ok(())
}

/// The servers of each plugin on in this folder, the last of the user's, the project's and its
/// local `enabledPlugins` winning, named as Claude names them, `plugin:<plugin>:<server>`
/// (code.claude.com/docs/en/plugins-reference) [D565].
fn plugin_servers(folder: &Path) -> Vec<Value> {
    let settings = [
        home_path(".claude/settings.json"),
        folder.join(".claude/settings.json"),
        folder.join(".claude/settings.local.json"),
    ];
    let mut on = Map::new();
    for f in settings.iter().map(|f| read(f)) {
        on.extend(f["enabledPlugins"].as_object().cloned().unwrap_or_default());
    }
    let installed = read(&home_path(".claude/plugins/installed_plugins.json"));
    let mut all = vec![];
    for (key, _) in on.iter().filter(|(_, v)| **v == true) {
        let installs = installed["plugins"][key].as_array().cloned();
        let installs = installs.unwrap_or_default();
        let here = (installs.iter()).find(|i| i["projectPath"].as_str() == folder.to_str());
        if let Some(root) = here
            .or(installs.first())
            .and_then(|i| i["installPath"].as_str())
        {
            let (manifest, var) = (".claude-plugin/plugin.json", Some("${CLAUDE_PLUGIN_ROOT}"));
            all.extend(files::plugin_servers(Path::new(root), manifest, key, var));
        }
    }
    all
}

/// The servers of Claude Code's Slack plugin when it's on in the worker's project, under the
/// plugin's own names, so Claude uses the sign-in it keeps for them: the one exception to naked
/// workers, as `--strict-mcp-config` connects no plugin servers [D586].
fn slack(cwd: &Path) -> Map<String, Value> {
    let root = crate::projects::root(cwd).unwrap_or_else(|| cwd.into());
    (plugin_servers(&root).into_iter())
        .filter(|s| s["source"] == "plugin slack@claude-plugins-official")
        .filter_map(|mut s| {
            let o = s.as_object_mut()?;
            o.remove("source");
            let name = o.remove("name")?.as_str()?.to_string();
            Some((name, s))
        })
        .collect()
}

/// A worker's servers that only Claude signs in to: its own, a plugin's or its settings', that the
/// library holds as signed in by each agent and on for the worker's project, under their own
/// names so Claude uses the sign-in it keeps. The relay can't reach these, so a worker has them
/// from its CLI: Slack's rule [D586], for every such server (owner, 2026-11-25).
fn held(spec: &Spec, cwd: &Path) -> Map<String, Value> {
    let root = crate::projects::root(cwd).unwrap_or_else(|| cwd.into());
    let items = library::on_for(&crate::data_of(spec), spec.project.as_deref());
    let items: Vec<&Value> = items.iter().filter(|i| i["sign_in"] == "cli").collect();
    let own = mcp_servers(&root);
    let mut all = Map::new();
    for mut s in own
        .iter()
        .filter(|s| items.iter().any(|i| library::same(s, i)))
        .cloned()
    {
        let name = s["name"].as_str().unwrap_or("").to_string();
        if let Some(o) = s.as_object_mut() {
            o.remove("source");
            o.remove("name");
        }
        // The first of a name, the local one, as Claude takes it.
        all.entry(name).or_insert(s);
    }
    // One only the library has, as its lead has it.
    for i in items
        .iter()
        .filter(|i| !own.iter().any(|s| library::same(s, i)))
    {
        let name = library::named(i["name"].as_str().unwrap_or(""));
        all.insert(name, json!({"type": "http", "url": i["url"]}));
    }
    all
}

/// A worker's launch is naked [D89]; any other gets the library.
pub fn launch(spec: &Spec, argv: &mut Vec<String>, env: &mut Vec<(String, String)>) {
    let cwd = Path::new(&spec.cwd);
    if spec.naked {
        // A worker's, not the message writer's (its own folder) or the queue's judge's (no tools).
        let worker = spec.dir == crate::session_dir(&crate::data_of(spec), &spec.id)
            && !spec.opts.contains_key("no_tools");
        let servers = if worker { held(spec, cwd) } else { Map::new() };
        return super::control::naked(argv, servers);
    }
    let mut off = library(spec, cwd, argv, env);
    let (data, project) = (crate::data_of(spec), spec.project.as_deref());
    off.extend(library::own_off(&data, project, &mcp_servers(cwd)));
    // Its own skills the library holds off here: `skillOverrides` (code.claude.com/docs/en/skills),
    // which a plugin's skill doesn't take.
    let hidden = library::hidden(&data, project);
    let skills: Map<String, Value> = (super::commands::fixed(Some(cwd), Some(spec)).iter())
        .filter(|k| hidden.has(k))
        .filter_map(|k| Some((k["name"].as_str()?.to_string(), "off".into())))
        .collect();
    // Claude Code drops its Slack plugin's server for a claude.ai Slack connector at the same
    // address, even one not signed in; the plugin is the Slack Brigadier uses [D586, D768].
    if !slack(cwd).is_empty() {
        off.push("claude.ai Slack".into());
    }
    let denied: Vec<Value> = (off.iter()).map(|n| json!({ "serverName": n })).collect();
    let at = argv.iter().rposition(|a| a == "--settings");
    if let (false, Some(at)) = (denied.is_empty() && skills.is_empty(), at) {
        let mut settings: Value = serde_json::from_str(&argv[at + 1]).unwrap_or_default();
        if !denied.is_empty() {
            settings["deniedMcpServers"] = denied.into();
        }
        if !skills.is_empty() {
            settings["skillOverrides"] = skills.into();
        }
        argv[at + 1] = settings.to_string();
    }
}

/// The library at launch; the names of the user's own servers it turns off.
fn library(
    spec: &Spec,
    cwd: &Path,
    argv: &mut Vec<String>,
    env: &mut Vec<(String, String)>,
) -> Vec<String> {
    // Its own skill of a library skill's name wins, and no flag turns only that one off: the
    // library's isn't linked [D415].
    let own: Vec<String> = (super::commands::fixed(Some(cwd), Some(spec)).into_iter())
        .filter(|k| k["kind"] == "skill")
        .filter_map(|k| k["name"].as_str().map(String::from))
        .collect();
    let Some(kit) = library::kit(spec, &own) else {
        return vec![];
    };
    argv.extend(["--add-dir".into(), kit.dir.display().to_string()]);
    // Its own copy of each goes off for this session by name, the user's others untouched [D407].
    let (given, off) = library::split(&kit.servers, &mcp_servers(cwd));
    // Each secret reaches its server through a variable of Claude's own env, never the file.
    let mut servers = Map::new();
    for (i, s) in given.iter().enumerate() {
        let name = library::named(s["name"].as_str().unwrap_or(""));
        // The proxy's bearer as it is: Claude empties a credential-looking `${VAR}` in a remote
        // server's headers (w07 §2); it opens only this session's proxy.
        if s["to"].is_string() {
            servers.insert(
                name,
                json!({"type": "http", "url": s["to"], "headers": s["headers"]}),
            );
            continue;
        }
        let mut vars = Map::new();
        for (k, v) in s["env"].as_object().into_iter().flatten() {
            let var = format!("BRIGADIER_MCP_{i}_{k}");
            env.push((var.clone(), v.as_str().unwrap_or("").into()));
            vars.insert(k.clone(), format!("${{{var}}}").into());
        }
        servers.insert(
            name,
            json!({"command": s["command"], "args": s["args"], "env": vars}),
        );
    }
    let file = kit.dir.join("mcp.json");
    let wrote = std::fs::write(&file, json!({ "mcpServers": servers }).to_string());
    if servers.is_empty() || wrote.is_err() {
        return vec![];
    }
    argv.extend(["--mcp-config".into(), file.display().to_string()]);
    off
}
