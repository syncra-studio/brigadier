//! Agents in the browser, `brigadier browser …` [D2026, D503, D516, D518]: the old app's browser
//! tool (crates/core/src/manager/browser_tool.rs), ported. The daemon pushes each call to the app's
//! page, which runs it on the tab's page and answers it back (app/ui/src/browser/agent.ts). A tab
//! the user took over holds its calls; an action that asks the user first waits on its card.

mod asks;
mod keys;
mod text;

use crate::agent::refuse;
use brigadier_core as core;
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::mpsc::{self, Sender};
use std::sync::{Condvar, LazyLock, Mutex, MutexGuard};
use std::time::{Duration, Instant};

pub(crate) use asks::answered;
pub(crate) use text::HELP;

/// How long the app may take over a call: a page load it waits for, at most.
const CALL_WAIT: Duration = Duration::from_secs(45);
/// How long a call on a tab the user took over waits for their Continue before the agent hears
/// it is still paused.
const PAUSE_WAIT: Duration = Duration::from_secs(50);

/// A call the app hasn't answered yet: the connection it went to, and who waits.
type Waiting = (u64, Sender<Value>);

#[derive(Default)]
struct Hub {
    /// The app's connections that run calls; the newest runs them.
    pages: Mutex<Vec<(u64, Sender<String>)>>,
    calls: Mutex<HashMap<String, Waiting>>,
    /// The tabs the user took over, with how many calls wait on each for Continue.
    paused: Mutex<HashMap<String, usize>>,
    pause_changed: Condvar,
    /// The user's yes to one call until it goes through, by agent, tab and the call itself. In
    /// memory only, so nothing typed is ever written down.
    grants: Mutex<HashMap<(String, String, String), Value>>,
    /// Each tab's last read for its agent: its page load and text, for the next read's changes.
    reads: Mutex<HashMap<String, (u64, String)>>,
    /// The tab each agent works in now.
    tabs: Mutex<HashMap<String, String>>,
    /// The tabs agents opened, by tab: the agent, its session's tabs and whether `--keep` kept it.
    opened: Mutex<HashMap<String, (String, String, bool)>>,
}

static HUB: LazyLock<Hub> = LazyLock::new(Hub::default);

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// The app's connection `conn` runs the agents' calls from now on.
pub fn page(conn: u64, out: Sender<String>) {
    let mut pages = lock(&HUB.pages);
    pages.retain(|(c, _)| *c != conn);
    pages.push((conn, out));
}

/// Connection `conn` went: what waits on it fails at once, and with no window left the tabs it
/// paused go with it.
pub fn leave(conn: u64) {
    let mut pages = lock(&HUB.pages);
    pages.retain(|(c, _)| *c != conn);
    lock(&HUB.calls).retain(|_, (c, _)| *c != conn);
    if pages.is_empty() {
        lock(&HUB.paused).clear();
        HUB.pause_changed.notify_all();
    }
}

/// The app's side: `browser answer <call> <json>`, the page's answer to a call, and
/// `browser <session> paused <tab> true|false`, the user's takeover and Continue (pause.ts).
pub(super) fn run(args: &[String]) -> std::io::Result<Value> {
    let arg = |i: usize| args.get(i).map_or("", String::as_str);
    match (arg(1), arg(2)) {
        ("answer", id) => {
            let answer = serde_json::from_str(arg(3)).unwrap_or(Value::Null);
            if let Some((_, to)) = lock(&HUB.calls).remove(id) {
                let _ = to.send(answer);
            }
        }
        (session, "paused") => {
            core::check_id(session)?;
            // How many calls the hand-back lets go on: with none, the app tells the agent (pause.ts).
            let waiting = set_paused(arg(3), arg(4) == "true");
            return Ok(json!({"ok": true, "waiting": waiting}));
        }
        _ => return Err(std::io::Error::other(super::USAGE)),
    }
    Ok(json!({"ok": true}))
}

/// Pauses `tab` or lets it go on; how many calls waited on it.
fn set_paused(tab: &str, paused: bool) -> usize {
    let mut set = lock(&HUB.paused);
    let (changed, waiting) = match paused {
        true => (
            !set.contains_key(tab),
            *set.entry(tab.to_string()).or_insert(0),
        ),
        false => set.remove(tab).map_or((false, 0), |n| (true, n)),
    };
    if changed {
        HUB.pause_changed.notify_all();
    }
    waiting
}

/// Waits until `tab` isn't paused, `until` at the latest, or the agent went; false if it still is.
fn unpaused(tab: &str, until: Instant, here: &dyn Fn() -> bool) -> bool {
    let mut set = lock(&HUB.paused);
    while let Some(n) = set.get_mut(tab) {
        let left = until.saturating_duration_since(Instant::now());
        if left.is_zero() || !here() {
            return false;
        }
        *n += 1;
        let step = left.min(Duration::from_secs(1));
        set = HUB
            .pause_changed
            .wait_timeout(set, step)
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .0;
        if let Some(n) = set.get_mut(tab) {
            *n = n.saturating_sub(1);
        }
    }
    true
}

/// Sends `op` to the app's page and waits for its answer, the call's wait at most.
fn call(owner: &str, driver: &str, label: &str, op: &Value, here: &dyn Fn() -> bool) -> Value {
    let failed = |m: &str| json!({"result": "failed", "message": m});
    let Some((conn, out)) = lock(&HUB.pages).last().cloned() else {
        return failed("Brigadier's window isn't open, so its browser can't be used now.");
    };
    let id = core::adapters::uuid();
    let (to, answer) = mpsc::channel();
    lock(&HUB.calls).insert(id.clone(), (conn, to));
    let push =
        json!({"browser": {"id": id, "owner": owner, "driver": driver, "label": label, "op": op}});
    if out.send(push.to_string()).is_err() {
        lock(&HUB.calls).remove(&id);
        return failed("Brigadier's window closed before it answered.");
    }
    let until = Instant::now() + CALL_WAIT;
    loop {
        match answer.recv_timeout(Duration::from_millis(500)) {
            Ok(v) => return v,
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return failed("Brigadier's window closed before it answered.");
            }
            Err(_) if here() && Instant::now() < until => {}
            Err(_) => {
                lock(&HUB.calls).remove(&id);
                return failed("The page didn't answer in time; nothing more is known.");
            }
        }
    }
}

/// The session whose tabs an agent works in: a worker's are its thread's, a Brigade's
/// sub-session's its own.
fn owner(data: &Path, me: &str) -> String {
    crate::workers::link(data, me)
        .filter(|l| !l.session)
        .map_or(me.to_string(), |l| l.parent)
}

/// The checked words of an agent's call: its action, the words after it, and its flags.
struct Words<'a> {
    action: &'a str,
    rest: Vec<&'a str>,
    values: HashMap<&'a str, &'a str>,
    flags: HashSet<&'a str>,
}

const VALUES: [&str; 9] = [
    "--tab", "--go", "--since", "--kinds", "--asks", "--ref", "--text", "--gone", "--ms",
];
const FLAGS: [&str; 6] = [
    "--keep",
    "--dev-url",
    "--submit",
    "--json",
    "--help",
    "--confirm",
];

/// Who the user sees drive a tab [D778]: a worker by its name, the session's own agent as
/// Brigadier, never the agent CLI's name.
pub(crate) fn who(data: &Path, session: &str) -> String {
    crate::workers::link(data, session)
        .map(|l| l.title)
        .filter(|t| !t.trim().is_empty())
        .unwrap_or_else(|| "Brigadier".into())
}

fn words(args: &[String]) -> Result<Words<'_>, Value> {
    let mut w = Words {
        action: args.get(1).map_or("help", String::as_str),
        rest: vec![],
        values: HashMap::new(),
        flags: HashSet::new(),
    };
    let mut it = args.iter().skip(2).map(String::as_str);
    while let Some(a) = it.next() {
        if VALUES.contains(&a) {
            let v = it
                .next()
                .ok_or_else(|| refuse(&format!("{a} needs a value.")))?;
            w.values.insert(a, v);
        } else if FLAGS.contains(&a) {
            w.flags.insert(a);
        } else if a.starts_with("--") && w.rest.is_empty() {
            return Err(refuse(&format!(
                "`{a}` isn't an option of `brigadier browser`. `brigadier browser --help` shows them."
            )));
        } else {
            w.rest.push(a);
        }
    }
    Ok(w)
}

/// An agent's `brigadier browser …` for session `me`; `here` is false once the caller has gone.
pub fn agent(data: &Path, me: &str, args: &[String], here: &dyn Fn() -> bool) -> Value {
    let w = match words(args) {
        Ok(w) => w,
        Err(e) => return e,
    };
    if w.action == "help" || w.flags.contains("--help") {
        return json!({"ok": true, "text": HELP});
    }
    let spec = match core::load(data, me) {
        Ok(s) => s,
        Err(e) => return refuse(&e.to_string()),
    };
    let owner = owner(data, me);
    let level = spec.level.as_deref().unwrap_or("ask");
    let op = match asks::op(&w, me, &owner, level) {
        Ok(op) => op,
        Err(e) => return e,
    };
    // `$BROWSER`'s open (core::agent's shim): a local page, and only while local links open here.
    if w.action == "open" && w.flags.contains("--dev-url") {
        let url = w.rest.first().copied().unwrap_or_default();
        if !core::agent::local_address(url) {
            return refuse(&format!("{url} isn't a local address."));
        }
        if crate::settings::get(data, "local_links_in") != "brigadier" {
            return refuse("Local links open in the default browser (Settings › Browser).");
        }
    }
    let label = who(data, me);
    let tab = op["tab"].as_str().unwrap_or("").to_string();
    let key = asks::fingerprint(&op).map(|f| (me.to_string(), tab.clone(), f));
    // Asked first, the call goes on once the user says yes; the page may have moved by then, and
    // then it asks again.
    for _ in 0..3 {
        let mut sent = op.clone();
        // A yes the user gave this very call goes with it, taken: one yes lets one call through.
        let granted = key.as_ref().and_then(|k| lock(&HUB.grants).remove(k));
        if let Some(g) = &granted {
            sent["approved"] = g.clone();
        }
        let result = held(&owner, me, &label, &sent, here);
        match result["result"].as_str() {
            Some("paused") => {
                if let (Some(k), Some(g)) = (key.clone(), granted) {
                    lock(&HUB.grants).entry(k).or_insert(g);
                }
            }
            Some("needsApproval") => {
                if let Err(reply) = asks::ask(data, me, &op, &result, key.clone(), here) {
                    return reply;
                }
                continue;
            }
            _ => {}
        }
        return text::reply(data, me, &w, &op, result);
    }
    refuse(
        "The page kept asking for the user's yes again; nothing more was done. Read it and try once more.",
    )
}

/// Runs `op` on its tab, except on a tab the user took over: there it waits for their Continue,
/// the pause's wait at most, then hears `paused`. A call whose agent went never reaches the tab.
fn held(owner: &str, me: &str, label: &str, op: &Value, here: &dyn Fn() -> bool) -> Value {
    let until = Instant::now() + PAUSE_WAIT;
    let tab = op["tab"].as_str().unwrap_or("");
    loop {
        if !tab.is_empty() && !unpaused(tab, until, here) {
            return json!({"result": "paused", "tab": tab});
        }
        let result = call(owner, me, label, op, here);
        // The user took the tab over as the call reached it: wait as for any pause.
        if result["result"] == "paused" && Instant::now() < until && here() {
            set_paused(result["tab"].as_str().unwrap_or(tab), true);
            continue;
        }
        if let Some(t) = result["tab"]
            .as_str()
            .filter(|_| result["result"] != "closed")
        {
            lock(&HUB.tabs).insert(me.to_string(), t.to_string());
            if op["op"] == "open" {
                let keep = op["keep"] == true;
                let mut opened = lock(&HUB.opened);
                let kept = opened.get(t).is_some_and(|o| o.2);
                opened.insert(t.into(), (me.into(), owner.into(), keep || kept));
            }
        }
        return result;
    }
}

/// The tab an agent's call is on: `--tab`, else the one it worked in last.
fn tab_of(w: &Words, me: &str) -> Result<String, Value> {
    match w.values.get("--tab") {
        Some(t) => Ok(t.to_string()),
        None => lock(&HUB.tabs).get(me).cloned().ok_or_else(|| {
            refuse("You have no tab yet: open one with `brigadier browser open <url>`.")
        }),
    }
}

/// Session `me`'s turn ended: the tabs its agent opened without `--keep` close in the app, except
/// the one in front and those the user took over, and it lets go of the rest (agent.ts).
pub fn turn_ended(me: &str) {
    let mut gone: HashMap<String, Vec<String>> = HashMap::new();
    lock(&HUB.opened).retain(|tab, (driver, owner, keep)| {
        if driver != me {
            return true;
        }
        let close = gone.entry(owner.clone()).or_default();
        if !*keep {
            close.push(tab.clone());
        }
        *keep
    });
    let Some((_, out)) = lock(&HUB.pages).last().cloned() else {
        return;
    };
    for (owner, tabs) in gone {
        let op = json!({"op": "end", "tabs": tabs});
        let push =
            json!({"browser": {"id": "", "owner": owner, "driver": me, "label": "", "op": op}});
        let _ = out.send(push.to_string());
    }
}

/// The tab closed, or its page moved on: its last read goes.
fn forget(tab: &str) {
    lock(&HUB.reads).remove(tab);
    lock(&HUB.grants).retain(|(_, t, _), _| t != tab);
}
