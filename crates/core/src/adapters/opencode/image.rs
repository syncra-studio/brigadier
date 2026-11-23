//! OpenCode's image tool [D331]: its call starts a job in the background and returns at once; a
//! notice in the session's inbox later names the saved file. Both are the thread's image row, as
//! Codex's are [D289], the file kept in the session's folder [D301].

use super::super::{Event, s};
use crate::images::{keep, plain};
use serde_json::{Value, json};
use std::path::PathBuf;

pub(super) const TOOL: &str = "experimental_image_generate";
/// Its server's image models.
pub(super) const LIST: &str = "/api/model?types=image";

/// Its call: running once its job started, by the job's id its notice repeats; failed when the
/// job couldn't start. The call is no step of its own.
pub(super) fn call(kind: &str, d: &Value) -> Vec<Event> {
    let (id, progress) = match kind {
        "session.tool.success" => (s(d, &["metadata", "jobID"]), "running"),
        "session.tool.failed" => (s(d, &["id"]), "failed"),
        _ => return vec![],
    };
    let error = (progress == "failed").then_some("failed");
    vec![Event::Image(json!({"id": plain(id), "progress": progress,
        "prompt": d["input"]["prompt"], "error": error}))]
}

/// Its job's notice, `{text, metadata: {source, jobID, state, path}}`: done once the helper kept
/// the file; failed or cancelled otherwise.
pub(super) fn notice(p: &Value) -> Event {
    let m = &p["metadata"];
    let done = m["state"] == "completed" && m["attachment"].is_string();
    Event::Image(
        json!({"id": plain(s(m, &["jobID"])), "progress": if done { "done" } else { "failed" },
        "attachment": m["attachment"], "name": m["name"], "error": (!done).then_some("failed")}),
    )
}

/// In the helper: a finished job's file copied into the session's attachments, the notice naming
/// the copy, so it outlives OpenCode's temp folder.
pub(super) fn kept(p: &mut Value) {
    if p["metadata"]["state"] != "completed" {
        return;
    }
    // "Saved image: <file> (<model>)." `path` is the file without the extension its format gave it.
    let text = s(p, &["text"]);
    let file = (text.split_once("Saved image: "))
        .and_then(|(_, rest)| rest.lines().next()?.rsplit_once(" ("))
        .map(|(file, _)| PathBuf::from(file));
    let id = plain(s(p, &["metadata", "jobID"]));
    let session = std::env::var_os(crate::agent::SESSION).map(PathBuf::from);
    if let Some((from, dir)) = file.zip(session) {
        match keep(&dir, &id, &from) {
            Ok(name) => {
                p["metadata"]["attachment"] = id.into();
                p["metadata"]["name"] = name.into();
            }
            Err(e) => eprintln!("OpenCode's image wasn't kept: {e}"),
        }
    }
}

/// Whether a connected provider has an image model, by its server's answer to
/// `GET` [`LIST`]; None where it couldn't be read.
pub(super) fn any(listed: Result<String, String>) -> Option<bool> {
    let t = listed.ok()?;
    let v: Value = serde_json::from_str(&t[t.find('{')?..]).ok()?;
    Some(v["data"].as_array()?.iter().any(|m| m["enabled"] != false))
}

/// Whether its chat model makes images: OpenCode offers the tool to a model that calls tools
/// while a connected provider has an image model.
// shortcut: a config's `experimental.image_generate: false` still reads as true; read the config if users turn it off.
pub(super) fn draws(chat: &Value, images: Option<bool>) -> Option<bool> {
    images.map(|any| any && chat["capabilities"]["tools"] != false)
}
