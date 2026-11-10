//! The checkouts the app's panel shows, each watched once however many ask [D48, D71].
//!
//! `{"id", "op": "git", "session" | "project"}` answers `{"re", "ok", "n", "git": {"head", "files"}}`,
//! the checkout's status at N, then pushes `{"git": <that id>, "watch": <re>, "n": N+1, "head",
//! "files", "gone"}`: the head whole, the files new or changed by path, the paths no longer changed.
//! A read that fails pushes `{"git", "watch", "error"}` once and ends the watch. One git watch per
//! connection: a new request ends the last. Every connection on one checkout shares its watcher,
//! which goes with the last of them. `{"id", "op": "git_refresh"}` reads it again now, as on window
//! focus; a turn's start or end in a session does the same for its checkout.

use brigadier_core::git::{self, Status, Target, watch::Watch};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex};

struct Sub {
    conn: u64,
    re: Value,
    /// The session or project it asked for, which its pushes name.
    name: String,
    session: bool,
    out: Sender<String>,
    /// Its snapshot waits for the watcher's first read.
    waiting: bool,
}

#[derive(Default)]
struct Seen {
    n: u64,
    last: Option<Status>,
    subs: Vec<Sub>,
    /// Its watch ended on an error: the next request starts a new one.
    ended: bool,
}

struct Watched {
    seen: Arc<Mutex<Seen>>,
    watch: Watch,
}

/// By the checkout's top folder. Locked before any `Seen`. A watch is only dropped (which waits for
/// its thread, and that thread takes its `Seen`) with neither held.
static WATCHED: Mutex<BTreeMap<PathBuf, Watched>> = Mutex::new(BTreeMap::new());

/// Takes `conn`'s subscription out of every watcher, and the watchers no one is left on, for the
/// caller to drop once it lets go of the map.
fn sweep(all: &mut BTreeMap<PathBuf, Watched>, conn: u64) -> Vec<Watched> {
    let done: Vec<PathBuf> = (all.iter())
        .filter(|(_, w)| {
            let mut seen = w.seen.lock().unwrap();
            seen.subs.retain(|s| s.conn != conn);
            seen.subs.is_empty() || seen.ended
        })
        .map(|(root, _)| root.clone())
        .collect();
    done.iter().filter_map(|root| all.remove(root)).collect()
}

/// Sends a watcher's read to everyone on it: the snapshot to those waiting for one, what changed to
/// the rest. An error goes to all, and ends it.
fn deliver(seen: &Mutex<Seen>, read: io::Result<Status>) -> bool {
    let mut seen = seen.lock().unwrap();
    let status = match read {
        Ok(status) => status,
        Err(e) => {
            for sub in seen.subs.drain(..) {
                let error = match sub.waiting {
                    true => json!({"re": sub.re, "ok": false, "error": e.to_string()}),
                    false => json!({"git": sub.name, "watch": sub.re, "error": e.to_string()}),
                };
                let _ = sub.out.send(error.to_string());
            }
            seen.ended = true;
            return false;
        }
    };
    let delta = seen.last.as_ref().and_then(|old| status.delta(old));
    seen.n += delta.is_some() as u64;
    let (n, snapshot) = (seen.n, status.json());
    seen.subs.retain_mut(|sub| {
        let frame = match (&delta, sub.waiting) {
            (_, true) => json!({"re": sub.re, "ok": true, "n": n, "git": snapshot}),
            (Some(delta), false) => {
                let mut push = delta.clone();
                (push["git"], push["watch"], push["n"]) =
                    (sub.name.clone().into(), sub.re.clone(), n.into());
                push
            }
            (None, false) => return true,
        };
        sub.waiting = false;
        sub.out.send(frame.to_string()).is_ok()
    });
    seen.last = Some(status);
    true
}

/// Starts `conn`'s git watch, unless a newer request from it (`gitting` past `mine`) came first.
/// Resolving the checkout runs git, so this runs off the connection's thread.
pub(super) fn subscribe(
    data: &Path,
    conn: u64,
    req: &Value,
    out: &Sender<String>,
    mine: u64,
    gitting: &AtomicU64,
) {
    let re = req["id"].clone();
    let (target, name, session) = match (req["session"].as_str(), req["project"].as_str()) {
        (Some(id), _) => (Target::Session(id), id, true),
        (None, Some(id)) => (Target::Project(id), id, false),
        _ => {
            let error = json!({"re": re, "ok": false, "error": "git needs a session or project"});
            let _ = out.send(error.to_string());
            return;
        }
    };
    let checkout = git::checkout(data, &target);
    let mut all = WATCHED.lock().unwrap();
    if gitting.load(Ordering::SeqCst) != mine {
        return;
    }
    let left = sweep(&mut all, conn);
    let checkout = match checkout {
        Ok(checkout) => checkout,
        Err(e) => {
            drop(all);
            drop(left);
            let error = match e.kind() {
                io::ErrorKind::NotFound => "not_found".to_string(),
                _ => e.to_string(),
            };
            let _ = out.send(json!({"re": re, "ok": false, "error": error}).to_string());
            return;
        }
    };
    let mut sub = Sub {
        conn,
        re,
        name: name.into(),
        session,
        out: out.clone(),
        waiting: true,
    };
    if let Some(w) = all.get(&checkout.root) {
        let mut seen = w.seen.lock().unwrap();
        // Joined at its last read: its snapshot goes now, numbered where the others are.
        if let Some(last) = &seen.last {
            let snapshot = json!({"re": sub.re, "ok": true, "n": seen.n, "git": last.json()});
            sub.waiting = false;
            let _ = out.send(snapshot.to_string());
        }
        seen.subs.push(sub);
    } else {
        let seen = Arc::new(Mutex::new(Seen {
            subs: vec![sub],
            ..Seen::default()
        }));
        let shared = seen.clone();
        let root = checkout.root.clone();
        let watch = Watch::start(checkout, move |read| deliver(&shared, read));
        all.insert(root, Watched { seen, watch });
    }
    drop(all);
    drop(left);
}

/// The connection closed, or its watch was asked to end.
pub(super) fn leave(conn: u64) {
    let left = sweep(&mut WATCHED.lock().unwrap(), conn);
    drop(left);
}

/// Reads again now every checkout `wanted` says, as on focus.
fn poke(wanted: impl Fn(&Sub) -> bool) {
    for w in WATCHED.lock().unwrap().values() {
        if w.seen.lock().unwrap().subs.iter().any(&wanted) {
            w.watch.poke();
        }
    }
}

/// Window focus: reads `conn`'s checkout again now.
pub(super) fn refresh(conn: u64) {
    poke(|sub| sub.conn == conn);
}

/// A turn began or ended in these sessions: their checkouts are read again [D48].
pub(super) fn turned(sessions: &[&str]) {
    if !sessions.is_empty() {
        poke(|sub| sub.session && sessions.contains(&sub.name.as_str()));
    }
}
