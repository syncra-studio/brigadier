use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap};
use std::path::Path;
use std::thread;

/// Moves a session at its limit on by itself, only where the user turned that on [D51]. Off costs
/// one small read a pass while a session is at its limit, and does nothing else. The switch runs off this loop; the host and
/// the limit's fixed cid keep it to one, whoever else acts on the same limit [D54, D82].
pub fn auto_switch(data: &Path, rows: &BTreeMap<String, Value>, seen: &mut HashMap<String, Value>) {
    seen.retain(|id, _| rows.contains_key(id));
    let mut settings = None; // read once a pass, and only with a session at its limit
    for (id, row) in rows {
        // A worker's limit moves follow its own routing, a later step [D3030].
        let Some(why) = row["switchable"]
            .as_str()
            .filter(|_| row["worker"].is_null())
        else {
            seen.remove(id);
            continue;
        };
        let settings = settings.get_or_insert_with(|| brigadier::switch_settings(data));
        let at = json!([row["items"], settings]);
        if seen.get(id) == Some(&at) {
            continue;
        }
        seen.insert(id.clone(), at);
        if !brigadier::wants(data, row["backend"].as_str().unwrap_or(""), why) {
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
