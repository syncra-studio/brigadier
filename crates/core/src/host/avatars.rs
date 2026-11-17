//! The PR tabs' pictures of people [D614, D615]: each one the host's read names, fetched once and
//! kept as `<data>/avatars/<login>.png`, which the app shows at once from then on.

use crate::adapters::setup;
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::Path;
use std::process::Command;

/// Every login in a GraphQL read whose picture isn't kept yet, fetched side by side before the read
/// answers; one that fails is asked for again on the next read.
pub(super) fn keep(dir: &Path, data: &Value) {
    let mut found = BTreeMap::new();
    walk(data, &mut found);
    found.retain(|login, _| !dir.join(format!("{login}.png")).exists());
    let Some(curl) = setup::find("curl", &[]).filter(|_| !found.is_empty()) else {
        return;
    };
    if std::fs::create_dir_all(dir).is_err() {
        return;
    }
    std::thread::scope(|s| {
        for (login, url) in &found {
            let curl = &curl;
            s.spawn(move || {
                let part = dir.join(format!(".{login}.part"));
                let sized = format!("{url}{}s=64", if url.contains('?') { '&' } else { '?' });
                let mut command = Command::new(curl);
                command
                    .args(["-sSfL", "--max-time", "5", &sized, "-o"])
                    .arg(&part);
                let got = setup::run(&mut command, 8).is_ok_and(|o| o.status.success());
                if !got || std::fs::rename(&part, dir.join(format!("{login}.png"))).is_err() {
                    let _ = std::fs::remove_file(&part);
                }
            });
        }
    });
}

/// Each `{login, avatarUrl}` in `v`, a login only a plain name so its file stays in the folder.
fn walk(v: &Value, found: &mut BTreeMap<String, String>) {
    match v {
        Value::Object(map) => {
            if let (Some(login), Some(url)) = (
                map.get("login").and_then(Value::as_str),
                map.get("avatarUrl").and_then(Value::as_str),
            ) && plain(login)
                && url.starts_with("https://")
            {
                found.insert(login.to_string(), url.to_string());
            }
            map.values().for_each(|v| walk(v, found));
        }
        Value::Array(list) => list.iter().for_each(|v| walk(v, found)),
        _ => {}
    }
}

/// The app's `/avatar/` name check (main.ts's PLAIN).
fn plain(login: &str) -> bool {
    let mut chars = login.chars();
    chars
        .next()
        .is_some_and(|c| c.is_ascii_alphanumeric() || c == '_')
        && login.len() <= 128
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}
