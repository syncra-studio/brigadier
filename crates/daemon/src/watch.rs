//! Following one session's thread: its snapshot, then what changed, until the client moves on.

use super::store::Store;
use brigadier_core::fold;
use brigadier_core::thread::{Saved, Thread};
use brigadier_core::{check_id, session_dir};
use brigadier_frames::log::now_ms;
use brigadier_frames::procs;
use serde_json::{Value, json};
use std::fs;
use std::io;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// How often an open thread checks its log for new frames.
const FOLLOW: Duration = Duration::from_millis(100);

pub(super) type Shown = Arc<Mutex<Option<(String, Arc<Mutex<Saved>>)>>>;

/// Sends a session's thread, from the store's copy folded to the log's end [D503], then follows
/// the log and sends what changed, numbered on from the snapshot and tagged with this watch's
/// request, until `watching` moves past `mine`. A host that died mid-turn writes no frame, so the
/// live state ends such a turn [D60]; a worker that ended with no note of it lets go of the turn it
/// held [D336]. Those ends stay in this copy, never saved. The thread is locked while a change is
/// taken and sent, so an older page never passes it.
/// With no `mine` it's a peek: the snapshot only, nothing shown or followed.
#[allow(clippy::too_many_arguments)]
pub(super) fn watch(
    data: &Path,
    id: &str,
    title: Value,
    (from, to): (Option<u64>, Option<u64>),
    re: Value,
    out: &Sender<String>,
    mine: Option<u64>,
    watching: &AtomicU64,
    shown: &Shown,
    store: &Store,
) {
    let dir = session_dir(data, id);
    if check_id(id).is_err() || !dir.join("session.json").exists() {
        let _ = out.send(json!({"re": re, "ok": false, "error": "not_found"}).to_string());
        return;
    }
    let (mut setup_at, mut setup) = (None, Value::Null);
    let mut drain = |saved: &mut Saved| -> io::Result<()> {
        // Setup writes rename files in the session directory, so unchanged ticks need only a stat.
        let at = fs::metadata(&dir).and_then(|m| m.modified()).ok();
        if at != setup_at {
            setup = brigadier_core::worktrees::setup_state(&dir, true);
            setup_at = at;
        }
        saved.advance(&dir, false)?;
        let thread = &mut saved.thread;
        let alive = !thread.setup_running(&setup)
            || (thread
                .status_fold()
                .child
                .as_ref()
                .is_some_and(|c| !c.exited)
                && brigadier::owner::state(data, id) != fold::Owner::Dead);
        thread.sync_setup(setup.clone(), alive);
        Ok(())
    };
    let interrupted = |thread: &mut Thread| {
        thread.workers_over(|w| brigadier::workers::over(data, id, w));
        if !thread.running() {
            return;
        }
        let owner = brigadier::owner::state(data, id);
        let live = fold::live(thread.status_fold(), owner, &dir, &procs::all());
        if fold::status(thread.status_fold(), &live)["state"] == "interrupted" {
            thread.interrupt(now_ms());
        }
    };
    let title = title.as_str().unwrap_or("");
    // A saved row that can't be read: what was saved goes, and it's folded once more from the log.
    let mut tries = 0;
    let (saved, session) = loop {
        let mut saved = match store
            .copy(data, id)
            .and_then(|mut s| drain(&mut s).map(|()| s))
        {
            Ok(saved) => saved,
            Err(e) => {
                let _ =
                    out.send(json!({"re": re, "ok": false, "error": e.to_string()}).to_string());
                return;
            }
        };
        interrupted(&mut saved.thread);
        let session = saved.thread.session(id, title, from, to);
        if !saved.thread.items.broken() || tries > 0 {
            break (saved, session);
        }
        store.invalidate(data, id);
        tries += 1;
    };
    let shared = Arc::new(Mutex::new(saved));
    let thread = shared.lock().unwrap();
    // Shown before the snapshot goes, so its older pages can be asked for at once.
    if let Some(mine) = mine {
        let mut shown = shown.lock().unwrap();
        if watching.load(Ordering::SeqCst) == mine {
            *shown = Some((id.to_string(), shared.clone()));
        }
    }
    let snapshot = json!({"re": re, "ok": true, "n": 0, "session": session});
    let Some(mine) = mine else {
        let _ = out.send(snapshot.to_string());
        return;
    };
    if out.send(snapshot.to_string()).is_err() {
        return;
    }
    drop(thread);
    let tag = |mut frame: Value| {
        frame["thread"] = id.into();
        frame["watch"] = re.clone();
        frame.to_string()
    };
    let (mut n, mut changed) = (0u64, 0);
    for tick in 1u64.. {
        // A queue change can be a message steered in: shown as it leaves the queue [D30].
        changed = brigadier::queue::wake::changed(changed, FOLLOW);
        if watching.load(Ordering::SeqCst) != mine {
            return;
        }
        let mut saved = shared.lock().unwrap();
        // Deleted: say so.
        if !dir.join("session.json").exists() {
            let _ = out.send(tag(json!({"error": "not_found"})));
            return;
        }
        // A damaged frame stays damaged: say so once and stop following.
        if let Err(e) = drain(&mut saved) {
            let _ = out.send(tag(json!({"error": e.to_string()})));
            return;
        }
        // A rewind's rows are gone from what was sent, a log made again under the same id isn't
        // this one, and a saved row that couldn't be read leaves pages wrong: the client asks for a
        // fresh thread.
        if saved.rewound || saved.thread.items.broken() {
            if saved.thread.items.broken() {
                store.invalidate(data, id);
            }
            let _ = out.send(tag(json!({"reset": true})));
            return;
        }
        let thread = &mut saved.thread;
        if tick % 10 == 0 {
            interrupted(thread);
        }
        if let Some(mut update) = thread.take() {
            n += 1;
            update["n"] = n.into();
            if out.send(tag(update)).is_err() {
                return;
            }
        }
    }
}
