//! What `claude update` would install, as the old app read it: npm's version on its release
//! channel, within what its settings allow.

use crate::adapters::home_path;
use crate::adapters::setup::{newer, npm_latest};
use serde_json::Value;
use std::path::PathBuf;

/// Managed settings first, then the user's: the channel (`autoUpdatesChannel`, "stable" or
/// "latest"); none where `DISABLE_UPDATES` turns updates off or `requiredMaximumVersion` caps them
/// below it.
pub(super) fn latest() -> Option<String> {
    let read = |path: PathBuf| -> Value {
        let bytes = std::fs::read(path).unwrap_or_default();
        serde_json::from_slice(&bytes).unwrap_or_default()
    };
    let managed = read("/Library/Application Support/ClaudeCode/managed-settings.json".into());
    let both = [managed, read(home_path(".claude/settings.json"))];
    let off = |v: &Value| {
        v["env"]["DISABLE_UPDATES"]
            .as_str()
            .is_some_and(|v| !matches!(v, "" | "0" | "false"))
    };
    if both.iter().any(off) {
        return None;
    }
    let tag = match both.iter().find_map(|v| v["autoUpdatesChannel"].as_str()) {
        Some("stable") => "stable",
        _ => "latest",
    };
    let latest = npm_latest("@anthropic-ai/claude-code", tag)?;
    let cap = both[0]["requiredMaximumVersion"].as_str();
    (!cap.is_some_and(|max| newer(&latest, max))).then_some(latest)
}
