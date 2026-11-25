//! Its model list as `claude` itself answers `initialize` over stream-json, as the old app read it:
//! each model under its real name ("Opus 5.5"), with its effort levels, the `default` alias
//! folded into the model it runs, and older models of a family marked legacy; and its usage limits
//! as it answers `get_usage` in the same run, the old app's way [D28].

use super::super::setup::run_fed;
use super::super::{
    Check, Event, Limit, ModelInfo, base_env, home_path, iso_ms, mark_superseded, s,
};
use crate::Spec;
use serde_json::Value;
use std::path::Path;
use std::process::Command;
use std::sync::atomic::AtomicBool;

/// The jobs Claude's models seed, in the spec's order (D392 P1).
pub const SEEDS: &[super::super::Seed] = &[
    ("Write code", "opus", Some("high")),
    ("Look into the codebase", "sonnet", Some("low")),
    ("Plan and orchestrate", "fable", Some("high")),
    ("Quick actions", "haiku", Some("low")),
    ("Review", "opus", Some("high")),
];

/// Its models and usage; none where its list can't be read.
pub fn list(spec: &Spec, exe: &Path, cwd: &Path) -> Check {
    let (models, usage) = listed(spec, exe, cwd).unwrap_or_default();
    Check {
        models,
        usage,
        ..Check::default()
    }
}

/// Its own subagents can't run a model a rule bars: the allowlist, merged into the one `--settings`
/// object of `standing` (`deniedModels` is read from managed settings only); their effort can't
/// be set [D376].
pub fn bar(spec: &Spec, mut standing: Vec<String>) -> Vec<String> {
    let at = standing.iter().position(|a| a == "--settings");
    if let (Some(models), Some(at)) = (&spec.ruled.models, at) {
        let mut settings: Value = serde_json::from_str(&standing[at + 1]).unwrap_or_default();
        settings["availableModels"] = models.clone().into();
        standing[at + 1] = settings.to_string();
    }
    standing
}

type Listed = (Vec<ModelInfo>, Option<Vec<Limit>>);

/// A throwaway `claude` that answers `initialize` and `get_usage`, then ends at its input's end: no
/// settings, MCP servers or hooks loaded, and no session written.
fn listed(spec: &Spec, exe: &Path, cwd: &Path) -> Result<Listed, String> {
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
    let ask = concat!(
        r#"{"type":"control_request","request_id":"models","request":{"subtype":"initialize"}}"#,
        "\n",
        r#"{"type":"control_request","request_id":"usage","request":{"subtype":"get_usage","skip_behaviors":true}}"#,
        "\n"
    );
    let out = run_fed(&mut command, 30, &AtomicBool::new(false), Some(ask))?;
    let answers: Vec<Value> = String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .filter(|v| v["type"] == "control_response" && v["response"]["subtype"] == "success")
        .collect();
    let answer = |id: &str| answers.iter().find(|v| v["response"]["request_id"] == id);
    let said_usage = answer("usage");
    let answer = answer("models").ok_or("Claude didn't list its models")?;
    let listed = answer["response"]["response"]["models"].as_array().cloned();
    let settings: Value = std::fs::read(home_path(".claude/settings.json"))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();
    let mut models: Vec<(ModelInfo, String)> = (listed.iter().flatten())
        .filter_map(|m| info(m, &settings))
        .collect();
    // The `default` alias names the model run unpicked: a second row for a model already listed,
    // whose own row stays and takes the mark.
    if let Some(at) = models.iter().position(|(m, _)| m.id == "default") {
        let own = (models.iter()).position(|(m, r)| m.id != "default" && *r == models[at].1);
        models[own.unwrap_or(at)].0.default = true;
        if own.is_some() {
            models.remove(at);
        }
    }
    let usage = said_usage.map(|v| usage(&v["response"]["response"], &models));
    // Two rows under one name: the long-context one says so.
    let names: Vec<String> = models.iter().map(|(m, _)| m.name.clone()).collect();
    for (m, _) in &mut models {
        if names.iter().filter(|n| **n == m.name).count() > 1 && m.id.ends_with("[1m]") {
            m.name.push_str(" (1M)");
        }
    }
    let mut models: Vec<ModelInfo> = models.into_iter().map(|(m, _)| m).collect();
    mark_superseded(&mut models);
    Ok((models, usage))
}

/// Its `get_usage` answer's limits, the old app's reading: its `limits` list where it gives one (the
/// session, the week and a week scoped to one model), else the named windows `five_hour`,
/// `seven_day` and `seven_day_<family>`; nothing where it says limits aren't available.
fn usage(answer: &Value, list: &[(ModelInfo, String)]) -> Vec<Limit> {
    let rates = &answer["rate_limits"];
    if answer["rate_limits_available"] == false || rates.is_null() {
        return vec![];
    }
    let at = |r: &Value| r.as_str().and_then(iso_ms);
    let found = match rates["limits"].as_array() {
        Some(limits) => (limits.iter())
            .filter_map(|l| listed_limit(l, list))
            .collect(),
        None => (rates.as_object().into_iter().flatten())
            .filter_map(|(id, w)| {
                window(
                    id,
                    w["utilization"].as_f64()?,
                    at(&w["resets_at"]),
                    Some(list),
                )
            })
            .collect(),
    };
    Limit::ordered(found)
}

/// The windows a `rate_limit_event` names, its `unifiedWindows` (a share of 1, resets in seconds)
/// else its one `rateLimitType`. A window that meters one family is left to the next check, which
/// has the model list to say which ids it meters (shortcut: until a run's event carries that list).
fn reported(info: &Value) -> Vec<Limit> {
    let one = |w: &Value| Some((w["utilization"].as_f64()? * 100.0, w["resetsAt"].as_u64()?));
    let mut found: Vec<(String, f64, u64)> = (info["unifiedWindows"].as_object().into_iter())
        .flatten()
        .filter_map(|(id, w)| one(w).map(|(u, r)| (id.clone(), u, r)))
        .collect();
    if found.is_empty()
        && let (Some(id), Some((u, r))) = (info["rateLimitType"].as_str(), one(info))
    {
        found.push((id.into(), u, r));
    }
    let found = (found.into_iter())
        .filter_map(|(id, used, resets)| window(&id, used, Some(resets * 1000), None))
        .collect();
    Limit::ordered(found)
}

/// The family word of a model's name or id: "opus" in "Opus 5.5", "Claude Fable 5.1" or
/// "claude-opus-5-5[1m]".
fn family(name: &str) -> Option<String> {
    (name.split(|c: char| !c.is_ascii_alphanumeric()))
        .find(|w| w.chars().any(|c| c.is_ascii_alphabetic()) && !w.eq_ignore_ascii_case("claude"))
        .map(str::to_ascii_lowercase)
}

/// One entry of the `limits` list, if it's a window work waits on.
fn listed_limit(limit: &Value, list: &[(ModelInfo, String)]) -> Option<Limit> {
    let (used, resets, scope) = (
        limit["percent"].as_f64()?,
        limit["resets_at"].as_str().and_then(iso_ms),
        &limit["scope"],
    );
    let list = Some(list);
    match limit["kind"].as_str()? {
        "session" if scope.is_null() => window("five_hour", used, resets, list),
        "weekly_all" if scope.is_null() => window("seven_day", used, resets, list),
        "weekly_scoped" => {
            let model = &scope["model"];
            let family = family(model["display_name"].as_str().or(model["id"].as_str())?)?;
            window(&format!("seven_day_{family}"), used, resets, list)
        }
        _ => None,
    }
}

/// A named window: the 5-hour session, the week, or a week that meters one model family
/// (`seven_day_opus`), with the ids of `list` it meters; other entries (overage, extra usage)
/// aren't windows work waits on. With no list, a family's week is left out.
fn window(
    id: &str,
    used: f64,
    resets: Option<u64>,
    list: Option<&[(ModelInfo, String)]>,
) -> Option<Limit> {
    let family = id.strip_prefix("seven_day_").filter(|f| {
        !f.is_empty()
            && f.chars().all(|c| c.is_ascii_lowercase())
            && !matches!(*f, "overage" | "oauth")
    });
    let name = match (id, family) {
        ("five_hour", _) => "5-hour".to_string(),
        ("seven_day", _) => "Weekly".to_string(),
        (_, Some(f)) => format!("Weekly · {}{}", f[..1].to_ascii_uppercase(), &f[1..]),
        _ => return None,
    };
    let minutes = if id == "five_hour" {
        5 * 60
    } else {
        7 * 24 * 60
    };
    let models = match family {
        None => None,
        Some(f) => Some(
            (list?.iter())
                .filter(|(_, resolved)| self::family(resolved).as_deref() == Some(f))
                .map(|(m, _)| m.id.clone())
                .collect(),
        ),
    };
    Some(Limit {
        models,
        ..Limit::new(name, used, resets, Some(minutes), family.is_some())
    })
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

/// A limit hit, from its rate_limit_event: its reset time is in seconds [D74, D220]. Rejected while
/// extra usage still pays, the turn carries on.
pub fn rate_limit(info: &Value) -> Vec<Event> {
    let reported = reported(info);
    let mut events = match reported.is_empty() {
        true => vec![],
        false => vec![Event::Limits(reported)],
    };
    let overage = matches!(s(info, &["overageStatus"]), "allowed" | "allowed_warning");
    if info["status"] != "rejected" || overage {
        return events;
    }
    let words = match s(info, &["rateLimitType"]) {
        "five_hour" => "5-hour limit reached",
        t if t.starts_with("seven_day") => "Weekly limit reached",
        _ => "Usage limit reached",
    };
    events.push(Event::Limited(
        words.into(),
        info["resetsAt"].as_u64().map(|t| t * 1000),
    ));
    events
}
