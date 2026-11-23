use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::net::{TcpStream, ToSocketAddrs};
use std::path::Path;
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

/// Moves a session at its limit on by itself, only where the user turned that on [D51]. Off costs
/// one small read a pass while a session is at its limit, and does nothing else. The switch runs off this loop; the host and
/// the limit's fixed cid keep it to one, whoever else acts on the same limit [D54, D82].
pub fn auto_switch(data: &Path, rows: &BTreeMap<String, Value>, seen: &mut HashMap<String, Value>) {
    seen.retain(|id, _| rows.contains_key(id));
    let mut settings = None; // read once a pass, and only with a session at its limit
    for (id, row) in rows {
        // A worker's limit moves follow its own routing row, whatever the session settings
        // [D2037, D2041]; nothing else moves it.
        let worker = !row["worker"].is_null();
        let Some(why) = row["switchable"]
            .as_str()
            .filter(|w| !worker || *w == "limited")
        else {
            seen.remove(id);
            continue;
        };
        let settings = settings.get_or_insert_with(|| brigadier::switch_settings(data));
        // Asked again at a new limit or a settings change; a failure's own note isn't one.
        let at = json!([row["finished"], settings]);
        if seen.get(id) == Some(&at) {
            continue;
        }
        seen.insert(id.clone(), at);
        if !worker && !brigadier::wants(data, row["backend"].as_str().unwrap_or(""), why) {
            continue;
        }
        let (data, id) = (data.to_path_buf(), id.clone());
        thread::spawn(move || {
            let args = ["switch", &id, "--auto"].map(String::from);
            match brigadier::run(&data, &args) {
                Ok(r) if r["ok"] == true => {}
                Ok(r) => eprintln!("brigadierd: switch {id}: {}", r["error"]),
                Err(e) => eprintln!("brigadierd: switch {id}: {e}"),
            }
        });
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
/// until one goes through, 5 s apart and doubling to a minute. Rust sends only the try still due,
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
            let mut wait = 5;
            while due["host"].as_str().is_some_and(|h| !reachable(h)) {
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

/// Whether `host:port` resolves and takes a connection within 5 s.
fn reachable(host: &str) -> bool {
    let addr = host.to_socket_addrs().ok().and_then(|mut a| a.next());
    addr.is_some_and(|a| TcpStream::connect_timeout(&a, Duration::from_secs(5)).is_ok())
}
