//! Its model list as `claude` itself answers `initialize` over stream-json, as the old app read it:
//! each model under its real name ("Opus 5.5"), with its effort levels, the `default` alias
//! folded into the model it runs, and older models of a family marked legacy; and its usage limits
//! as it answers `get_usage` in the same run, the old app's way [D28].

use super::super::{
    Check, Event, Limit, ModelInfo, Who, base_env, home_path, iso_ms, mark_superseded, s,
};
use super::commands;
use crate::Spec;
use serde_json::{Value, json};
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::mpsc::channel;
use std::thread;
use std::time::{Duration, Instant};

/// The jobs Claude's models seed, in the spec's order (D392 P1).
pub const SEEDS: &[super::super::Seed] = &[
    ("Write code", "opus", Some("high")),
    ("Look into the codebase", "sonnet", Some("low")),
    ("Plan and orchestrate", "fable", Some("high")),
    ("Quick actions", "haiku", Some("low")),
    ("Review", "opus", Some("high")),
];

/// Its models, usage and plan; none where its list can't be read.
pub fn list(spec: &Spec, exe: &Path, cwd: &Path) -> Check {
    listed(spec, exe, cwd).unwrap_or_default()
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

/// A throwaway `claude` that answers control requests, one at a time: no settings, MCP servers or
/// hooks loaded, and no session written. Bounded to 30 s in all.
fn asked<T>(
    spec: &Spec,
    exe: &Path,
    cwd: &Path,
    work: impl FnOnce(&mut dyn FnMut(Value) -> Result<Value, String>) -> Result<T, String>,
) -> Result<T, String> {
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
    let mut child = Command::new(exe)
        .args(args)
        .env_clear()
        .envs(base_env(spec, exe, &[]))
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| e.to_string())?;
    let (stdin, out) = (child.stdin.take(), child.stdout.take());
    let (tx, rx) = channel::<Value>();
    thread::spawn(move || {
        let lines = out.map(BufReader::new).into_iter().flat_map(|r| r.lines());
        for v in (lines.map_while(Result::ok)).filter_map(|l| serde_json::from_str(&l).ok()) {
            if tx.send(v).is_err() {
                break;
            }
        }
    });
    let deadline = Instant::now() + Duration::from_secs(30);
    let mut id = 0_u64;
    let mut stdin = stdin.ok_or("no stdin")?;
    let mut ask = |request: Value| -> Result<Value, String> {
        id += 1;
        let (id, what) = (id.to_string(), s(&request, &["subtype"]).to_string());
        let line = json!({"type": "control_request", "request_id": id, "request": request});
        writeln!(stdin, "{line}").map_err(|e| e.to_string())?;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            let v = (rx.recv_timeout(left)).map_err(|_| format!("Claude didn't answer {what}"))?;
            let r = &v["response"];
            if v["type"] == "control_response" && r["request_id"] == id.as_str() {
                return match r["subtype"] == "success" {
                    true => Ok(r["response"].clone()),
                    false => Err(s(r, &["error"]).to_string()),
                };
            }
        }
    };
    let done = work(&mut ask);
    let _ = child.kill();
    let _ = child.wait();
    done
}

fn listed(spec: &Spec, exe: &Path, cwd: &Path) -> Result<Check, String> {
    let (answer, usage, efforts) = asked(spec, exe, cwd, |ask| {
        let answer = ask(json!({"subtype": "initialize"}))?;
        let usage = ask(json!({"subtype": "get_usage", "skip_behaviors": true})).ok();
        // The effort it runs each at with none asked for, as it says it applies; none where it doesn't.
        let mut efforts = std::collections::HashMap::new();
        for id in (answer["models"].as_array().into_iter().flatten())
            .filter(|m| m["supportsEffort"] == true)
            .filter_map(|m| m["value"].as_str())
        {
            if ask(json!({"subtype": "set_model", "model": id})).is_err() {
                continue;
            }
            match ask(json!({"subtype": "get_settings"})) {
                Ok(v) => efforts.insert(id.to_string(), s(&v, &["applied", "effort"]).to_string()),
                Err(_) => break,
            };
        }
        Ok((answer, usage, efforts))
    })?;
    commands::keep(&answer["commands"]);
    let listed = answer["models"].as_array();
    let settings: Value = std::fs::read(home_path(".claude/settings.json"))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();
    // Auto is said per model, where the CLI says it at all.
    let says = (listed.into_iter().flatten()).any(|m| m["supportsAutoMode"].is_boolean());
    let mut models: Vec<(ModelInfo, String)> = (listed.into_iter().flatten())
        .filter_map(|m| {
            let (mut info, resolved) = info(m, &settings, &efforts)?;
            info.auto = says.then(|| m["supportsAutoMode"] == true);
            Some((info, resolved))
        })
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
    let usage = usage.and_then(|v| self::usage(&v, &models));
    // Two rows under one name: the long-context one says so.
    let names: Vec<String> = models.iter().map(|(m, _)| m.name.clone()).collect();
    for (m, _) in &mut models {
        if names.iter().filter(|n| **n == m.name).count() > 1 && m.id.ends_with("[1m]") {
            m.name.push_str(" (1M)");
        }
    }
    let mut models: Vec<ModelInfo> = models.into_iter().map(|(m, _)| m).collect();
    mark_superseded(&mut models);
    let plan = s(&answer, &["account", "subscriptionType"]);
    let plan = plan.strip_prefix("Claude ").unwrap_or(plan);
    Ok(Check {
        models,
        usage,
        who: Who {
            plan: (!plan.is_empty()).then(|| plan.into()),
            ..Who::default()
        },
        ..Check::default()
    })
}

/// Its `get_usage` answer's limits, the old app's reading: its `limits` list where it gives one (the
/// session, the week and a week scoped to one model), else the named windows `five_hour`,
/// `seven_day` and `seven_day_<family>`; none where it says limits aren't available, None unread.
fn usage(answer: &Value, list: &[(ModelInfo, String)]) -> Option<Vec<Limit>> {
    let rates = &answer["rate_limits"];
    if answer["rate_limits_available"] == false {
        return Some(vec![]);
    }
    if rates.is_null() {
        return None;
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
    Some(Limit::ordered(found))
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

/// One entry of the `limits` list.
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
        kind => Some(other(kind, used, resets, scope)),
    }
}

/// A limit of a kind not known here, by its own words ("monthly_all" → "Monthly"): for every model,
/// or, scoped to something else (a surface), only shown.
fn other(kind: &str, used: f64, resets: Option<u64>, scope: &Value) -> Limit {
    let words = kind.split('_').filter(|w| !matches!(*w, "all" | "scoped"));
    let mut name = words.collect::<Vec<_>>().join(" ");
    if let Some(first) = name.get_mut(..1) {
        first.make_ascii_uppercase();
    }
    let minutes = match kind.split('_').next() {
        Some("daily") => Some(24 * 60),
        Some("weekly") => Some(7 * 24 * 60),
        Some("monthly") => Some(30 * 24 * 60),
        _ => None,
    };
    Limit {
        models: (!scope.is_null()).then(Vec::new),
        ..Limit::new(name, used, resets, minutes, !scope.is_null())
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

/// A model and the one its alias resolves to; `applied`: the effort it runs each at unasked.
fn info(
    m: &Value,
    settings: &Value,
    applied: &std::collections::HashMap<String, String>,
) -> Option<(ModelInfo, String)> {
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
        default_effort: settings_effort(settings, &resolved, &efforts)
            .or(applied.get(id).filter(|e| efforts.contains(e)).cloned()),
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

/// The effort the user's `settings.json` has `claude` run a model at: its `modelSettings` entry, then
/// the global `effortLevel`, each only if the model takes it.
fn settings_effort(settings: &Value, resolved: &str, efforts: &[String]) -> Option<String> {
    let taken = |l: &&str| efforts.iter().any(|e| e == l);
    let bare = resolved.strip_suffix("[1m]").unwrap_or(resolved);
    let own = settings["modelSettings"][bare]["effortLevel"].as_str();
    (own.filter(taken))
        .or(settings["effortLevel"].as_str().filter(taken))
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
