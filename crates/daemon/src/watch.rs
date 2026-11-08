//! Following one session's thread: its snapshot, then what changed, until the client moves on.

use brigadier_core::fold;
use brigadier_core::norm::Norm;
use brigadier_core::thread::Thread;
use brigadier_core::{check_id, session_dir};
use brigadier_frames::log::{Reader, now_ms};
use brigadier_frames::procs;
use serde_json::{Value, json};
use std::fs;
use std::io;
use std::os::unix::fs::MetadataExt;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

/// How often an open thread checks its log for new frames.
const FOLLOW: Duration = Duration::from_millis(100);

pub(super) type Shown = Arc<Mutex<Option<(String, Arc<Mutex<Thread>>)>>>;

/// Folds a session's log into its thread, sends it, then follows the log and sends what changed,
/// numbered on from the snapshot and tagged with this watch's request, until `watching` moves past
/// `mine`. A host that died mid-turn writes no frame, so the live state ends such a turn [D60].
/// The thread is locked while a change is taken and sent, so an older page never passes it.
// shortcut: every open folds the whole log; add a thread checkpoint once long sessions make opening
// slow.
#[allow(clippy::too_many_arguments)]
pub(super) fn watch(
    data: &Path,
    id: &str,
    title: Value,
    re: Value,
    out: &Sender<String>,
    mine: u64,
    watching: &AtomicU64,
    shown: &Shown,
) {
    let dir = session_dir(data, id);
    if check_id(id).is_err() || !dir.join("session.json").exists() {
        let _ = out.send(json!({"re": re, "ok": false, "error": "not_found"}).to_string());
        return;
    }
    let (shared, mut norm, mut items) = (Arc::<Mutex<Thread>>::default(), Norm::default(), vec![]);
    let mut thread = shared.lock().unwrap();
    let mut reader: Option<Reader> = None;
    let (mut setup_at, mut setup) = (None, Value::Null);
    let log = dir.join("log");
    let inode = |path: &Path| fs::metadata(path).map(|m| m.ino()).ok();
    let mut drain = |thread: &mut Thread| -> io::Result<()> {
        // Setup writes rename files in the session directory, so unchanged ticks need only a stat.
        let at = fs::metadata(&dir).and_then(|m| m.modified()).ok();
        if at != setup_at {
            setup = brigadier_core::worktrees::setup_state(&dir, true);
            setup_at = at;
        }
        // A session just created may have no log yet.
        if reader.is_none() && log.exists() {
            reader = Some(Reader::open(&log, 0, 0)?);
        }
        while let Some(frame) = reader.as_mut().map(Reader::frame).transpose()?.flatten() {
            norm.push(&frame, &mut items);
            for item in items.drain(..) {
                thread.push(&item);
            }
        }
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
        let owner = brigadier::owner::state(data, id);
        let live = fold::live(thread.status_fold(), owner, data, &procs::all());
        if thread.running() && fold::status(thread.status_fold(), &live)["state"] == "interrupted" {
            thread.interrupt(now_ms());
        }
    };
    if let Err(e) = drain(&mut thread) {
        let _ = out.send(json!({"re": re, "ok": false, "error": e.to_string()}).to_string());
        return;
    }
    interrupted(&mut thread);
    let title = title.as_str().unwrap_or("");
    // Shown before the snapshot goes, so its older pages can be asked for at once.
    {
        let mut shown = shown.lock().unwrap();
        if watching.load(Ordering::SeqCst) == mine {
            *shown = Some((id.to_string(), shared.clone()));
        }
    }
    let snapshot = json!({"re": re, "ok": true, "n": 0, "session": thread.session(id, title)});
    if out.send(snapshot.to_string()).is_err() {
        return;
    }
    drop(thread);
    let tag = |mut frame: Value| {
        frame["thread"] = id.into();
        frame["watch"] = re.clone();
        frame.to_string()
    };
    let (mut opened, mut n) = (inode(&log), 0u64);
    for tick in 1u64.. {
        thread::sleep(FOLLOW);
        if watching.load(Ordering::SeqCst) != mine {
            return;
        }
        let mut thread = shared.lock().unwrap();
        // Deleted: say so. Replaced (deleted and made again): the client asks for a fresh thread.
        if !dir.join("session.json").exists() {
            let _ = out.send(tag(json!({"error": "not_found"})));
            return;
        }
        let now = inode(&log);
        if opened.is_some() && now != opened {
            let _ = out.send(tag(json!({"reset": true})));
            return;
        }
        opened = now;
        // A damaged frame stays damaged: say so once and stop following.
        if let Err(e) = drain(&mut thread) {
            let _ = out.send(tag(json!({"error": e.to_string()})));
            return;
        }
        if tick % 10 == 0 && thread.running() {
            interrupted(&mut thread);
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
