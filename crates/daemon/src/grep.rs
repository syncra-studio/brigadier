//! Search's stream [D1003]: `{"id", "op": "grep", "session" | "project", "query"}` pushes
//! `{"found": <id>, "files"}` batches as they're found, then answers `{"re", "ok", "done": {files,
//! matches, capped}}`. One search per connection, as the old tab: a new one stops the last, which
//! answers `{"re", "ok": false, "error": "stopped"}`, and so does closing the connection.

use brigadier_core::git::{self, Target, search};
use serde_json::{Value, json};
use std::io;
use std::path::Path;
use std::sync::atomic::AtomicBool;
use std::sync::mpsc::Sender;

pub(super) fn run(data: &Path, req: &Value, out: &Sender<String>, stop: &AtomicBool) {
    let re = req["id"].clone();
    let done = (|| {
        let target = match (req["session"].as_str(), req["project"].as_str()) {
            (Some(id), _) => Target::Session(id),
            (None, Some(id)) => Target::Project(id),
            _ => return Err(io::Error::other("grep needs a session or project")),
        };
        let checkout = git::checkout(data, &target)?;
        let matcher = search::Matcher::new(&req["query"])?;
        search::search(&checkout, &matcher, stop, |files| {
            out.send(json!({"found": re, "files": files}).to_string())
                .is_ok()
        })
    })();
    let reply = match done {
        Ok(Some(done)) => json!({"re": re, "ok": true, "done": done}),
        Ok(None) => json!({"re": re, "ok": false, "error": "stopped"}),
        Err(e) => json!({"re": re, "ok": false, "error": e.to_string()}),
    };
    let _ = out.send(reply.to_string());
}
