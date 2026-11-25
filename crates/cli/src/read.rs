//! `read`: a session's normalised log, whole, its tail, or followed.

use crate::{flag, has};
use brigadier_core as core;
use brigadier_frames::log;
use serde_json::{Value, json};
use std::io::{self, Write};
use std::path::Path;
use std::thread;
use std::time::{Duration, Instant};

pub fn run(data: &Path, id: &str, args: &[String]) -> io::Result<Value> {
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
        stdout.flush()?;
        return Ok(
            json!({"ok": true, "items": count, "hash": format!("{hash:016x}"), "ms": started.elapsed().as_millis() as u64}),
        );
    }
    // Follow: the same normaliser over the same frames, as they arrive.
    let mut reader = log::Reader::open(&spec.dir.join("log"), 0, 0)?;
    let mut norm = brigadier_core::norm::Norm::default();
    let mut items = vec![];
    loop {
        while let Some(frame) = reader.frame()? {
            norm.push(&frame, &mut items);
            for item in items.drain(..) {
                writeln!(stdout, "{item}")?;
            }
        }
        stdout.flush()?;
        thread::sleep(Duration::from_millis(100));
    }
}
