//! The user's own MCP servers in Claude Code's config, for the relay [D100].

use crate::adapters::home_path;
use serde_json::Value;
use std::path::Path;

/// The user's MCP servers in its global config, user scope and this folder's local scope, read
/// only, the local first (code.claude.com/docs/en/mcp) [D100].
// shortcut: a project's `.mcp.json` and `${VAR}` in values aren't read; upgrade with the library (4.12).
pub fn mcp_servers(folder: &Path) -> Vec<Value> {
    let config = std::fs::read(home_path(".claude.json")).unwrap_or_default();
    let v: Value = serde_json::from_slice(&config).unwrap_or_default();
    let local = &v["projects"][folder.display().to_string()]["mcpServers"];
    let all = [local, &v["mcpServers"]].into_iter();
    (all.flat_map(|m| m.as_object().into_iter().flatten()))
        .map(|(name, d)| {
            let mut d = d.clone();
            d["name"] = name.as_str().into();
            d
        })
        .collect()
}
