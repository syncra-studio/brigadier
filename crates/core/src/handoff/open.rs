//! What a hand-off lists as open: workers not yet reported back, the user's `!` commands still running.

use super::{OPEN, fill, head};
use crate::Spec;
use crate::archive::Entry;
use serde_json::Value;

pub(super) fn items(spec: &Spec, entries: &[Entry]) -> String {
    // Open items: workers started and not yet reported back.
    let workers = std::fs::read_dir(spec.dir.join("workers"))
        .into_iter()
        .flatten()
        .flatten();
    let open = workers.filter_map(|w| {
        let r: Value = serde_json::from_slice(&std::fs::read(w.path()).ok()?).ok()?;
        let wid = r["wid"].as_str()?;
        // Its newest record, written before its delivery, says it ended, unless it's a question
        // it asked and waits on (O50). shortcut: a worker told again after a result reads as done.
        let records = std::fs::read_dir(spec.dir.join("results"))
            .into_iter()
            .flatten();
        let newest = (records.flatten())
            .filter(|f| {
                f.file_name()
                    .to_string_lossy()
                    .starts_with(&format!("{wid}."))
            })
            .filter_map(|f| Some((f.metadata().ok()?.modified().ok()?, f.path())))
            .max();
        let back = match newest {
            Some((_, path)) => (std::fs::read(path).ok())
                .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
                .is_some_and(|end| end["how"] != "asks"),
            None => entries.iter().any(|e| e.from == "worker" && e.who == wid),
        };
        (r["state"] == "started" && !back).then(|| {
            format!(
                "- worker {wid} ({}) is still working; its result comes to you by itself\n",
                r["title"].as_str().unwrap_or("")
            )
        })
    });
    // And the user's `!` commands still running, by their marks.
    let commands = std::fs::read_dir(spec.dir.join("commands"))
        .into_iter()
        .flatten()
        .flatten();
    let commands = commands.filter_map(|c| {
        let mark = std::fs::read_to_string(c.path()).ok()?;
        let (line, cmd) = (head(mark.strip_prefix('!')?, 300), c.file_name());
        Some(format!("- `{line}`, which the user ran with `!`, is still running; you'll hear when it ends (`brigadier terminal read {}`)\n", cmd.to_string_lossy()))
    });
    let open = open.chain(commands);
    fill(open, OPEN, "`brigadier sessions` lists them")
}
