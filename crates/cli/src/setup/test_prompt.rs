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
    // Its cheapest, else the first it lists: some pick only beside a current model.
    let model = (a.cheap(None, &models)).or_else(|| models.first().map(|m| m.id.clone()));
    let effort = (models.iter().find(|m| Some(&m.id) == model.as_ref()))
        .and_then(|m| m.efforts.first().cloned());
    // On the account new sessions start on, as its check is [D2082].
    let (account, on) = crate::accounts::check_as(data, a, &dir);
    let run = Spec {
        account: on.account,
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
    // A conversation a test couldn't remove stays recorded and is tried again; the folder goes once none is left.
    let clean = || {
        (writer::left(&dir).into_iter())
            .all(|(_, _, id, paths)| writer::remove(a, &run, &id, &paths).is_ok())
    };
    clean();
    let active = File::create(dir.join("writer.lock"))?;
    let outcome = writer::write(a, &run, &account, "Reply with OK.", &active, SECS);
    if clean() {
        let _ = fs::remove_dir_all(&dir);
    }
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
