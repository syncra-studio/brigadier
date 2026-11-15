//! One small host per session. It locks `sessions/<id>/`, holds the agent child through
//! the shared runner, and answers on `sessions/<id>/s`. It has no provider code and speaks the
//! frozen protocol, so clients can be replaced or killed at any time without touching it.
//!
//! A watchdog (this binary with `--watchdog`) outlives a killed host just long enough to stop the
//! child groups it was told about, so nothing runs unsupervised.
//!
//! An app update replaces this binary on disk. A host that holds no process then re-execs itself
//! onto the new one (same pid); one with work keeps its old build until the work ends [D60].

mod proxy;

use brigadier_frames::runner::{Groups, Runner};
use brigadier_frames::{procs, take_lock, wire};
use serde_json::{Value, json};
use std::fs::File;
use std::io::{self, BufRead, Write};
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::fs::MetadataExt;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
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
    // Noted first, so an update landing while this host starts still counts as a change.
    let exe = env::current_exe()?;
    let born = stamp(&exe);
    // A host moving to a new build hands its session lock through exec, still held, so no other
    // host can take the session in between.
    let lock = match args.get(1).and_then(|a| a.strip_prefix("--lock-fd=")) {
        Some(fd) => adopt(fd.parse().map_err(io::Error::other)?)?,
        None => match take_lock(&dir.join("owner.lock"))? {
            Some(lock) => lock,
            None => return Ok(()),
        },
    };
    let me = procs::info(process::id() as i32).map_or(0, |p| p.start_us);
    fs::write(
        dir.join("owner.json"),
        json!({"pid": process::id(), "start_us": me, "build": wire::build()}).to_string(),
    )?;

    let dog = Arc::new(Mutex::new(Some(spawn_watchdog(&exe)?)));
    let watch = {
        let dog = dog.clone();
        move |groups: &Groups| {
            let line: Vec<String> = groups.iter().map(|(g, s)| format!("{g}:{s}")).collect();
            if let Some(d) = dog.lock().unwrap().as_mut()
                && let Some(pipe) = d.stdin.as_mut()
            {
                let _ = writeln!(pipe, "{}", line.join(" "));
            }
        }
    };

    let runner = Runner::open(&dir, Box::new(watch))?;
    let listener = wire::bind(&dir.join("s"))?;
    // The MCP proxy's port survives a move: its listener goes through exec as the lock does.
    let proxy_fd = args
        .iter()
        .find_map(|a| a.strip_prefix("--proxy-fd=")?.parse().ok());
    let proxy = {
        let runner = runner.clone();
        proxy::start(&dir, proxy_fd, Box::new(move |v| drop(runner.note(v))))?
    };
    {
        let (runner, fd) = (runner.clone(), lock.as_raw_fd());
        thread::spawn(move || {
            let mut born = born;
            loop {
                thread::sleep(Duration::from_secs(1));
                let now = stamp(&exe);
                if now.is_none() || now == born {
                    continue;
                }
                // Spawns wait on this guard, so nothing can start (or inherit the lock) from here on.
                let Some(_op) = runner.retire() else {
                    continue;
                };
                // Nothing runs: an empty list and EOF let the watchdog exit at once, and it's reaped.
                if let Some(mut d) = dog.lock().unwrap().take() {
                    if let Some(mut pipe) = d.stdin.take() {
                        let _ = writeln!(pipe);
                    }
                    let _ = d.wait();
                }
                unsafe { libc::fcntl(fd, libc::F_SETFD, 0) };
                proxy::keep(proxy);
                let error = Command::new(&exe)
                    .arg(&dir)
                    .arg(format!("--lock-fd={fd}"))
                    .arg(format!("--proxy-fd={proxy}"))
                    .exec();
                // Still the old image: carry on as it, with a fresh watchdog, until the file changes again.
                unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) };
                proxy::unkeep(proxy);
                let _ = runner.note(&json!({"event": "move_failed", "error": error.to_string()}));
                match spawn_watchdog(&exe) {
                    Ok(d) => *dog.lock().unwrap() = Some(d),
                    Err(_) => process::exit(1),
                }
                born = now;
            }
        });
    }
    let handler = move |req: &Value| match req["op"].as_str() {
        // Leaves only when nothing runs, so a session is never left unsupervised by a request.
        Some("exit") => match runner.retire() {
            Some(op) => {
                std::mem::forget(op);
                thread::spawn(|| {
                    thread::sleep(Duration::from_millis(50));
                    process::exit(0)
                });
                json!({"ok": true})
            }
            None => json!({"ok": false, "error": "busy"}),
        },
        _ => runner.handle(req),
    };
    wire::serve(listener, Arc::new(handler));
    drop(lock);
    Ok(())
}

/// The watchdog sits in its own process group, so stopping the agent's groups never hits it.
fn spawn_watchdog(exe: &Path) -> io::Result<Child> {
    Command::new(exe)
        .process_group(0)
        .arg("--watchdog")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
}

/// Takes over the session lock a moving host passed through exec, still held.
fn adopt(fd: i32) -> io::Result<File> {
    if unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) } < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { File::from_raw_fd(fd) })
}

/// The executable file's identity: an update that replaces it changes this.
fn stamp(exe: &Path) -> Option<(u64, i64, i64)> {
    fs::metadata(exe)
        .ok()
        .map(|m| (m.ino(), m.mtime(), m.mtime_nsec()))
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
