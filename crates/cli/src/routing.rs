//! Settings › Routing [D378, D383, D338, D341]: the user's jobs, each an ordered list of agent ·
//! model · effort, and their exact rules; and the resolver that picks a worker's model and account
//! from its job, kept for its life [D2037, D2040, D2041, D375]. A job out of quota holds the worker
//! for the user's call [D2028, D342].

use crate::accounts::{self, accounts_of, listed};
use crate::workers::{self, row::clock};
use crate::{models, owner, settings, usage};
use brigadier_core::{self as core, Spec, adapters, fold::Fold};
use brigadier_frames::log;
use serde_json::{Value, json};
use std::fs::{self, OpenOptions};
use std::io;
use std::path::Path;

mod hold;
mod jobs;
mod offers;
mod pick;
mod receipt;
mod retry;
mod rules;

pub(crate) use hold::{ask, due, real, set_ran, stopped, stops};
pub(crate) use jobs::said;
pub(crate) use pick::{next, resolve};
pub(crate) use receipt::receipt;
pub(crate) use retry::plan as retry;
use rules::{FULL, allowed, barred, cap, effort_of, unusable};
pub(crate) use rules::{launch, picks};

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

/// The job a lead names to start computer use's worker [D941]: the one whose line covers it; None
/// when the user has no job to start one on.
pub(crate) fn computer_job(data: &Path) -> Option<String> {
    let t = current(data);
    let mut all = jobs::startable(t["jobs"].as_array().map_or(&[], Vec::as_slice)).peekable();
    all.peek()?;
    let covers = |j: &&Value| str_of(j, "for").to_lowercase().contains("computer");
    Some(
        all.find(covers)
            .map_or("<the job that covers computer use>", |j| str_of(j, "name"))
            .into(),
    )
}

fn str_of<'a>(v: &'a Value, k: &str) -> &'a str {
    v[k].as_str().unwrap_or("")
}

/// Whether Settings › Routing's Adversarial review is on [D3026, C4].
pub(crate) fn review_on(data: &Path) -> bool {
    read(&data.join(FILE))["review"] == true
}

/// "High" for "high"; a row's title for one from before jobs.
pub(crate) fn capital(word: &str) -> String {
    let mut c = word.chars();
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
    // Barred models too: the table and its checks name them [D376].
    let home = of(&["models".into(), "--all".into()]);
    let here = me.map_or(vec![], |m| {
        of(&[
            "models".into(),
            "--all".into(),
            "--session".into(),
            m.into(),
        ])
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

/// A model's name as the pickers show it: from `me`'s folder's check, else the home folder's.
pub(crate) fn name_of(data: &Path, me: &str, agent: &str, id: &str) -> Option<String> {
    let groups = groups(data, Some(me));
    model_of(&groups, agent, id)?["name"]
        .as_str()
        .map(String::from)
}

/// The table [C5]: the user's jobs (the seeds or carried rows until the first save), rules and
/// review switch.
fn table(data: &Path, groups: &[Value]) -> Value {
    let saved = read(&data.join(FILE));
    let rules = saved["rules"].as_array().cloned().unwrap_or_default();
    json!({"jobs": jobs::of(&saved, groups), "rules": rules, "review": saved["review"] == true,
        "images": saved["images"]})
}

/// The table without offers, for agents and results: agents never see offers [D386].
pub(crate) fn current(data: &Path) -> Value {
    table(data, &groups(data, None))
}

/// What a session's agent is told of the jobs at launch, after its lead rule [D387]; a worker,
/// naked, is told none. Every launch carries the rules' check [D376].
pub(crate) fn told(data: &Path, spec: &Spec) -> Spec {
    let mut spec = spec.clone();
    spec.rules = Some(launch);
    if !spec.naked {
        let t = current(data);
        spec.jobs = Some(jobs::lead(t["jobs"].as_array().map_or(&[], Vec::as_slice)));
    }
    // A reviewer's own plans aren't reviewed: one review, never a chain [§6].
    // A night's plans are reviewed whatever the switch says.
    spec.review = (review_on(data) || crate::overnight::of(data, &spec.id).is_some())
        && crate::workers::link(data, &spec.id).is_none_or(|l| l.review["of"].is_null());
    spec
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

/// An entry a "never use" rule bars, refused when added as an invalid one is [D341, D363].
fn barred_error(groups: &[Value], rules: &[Value], e: &Value) -> Option<String> {
    let (agent, id) = (str_of(e, "agent"), str_of(e, "model"));
    let name = model_of(groups, agent, id).map_or(id, |m| m["name"].as_str().unwrap_or(id));
    barred(rules, agent, id).then(|| format!("{name} is barred by your rule \"Never use {name}\"."))
}

/// A whole new value checked against the table as it stands: what's already in it isn't checked
/// again, only what the user just added is refused. The first save writes the whole list and
/// drops the carried rows [D388 Q4]; no `jobs` keeps the list as it stands.
fn checked(groups: &[Value], v: &Value, now: &Value, saved: &Value) -> Result<Value, String> {
    let kept = |x: &Value| {
        (now["jobs"].as_array().into_iter().flatten())
            .map(|j| &j["entries"])
            .chain([&now["rules"]])
            .any(|l| l.as_array().is_some_and(|l| l.contains(x)))
    };
    let rules = v["rules"].as_array().cloned().unwrap_or_default();
    let mut out = match saved {
        Value::Object(_) => saved.clone(),
        _ => json!({}),
    };
    if let Some(list) = v["jobs"].as_array() {
        let list = jobs::limits(list)?;
        if let Some(why) = (list.iter())
            .flat_map(|j| j["entries"].as_array().cloned().unwrap_or_default())
            .filter(|e| !kept(e))
            .find_map(|e| entry_error(groups, &e).or_else(|| barred_error(groups, &rules, &e)))
        {
            return Err(why);
        }
        out["jobs"] = list.into();
        if let Some(o) = out.as_object_mut() {
            o.remove("rows");
        }
    }
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
    (out["rules"], out["review"]) = (rules.into(), (v["review"] == true).into());
    // The model images go to first: one that makes them, or none for automatic [D298].
    // Left out, it stays as it was.
    if let Some(images) = v.get("images") {
        let (agent, id) = (str_of(images, "agent"), str_of(images, "model"));
        if !images.is_null()
            && now["images"] != *images
            && model_of(groups, agent, id).is_none_or(|m| m["draws"] != true)
        {
            return Err("That model doesn't make images.".into());
        }
        out["images"] = images.clone();
    }
    Ok(out)
}

/// Saves a new table checked against `now`, the table as it stands, or says why not; the caller
/// holds the lock.
fn save(data: &Path, groups: &[Value], v: &Value, now: &Value) -> io::Result<Option<String>> {
    match checked(groups, v, now, &read(&data.join(FILE))) {
        Ok(kept) => core::write_atomic(&data.join(FILE), kept.to_string().as_bytes()).map(|_| None),
        Err(why) => Ok(Some(why)),
    }
}

/// `routing [--json]`, `routing set <json>`, `routing offer <id> use|later|never` and the
/// daemon's and app's own `routing resume <wid>` and `routing answer <wid> <request> <choice>`
/// [C5, D30].
pub fn run(data: &Path, args: &[String]) -> io::Result<Value> {
    let arg = |i: usize| args.get(i).map(String::as_str).unwrap_or("");
    let groups = || groups(data, None);
    // Read before the lock every start also takes: it walks every worker's log and git [D2038].
    let results = || crate::outcomes::results(data);
    match arg(1) {
        "" | "--json" => {
            let (groups, r) = (groups(), results());
            let _one = lock(data)?;
            Ok(shown(data, &groups, &r, None))
        }
        "set" => {
            let v: Value = serde_json::from_str(arg(2))
                .map_err(|e| io::Error::other(format!("routing set: {e}")))?;
            let (groups, r) = (groups(), results());
            let _one = lock(data)?;
            let why = save(data, &groups, &v, &table(data, &groups))?;
            Ok(shown(data, &groups, &r, why))
        }
        "offer" => offers::answer(data, &groups(), arg(2), arg(3)),
        "results" => Ok(results()),
        "resume" => hold::resume(data, arg(2)),
        "answer" => hold::answer(data, arg(2), arg(3), arg(4)),
        _ => Err(io::Error::other(
            "usage: brigadier routing [set <json> | offer <id> use|later|never | results | resume <wid> | answer <wid> <request> <choice>]",
        )),
    }
}

/// The table as the page reads it [C5], with the page's grey lines and the offers open now; `why`
/// a refused change's. The caller holds the lock.
fn shown(data: &Path, groups: &[Value], r: &Value, why: Option<String>) -> Value {
    let mut t = table(data, groups);
    let offers = offers::open(data, groups, &t, r).unwrap_or_default();
    (t["offers"], t["notes"]) = (offers.into(), jobs::notes(groups));
    t["ok"] = why.is_none().into();
    if let Some(why) = why {
        (t["error"], t["message"]) = ("invalid".into(), why.into());
    }
    t
}

fn rules_of(data: &Path) -> Vec<Value> {
    (read(&data.join(FILE))["rules"].as_array().cloned()).unwrap_or_default()
}

/// Why a start ran on what it did, in a line, for its reply and start outcome [D2037]: the
/// next-entry or user's note, a rule's cap, the retry's step, else what was asked.
pub(crate) fn why(asked: &Value, ran: &Value, retry: &Value) -> String {
    let step = match retry["step"].as_str() {
        Some("effort") => Some("a retry: the same model one effort up"),
        Some("again") => Some("a retry: the same model once more"),
        Some("next") => Some("a retry: the job's next model"),
        Some("same") => Some("a retry on the same pick, as its last end wasn't its work"),
        _ => None,
    };
    let named = match (asked["model"].is_string(), ran["job"].as_str()) {
        (false, Some(job)) => match ran["other_than"].as_str() {
            Some(a) => format!("the first in {job} on another agent than {a}"),
            None => format!("the first model in {job}"),
        },
        _ => "the model asked for".into(),
    };
    (ran["note"].as_str().or(ran["capped"].as_str()).or(step)).map_or(named, String::from)
}

/// What was asked, in words, where it isn't what ran: "Asked for Write code · fake-large" [D2037].
pub(crate) fn asked(asked: &Value, ran: &Value) -> Option<String> {
    let differs =
        (["agent", "model", "effort"].iter()).any(|k| asked[k].is_string() && asked[k] != ran[k]);
    let words: Vec<&str> = (["job", "agent", "model", "effort"].iter())
        .filter_map(|k| asked[k].as_str())
        .collect();
    differs.then(|| format!("Asked for {}", words.join(" · ")))
}

/// Whether worker `id` is held for the user's call: only the user answers it.
pub(crate) fn held(data: &Path, id: &str) -> bool {
    core::fold(&core::session_dir(data, id), true).is_ok_and(|f| f.fold.hold.is_some())
}

/// The entries after `agent`'s `model` on other agents, in the first job holding it, in the
/// user's order, each one the user allows at the effort the rules let it run: the session limit
/// switch's order [D2028, D376].
pub(crate) fn after(
    data: &Path,
    agent: &str,
    model: &str,
) -> Vec<(String, String, Option<String>)> {
    let groups = groups(data, None);
    let t = table(data, &groups);
    let rules = t["rules"].as_array().cloned().unwrap_or_default();
    let it = |e: &Value| e["agent"] == agent && e["model"] == model;
    let Some(list) = (t["jobs"].as_array().into_iter().flatten())
        .filter_map(|j| j["entries"].as_array())
        .find(|l| l.iter().any(it))
    else {
        return vec![];
    };
    let at = list.iter().position(it).unwrap_or(0);
    (list.iter().skip(at + 1))
        .filter(|e| e["agent"] != agent)
        .filter_map(|e| {
            let (a, id) = (str_of(e, "agent"), str_of(e, "model"));
            let m = allowed(data, &groups, &rules, a, id).ok()?;
            let (effort, _) = effort_of(&rules, a, m, e["effort"].as_str(), false).ok()?;
            Some((a.to_string(), id.to_string(), effort))
        })
        .collect()
}
