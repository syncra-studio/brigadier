//! Usage kept per account and window [D28, D41, D2039]: `usage.json` in the data folder, keyed
//! `<agent>/<account>` ("" the computer's login) as `accounts.json`'s `limited` is, from each
//! check's read and each run's reports, so Providers, the sidebar's Usage, the picker and routing
//! read one source. Nothing here names a provider [D43].

use crate::accounts;
use brigadier_core::{self as core, adapters::Check, adapters::Limit};
use brigadier_frames::log::now_ms;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::fs::{self, File};
use std::io;
use std::path::Path;
use std::sync::Mutex;

/// A sample older than this says nothing of now (proposed).
pub(crate) const STALE_MS: u64 = 60 * 60 * 1000;

#[derive(Serialize, Deserialize, Clone)]
pub(crate) struct Window {
    /// "5-hour", "Weekly", "Weekly · Opus": the words D28 already uses.
    pub name: String,
    /// The window's length, where its CLI says.
    pub minutes: Option<u64>,
    /// Model ids this window meters; None = every model of the agent.
    pub models: Option<Vec<String>>,
    /// Whole percent; None = unknown.
    pub used: Option<u32>,
    /// Unix ms, where said.
    pub resets: Option<u64>,
    /// When this sample was read (Unix ms).
    pub at: u64,
}

fn key(agent: &str, account: &str) -> String {
    format!("{agent}/{account}")
}

/// Each account's entry: `{signed_in, usable, email, windows}`, the first three as its last check
/// said.
fn load(data: &Path) -> Value {
    fs::read(data.join("usage.json"))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_else(|| json!({}))
}

fn windows(entry: &Value) -> Vec<Window> {
    serde_json::from_value(entry["windows"].clone()).unwrap_or_default()
}

/// The last sample of each window of one account; `account` "" = the computer's login. A window
/// whose reset has passed, or with no reset said and a sample older than `STALE_MS`, is unknown
/// until a fresh report: never kept as exhausted past its reset, never assumed full. Use only
/// rises inside a window, so a sample whose reset is ahead still holds.
pub(crate) fn of(data: &Path, agent: &str, account: &str) -> Vec<Window> {
    let now = now_ms();
    let mut found = windows(&load(data)[key(agent, account)]);
    for w in &mut found {
        if w.resets.map_or(now.saturating_sub(w.at) > STALE_MS, |r| r <= now) {
            w.used = None;
        }
    }
    found
}

/// Whether an account's last check found work can run on it (`accounts::usable`); None before.
pub(crate) fn usable(data: &Path, agent: &str, account: &str) -> Option<bool> {
    load(data)[key(agent, account)]["usable"].as_bool()
}

/// Keeps a sample read at `at`: each window replaces the one of its name unless that one is newer, and
/// a check's whole list all but newer ones; `who` (signed in, email, usable) where a check said it. One writer at a time, across processes.
fn record(
    data: &Path,
    agent: &str,
    account: &str,
    limits: Option<&[Limit]>,
    at: u64,
    who: Option<(Option<bool>, Option<&str>, bool)>,
) -> io::Result<()> {
    fs::create_dir_all(data)?;
    let lock = File::options()
        .create(true)
        .truncate(false)
        .write(true)
        .open(data.join("usage.lock"))?;
    lock.lock()?;
    let mut v = load(data);
    let entry = &mut v[key(agent, account)];
    if let Some((signed_in, email, usable)) = who {
        entry["signed_in"] = signed_in.into();
        entry["email"] = email.into();
        entry["usable"] = usable.into();
    }
    if let Some(limits) = limits {
        let mut kept = windows(entry);
        let whole = who.is_some();
        kept.retain(|w| w.at > at || (!whole && !limits.iter().any(|l| l.name == w.name)));
        let fresh: Vec<&Limit> = (limits.iter())
            .filter(|l| !kept.iter().any(|w| w.name == l.name))
            .collect();
        kept.extend(fresh.into_iter().map(|l| Window {
            name: l.name.clone(),
            minutes: l.minutes,
            models: l.models.clone(),
            used: Some(l.used),
            resets: l.resets,
            at,
        }));
        // The shortest window first, one that meters some models after the one for all.
        kept.sort_by_key(|w| (w.minutes.unwrap_or(u64::MAX), w.models.is_some()));
        entry["windows"] = json!(kept);
    }
    core::write_atomic(&data.join("usage.json"), v.to_string().as_bytes())
}

/// Keeps what a check on one account read: who, and its limits where it read them.
pub(crate) fn checked(data: &Path, agent: &str, account: &str, c: &Check) {
    let usable = c.signed_in == Some(true)
        && core::adapters::get(agent).is_some_and(|a| accounts::kept_apart(a, account, &c.how));
    let who = Some((c.signed_in, c.who.email.as_deref(), usable));
    if let Err(e) = record(data, agent, account, c.usage.as_deref(), now_ms(), who) {
        eprintln!("brigadier: usage of {agent}/{account} not kept: {e}");
    }
}

/// The UI's limits: `[{name, used, resets}]`, `used` null when unknown.
pub(crate) fn limits(windows: &[Window]) -> Value {
    (windows.iter())
        .map(|w| json!({"name": w.name, "used": w.used, "resets": w.resets}))
        .collect()
}

/// An agent's usage for its picker group: each signed-in account in Providers' order, named as
/// Providers names it [D24], with its limits; null when no account is known signed in.
pub(crate) fn of_agent(data: &Path, agent: &str) -> Value {
    let v = load(data);
    let rows = accounts::accounts_of(&accounts::load(data), agent);
    let email = |id: &str| {
        let e = &v[key(agent, id)]["email"];
        e.as_str().map(str::to_lowercase)
    };
    // The computer's login signed in to an account also added: one entry, the added one's.
    let own = email("");
    let twin = |id: &str| {
        id.is_empty() && own.is_some() && rows.iter().any(|(x, _)| !x.is_empty() && email(x) == own)
    };
    let found: Vec<Value> = (rows.iter())
        .filter(|(id, _)| v[key(agent, id)]["signed_in"] == true && !twin(id))
        .map(|(id, given)| {
            let email = v[key(agent, id)]["email"].as_str();
            let name = match (given.as_str(), email) {
                (g, e) if !g.is_empty() && Some(g) != e => g,
                (_, Some(e)) => e,
                _ if id.is_empty() => "This computer's login",
                _ => "New account",
            };
            json!({"account": id, "name": name, "limits": limits(&of(data, agent, id))})
        })
        .collect();
    match found.is_empty() {
        true => Value::Null,
        false => found.into(),
    }
}

/// Sessions' newest run reports, by the sample time each was last kept at.
static KEPT: Mutex<BTreeMap<String, u64>> = Mutex::new(BTreeMap::new());

/// Keeps each session's newest run report on the account it ran on, once each [D2039].
pub fn pass(data: &Path, rows: &BTreeMap<String, Value>) {
    let mut kept = KEPT.lock().unwrap();
    kept.retain(|id, _| rows.contains_key(id));
    for (id, row) in rows {
        let l = &row["limits"];
        let Some(at) = l["at"].as_u64() else {
            continue;
        };
        if kept.get(id) == Some(&at) {
            continue;
        }
        let found: Vec<Limit> = serde_json::from_value(l["limits"].clone()).unwrap_or_default();
        let (agent, account) = (
            l["backend"].as_str().unwrap_or(""),
            l["account"].as_str().unwrap_or(""),
        );
        match record(data, agent, account, Some(&found), at, None) {
            Ok(()) => drop(kept.insert(id.clone(), at)),
            Err(e) => eprintln!("brigadierd: usage of {agent}/{account} not kept: {e}"),
        }
    }
}
