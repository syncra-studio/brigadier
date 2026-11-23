//! A queue change wakes the daemon's pass and its open threads, so the change and the message it
//! delivered go out together, at once, not at their next ticks [D30].

use super::Queue;
use brigadier_core as core;
use std::io;
use std::path::Path;
use std::sync::{Condvar, Mutex};
use std::time::Duration;

/// How many times a queue changed in this process.
static CHANGED: (Mutex<u64>, Condvar) = (Mutex::new(0), Condvar::new());

/// Writes the queue as a new file renamed into place, and wakes whoever waits on a change.
pub(super) fn write(dir: &Path, q: &Queue) -> io::Result<()> {
    core::write_atomic(&dir.join("queue.json"), &serde_json::to_vec(q)?)?;
    *CHANGED.0.lock().unwrap() += 1;
    CHANGED.1.notify_all();
    Ok(())
}

/// Waits until a queue changed after count `seen`, at most `most`; answers the count now.
pub fn changed(seen: u64, most: Duration) -> u64 {
    let (count, wake) = &CHANGED;
    *wake
        .wait_timeout_while(count.lock().unwrap(), most, |n| *n == seen)
        .unwrap()
        .0
}
