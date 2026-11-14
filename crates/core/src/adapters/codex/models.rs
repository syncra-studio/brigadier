//! Requests to a short-lived app-server: Codex's own model list [D128, D129], `model/list` being its
//! documented list, paged, with each model's efforts; and its thread delete [D35].

use super::super::{Check, Failed, Limit, ModelInfo, Who, base_env, mark_superseded, versioned};
use crate::Spec;
use serde_json::{Value, json};
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::mpsc::channel;
use std::thread;
use std::time::{Duration, Instant};

/// The name Codex records as a thread's originator.
const CLIENT: &str = "brigadier";

/// One request's result, or the server's error message; the same for no answer in time.
type Call<'a> = &'a mut dyn FnMut(&str, Value) -> Result<Value, String>;

/// Runs `work` against an app-server of its own; None when it wouldn't start. Bounded to `secs` in all.
fn short_lived<T>(
    spec: &Spec,
    exe: &Path,
    cwd: &Path,
    secs: u64,
    work: impl FnOnce(Call) -> T,
) -> Option<T> {
    let mut child = Command::new(exe)
        .args(["app-server"])
        .env_clear()
        .envs(base_env(spec, exe, &[]))
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut server = child.stdin.take()?;
    let out = BufReader::new(child.stdout.take()?);
    let (tx, rx) = channel::<Value>();
    thread::spawn(move || {
        for v in out
            .lines()
            .map_while(Result::ok)
            .filter_map(|l| serde_json::from_str(&l).ok())
        {
            if tx.send(v).is_err() {
                break;
            }
        }
    });
    let deadline = Instant::now() + Duration::from_secs(secs);
    let mut id = 0_u64;
    let mut call = |method: &str, params: Value| -> Result<Value, String> {
        id += 1;
        writeln!(
            server,
            "{}",
            json!({"id": id, "method": method, "params": params})
        )
        .map_err(|e| e.to_string())?;
        loop {
            let late = || format!("Codex didn't answer {method}");
            let left = (deadline.checked_duration_since(Instant::now())).ok_or_else(late)?;
            let v = rx.recv_timeout(left).map_err(|_| late())?;
            if v["id"] != id || v.get("method").is_some() {
                continue;
            }
            return match v["error"]["message"].as_str() {
                Some(e) => Err(e.to_string()),
                None => v.get("result").cloned().ok_or_else(late),
            };
        }
    };
    let client = json!({"clientInfo": {"name": CLIENT, "version": env!("CARGO_PKG_VERSION")}});
    let done = call("initialize", client).ok().map(|_| work(&mut call));
    let _ = child.kill();
    let _ = child.wait();
    done
}

/// Its models, the default first, who is signed in (`account/read`, which hands out no token) and
/// its usage limits (`account/rateLimits/read`); None when the probe failed. Bounded to `secs` in all.
pub fn list(spec: &Spec, exe: &Path, cwd: &Path, secs: u64) -> Option<Check> {
    let found = short_lived(spec, exe, cwd, secs, |call| {
        let (mut models, mut cursor) = (vec![], Value::Null);
        loop {
            let page = call("model/list", json!({"cursor": cursor})).ok()?;
            models.extend(page["data"].as_array().cloned().unwrap_or_default());
            cursor = page["nextCursor"].clone();
            if cursor.is_null() {
                break;
            }
        }
        let account = call("account/read", json!({})).unwrap_or_default();
        let limits = call("account/rateLimits/read", Value::Null).ok();
        Some((models, account["account"].clone(), limits))
    });
    let (mut models, account, limits) = found??;
    models.sort_by_key(|m| m["isDefault"] != true);
    let mut models: Vec<ModelInfo> = models.iter().map(info).collect();
    mark_legacy(&mut models);
    let mut who = Who::read(&account, ["email", "planType", "workspaceName"]);
    who.plan = who.plan.as_deref().and_then(plan_name).map(Into::into);
    let usage = limits.as_ref().map(usage);
    Some(Check {
        models,
        who,
        usage,
        ..Check::default()
    })
}

/// The bucket for all its models; others meter one.
const MAIN: &str = "codex";

/// Its rate limits, the old app's reading: each bucket's primary and secondary window, the main
/// bucket's by name alone, another's with what it meters and the model id it names.
pub(super) fn usage(read: &Value) -> Vec<Limit> {
    let main = &read["rateLimits"];
    let buckets: Vec<(&str, &Value)> = match read["rateLimitsByLimitId"].as_object() {
        Some(by_id) if !by_id.is_empty() => by_id.iter().map(|(id, b)| (id.as_str(), b)).collect(),
        _ => vec![(main["limitId"].as_str().unwrap_or(MAIN), main)],
    };
    let mut found = vec![];
    for (id, bucket) in buckets {
        let what = (bucket["limitName"].as_str()).or(bucket["normalModelSlug"].as_str());
        for slot in ["primary", "secondary"] {
            let w = &bucket[slot];
            let Some(used) = w["usedPercent"].as_f64() else {
                continue;
            };
            let minutes = w["windowDurationMins"].as_u64();
            let label = match minutes {
                Some(300) => "5-hour".to_string(),
                Some(10_080) => "Weekly".to_string(),
                Some(m) if m % 1_440 == 0 => format!("{}-day", m / 1_440),
                Some(m) if m % 60 == 0 => format!("{}-hour", m / 60),
                Some(m) => format!("{m}-minute"),
                None => slot.to_string(),
            };
            let name = match id == MAIN {
                true => label,
                false => format!("{label} · {}", what.unwrap_or(id)),
            };
            let resets = w["resetsAt"].as_u64().map(|s| s * 1000);
            let models = (id != MAIN)
                .then(|| {
                    bucket["normalModelSlug"]
                        .as_str()
                        .map(|m| vec![m.to_string()])
                })
                .flatten();
            found.push(Limit {
                models,
                ..Limit::new(name, used, resets, minutes, id != MAIN)
            });
        }
    }
    Limit::ordered(found)
}

/// Marks legacy, beside what its list names an upgrade for, older namesakes and the models of an
/// older generation than the newest: Codex versions its lineup together.
fn mark_legacy(models: &mut [ModelInfo]) {
    mark_superseded(models);
    let generation = |m: &ModelInfo| versioned(&m.name).and_then(|(_, v)| v.first().copied());
    let newest = models.iter().filter_map(generation).max();
    for model in models.iter_mut() {
        if generation(model)
            .zip(newest)
            .is_some_and(|(own, newest)| own < newest)
        {
            model.legacy = true;
        }
    }
}

/// Its fast service tier, as `model/list` names it.
pub const FAST_TIER: &str = "priority";

/// Codex's own delete of a thread and the agents it spawned. Ok only on its word that they're gone:
/// done now, or one of its two "unknown thread" answers, given only with no row and no rollout left.
/// A spawned agent's row goes in the one transaction with its root's [D35, D244]. Anything else
/// keeps the session, to try again.
pub fn delete(spec: &Spec, exe: &Path, cwd: &Path, thread: &str) -> Result<(), String> {
    let done = short_lived(spec, exe, cwd, 30, |call| {
        call("thread/delete", json!({"threadId": thread}))
    });
    match done {
        Some(Ok(_)) => Ok(()),
        Some(Err(e)) if e.starts_with("thread not found") || e.starts_with("no rollout found") => {
            Ok(())
        }
        Some(Err(e)) => Err(format!("Codex couldn't delete thread {thread}: {e}")),
        None => Err(format!(
            "Codex's server didn't start, so thread {thread} can't be removed."
        )),
    }
}

/// A new thread holding `conv` up to its completed turn `turn`, inclusive; `conv` itself is left
/// as it was, so the same message can be rewound to again [D384]. No answer can't say it wasn't made.
pub fn fork(spec: &Spec, exe: &Path, cwd: &Path, conv: &str, turn: &str) -> Result<String, Failed> {
    let params = json!({"threadId": conv, "lastTurnId": turn, "excludeTurns": true});
    let made = short_lived(spec, exe, cwd, 30, |call| {
        call("thread/fork", params).map_err(|e| (e.starts_with("Codex didn't answer"), e))
    });
    match made {
        Some(Ok(v)) => (v["thread"]["id"].as_str().map(String::from))
            .ok_or_else(|| Failed::Uncertain("Codex's fork named no thread".into())),
        Some(Err((true, e))) => Err(Failed::Uncertain(e)),
        Some(Err((false, e))) => Err(Failed::Refused(e)),
        None => Err(Failed::Refused("Codex's server didn't start".into())),
    }
}

/// A fork that was never heard about goes, so nothing is left behind unrecorded [D35]. Only what
/// Brigadier forked goes: a fork made elsewhere isn't ours to delete. The original is untouched
/// either way; a list that fails, or names no originator, can leave one fork, which nothing resumes.
pub fn drop_fork(spec: &Spec, exe: &Path, cwd: &Path, conv: &str, resume: &str, at: u64) {
    let found = short_lived(spec, exe, cwd, 30, |call| {
        let page = call("thread/list", json!({"limit": 50})).ok()?;
        let made = (page["data"]
            .as_array()
            .cloned()
            .unwrap_or_default()
            .into_iter())
        .filter(|t| t["forkedFromId"] == conv && t["id"] != resume && t["originator"] == CLIENT)
        .filter(|t| t["createdAt"].as_u64().is_some_and(|s| s >= at / 1000));
        for thread in made {
            let _ = call("thread/delete", json!({"threadId": thread["id"]}));
        }
        Some(())
    });
    if found.flatten().is_none() {
        eprintln!("Codex: couldn't list threads to clear a fork of {conv}");
    }
}

/// The threads forked from `conv` that Brigadier made, on Codex's newest page.
pub fn forks(spec: &Spec, exe: &Path, cwd: &Path, conv: &str) -> Option<Vec<String>> {
    short_lived(spec, exe, cwd, 30, |call| {
        let page = call("thread/list", json!({"limit": 50})).ok()?;
        let all = page["data"].as_array()?.iter();
        let mine = all.filter(|t| t["forkedFromId"] == conv && t["originator"] == CLIENT);
        Some(
            mine.filter_map(|t| t["id"].as_str().map(String::from))
                .collect(),
        )
    })
    .flatten()
}

fn info(m: &Value) -> ModelInfo {
    let efforts = m["supportedReasoningEfforts"]
        .as_array()
        .into_iter()
        .flatten();
    ModelInfo {
        id: m["id"].as_str().unwrap_or("").into(),
        name: m["displayName"].as_str().unwrap_or("").into(),
        local: false,
        efforts: efforts
            .filter_map(|e| e["reasoningEffort"].as_str().map(String::from))
            .collect(),
        default_effort: m["defaultReasoningEffort"].as_str().map(String::from),
        images: (m["inputModalities"].as_array()).map(|i| i.iter().any(|m| m == "image")),
        fast: (m["serviceTiers"].as_array().into_iter().flatten())
            .find(|t| t["id"] == FAST_TIER)
            .map(|t| t["description"].as_str().unwrap_or("").into()),
        legacy: !m["upgrade"].is_null(),
        window: None,
        // Its list marks the default only: no top or small model [D2075].
        default: m["isDefault"] == true,
        top: false,
        small: false,
        // Its upgrade info: a move it advises, with a retirement time where it has one [D487].
        retiring: m["upgradeInfo"].as_object().map(|u| {
            let at = u.get("retirementAt").and_then(Value::as_u64);
            // A Unix time, in seconds unless it's already as large as milliseconds.
            let at = at.map(|t| if t < 100_000_000_000 { t * 1000 } else { t });
            json!({"at": at, "to": u.get("model")})
        }),
    }
}

/// Its plan as the old app named it; None for one it can't name (`unknown`).
fn plan_name(plan: &str) -> Option<&'static str> {
    Some(match plan {
        "free" => "Free",
        "go" => "Go",
        "plus" => "Plus",
        "pro" => "Pro",
        "prolite" => "Pro Lite",
        "promax" => "Pro Max",
        "team" => "Team",
        p if p.contains("business") => "Business",
        p if p.contains("ent") => "Enterprise",
        "edu" => "Edu",
        "edu_plus" => "Edu Plus",
        "edu_pro" => "Edu Pro",
        _ => return None,
    })
}
