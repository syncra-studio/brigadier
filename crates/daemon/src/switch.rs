use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::Path;
use std::sync::Mutex;
use std::thread;

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
