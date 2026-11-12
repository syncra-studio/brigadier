//! Its model list as `claude` itself answers `initialize` over stream-json, as the old app read it:
//! each model under its real name ("Opus 5.5"), with its effort levels, the `default` alias
//! folded into the model it runs, and older models of a family marked legacy.

use super::super::setup::run_fed;
use super::super::{ModelInfo, base_env, home_path, mark_superseded};
use crate::Spec;
use serde_json::Value;
use std::path::Path;
use std::process::Command;
use std::sync::atomic::AtomicBool;

/// Its models; where its list can't be read, its aliases by id.
pub fn list(spec: &Spec, exe: &Path, cwd: &Path) -> Vec<ModelInfo> {
    listed(spec, exe, cwd).unwrap_or_else(|_| {
        (["sonnet", "opus", "haiku"].map(|m| ModelInfo::plain(m, false))).into()
    })
}

/// A throwaway `claude` that answers `initialize`, then ends at its input's end: no settings, MCP
/// servers or hooks loaded, and no session written.
fn listed(spec: &Spec, exe: &Path, cwd: &Path) -> Result<Vec<ModelInfo>, String> {
    let args = [
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--no-session-persistence",
        "--exclude-dynamic-system-prompt-sections",
        "--strict-mcp-config",
        "--mcp-config",
        r#"{"mcpServers":{}}"#,
        "--setting-sources",
        "",
        "--settings",
        r#"{"autoMemoryEnabled":false,"disableAllHooks":true}"#,
    ];
    let mut command = Command::new(exe);
    command
        .args(args)
        .env_clear()
        .envs(base_env(spec, exe, &[]))
        .current_dir(cwd);
    let ask =
        r#"{"type":"control_request","request_id":"models","request":{"subtype":"initialize"}}"#;
    let out = run_fed(
        &mut command,
        30,
        &AtomicBool::new(false),
        Some(&format!("{ask}\n")),
    )?;
    let answer = String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .find(|v| v["type"] == "control_response" && v["response"]["request_id"] == "models")
        .ok_or("Claude didn't list its models")?;
    let listed = answer["response"]["response"]["models"].as_array().cloned();
    let settings: Value = std::fs::read(home_path(".claude/settings.json"))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();
    let mut models: Vec<(ModelInfo, String)> = (listed.iter().flatten())
        .filter_map(|m| info(m, &settings))
        .collect();
    // The `default` alias is a second row for a model already listed: the model's own row stays.
    if let Some(at) = models.iter().position(|(m, _)| m.id == "default")
        && (models.iter()).any(|(m, r)| m.id != "default" && *r == models[at].1)
    {
        models.remove(at);
    }
    // Two rows under one name: the long-context one says so.
    let names: Vec<String> = models.iter().map(|(m, _)| m.name.clone()).collect();
    for (m, _) in &mut models {
        if names.iter().filter(|n| **n == m.name).count() > 1 && m.id.ends_with("[1m]") {
            m.name.push_str(" (1M)");
        }
    }
    let mut models: Vec<ModelInfo> = models.into_iter().map(|(m, _)| m).collect();
    mark_superseded(&mut models);
    Ok(models)
}

/// A model and the one its alias resolves to.
fn info(m: &Value, settings: &Value) -> Option<(ModelInfo, String)> {
    let id = m["value"].as_str()?;
    let resolved = m["resolvedModel"].as_str().unwrap_or(id).to_string();
    let efforts: Vec<String> = (m["supportedEffortLevels"].as_array().into_iter().flatten())
        .filter_map(|e| e.as_str().map(String::from))
        .collect();
    let name = real_name(
        m["displayName"].as_str().unwrap_or(id),
        m["description"].as_str().unwrap_or(""),
    );
    let info = ModelInfo {
        name,
        default_effort: settings_effort(settings, &resolved, &efforts),
        efforts,
        ..ModelInfo::plain(id, false)
    };
    Some((info, resolved))
}

/// "Opus 5.5" from a description such as "Opus 5.5 with 1M context · Best for everyday tasks";
/// the CLI's display name where the description doesn't start with one ("Default (recommended)").
fn real_name(display: &str, description: &str) -> String {
    let lead = description.split(" · ").next().unwrap_or_default();
    let name = lead.split(" with ").next().unwrap_or_default().trim();
    let named = name.split_whitespace().count() <= 3
        && name.chars().next().is_some_and(char::is_uppercase)
        && name.chars().any(|c| c.is_ascii_digit());
    if named { name } else { display }.to_string()
}

/// The effort `claude` runs a model at: its `modelSettings` entry in the user's `settings.json`,
/// then the global `effortLevel`, each kept only if the model takes it; else High, else its
/// highest.
fn settings_effort(settings: &Value, resolved: &str, efforts: &[String]) -> Option<String> {
    let taken = |l: &&str| efforts.iter().any(|e| e == l);
    let bare = resolved.strip_suffix("[1m]").unwrap_or(resolved);
    let own = settings["modelSettings"][bare]["effortLevel"].as_str();
    (own.filter(taken))
        .or(settings["effortLevel"].as_str().filter(taken))
        .or(Some("high").filter(taken))
        .or(efforts.last().map(String::as_str))
        .map(String::from)
}
