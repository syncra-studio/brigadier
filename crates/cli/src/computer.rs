//! Computer use [D2032]: the agents' `brigadier computer …` (verbs.rs) and the app's
//! `computer status|on|off|grant`. The grants sit on "Brigadier Computer Use", a helper app of
//! its own that LaunchServices starts, so they're charged to it and never to Brigadier or an
//! agent's shell [D908, D913]. It runs the pinned Cua Driver over its own pipes and connects out to
//! this daemon, which sends it each call: no other process can reach the driver. Everything else
//! lives here: the one-at-a-time lock [D907], the block list [D903] and the pause [D910].

mod status;
mod verbs;

pub(crate) use verbs::asks::answered;
pub use verbs::turn_ended;
pub(crate) use verbs::{HELP, VERBS};

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
pub const SETTING: &str = "computer_use";
/// The agent cursor's setting, on unless the user turns it off [D956].
pub const CURSOR: &str = "computer_cursor";
pub const WEB: &str = "computer_web";
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
    /// Why this helper runs with no agent cursor, when it said so [D956].
    no_cursor: Option<String>,
}

#[derive(Default)]
struct Hub {
    link: Mutex<Link>,
    changed: Condvar,
    /// When the helper was last launched, and with what it asked macOS for.
    launched: Mutex<Option<Instant>>,
    /// The grants as the driver last said: Accessibility, Screen Recording.
    grants: Mutex<Option<(bool, bool)>>,
    /// The sessions whose agent cursor was last told to hide [D956].
    hidden: Mutex<std::collections::HashSet<String>>,
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
    let mut link = lock(&HUB.link);
    if link.conn != conn {
        return;
    }
    // Its one notice: Cua's private worker didn't start, so no cursor shows [D956].
    if answer["method"] == "brigadier/cursor" {
        let why = answer["params"]["error"].as_str().unwrap_or("").to_string();
        eprintln!("brigadierd: computer use runs without its agent cursor: {why}");
        link.no_cursor = Some(why);
        return;
    }
    let Some(id) = answer["id"].as_u64() else {
        return;
    };
    if let Some(to) = link.waiting.remove(&id) {
        let _ = to.send(answer);
    }
}

/// Connection `conn` went: if it was the helper's, what waits on it fails at once, and while
/// computer use is on it starts again now, as macOS's Quit & Reopen copy has no daemon [D963].
pub fn leave(data: &Path, conn: u64) {
    let mut link = lock(&HUB.link);
    if link.conn == conn && link.out.is_some() {
        *link = Link::default();
        HUB.changed.notify_all();
        drop(link);
        // One that dies as it starts waits for the next call, so a crash can't loop.
        let old = lock(&HUB.launched).is_none_or(|at| at.elapsed() > RECHECK);
        if old && on(data) {
            let data = data.to_path_buf();
            std::thread::spawn(move || launch(&data, None));
        }
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
    waited(data, name, args, CALL_WAIT, cancel)
}

/// `tool`, waiting at most `wait` for the answer.
fn waited(
    data: &Path,
    name: &str,
    args: Value,
    wait: Duration,
    cancel: &dyn Fn() -> bool,
) -> Result<Result<Value, String>, Fail> {
    ready(data)?;
    if let Some(session) = args.get("session").filter(|_| name != SHOW_CURSOR) {
        sync_cursor(data, session, cancel);
        // The caller went while it waited: the action isn't sent.
        if cancel() {
            return Err(Fail::NotSent("Stopped.".into()));
        }
    }
    if let Some(why) = verbs::still::closed(name, &args) {
        return Err(Fail::NotSent(why));
    }
    let answer = send(
        "tools/call",
        json!({"name": name, "arguments": args}),
        wait,
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

/// One of the helper's own calls (`brigadier/<method>`, its ax.rs) [D928]: its result, or why not.
pub(crate) fn own(
    data: &Path,
    method: &str,
    params: Value,
    cancel: &dyn Fn() -> bool,
) -> Result<Result<Value, String>, Fail> {
    ready(data)?;
    if let Some(why) = verbs::still::closed(method, &params) {
        return Err(Fail::NotSent(why));
    }
    let answer = send(&format!("brigadier/{method}"), params, CALL_WAIT, cancel)?;
    Ok(match answer["error"]["message"].as_str() {
        Some(e) => Err(e.to_string()),
        None => Ok(answer["result"].clone()),
    })
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

/// Cua's switch for one session's agent cursor.
const SHOW_CURSOR: &str = "set_agent_cursor_enabled";

fn cursor(data: &Path) -> bool {
    crate::settings::get(data, CURSOR) == "true"
}

/// Show cursor was switched: the session using the computer now sees it at once [D956]. Never
/// starts the helper for it.
pub(crate) fn cursor_switched(data: &Path) {
    let Some(me) = verbs::holder() else { return };
    if !on(data) || !lock(&HUB.link).ready {
        return;
    }
    let data = data.to_path_buf();
    std::thread::spawn(move || sync_cursor(&data, &json!(me), &|| false));
}

/// Cua's cursor for `session` as Show cursor says [D956]. Cua's sessions forget a hidden cursor
/// after 5 minutes idle, so a hide goes with each call; a show goes once, after a hide.
fn sync_cursor(data: &Path, session: &Value, cancel: &dyn Fn() -> bool) {
    let show = cursor(data);
    let key = session.as_str().unwrap_or("").to_string();
    {
        let mut hidden = lock(&HUB.hidden);
        match show {
            true if !hidden.remove(&key) => return,
            true => {}
            false => {
                hidden.insert(key);
            }
        }
    }
    let args = json!({"session": session, "enabled": show});
    let _ = send(
        "tools/call",
        json!({"name": SHOW_CURSOR, "arguments": args}),
        CALL_WAIT,
        cancel,
    );
}

/// Session `id` is using the computer now: it holds the lock [D907].
pub fn holds(id: &str) -> bool {
    verbs::holder().as_deref() == Some(id)
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
    // A restart drops the driver's reads, so never under a session or a test that holds the computer.
    if !(both.0 && both.1) && stale && verbs::holder().is_none() && !verbs::testing() {
        let _ = launch(data, None);
    }
    Ok(both)
}

/// An agent's `brigadier computer …`. A chat's lead hands it to a worker [D931]: refused here,
/// as the words alone didn't hold [D941]; its help stays open.
pub fn agent(
    data: &Path,
    me: &str,
    args: &[String],
    rows: &dyn Fn() -> Vec<Value>,
    here: &dyn Fn() -> bool,
) -> Value {
    let help = args.get(1).is_none_or(|v| v == "help") || args.iter().any(|a| a == "--help");
    let lead = !help && brigadier_core::load(data, me).is_ok_and(|s| !s.naked);
    match lead.then(|| crate::routing::computer_job(data)).flatten() {
        Some(job) => crate::agent::refuse(&format!(
            "Computer use runs in a worker: brigadier start --job \"{job}\" \"<brief>\""
        )),
        _ => verbs::agent(data, me, args, rows, here),
    }
}

/// Off by any path ends the helper, the holder and every yes [D46].
pub fn turned_off() {
    stop_helper();
    verbs::release_all();
    verbs::asks::forget();
}

/// The app's `computer test <pid> <window>`, with the daemon's rows: who holds the computer [D907].
pub fn test(data: &Path, args: &[String], rows: &dyn Fn() -> Vec<Value>) -> io::Result<Value> {
    status::test(data, args, rows)
}

/// The app's side: `computer status|on|off|grant accessibility|screenRecording|test` [D911, D912].
pub fn run(data: &Path, args: &[String]) -> io::Result<Value> {
    let arg = |i: usize| args.get(i).map_or("", String::as_str);
    match arg(1) {
        "status" => Ok(status::status(data)),
        "on" | "off" => {
            let on = arg(1) == "on";
            let set: Vec<String> = ["settings", SETTING, if on { "true" } else { "false" }]
                .map(String::from)
                .into();
            crate::settings::run(data, &set)?;
            // Turning it on raises macOS's own prompts for what's missing [D911].
            if on && helper_app(data).is_some() {
                launch(data, Some("all"))?;
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
            "usage: brigadier computer status|on|off|grant accessibility|screenRecording|test <pid> <window>",
        )),
    }
}
