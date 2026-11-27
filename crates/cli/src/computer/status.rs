//! The app's live read of computer use, and its Test screen access [D911, D912, C91].

use super::{
    CALL_WAIT, Fail, HUB, START_WAIT, grants, helper_app, launch, lock, on, verbs, waited,
};
use serde_json::{Value, json};
use std::path::Path;
use std::sync::mpsc;
use std::time::Duration;
use std::{io, thread};

/// How long a test's capture may wait on the user answering macOS's alert: the driver may hold it
/// that long, so the test keeps the computer, and status keeps off the driver, until it's answered.
const ALERT_WAIT: Duration = Duration::from_secs(120);

pub(super) fn status(data: &Path) -> Value {
    let last = *lock(&HUB.grants);
    let no_cursor = lock(&HUB.link).no_cursor.clone();
    let reply = |helper: &str, grants: Option<(bool, bool)>, error: Option<String>| {
        let mut r = json!({"ok": true, "on": on(data), "helper": helper, "accessibility": word(grants.map(|g| g.0)), "screenRecording": word(grants.map(|g| g.1)), "noCursor": no_cursor});
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
    // A test's capture may wait behind macOS's alert, and the driver with it: the last grants stand.
    if verbs::testing() {
        return reply("ready", last, None);
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

/// Test screen access, the user's click in Settings › Computer use: one throwaway capture of the
/// window they clicked in (`pid`, `window`), so macOS's capture alert comes now, while they're
/// there, and not at an agent's first screenshot mid-task [C91, D2032, D909]. It holds the
/// computer as a session would, so none takes it meanwhile [D907]; nothing is kept.
pub(super) fn test(
    data: &Path,
    args: &[String],
    rows: &dyn Fn() -> Vec<Value>,
) -> io::Result<Value> {
    let n = |i: usize| (args.get(i)?.parse::<i64>().ok()).filter(|v| *v > 0);
    let (Some(pid), Some(window)) = (n(2), n(3)) else {
        return Err(io::Error::other(
            "usage: brigadier computer test <pid> <window>",
        ));
    };
    if !on(data) {
        return Err(io::Error::other("Turn computer use on first."));
    }
    verbs::test_take(rows).map_err(io::Error::other)?;
    let shot = json!({"pid": pid, "window_id": window, "include_accessibility_tree": false});
    let (to, answer) = mpsc::channel();
    let data = data.to_path_buf();
    thread::spawn(move || {
        let capture = |shot| waited(&data, "get_window_state", shot, ALERT_WAIT, &|| false);
        let found = verbs::shot::throwaway(shot, capture);
        verbs::test_done();
        let _ = to.send(found);
    });
    let found = answer.recv_timeout(CALL_WAIT).unwrap_or(Err(Fail::Unknown));
    let why = match found {
        Ok(Ok(found)) if !found["screenshot_file_path"].is_null() => return Ok(json!({"ok": true})),
        Ok(Ok(found)) => format!(
            "Couldn't capture Brigadier's window: {}.",
            (found["screenshot_error"]["code"].as_str()).unwrap_or("no picture came back")
        ),
        Ok(Err(why)) | Err(Fail::NotSent(why)) => why,
        // Proposed: the capture may be waiting on macOS's own question; it goes on behind.
        Err(Fail::Unknown) => "Brigadier Computer Use didn't answer in time. If macOS asks you to allow it, choose Allow.".into(),
    };
    Err(io::Error::other(why))
}

fn word(granted: Option<bool>) -> &'static str {
    match granted {
        Some(true) => "granted",
        Some(false) => "notGranted",
        None => "unknown",
    }
}
