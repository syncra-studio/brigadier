//! A worker's images, relayed to its parent's thread [D289].

use crate::owner;
use crate::workers::link;
use brigadier_core::{self as core};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;

/// A worker's images go to its parent's thread as they start and end, each kept in the parent's
/// own folder [D289]; one the parent already holds isn't sent again after a restart.
pub(super) fn pass(data: &Path, wid: &str, row: &Value) {
    static SENT: Mutex<Option<HashMap<String, Value>>> = Mutex::new(None);
    let Some(list) = row["images"].as_array().filter(|l| !l.is_empty()) else {
        return;
    };
    let Some(parent) = link(data, wid).map(|l| l.parent) else {
        return;
    };
    let to = core::session_dir(data, &parent);
    let mut sent = SENT.lock().unwrap();
    let sent = sent.get_or_insert_with(HashMap::new);
    for image in list {
        let key = format!("{wid}/{}", image["id"].as_str().unwrap_or(""));
        if sent.get(&key) == Some(image) {
            continue;
        }
        let file = (image["attachment"].as_str()).zip(image["name"].as_str());
        if let Some((id, name)) = file
            && !sent.contains_key(&key)
            && core::message::sent(&to).join(id).join(name).exists()
        {
            sent.insert(key, image.clone());
            continue;
        }
        let mut note = image.clone();
        (note["event"], note["from"]) = ("image".into(), wid.into());
        if owner::call(data, &parent, json!({"op": "note", "data": note})).is_err() {
            continue;
        }
        // Copied only once the parent has the note, so a copy there means it was told.
        if let Some((id, name)) = file {
            let from = core::message::sent(&core::session_dir(data, wid)).join(id);
            if core::images::keep(&to, id, &from.join(name)).is_err() {
                continue;
            }
        }
        sent.insert(key, image.clone());
    }
}
