//! What a command prints.

use super::{flag, has};
use brigadier_core as core;
use brigadier_frames::log;
use serde_json::{Value, json};
use std::io::{self, ErrorKind, Write};
use std::path::Path;
use std::thread;
use std::time::{Duration, Instant};

/// Whether the reader of what was just written is still there. One that left (`… | head`) has all
/// it wanted: never an error, so a command ends as it did, and one that streams stops.
pub fn heard(wrote: io::Result<()>) -> io::Result<bool> {
    match wrote {
        Err(e) if e.kind() == ErrorKind::BrokenPipe => Ok(false),
        wrote => wrote.map(|()| true),
    }
}

/// `read <id> [--follow] [--hash] [--tail N]`: a session's items, one a line.
pub(crate) fn read(data: &Path, id: &str, args: &[String]) -> io::Result<Value> {
    let spec = core::load(data, id)?;
    let started = Instant::now();
    if let Some(n) = flag(args, "--tail") {
        let items = core::tail(&spec.dir, &spec, n.parse().unwrap_or(50))?;
        return Ok(
            json!({"ok": true, "items": items.len(), "ms": started.elapsed().as_secs_f64() * 1000.0}),
        );
    }
    let quiet = has(args, "--hash");
    let mut stdout = io::BufWriter::new(io::stdout().lock());
    let mut count = 0u64;
    if !has(args, "--follow") {
        let hash = core::read(&spec.dir, |item| {
            count += 1;
            if !quiet {
                let _ = writeln!(stdout, "{item}");
            }
        })?;
        heard(stdout.flush())?;
        return Ok(
            json!({"ok": true, "items": count, "hash": format!("{hash:016x}"), "ms": started.elapsed().as_millis() as u64}),
        );
    }
    // Follow: the same normaliser over the same frames, as they arrive.
    let mut reader = log::Reader::open(&spec.dir.join("log"), 0, 0)?;
    let mut norm = core::norm::Norm::default();
    let mut items = vec![];
    loop {
        while let Some(frame) = reader.frame()? {
            norm.push(&frame, &mut items);
            for item in items.drain(..) {
                if !heard(writeln!(stdout, "{item}"))? {
                    return Ok(Value::Null);
                }
            }
        }
        if !heard(stdout.flush())? {
            return Ok(Value::Null);
        }
        thread::sleep(Duration::from_millis(100));
    }
}
