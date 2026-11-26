use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::net::{TcpStream, ToSocketAddrs};
use std::path::Path;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;
use std::time::Duration;

/// Moves a session at its limit on by itself, only where the user turned that on [D51]. Off costs
/// one small read a pass while a session is at its limit, and does nothing else. The switch runs off this loop; the host and
/// the limit's fixed cid keep it to one, whoever else acts on the same limit.
pub fn auto_switch(data: &Path, rows: &BTreeMap<String, Value>, seen: &mut HashMap<String, Value>) {
    seen.retain(|id, _| rows.contains_key(id));
    let mut settings = None; // read once a pass, and only with a session at its limit
    for (id, row) in rows {
        let Some(why) = switchable(row) else {
            seen.remove(id);
            continue;
        };
        let settings = settings.get_or_insert_with(|| brigadier::switch_settings(data));
        // Asked again at a new limit or a settings change; a failure's own note isn't one.
        let at = key(row, settings);
        if seen.get(id) == Some(&at) {
            continue;
        }
        seen.insert(id.clone(), at.clone());
        if !moves(data, row, why) {
            continue;
        }
        // This attempt is the row's now, whatever an earlier one still running ends with; its row
        // goes out again with the hold, also when nothing in it changed (a settings change).
        let n = ATTEMPTS.fetch_add(1, Ordering::Relaxed);
        SETTLED
            .lock()
            .unwrap()
            .insert(id.clone(), (n, at.clone(), None));
        AGAIN.lock().unwrap().push(id.clone());
        let (data, id) = (data.to_path_buf(), id.clone());
        thread::spawn(move || {
            let args = ["switch", &id, "--auto"].map(String::from);
            let ok = match brigadier::run(&data, &args) {
                Ok(r) if r["ok"] == true => true,
                Ok(r) => {
                    eprintln!("brigadierd: switch {id}: {}", r["error"]);
                    false
                }
                Err(e) => {
                    eprintln!("brigadierd: switch {id}: {e}");
                    false
                }
            };
            if let Some(e) = SETTLED.lock().unwrap().get_mut(&id).filter(|e| e.0 == n) {
                e.2 = Some(ok);
            }
            if !ok {
                AGAIN.lock().unwrap().push(id);
            }
        });
    }
}

/// Why a row's limit could move on: a worker's only at its usage limit, by its own routing row
/// whatever the session settings [D2037, D2041]; nothing else moves it.
fn switchable(row: &Value) -> Option<&str> {
    let worker = !row["worker"].is_null();
    (row["switchable"].as_str()).filter(|w| !worker || *w == "limited")
}

/// Whether the daemon moves this limit on itself.
fn moves(data: &Path, row: &Value, why: &str) -> bool {
    !row["worker"].is_null() || brigadier::wants(data, row["backend"].as_str().unwrap_or(""), why)
}

/// One limit as `auto_switch` looks at it: its turn's end and the switching settings.
fn key(row: &Value, settings: &Value) -> Value {
    json!([row["finished"], settings])
}

/// Each session's latest automatic switch: its number, its key, and once it settled whether it
/// moved on.
static SETTLED: Mutex<BTreeMap<String, Attempt>> = Mutex::new(BTreeMap::new());
type Attempt = (u64, Value, Option<bool>);
static ATTEMPTS: AtomicU64 = AtomicU64::new(0);
/// Sessions whose automatic switch started or failed since the loop last asked: their rows go out again.
static AGAIN: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// The sessions whose automatic switch started or failed since the last call, to publish again:
/// neither a settings change nor a refusal that writes nothing to the log changes their rows.
pub fn again() -> Vec<String> {
    std::mem::take(&mut *AGAIN.lock().unwrap())
}

/// While the daemon's own switch of a limit is due or under way, its row says so and stays
/// working, and its "stopped with an error" notice waits: told once if the switch fails, never if
/// the work goes on (proposed) [C6, D51]. A question or a sign-in still goes out [D2028].
pub fn hold(data: &Path, rows: &mut [Value]) {
    let mut settings = None;
    for row in rows {
        let Some(why) = switchable(row).map(String::from) else {
            continue;
        };
        if !moves(data, row, &why) {
            continue;
        }
        let settings = settings.get_or_insert_with(|| brigadier::switch_settings(data));
        let id = row["id"].as_str().unwrap_or("");
        let settled = SETTLED.lock().unwrap().get(id).cloned();
        if settled.is_some_and(|(_, at, ok)| ok == Some(false) && at == key(row, settings)) {
            continue;
        }
        // Kept, so an app opening now knows it as told before; it goes out once it isn't held.
        if row["notice"]["kind"] == "failed" {
            row["notice"]["held"] = true.into();
        }
        if row["mark"] == "amber" {
            row["mark"] = "working".into();
        }
        if row["state"] != "waiting_answer" {
            row["switching"] = true.into();
        }
    }
}

/// Sessions with a rebirth under way in this daemon: one each at a time.
static REBIRTHS: Mutex<BTreeSet<String>> = Mutex::new(BTreeSet::new());

/// Starts each rebirth Rust found due [D88, D108]: a running turn past its threshold, or one its
/// window refused. Its fixed command id keeps a repeat or a racing pass to one.
pub fn rebirth(data: &Path, rows: &BTreeMap<String, Value>) {
    for (id, _) in rows.iter().filter(|(_, r)| !r["rebirth"].is_null()) {
        if !REBIRTHS.lock().unwrap().insert(id.clone()) {
            continue;
        }
        let (data, id) = (data.to_path_buf(), id.clone());
        thread::spawn(move || {
            match brigadier::run(&data, &["rebirth".into(), id.clone()]) {
                Ok(r) if r["ok"] == true || r["error"] == "not_due" => {}
                Ok(r) => eprintln!("brigadierd: rebirth {id}: {}", r["error"]),
                Err(e) => eprintln!("brigadierd: rebirth {id}: {e}"),
            }
            REBIRTHS.lock().unwrap().remove(&id);
        });
    }
}

/// Sessions waiting in this daemon to resume a turn the network cut: one wait each.
static RECONNECTS: Mutex<BTreeSet<String>> = Mutex::new(BTreeSet::new());

/// Resumes each turn the network cut, once its agent's API answers again [D339]: a wait that
/// doubles each try (15 s, 30 s, 60 s), then a connect to its API's host (its DNS and a route)
/// until one goes through, 5 s apart and doubling to a minute; a host that resolves but hasn't
/// answered in 3 minutes may not be the one its CLI reaches (a proxy, a cloud's own API), so it's
/// tried anyway. Rust sends only the try still due,
/// under its own command id: a repeat finds it logged, a message sent meanwhile made it not due.
pub fn reconnect(data: &Path, rows: &BTreeMap<String, Value>) {
    for (id, row) in rows.iter().filter(|(_, r)| r["reconnect"].is_object()) {
        if !RECONNECTS.lock().unwrap().insert(id.clone()) {
            continue;
        }
        let (data, id, due) = (data.to_path_buf(), id.clone(), row["reconnect"].clone());
        thread::spawn(move || {
            let attempt = due["attempt"].as_u64().unwrap_or(1).clamp(1, 4);
            thread::sleep(Duration::from_secs(15 << (attempt - 1)));
            let (mut wait, mut named) = (5, 0);
            while let Some(h) = due["host"].as_str().filter(|h| !reachable(h)) {
                if h.to_socket_addrs().is_ok() {
                    named += wait;
                }
                if named > 180 {
                    break;
                }
                thread::sleep(Duration::from_secs(wait));
                wait = (wait * 2).min(60);
            }
            match brigadier::run(&data, &["reconnect".into(), id.clone()]) {
                Ok(r) if r["ok"] == true || r["error"] == "not_due" => {}
                Ok(r) => eprintln!("brigadierd: reconnect {id}: {}", r["error"]),
                Err(e) => eprintln!("brigadierd: reconnect {id}: {e}"),
            }
            RECONNECTS.lock().unwrap().remove(&id);
        });
    }
}

/// Whether `host:port` resolves and one of its addresses takes a connection within 5 s.
fn reachable(host: &str) -> bool {
    let mut addrs = host.to_socket_addrs().into_iter().flatten();
    addrs.any(|a| TcpStream::connect_timeout(&a, Duration::from_secs(5)).is_ok())
}
