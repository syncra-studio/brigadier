//! The user's own MCP servers in Claude Code's config, for the relay [D100], and the library at
//! launch [D2043].

use crate::adapters::home_path;
use crate::{Spec, library};
use serde_json::{Map, Value, json};
use std::path::Path;

/// The user's MCP servers in its global config, user scope, this folder's local scope and its
/// `.mcp.json`, read only, the local first (code.claude.com/docs/en/mcp) [D100].
// shortcut: `${VAR}` in values isn't expanded; upgrade when a relay call needs one.
pub fn mcp_servers(folder: &Path) -> Vec<Value> {
    let read = |path: &Path| -> Value {
        serde_json::from_slice(&std::fs::read(path).unwrap_or_default()).unwrap_or_default()
    };
    let (v, project) = (
        read(&home_path(".claude.json")),
        read(&folder.join(".mcp.json")),
    );
    let local = &v["projects"][folder.display().to_string()]["mcpServers"];
    let all = [local, &project["mcpServers"], &v["mcpServers"]].into_iter();
    (all.flat_map(|m| m.as_object().into_iter().flatten()))
        .map(|(name, d)| {
            let mut d = d.clone();
            d["name"] = name.as_str().into();
            d
        })
        .collect()
}

/// A worker's launch is naked [D89]; any other gets the library.
pub fn launch(spec: &Spec, argv: &mut Vec<String>, env: &mut Vec<(String, String)>) {
    if spec.naked {
        return super::control::naked(argv, env);
    }
    // Its own skill of a library skill's name wins, and no flag turns only that one off: the
    // library's isn't linked [D415].
    let cwd = Path::new(&spec.cwd);
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
