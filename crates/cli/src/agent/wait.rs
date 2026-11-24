//! `brigadier wait`: until a session stops working or needs its user, or its worker asks.

use super::{refuse, str_of};
use crate::workers;
use serde_json::{Value, json};
use std::path::Path;
use std::thread;
use std::time::{Duration, Instant};

/// Waits for the first of `ids` to stop working or need its user; what waits of the user's
/// terminals goes first, taken once [D316].
pub(super) fn wait(
    data: &Path,
    me: &str,
    ids: &[String],
    secs: u64,
    rows: &dyn Fn() -> Vec<Value>,
    here: &dyn Fn() -> bool,
) -> Value {
    let mut reply = until(data, me, ids, secs, rows, here);
    if reply["ok"] == true
        && let Some(notes) = workers::take_shell(data, me)
    {
        reply["text"] = format!("{notes}\n\n{}", reply["text"].as_str().unwrap_or("")).into();
        reply["terminals"] = notes.into();
    }
    reply
}

fn until(
    data: &Path,
    me: &str,
    ids: &[String],
    secs: u64,
    rows: &dyn Fn() -> Vec<Value>,
    here: &dyn Fn() -> bool,
) -> Value {
    let started = Instant::now();
    let mine = ids.iter().all(|w| workers::record(data, me, w).is_some());
    let mut state = String::new();
    loop {
        let rows = rows();
        for id in ids.iter().map(String::as_str) {
            let Some(row) = rows.iter().find(|r| r["id"] == id) else {
                return refuse(&format!("Session {id} is gone."));
            };
            state = str_of(row, "state").to_string();
            // What the user told its worker comes at once, once, though it still works [D304].
            if let Some(told) = workers::told_take(data, me, id) {
                let done = row["running"] != true && !workers::owes(data, id);
                return json!({"ok": true, "done": done, "id": id, "state": state, "result": told, "text": told});
            }
            // Its worker's ask comes at once, though the worker is still at work [D131].
            if let Some(ask) = workers::take_ask(data, me, id) {
                return json!({"ok": true, "done": true, "id": id, "state": "asking", "result": ask, "text": ask});
            }
            let cut = state == "interrupted" && !crate::queue::goes_on(data, id);
            let idle = row["running"] != true && (cut || !workers::owes(data, id));
            if idle || state == "waiting_answer" || state == "asking" {
                let last = crate::relay::archive(data, id, false)
                    .into_iter()
                    .rev()
                    .find(|e| e.from == "agent");
                let last = last.map(|e| e.text).unwrap_or_default();
                // Its parent's own wait takes the worker's result, which then isn't sent again.
                if let Some(result) = workers::take(data, me, id, None, state == "interrupted") {
                    return json!({"ok": true, "done": true, "id": id, "state": state, "last": last, "result": result, "text": result});
                }
                let text = (state == "waiting_answer")
                    .then(|| workers::for_user(data, id))
                    .flatten()
                    .unwrap_or_else(|| {
                        format!("{id} is {state}. Its last message:\n{}", last.trim_end())
                    });
                return json!({"ok": true, "done": true, "id": id, "state": state, "last": last, "text": text});
            }
        }
        // One's own workers' results and asks reach it by themselves, so a wait on them looks
        // once and returns: a wait in the background can't wake it with nothing new [D529, D599].
        if mine {
            let text = format!(
                "Still working: {}. Its result and questions come to you by themselves, so end your turn.",
                ids.join(", ")
            );
            return json!({"ok": true, "done": false, "state": state, "text": text});
        }
        if started.elapsed() >= Duration::from_secs(secs) || !here() {
            let text = format!(
                "Still working after {secs}s: {}. Wait again, or end your turn and check later.",
                ids.join(", ")
            );
            return json!({"ok": true, "done": false, "state": state, "text": text});
        }
        thread::sleep(Duration::from_millis(500));
    }
}
