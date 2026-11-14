//! Settings › Routing [D2037, D338, D339, D341]: three rows (Best, Standard, Quick), each an
//! ordered list of agent · model · effort, and the user's exact rules; and the resolver that picks
//! a worker's model and account from them, kept for its life [D2037, D2040, D2041]. A row out of
//! quota holds the worker for the user's call [D2028, D342].

use crate::accounts::{self, accounts_of, listed};
use crate::workers::{self, row::clock};
use crate::{models, owner, settings, usage};
use brigadier_core::{self as core, Spec, adapters, fold::Fold};
use brigadier_frames::log;
use serde_json::{Map, Value, json};
use std::fs::{self, OpenOptions};
use std::io;
use std::path::Path;

mod hold;
mod pick;
mod retry;

pub(crate) use hold::{ask, moved, stopped, stops};
pub(crate) use pick::{next, receipt, resolve};
pub(crate) use retry::plan as retry;

pub(crate) const ROWS: [&str; 3] = ["best", "standard", "quick"];
const FILE: &str = "routing.json";
const RESERVED: &str = "reservations.json";
/// How long a hold with no known reset waits: the shortest plan window (proposed, as D51's).
const SKIP_MS: u64 = 5 * 3600 * 1000;

fn read(path: &Path) -> Value {
    fs::read(path)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

fn str_of<'a>(v: &'a Value, k: &str) -> &'a str {
    v[k].as_str().unwrap_or("")
}

/// Whether Settings › Routing's Adversarial review is on [D3026, C4].
pub(crate) fn review_on(data: &Path) -> bool {
    read(&data.join(FILE))["review"] == true
}

/// "Best", "Standard", "Quick".
pub(crate) fn title(row: &str) -> String {
    let mut c = row.chars();
    c.next()
        .map_or(String::new(), |f| f.to_uppercase().chain(c).collect())
}

/// One lock over the data dir for every pick and the table's change.
fn lock(data: &Path) -> io::Result<fs::File> {
    fs::create_dir_all(data)?;
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(data.join("routing.lock"))?;
    file.lock()?;
    Ok(file)
}

/// The agents and models the user lets work run on: on, installed, set up, none hidden [D2079,
/// D2082]; in `me`'s folder where given.
fn groups(data: &Path, me: Option<&str>) -> Vec<Value> {
    let of = |args: &[String]| {
        models::run(data, args).map_or(vec![], |r| {
            r["groups"].as_array().cloned().unwrap_or_default()
        })
    };
    let home = of(&["models".into()]);
    let here = me.map_or(vec![], |m| {
        of(&["models".into(), "--session".into(), m.into()])
    });
    // A folder not checked yet takes the home folder's check, as Home's picker does.
    let all = match here
        .iter()
        .any(|g| g["models"].as_array().is_some_and(|m| !m.is_empty()))
    {
        true => here,
        false => home,
    };
    (all.into_iter())
        .filter(|g| g["unavailable"].is_null() && settings::enabled(data, str_of(g, "provider")))
        .map(|mut g| {
            let off = settings::models_off(data, str_of(&g, "provider"));
            if let Some(ms) = g["models"].as_array_mut() {
                ms.retain(|m| !off.iter().any(|o| m["id"] == o.as_str()));
            }
            g
        })
        .collect()
}

fn model_of<'a>(groups: &'a [Value], agent: &str, id: &str) -> Option<&'a Value> {
    let g = groups.iter().find(|g| g["provider"] == agent)?;
    (g["models"].as_array()?.iter()).find(|m| m["id"] == id)
}

/// A row as its CLIs mark it [D2075]: Best each agent's top model at high, Standard its default,
/// Quick its small one. Proposed where a CLI marks none: no top, its default at high; no small,
/// its default at its lowest effort; no high, its highest below max.
fn default_row(groups: &[Value], row: &str) -> Vec<Value> {
    let high = |m: &Value| {
        let efforts = m["efforts"].as_array().cloned().unwrap_or_default();
        match efforts.iter().any(|e| e == "high") {
            true => json!("high"),
            false => efforts
                .into_iter()
                .rev()
                .find(|e| e != "max")
                .unwrap_or_default(),
        }
    };
    (groups.iter())
        .filter_map(|g| {
            let ms = g["models"].as_array()?;
            let mark = |k: &str| ms.iter().find(|m| m[k] == true);
            let standard = mark("default").or(ms.first())?;
            let (m, effort) = match row {
                "best" => mark("top").map_or((standard, high(standard)), |m| (m, high(m))),
                "quick" => match mark("small") {
                    Some(m) => (m, Value::Null),
                    None => (standard, standard["efforts"][0].clone()),
                },
                _ => (standard, Value::Null),
            };
            Some(json!({"agent": g["provider"], "model": m["id"], "effort": effort}))
        })
        .collect()
}

/// The table [C4]: the user's rows, each row they never set filled from the defaults.
fn table(data: &Path, groups: &[Value]) -> Value {
    let saved = read(&data.join(FILE));
    let rows: Map<String, Value> = ROWS
        .iter()
        .map(|r| {
            // An entry its agent no longer lists (gone, or hidden in Settings) is dropped, so it
            // never blocks a save; an agent off keeps its entries.
            let row = (saved["rows"][r].as_array())
                .map(|l| {
                    (l.iter())
                        .filter(|e| {
                            let a = str_of(e, "agent");
                            groups.iter().all(|g| g["provider"] != a)
                                || model_of(groups, a, str_of(e, "model")).is_some()
                        })
                        .cloned()
                        .collect()
                })
                .unwrap_or_else(|| default_row(groups, r));
            (r.to_string(), Value::Array(row))
        })
        .collect();
    let rules = saved["rules"].as_array().cloned().unwrap_or_default();
    json!({"rows": rows, "rules": rules, "review": saved["review"] == true})
}

/// Why an entry can't be one: an agent off or missing, a model it doesn't list, an effort that
/// model hasn't. Plain words, for the page and the agent alike.
fn entry_error(groups: &[Value], e: &Value) -> Option<String> {
    let (agent, id) = (str_of(e, "agent"), str_of(e, "model"));
    if !groups.iter().any(|g| g["provider"] == agent) {
        return Some(format!("{agent:?} isn't an agent you have on."));
    }
    let Some(m) = model_of(groups, agent, id) else {
        return Some(format!("{id:?} isn't a model of {agent} you may use."));
    };
    let effort = e["effort"].as_str()?;
    let has = (m["efforts"].as_array().into_iter().flatten()).any(|x| x == effort);
    (!has).then(|| format!("{id} has no effort {effort:?}."))
}

/// A whole new value checked, keeping only what differs from the defaults, so an untouched row
/// follows its CLIs' lists. What's already saved isn't checked again: only what the user just
/// added is refused.
fn checked(groups: &[Value], v: &Value, saved: &Value) -> Result<Value, String> {
    let kept = |x: &Value| {
        (saved["rows"]
            .as_object()
            .into_iter()
            .flat_map(|m| m.values()))
        .chain([&saved["rules"]])
        .any(|l| l.as_array().is_some_and(|l| l.contains(x)))
    };
    let mut rows = Map::new();
    if let Some(k) =
        (v["rows"].as_object().into_iter().flatten()).find(|(k, _)| !ROWS.contains(&k.as_str()))
    {
        return Err(format!("There's no row {:?}.", k.0));
    }
    for r in ROWS {
        let Some(list) = v["rows"][r].as_array() else {
            continue;
        };
        if let Some(why) = (list.iter())
            .filter(|e| !kept(e))
            .find_map(|e| entry_error(groups, e))
        {
            return Err(why);
        }
        if *list != default_row(groups, r) {
            rows.insert(r.into(), list.clone().into());
        }
    }
    let rules = v["rules"].as_array().cloned().unwrap_or_default();
    for rule in rules.iter().filter(|r| !kept(r)) {
        match str_of(rule, "never") {
            "model" => {
                let e = json!({"agent": rule["agent"], "model": rule["model"]});
                if let Some(why) = entry_error(groups, &e) {
                    return Err(why);
                }
            }
            "above" => {
                let effort = str_of(rule, "effort");
                let agent = rule["agent"].as_str();
                let listed = (groups.iter())
                    .filter(|g| agent.is_none_or(|a| g["provider"] == a))
                    .flat_map(|g| g["models"].as_array().cloned().unwrap_or_default())
                    .any(|m| (m["efforts"].as_array().into_iter().flatten()).any(|x| x == effort));
                if !listed {
                    return Err(format!("No model you may use has the effort {effort:?}."));
                }
            }
            _ => {
                return Err("A rule is \"never use a model\" or \"never above an effort\".".into());
            }
        }
    }
    Ok(json!({"rows": rows, "rules": rules, "review": v["review"] == true}))
}

/// `routing [--json]`, `routing set <json>` and the daemon's and app's own `routing resume <wid>`
/// and `routing answer <wid> <request> <choice>` [C4, D30].
pub fn run(data: &Path, args: &[String]) -> io::Result<Value> {
    let arg = |i: usize| args.get(i).map(String::as_str).unwrap_or("");
    let groups = || groups(data, None);
    match arg(1) {
        "" | "--json" => Ok(shown(data, &groups(), None)),
        "set" => {
            let v: Value = serde_json::from_str(arg(2))
                .map_err(|e| io::Error::other(format!("routing set: {e}")))?;
            let groups = groups();
            let _one = lock(data)?;
            match checked(&groups, &v, &read(&data.join(FILE))) {
                Ok(kept) => core::write_atomic(&data.join(FILE), kept.to_string().as_bytes())?,
                Err(why) => return Ok(shown(data, &groups, Some(why))),
            }
            Ok(shown(data, &groups, None))
        }
        "results" => Ok(crate::outcomes::results(data)),
        "resume" => hold::resume(data, arg(2)),
        "answer" => hold::answer(data, arg(2), arg(3), arg(4)),
        _ => Err(io::Error::other(
            "usage: brigadier routing [set <json> | results | resume <wid> | answer <wid> <request> <choice>]",
        )),
    }
}

/// The table as the page and the agent read it [C4], with each row's `now`: the entry a start
/// takes first by the rules, at the effort they let it run (quota aside); `why` a refused set's.
fn shown(data: &Path, groups: &[Value], why: Option<String>) -> Value {
    let mut t = table(data, groups);
    let rules = t["rules"].as_array().cloned().unwrap_or_default();
    let now: Map<String, Value> = ROWS
        .iter()
        .map(|r| {
            let list = t["rows"][*r].as_array().cloned().unwrap_or_default();
            let first = list.into_iter().find_map(|e| {
                let (a, id) = (str_of(&e, "agent"), str_of(&e, "model"));
                let m = allowed(data, groups, &rules, a, id).ok()?;
                let (effort, capped) = effort_of(&rules, a, m, e["effort"].as_str(), false).ok()?;
                Some(json!({"agent": a, "model": id, "effort": effort, "capped": capped}))
            });
            (r.to_string(), first.unwrap_or_default())
        })
        .collect();
    t["now"] = now.into();
    t["ok"] = why.is_none().into();
    if let Some(why) = why {
        (t["error"], t["message"]) = ("invalid".into(), why.into());
    }
    t
}

fn barred(rules: &[Value], agent: &str, id: &str) -> bool {
    (rules.iter()).any(|r| r["never"] == "model" && r["agent"] == agent && r["model"] == id)
}

/// The highest effort `agent`'s model may run at by the "never above" rules, by its own list.
fn cap(rules: &[Value], agent: &str, efforts: &[&str]) -> Option<usize> {
    (rules.iter())
        .filter(|r| r["never"] == "above" && (r["agent"].is_null() || r["agent"] == agent))
        .filter_map(|r| efforts.iter().position(|e| r["effort"] == *e))
        .min()
}

/// The model of an entry the user allows: listed, not hidden, not barred, its agent on [D338,
/// D2079, D2082]; or why not.
fn allowed<'a>(
    data: &Path,
    groups: &'a [Value],
    rules: &[Value],
    agent: &str,
    id: &str,
) -> Result<&'a Value, String> {
    if !groups.iter().any(|g| g["provider"] == agent) {
        return Err(format!(
            "{agent:?} isn't an agent you may use. `brigadier models` lists them."
        ));
    }
    if settings::models_off(data, agent).iter().any(|m| m == id) {
        return Err(format!("{id} is hidden in Settings, so no worker runs it."));
    }
    let m = model_of(groups, agent, id).ok_or_else(|| {
        format!("{id:?} isn't a model of {agent} you may use. `brigadier models` lists them.")
    })?;
    if barred(rules, agent, id) {
        return Err(format!("A rule in Settings › Routing says never use {id}."));
    }
    Ok(m)
}

/// The effort an entry runs at: its own (or `--effort`), else the model's default; one above a
/// rule runs at the highest the rule allows, with a note, or is refused when asked for outright
/// (`strict`) [D338] (proposed).
fn effort_of(
    rules: &[Value],
    agent: &str,
    m: &Value,
    want: Option<&str>,
    strict: bool,
) -> Result<(Option<String>, Option<String>), String> {
    let id = str_of(m, "id");
    let efforts: Vec<&str> = (m["efforts"].as_array().into_iter().flatten())
        .filter_map(Value::as_str)
        .collect();
    if let Some(w) = want.filter(|w| !efforts.contains(w)) {
        return Err(format!(
            "{id} has no effort {w:?}. `brigadier models` lists its efforts."
        ));
    }
    let now = want.or(m["default_effort"].as_str());
    let at = now.and_then(|e| efforts.iter().position(|x| *x == e));
    match (cap(rules, agent, &efforts), at) {
        (Some(cap), Some(at)) if at > cap && strict => Err(format!(
            "A rule in Settings › Routing says never above {}, so {id} can't run at {}.",
            efforts[cap], efforts[at]
        )),
        (Some(cap), Some(at)) if at > cap => Ok((
            Some(efforts[cap].into()),
            Some(format!("{id} runs at {} by your rule", efforts[cap])),
        )),
        _ => Ok((want.map(String::from), None)),
    }
}

/// Why a start ran on what it did, in a line, for its reply and start outcome [D2037]: the
/// same-row or user's note, a rule's cap, the retry's step, else what was asked (proposed).
pub(crate) fn why(asked: &Value, ran: &Value, retry: &Value) -> String {
    let step = match retry["step"].as_str() {
        Some("effort") => Some("a retry: the same model one effort up"),
        Some("row") => Some("a retry: one row up"),
        Some("same") => Some("a retry on the same pick, as its last end was temporary"),
        _ => None,
    };
    let named = match asked["model"].is_string() {
        true => "the model asked for",
        false => "your row's first model",
    };
    (ran["note"].as_str().or(ran["capped"].as_str()).or(step))
        .unwrap_or(named)
        .to_string()
}

/// What was asked, in words, where it isn't what ran: "Asked for Standard · fake-large" [D2037].
pub(crate) fn asked(asked: &Value, ran: &Value) -> Option<String> {
    let keys = ["row", "agent", "model", "effort"];
    let differs = keys
        .iter()
        .any(|k| asked[k].is_string() && asked[k] != ran[k]);
    let words: Vec<String> = (keys.iter())
        .filter_map(|k| {
            asked[k]
                .as_str()
                .map(|v| if *k == "row" { title(v) } else { v.into() })
        })
        .collect();
    differs.then(|| format!("Asked for {}", words.join(" · ")))
}

/// Whether worker `id` is held for the user's call: only the user answers it.
pub(crate) fn held(data: &Path, id: &str) -> bool {
    core::fold(&core::session_dir(data, id), true).is_ok_and(|f| f.fold.hold.is_some())
}

/// The entries after `agent`'s `model` on other agents, in the first row holding it (Best, then
/// Standard, then Quick, proposed), each one the user allows at the effort the rules let it run:
/// the session limit switch's order, never a lower row's [D2028].
pub(crate) fn after(
    data: &Path,
    agent: &str,
    model: &str,
) -> Vec<(String, String, Option<String>)> {
    let groups = groups(data, None);
    let t = table(data, &groups);
    let rules = t["rules"].as_array().cloned().unwrap_or_default();
    let holds = |r: &&&str| {
        (t["rows"][**r].as_array().into_iter().flatten())
            .any(|e| e["agent"] == agent && e["model"] == model)
    };
    let Some(row) = ROWS.iter().find(holds) else {
        return vec![];
    };
    let list = t["rows"][*row].as_array().cloned().unwrap_or_default();
    let at = list
        .iter()
        .position(|e| e["agent"] == agent && e["model"] == model)
        .unwrap_or(0);
    (list.into_iter().skip(at + 1))
        .filter(|e| e["agent"] != agent)
        .filter_map(|e| {
            let (a, id) = (str_of(&e, "agent"), str_of(&e, "model"));
            let m = allowed(data, &groups, &rules, a, id).ok()?;
            let (effort, _) = effort_of(&rules, a, m, e["effort"].as_str(), false).ok()?;
            Some((a.to_string(), id.to_string(), effort))
        })
        .collect()
}

/// The rows and rules in words, for the agent's `brigadier models` [C4].
pub(crate) fn said(t: &Value) -> String {
    let mut text = "Routing rows (start --row), first with room runs:\n".to_string();
    for r in ROWS {
        let list: Vec<String> = (t["rows"][r].as_array().into_iter().flatten())
            .map(|e| {
                let effort = e["effort"]
                    .as_str()
                    .map_or(String::new(), |x| format!(" · {x}"));
                format!("{} · {}{effort}", str_of(e, "agent"), str_of(e, "model"))
            })
            .collect();
        text += &format!("  {r}: {}\n", list.join(", then "));
    }
    for rule in t["rules"].as_array().into_iter().flatten() {
        text += &match str_of(rule, "never") {
            "model" => format!(
                "  Never use {} · {}\n",
                str_of(rule, "agent"),
                str_of(rule, "model")
            ),
            _ => format!(
                "  Never above {}{}\n",
                str_of(rule, "effort"),
                rule["agent"]
                    .as_str()
                    .map_or(String::new(), |a| format!(" on {a}"))
            ),
        };
    }
    text
}

/// The daemon's: worker `wid`'s wait for its reset is over, so it goes on as picked [D2028].
pub(crate) fn due(data: &Path, wid: &str) {
    let f = core::fold(&core::session_dir(data, wid), true).map(|f| f.fold);
    let Some(h) = f
        .ok()
        .and_then(|f| f.hold)
        .filter(|h| h["phase"] == "waiting")
    else {
        return;
    };
    if h["resets"].as_u64().is_none_or(|at| at <= log::now_ms()) {
        let (data, wid) = (data.to_path_buf(), wid.to_string());
        std::thread::spawn(move || hold::resume(&data, &wid));
    }
}
