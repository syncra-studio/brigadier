//! `brigadier git`: a checkout's status as the panel gets it, and with `--watch` what changes after,
//! one line each, from the same watch the daemon runs [D71].

use super::{arg, flag, has};
use brigadier_core::git::{self, Status, Target, watch::Watch};
use serde_json::{Value, json};
use std::io::{self, Write};
use std::path::Path;
use std::sync::atomic::AtomicBool;
use std::sync::mpsc;

pub(super) fn run(data: &Path, args: &[String]) -> io::Result<Value> {
    let target = match flag(args, "--project") {
        Some(project) => Target::Project(project),
        None => Target::Session(arg(args, 1)?),
    };
    let checkout = git::checkout(data, &target)?;
    if !has(args, "--watch") {
        let status = git::status(&checkout, &AtomicBool::new(false))?;
        return Ok(json!({"ok": true, "n": 0, "git": status.json()}));
    }
    let (tx, rx) = mpsc::channel();
    let _watch = Watch::start(checkout, move |read| tx.send(read).is_ok());
    let (mut last, mut n) = (None::<Status>, 0u64);
    for read in rx {
        let status = read?;
        let line = match last.as_ref().and_then(|old| status.delta(old)) {
            Some(mut delta) => {
                n += 1;
                delta["n"] = n.into();
                delta
            }
            None => json!({"ok": true, "n": 0, "git": status.json()}),
        };
        let mut stdout = io::stdout().lock();
        writeln!(stdout, "{line}")?;
        stdout.flush()?;
        last = Some(status);
    }
    Ok(Value::Null)
}
