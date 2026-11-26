//! Who holds the computer: one session at a time, until its turn ends [D907].

use super::{SESSIONS, asks, lock, refuse};
use serde_json::Value;
use std::sync::Mutex;

/// The session using the computer now [D907].
static HOLDER: Mutex<Option<String>> = Mutex::new(None);

/// A turn ended, stopped or crashed: its session lets the computer go [D907].
pub fn turn_ended(id: &str) {
    asks::ended(id);
    let mut holder = lock(&HOLDER);
    if holder.as_deref() == Some(id) {
        *holder = None;
    }
}

pub(in crate::computer) fn holder() -> Option<String> {
    lock(&HOLDER).clone()
}

pub(in crate::computer) fn release_all() {
    *lock(&HOLDER) = None;
    lock(&SESSIONS).clear();
}

/// Takes the computer for `me`, or names the session that has it [D907]. A holder waiting on the
/// user (a question, an approval) has let it go: its turn goes on only once they answer.
pub(super) fn take(me: &str, rows: &dyn Fn() -> Vec<Value>) -> Result<(), Value> {
    let mut holder = lock(&HOLDER);
    if let Some(id) = holder.as_deref().filter(|id| *id != me) {
        let row = rows().into_iter().find(|r| r["id"] == id);
        if let Some(r) = row.filter(|r| r["running"] == true && r["state"] != "waiting_answer") {
            return Err(refuse(&format!(
                "Computer use is in use by {} in \"{}\" (session {id}). Try again after its turn, or do something else.",
                r["backend"].as_str().unwrap_or("another agent"),
                r["title"].as_str().unwrap_or(id)
            )));
        }
    }
    *holder = Some(me.to_string());
    Ok(())
}
