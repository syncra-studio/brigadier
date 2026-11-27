//! Who holds the computer: one session at a time, until its turn ends [D907].

use super::{SESSIONS, asks, lock, refuse};
use serde_json::Value;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};

/// The session using the computer now, and when it last took it (ms) [D907].
static HOLDER: Mutex<Option<(String, u64)>> = Mutex::new(None);
/// The user's Test screen access has the computer until its capture is answered [C91].
static TESTING: AtomicBool = AtomicBool::new(false);

pub(in crate::computer) fn testing() -> bool {
    TESTING.load(Ordering::SeqCst)
}

/// Takes the computer for the user's test, under the lock a session takes it with, or says why not.
pub(in crate::computer) fn test_take() -> Result<(), &'static str> {
    let holder = lock(&HOLDER);
    match holder.is_some() {
        true => Err("An agent is using the computer now. Test again after its turn."),
        false if TESTING.swap(true, Ordering::SeqCst) => {
            Err("Brigadier is testing screen access already.")
        }
        false => Ok(()),
    }
}

pub(in crate::computer) fn test_done() {
    TESTING.store(false, Ordering::SeqCst);
}

/// A turn ended, stopped or crashed at `finished` (ms): its session lets the computer go [D907].
/// The daemon may hear of it late: a hold its next turn took since stays.
pub fn turn_ended(id: &str, finished: u64) {
    asks::ended(id);
    let mut holder = lock(&HOLDER);
    if holder
        .as_ref()
        .is_some_and(|(h, at)| h == id && *at <= finished)
    {
        *holder = None;
    }
}

pub(in crate::computer) fn holder() -> Option<String> {
    lock(&HOLDER).as_ref().map(|(h, _)| h.clone())
}

pub(in crate::computer) fn release_all() {
    *lock(&HOLDER) = None;
    lock(&SESSIONS).clear();
}

/// Takes the computer for `me`, or names the session that has it [D907]. A holder waiting on the
/// user (a question, an approval) has let it go: its turn goes on only once they answer.
pub(super) fn take(me: &str, rows: &dyn Fn() -> Vec<Value>) -> Result<(), Value> {
    let mut holder = lock(&HOLDER);
    if testing() {
        return Err(refuse(
            "The user is testing screen access in Settings. Try again in a moment.",
        ));
    }
    if let Some(id) = holder
        .as_ref()
        .map(|(h, _)| h.as_str())
        .filter(|id| *id != me)
    {
        let row = rows().into_iter().find(|r| r["id"] == id);
        if let Some(r) = row.filter(|r| r["running"] == true && r["state"] != "waiting_answer") {
            return Err(refuse(&format!(
                "Computer use is in use by {} in \"{}\" (session {id}). Try again after its turn, or do something else.",
                r["backend"].as_str().unwrap_or("another agent"),
                r["title"].as_str().unwrap_or(id)
            )));
        }
    }
    *holder = Some((me.to_string(), brigadier_frames::log::now_ms()));
    Ok(())
}
