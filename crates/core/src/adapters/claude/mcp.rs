//! The user's own MCP servers in Claude Code's config, for the relay [D100], and the library at
//! launch [D2043].

use crate::adapters::{files, home_path};
use crate::{Spec, library};
use serde_json::{Map, Value, json};
use std::path::Path;

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

/// A worker's launch is naked [D89]; any other gets the library.
pub fn launch(spec: &Spec, argv: &mut Vec<String>, env: &mut Vec<(String, String)>) {
    let cwd = Path::new(&spec.cwd);
    if spec.naked {
        return super::control::naked(argv, slack(cwd));
    }
    // Its own skill of a library skill's name wins, and no flag turns only that one off: the
    // library's isn't linked [D415].
    let own: Vec<String> = (super::commands::fixed(Some(cwd), Some(spec)).into_iter())
        .filter(|k| k["kind"] == "skill")
        .filter_map(|k| k["name"].as_str().map(String::from))
        .collect();
    let Some(kit) = library::kit(spec, &own) else {
        return;
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
        return;
    }
    argv.extend(["--mcp-config".into(), file.display().to_string()]);
    let denied: Vec<Value> = (off.iter()).map(|n| json!({ "serverName": n })).collect();
    let at = argv.iter().rposition(|a| a == "--settings");
    if let (false, Some(at)) = (denied.is_empty(), at) {
        let mut settings: Value = serde_json::from_str(&argv[at + 1]).unwrap_or_default();
        settings["deniedMcpServers"] = denied.into();
        argv[at + 1] = settings.to_string();
    }
}
