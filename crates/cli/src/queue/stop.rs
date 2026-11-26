//! The Stop of a running turn [D159].

use super::{change, cut};
use crate::{control, owner};
use brigadier_core as core;
use serde_json::{Value, json};
use std::io;
use std::path::Path;

/// Stop [D159]: the queue is paused first, so nothing goes on while the turn ends, and stays paused
/// if anything waits, including what was added during the Stop. Then the agent's own stop, and the
/// kill only when it has none or it didn't stop in time. `by`: "user", or "pause" for a worker's Pause.
pub fn stop(data: &Path, id: &str, by: &str) -> io::Result<Value> {
    let dir = core::session_dir(data, id);
    change(&dir, |q| {
        (q.paused, q.stopping) = (true, true);
        Ok(())
    })?;
    let stopped = (|| {
        if let Ok(Some(stopped)) = control::interrupt(data, id, by) {
            return Ok(stopped);
        }
        match owner::call(data, id, json!({"op": "stop", "by": by})) {
            Ok(v) => Ok(v),
            // A cut-off worker's is logged, so its parent's next message waits for Resume.
            Err(_) if by == "user" && cut::stoppable(data, id) => {
                owner::ensure(data, &core::load(data, id)?)?;
                owner::call(data, id, json!({"op": "stop", "by": by}))
            }
            // No owner: nothing can be running under us, but leftovers recorded in the log still go.
            Err(e) => {
                let f = core::fold(&dir, true)?;
                Ok(json!({"ok": true, "owner": e.to_string(), "swept": core::sweep(&f.fold, &dir)}))
            }
        }
    })();
    change(&dir, |q| {
        q.stopping = false;
        Ok(())
    })?;
    stopped
}
