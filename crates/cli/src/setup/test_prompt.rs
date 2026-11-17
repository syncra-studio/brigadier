//! `agents test <agent>` [D617, D618]: one tiny prompt on a throwaway conversation, through the
//! adapter's own launch and parse as the message writer runs it, stopped at 30 s. Whether it
//! answered is the reply's `passed`; failing to run the check at all is the command's error.

use brigadier_core::adapters::{self, Adapter};
use brigadier_core::{Spec, writer};
use brigadier_frames::log;
use serde_json::{Value, json};
use std::fs::{self, File};
use std::io;
use std::path::Path;

const SECS: u64 = 30;

pub(super) fn test(data: &Path, a: &dyn Adapter) -> io::Result<Value> {
    let models: Vec<_> = (crate::commit::models(data, a.name()).into_iter())
        .filter(|m| !m.local)
        .collect();
    // Local models only, or none listed: no account to check, so nothing to test [D618].
    if models.is_empty() {
        return Ok(json!({"ok": true, "passed": true, "skipped": true}));
    }
    let dir = data.join("setup").join(format!("test-{}", a.name()));
    fs::create_dir_all(&dir)?;
    let model = a.cheap(None, &models);
    let effort = (models.iter().find(|m| Some(&m.id) == model.as_ref()))
        .and_then(|m| m.efforts.first().cloned());
    let run = Spec {
        id: format!("agent-test-{}", a.name()),
        backend: a.name().into(),
        cwd: dir.display().to_string(),
        model,
        effort,
        level: a.can().levels.first().map(|l| l.to_string()),
        cid: Some(adapters::uuid()),
        created: log::now_ms(),
        dir: dir.clone(),
        ..Default::default()
    };
    let active = File::create(dir.join("writer.lock"))?;
    let outcome = writer::write(a, &run, "", "Reply with OK.", &active, SECS);
    let _ = fs::remove_dir_all(&dir);
    Ok(match outcome {
        Ok(_) => json!({"ok": true, "passed": true}),
        Err(failure) => {
            // Its last line, the CLI's own words, without the terminal's escapes.
            let reason = adapters::setup::reason(failure.why.as_bytes()).unwrap_or(failure.why);
            let login =
                (a.sign_in()).map(|(_, words)| format!("{} {}", a.bin().0, words.join(" ")));
            json!({"ok": true, "passed": false, "reason": reason, "login": login})
        }
    })
}
