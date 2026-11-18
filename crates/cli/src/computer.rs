//! Computer use [D2032]: the agents' `brigadier computer …` (verbs.rs) and the app's
//! `computer status|on|off|grant`. The grants sit on "Brigadier Computer Use", a helper app of
//! its own that LaunchServices starts, so they're charged to it and never to Brigadier or an
//! agent's shell [D908, D913]. It runs the pinned Cua Driver over its own pipes and connects out to
//! this daemon, which sends it each call: no other process can reach the driver. Everything else
//! lives here: the one-at-a-time lock [D907], the block list [D903] and the pause [D910].

mod verbs;

pub(crate) use verbs::HELP;
pub use verbs::{agent, turn_ended};

use serde_json::{Value, json};
use std::collections::HashMap;
use std::path::Path;
use std::process::Command;
use std::sync::mpsc::{self, Sender};
use std::sync::{Condvar, LazyLock, Mutex, MutexGuard};
use std::time::{Duration, Instant};
use std::{fs, io};

/// The longest the helper may take from launch to its driver answering.
const START_WAIT: Duration = Duration::from_secs(10);
/// The longest one driver call may take; a launch waits for its first window within it.
const CALL_WAIT: Duration = Duration::from_secs(20);
/// macOS caches a grant's answer per process: while one is missing, the helper is started afresh
/// at most this often, so a grant given in System Settings shows without restarting Brigadier.
const RECHECK: Duration = Duration::from_secs(4);
/// The setting, off until the user turns it on [D911, D912].
const SETTING: &str = "computer_use";
/// Where `brigadierd --install` writes the path of the bundle's helper (install.rs).
pub const HELPER_FILE: &str = "computer-helper";

/// The helper's connection: where calls go, its pid, and the calls waiting on an answer.
#[derive(Default)]
struct Link {
    conn: u64,
    out: Option<Sender<String>>,
    pid: i32,
    next: u64,
    waiting: HashMap<u64, Sender<Value>>,
    /// The driver answered `initialize`.
    ready: bool,
}

#[derive(Default)]
struct Hub {
    link: Mutex<Link>,
    changed: Condvar,
    /// When the helper was last launched, and with what it asked macOS for.
    launched: Mutex<Option<Instant>>,
    /// The grants as the driver last said: Accessibility, Screen Recording.
    grants: Mutex<Option<(bool, bool)>>,
}

static HUB: LazyLock<Hub> = LazyLock::new(Hub::default);

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Why a call to the driver didn't give an answer.
pub(crate) enum Fail {
    /// Nothing was sent: the words say why.
    NotSent(String),
    /// Sent, and no answer came: it may have happened.
    Unknown,
}

/// The helper connected on `conn` (ops.rs): calls go to it from now on, and an older one goes.
pub fn helper(conn: u64, out: Sender<String>, pid: i32) {
    {
        let mut link = lock(&HUB.link);
        if link.pid > 0 && link.pid != pid {
            unsafe { libc::kill(link.pid, libc::SIGTERM) };
        }
        *link = Link {
            conn,
            out: Some(out),
            pid,
            ..Link::default()
        };
    }
    std::thread::spawn(|| {
        let hello = json!({"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "brigadier", "version": env!("CARGO_PKG_VERSION")}});
        if send("initialize", hello, START_WAIT, &|| false).is_ok() {
            let _ = push(json!({"jsonrpc": "2.0", "method": "notifications/initialized"}));
            lock(&HUB.link).ready = true;
            HUB.changed.notify_all();
        }
    });
}

/// A line the driver answered, through the helper on `conn`; a replaced helper's late answers go.
pub fn reply(conn: u64, answer: Value) {
    let Some(id) = answer["id"].as_u64() else {
        return;
    };
    let mut link = lock(&HUB.link);
    if link.conn != conn {
        return;
    }
    if let Some(to) = link.waiting.remove(&id) {
        let _ = to.send(answer);
    }
}

/// Connection `conn` went: if it was the helper's, what waits on it fails at once.
pub fn leave(conn: u64) {
    let mut link = lock(&HUB.link);
    if link.conn == conn && link.out.is_some() {
        *link = Link::default();
        HUB.changed.notify_all();
    }
}

fn push(rpc: Value) -> Result<(), Fail> {
    let link = lock(&HUB.link);
    let out = link
        .out
        .as_ref()
        .ok_or_else(|| Fail::NotSent("Brigadier Computer Use stopped.".into()))?;
    out.send(json!({"rpc": rpc}).to_string())
        .map_err(|_| Fail::NotSent("Brigadier Computer Use stopped.".into()))
}

/// One JSON-RPC call to the driver, waiting at most `wait`, or until `cancel` says the caller went.
fn send(
    method: &str,
    params: Value,
    wait: Duration,
    cancel: &dyn Fn() -> bool,
) -> Result<Value, Fail> {
    let (to, answer) = mpsc::channel();
    let id = {
        let mut link = lock(&HUB.link);
        link.next += 1;
        let id = link.next;
        link.waiting.insert(id, to);
        id
    };
    push(json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}))?;
    let until = Instant::now() + wait;
    loop {
        match answer.recv_timeout(Duration::from_millis(250)) {
            Ok(a) => return Ok(a),
            Err(mpsc::RecvTimeoutError::Disconnected) => return Err(Fail::Unknown),
            Err(mpsc::RecvTimeoutError::Timeout) if Instant::now() < until && !cancel() => {}
            Err(_) => {
                lock(&HUB.link).waiting.remove(&id);
                return Err(Fail::Unknown);
            }
        }
    }
}

/// Calls one driver tool: its structured result, or the driver's own words when it failed.
pub(crate) fn tool(
    data: &Path,
    name: &str,
    args: Value,
    cancel: &dyn Fn() -> bool,
) -> Result<Result<Value, String>, Fail> {
    ready(data)?;
    let answer = send(
        "tools/call",
        json!({"name": name, "arguments": args}),
        CALL_WAIT,
        cancel,
    )?;
    if let Some(e) = answer.get("error") {
        return Ok(Err(e["message"]
            .as_str()
            .unwrap_or("The driver refused.")
            .to_string()));
    }
    let result = &answer["result"];
    let text: Vec<&str> = (result["content"].as_array().into_iter().flatten())
        .filter_map(|c| c["text"].as_str())
        .collect();
    let mut structured = result["structuredContent"].clone();
    if result["isError"] == true {
        return Ok(Err(text.join("\n")));
    }
    if structured.is_null() {
        structured = json!({});
    }
    structured["_text"] = text.join("\n").into();
    Ok(Ok(structured))
}

/// The helper is up and its driver answers, launched if it isn't; else why not.
fn ready(data: &Path) -> Result<(), Fail> {
    // Turned off while a call waited: nothing more is sent [D912].
    if !on(data) {
        return Err(Fail::NotSent(verbs::OFF.into()));
    }
    let started = Instant::now();
    let mut link = lock(&HUB.link);
    loop {
        if link.ready {
            return Ok(());
        }
        let launched = *lock(&HUB.launched);
        if launched.is_none_or(|at| at.elapsed() > START_WAIT) {
            drop(link);
            launch(data, None).map_err(|e| Fail::NotSent(e.to_string()))?;
            link = lock(&HUB.link);
            continue;
        }
        if started.elapsed() > START_WAIT {
            return Err(Fail::NotSent(
                "Brigadier Computer Use didn't start. Try again in a moment.".into(),
            ));
        }
        link = HUB
            .changed
            .wait_timeout(link, Duration::from_millis(250))
            .unwrap_or_else(|e| e.into_inner())
            .0;
    }
}

/// The helper app in this build, if it has one.
fn helper_app(data: &Path) -> Option<String> {
    let path = fs::read_to_string(data.join(HELPER_FILE)).ok()?;
    Path::new(path.trim())
        .is_dir()
        .then(|| path.trim().to_string())
}

/// Starts the helper through LaunchServices, behind the user's apps, so macOS charges the grants
/// to it [D913]; `ask` has it ask macOS for a grant first. The one running goes.
fn launch(data: &Path, ask: Option<&str>) -> io::Result<()> {
    let app = helper_app(data).ok_or_else(|| {
        io::Error::other("This build of Brigadier has no Brigadier Computer Use.")
    })?;
    stop_helper();
    *lock(&HUB.launched) = Some(Instant::now());
    let mut open = Command::new("/usr/bin/open");
    open.stderr(std::process::Stdio::null());
    open.args(["-g", "-j", "-n", "-a", &app, "--args", "--data"])
        .arg(data);
    if let Some(ask) = ask {
        open.args(["--ask", ask]);
    }
    match open.status()?.success() {
        true => Ok(()),
        false => Err(io::Error::other(
            "macOS couldn't open Brigadier Computer Use.",
        )),
    }
}

fn stop_helper() {
    let mut link = lock(&HUB.link);
    if link.pid > 0 {
        unsafe { libc::kill(link.pid, libc::SIGTERM) };
    }
    *link = Link::default();
    HUB.changed.notify_all();
}

pub(crate) fn on(data: &Path) -> bool {
    crate::settings::get(data, SETTING) == "true"
}

/// The grants as the driver says now: Accessibility, Screen Recording. A missing one starts the
/// helper afresh now and then, as macOS answers each process once.
pub(crate) fn grants(data: &Path) -> Result<(bool, bool), Fail> {
    let found = tool(data, "check_permissions", json!({}), &|| false)?.map_err(Fail::NotSent)?;
    let both = (
        found["accessibility"] == true,
        found["screen_recording"] == true,
    );
    *lock(&HUB.grants) = Some(both);
    let stale = lock(&HUB.launched).is_none_or(|at| at.elapsed() > RECHECK);
    // A restart drops the driver's reads, so never under a session that holds the computer.
    if !(both.0 && both.1) && stale && !verbs::held() {
        let _ = launch(data, None);
    }
    Ok(both)
}

fn word(granted: Option<bool>) -> &'static str {
    match granted {
        Some(true) => "granted",
        Some(false) => "notGranted",
        None => "unknown",
    }
}

/// The app's side: `computer status|on|off|grant accessibility|screenRecording` [D911, D912].
pub fn run(data: &Path, args: &[String]) -> io::Result<Value> {
    let arg = |i: usize| args.get(i).map_or("", String::as_str);
    match arg(1) {
        "status" => Ok(status(data)),
        "on" | "off" => {
            let on = arg(1) == "on";
            let set: Vec<String> = ["settings", SETTING, if on { "true" } else { "false" }]
                .map(String::from)
                .into();
            crate::settings::run(data, &set)?;
            match on {
                // Turning it on raises macOS's own prompts for what's missing [D911].
                true if helper_app(data).is_some() => launch(data, Some("all"))?,
                true => {}
                false => {
                    stop_helper();
                    verbs::release_all();
                }
            }
            Ok(json!({"ok": true}))
        }
        "grant" => {
            let ask = match arg(2) {
                a @ ("accessibility" | "screenRecording") => a,
                _ => {
                    return Err(io::Error::other(
                        "usage: brigadier computer grant accessibility|screenRecording",
                    ));
                }
            };
            if !on(data) {
                return Err(io::Error::other("Turn computer use on first."));
            }
            launch(data, Some(ask))?;
            Ok(json!({"ok": true}))
        }
        _ => Err(io::Error::other(
            "usage: brigadier computer status|on|off|grant accessibility|screenRecording",
        )),
    }
}

fn status(data: &Path) -> Value {
    let last = *lock(&HUB.grants);
    let reply = |helper: &str, grants: Option<(bool, bool)>, error: Option<String>| {
        let mut r = json!({"ok": true, "on": on(data), "helper": helper, "accessibility": word(grants.map(|g| g.0)), "screenRecording": word(grants.map(|g| g.1))});
        if let Some(e) = error {
            r["error"] = e.into();
        }
        r
    };
    if !on(data) {
        return reply("off", None, None);
    }
    if helper_app(data).is_none() {
        return reply("absent", None, None);
    }
    if !lock(&HUB.link).ready {
        let launched = *lock(&HUB.launched);
        if launched.is_none_or(|at| at.elapsed() > START_WAIT) {
            let failed = launched.is_some();
            if let Err(e) = launch(data, None) {
                return reply("failed", last, Some(e.to_string()));
            }
            if failed {
                return reply(
                    "failed",
                    last,
                    Some(
                        "Brigadier Computer Use didn't start; Brigadier is starting it again."
                            .into(),
                    ),
                );
            }
        }
        return reply("starting", last, None);
    }
    match grants(data) {
        Ok(g) => reply("ready", Some(g), None),
        Err(Fail::NotSent(e)) => reply("failed", last, Some(e)),
        Err(Fail::Unknown) => reply(
            "failed",
            last,
            Some("Brigadier Computer Use didn't answer.".into()),
        ),
    }
}
