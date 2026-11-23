//! Codex's generated image, kept in the session's folder [D289].

use crate::adapters::home_path;
use crate::images;
use serde_json::Value;
use std::fs;
use std::path::PathBuf;

/// Its picture out of the line, kept in the session's folder, so an image never meets the line
/// cap and outlives Codex's own copy: the item names the copy instead [D289]. Without its file
/// (`savedPath`), its bytes are saved where Codex saves its own, which the delete removes [D35].
pub(super) fn kept(thread: &str, item: &mut Value) {
    let bytes = (item.as_object_mut()).and_then(|o| o.remove("result"));
    let id = images::plain(item["id"].as_str().unwrap_or(""));
    let saved = item["savedPath"].as_str().map(PathBuf::from);
    let from = saved.filter(|p| p.exists()).or_else(|| {
        let bytes = images::decode(bytes?.as_str()?)?;
        let home =
            std::env::var_os("CODEX_HOME").map_or_else(|| home_path(".codex"), PathBuf::from);
        let dir = home.join("generated_images").join(thread);
        let path = dir.join(format!("{id}.png"));
        fs::create_dir_all(&dir)
            .and_then(|_| fs::write(&path, bytes))
            .ok()?;
        Some(path)
    });
    let session = std::env::var_os(crate::agent::SESSION).map(PathBuf::from);
    if let Some((from, dir)) = from.zip(session) {
        match images::keep(&dir, &id, &from) {
            Ok(name) => (item["attachment"], item["name"]) = (id.into(), name.into()),
            Err(e) => eprintln!("Codex's image wasn't kept: {e}"),
        }
    }
}
