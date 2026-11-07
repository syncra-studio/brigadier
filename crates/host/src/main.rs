//! One small host per session. It locks `sessions/<id>/`, holds the agent child through
//! the shared runner, and answers on `sessions/<id>/s`. It has no provider code and speaks the
//! frozen protocol, so clients can be replaced or killed at any time without touching it.
//!
//! A watchdog (this binary with `--watchdog`) outlives a killed host just long enough to stop the
//! child groups it was told about, so nothing runs unsupervised.

use brigadier_frames::runner::{Groups, Runner};
use brigadier_frames::{procs, take_lock, wire};
use serde_json::{Value, json};
use std::io::{self, BufRead, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use std::{env, fs, process, thread};

fn main() -> io::Result<()> {
    let args: Vec<String> = env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("--watchdog") {
        return watchdog();
    }
    let dir = PathBuf::from(
        args.first()
            .ok_or_else(|| io::Error::other("usage: brigadier-host <session dir>"))?,
    );
    let Some(_lock) = take_lock(&dir.join("owner.lock"))? else {
        return Ok(());
    };
    let me = procs::info(process::id() as i32).map_or(0, |p| p.start_us);
    fs::write(
        dir.join("owner.json"),
        json!({"pid": process::id(), "start_us": me, "build": wire::build()}).to_string(),
    )?;

    // The watchdog sits in its own process group, so stopping the agent's groups never hits it.
    let mut dog = Command::new(env::current_exe()?);
    std::os::unix::process::CommandExt::process_group(&mut dog, 0);
    let dog = dog
        .arg("--watchdog")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?;
    let pipe = Mutex::new(dog.stdin.expect("piped"));
    let watch = move |groups: &Groups| {
        let line: Vec<String> = groups.iter().map(|(g, s)| format!("{g}:{s}")).collect();
        let _ = writeln!(pipe.lock().unwrap(), "{}", line.join(" "));
    };

    let runner = Runner::open(&dir, Box::new(watch))?;
    let listener = wire::bind(&dir.join("s"))?;
    let handler = move |req: &Value| match req["op"].as_str() {
        // Leaves only when nothing runs, so a session is never left unsupervised by a request.
        Some("exit") if !runner.busy() && runner.groups().is_empty() => {
            thread::spawn(|| {
                thread::sleep(Duration::from_millis(50));
                process::exit(0)
            });
            json!({"ok": true})
        }
        Some("exit") => json!({"ok": false, "error": "busy"}),
        _ => runner.handle(req),
    };
    wire::serve(listener, Arc::new(handler));
    Ok(())
}

/// Reads the latest group list from the host. When the host is gone (EOF), stops those groups:
/// TERM, then KILL a second later. Start times guard against recycled ids.
fn watchdog() -> io::Result<()> {
    let mut last = String::new();
    for line in io::stdin().lock().lines() {
        last = line?;
    }
    let groups: Vec<(i32, u64)> = last
        .split_whitespace()
        .filter_map(|g| g.split_once(':'))
        .filter_map(|(g, s)| Some((g.parse().ok()?, s.parse().ok()?)))
        .collect();
    if groups.is_empty() {
        return Ok(());
    }
    for sig in [libc::SIGTERM, libc::SIGKILL] {
        for &(g, s) in &groups {
            procs::signal_group(g, s, sig);
            procs::signal_group(g, s, libc::SIGCONT);
        }
        thread::sleep(Duration::from_secs(1));
    }
    Ok(())
}
