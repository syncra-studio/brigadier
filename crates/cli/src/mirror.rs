//! `brigadier mirror`: runs beside a session's terminal, started by its host. It reads the new
//! entries of the CLI's own record through the adapter and prints them for the host to log, so the
//! chat shows the terminal's work [D47]. Read-only: it never writes the CLI's record.
//!
//! Before each prompt it prints, it logs which chat input typed it (the oldest one still unbound,
//! by order), so every refold binds the same way; the texts are only compared, never the key.

use crate::owner;
use brigadier_core::adapters::{self, Event};
use brigadier_core::{self as core};
use brigadier_frames::log::{self, Reader};
use serde_json::{Value, json};
use std::collections::VecDeque;
use std::io::{self, Write};
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::Duration;

const EVERY: Duration = Duration::from_millis(300);

/// `mirror <id> --backend B --conv C --from CURSOR --since LEN`
pub fn run(
    data: &Path,
    id: &str,
    backend: &str,
    conv: &str,
    from: &str,
    since: u64,
) -> io::Result<Value> {
    // It ends when its stdin closes (its host saw the terminal end), after one last read, so a
    // stop's TERM to every group can't cut that read short. The host kills it if it hangs.
    for sig in [libc::SIGTERM, libc::SIGINT, libc::SIGHUP] {
        unsafe { libc::signal(sig, libc::SIG_IGN) };
    }
    // It reads the record where the terminal's account keeps it [D51].
    let spec = core::load(data, id)?;
    let spec = core::as_run(&spec, &core::fold(&spec.dir, true)?.fold, backend, None);
    let a = adapters::get(backend).ok_or_else(|| io::Error::other("unknown backend"))?;
    let closed = Arc::new(AtomicBool::new(false));
    {
        let closed = closed.clone();
        thread::spawn(move || {
            let _ = io::copy(&mut io::stdin().lock(), &mut io::sink());
            closed.store(true, Ordering::SeqCst);
        });
    }
    // The chat inputs typed into this terminal, in the order they were logged.
    let mut reader = Reader::open(&spec.dir.join("log"), since, 0)?;
    let mut typed: VecDeque<(String, String)> = VecDeque::new();
    let mut cursor = from.to_string();
    let mut out = io::stdout().lock();
    loop {
        let last = closed.load(Ordering::SeqCst);
        let (lines, next) = a.mirror(&spec, conv, &cursor);
        // Read after the record: an input is logged before it's typed, so any prompt in what was
        // just read has its input in the log by now.
        while let Some(frame) = reader.next_with(|k| k == log::INTENT)? {
            if frame.kind == log::INTENT {
                let v: Value = serde_json::from_slice(&frame.data).unwrap_or_default();
                let text = v["text"].as_str().unwrap_or("").to_string();
                typed.extend(v["cid"].as_str().map(|c| (c.to_string(), text)));
            }
        }
        for line in lines {
            for event in a.parse(&line) {
                if let (Event::Prompt(prompt, text), Some((cid, sent))) = (event, typed.front()) {
                    let same = squash(sent) == squash(&text);
                    let bound =
                        json!({"event": "bound", "cid": cid, "prompt": prompt, "same_text": same});
                    owner::call(data, id, json!({"op": "note", "data": bound}))?;
                    typed.pop_front();
                }
            }
            writeln!(out, "{line}")?;
        }
        out.flush()?;
        cursor = next;
        if last {
            return Ok(Value::Null);
        }
        thread::sleep(EVERY);
    }
}

/// Text with its whitespace runs made one space: a TUI may reflow a pasted message.
fn squash(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}
