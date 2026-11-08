//! Each session has its own host, found at `sessions/<id>/s`. No daemon in between.

use brigadier_core::fold::Owner;
use brigadier_core::{Spec, session_dir};
use brigadier_frames::{lock_held, procs, wire};
use serde_json::{Value, json};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
use std::{env, fs, io, thread};

fn host_exe() -> io::Result<PathBuf> {
    match env::var_os("BRIGADIER_HOST") {
        Some(p) => Ok(PathBuf::from(p)),
        None => Ok(env::current_exe()?.with_file_name("brigadier-host")),
    }
}

/// Starts the session's host unless one holds its lock, then waits until it answers. Two racing
/// starts both spawn; the lock lets one win and the other exits at once.
pub fn ensure(data: &Path, spec: &Spec) -> io::Result<()> {
    let dir = session_dir(data, &spec.id);
    if !lock_held(&dir.join("owner.lock")) {
        let mut host = Command::new(host_exe()?);
        host.arg(&dir)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        // Its own session: no terminal, no signals from whoever started it.
        unsafe {
            host.pre_exec(|| {
                if libc::setsid() < 0 {
                    Err(io::Error::last_os_error())
                } else {
                    Ok(())
                }
            })
        };
        let mut child = host.spawn()?;
        thread::spawn(move || child.wait());
    }
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match wire::connect(&dir.join("s"), Duration::from_secs(2)) {
            Ok(_) if lock_held(&dir.join("owner.lock")) => return Ok(()),
            Err(e) if Instant::now() > deadline => {
                return Err(io::Error::other(format!("host did not answer: {e}")));
            }
            _ => thread::sleep(Duration::from_millis(20)),
        }
    }
}

pub fn call(data: &Path, id: &str, req: Value) -> io::Result<Value> {
    // A spawn may first wait out a handoff: a stop, then the last child's final drain.
    let timeout = match req["op"].as_str() {
        Some("stop") => 10,
        Some("spawn") => 20,
        _ => 3,
    };
    let mut conn = wire::connect(
        &session_dir(data, id).join("s"),
        Duration::from_secs(timeout),
    )?;
    conn.call(&req)
}

fn owner_info(data: &Path, id: &str) -> Option<Value> {
    serde_json::from_slice(&fs::read(session_dir(data, id).join("owner.json")).ok()?).ok()
}

pub fn state(data: &Path, id: &str) -> Owner {
    if !lock_held(&session_dir(data, id).join("owner.lock")) {
        return Owner::Dead;
    }
    let info = owner_info(data, id).unwrap_or_default();
    let pid = info["pid"].as_i64().unwrap_or(0) as i32;
    match procs::same(pid, info["start_us"].as_u64().unwrap_or(0)) {
        Some(p) if p.stopped => Owner::Frozen,
        _ => Owner::Alive,
    }
}

pub fn pid(data: &Path, id: &str) -> Option<i32> {
    (state(data, id) != Owner::Dead)
        .then(|| owner_info(data, id)?["pid"].as_i64().map(|p| p as i32))
        .flatten()
}

/// Asks the host to exit, retrying while a just-stopped child is still being reaped. Fails if the
/// host still holds the session, so nothing deletes a folder a live host owns.
pub fn release(data: &Path, id: &str) -> io::Result<()> {
    let lock = session_dir(data, id).join("owner.lock");
    let deadline = Instant::now() + Duration::from_secs(5);
    while lock_held(&lock) {
        if Instant::now() >= deadline {
            return Err(io::Error::other(
                "the host did not exit; stop it before deleting",
            ));
        }
        let _ = call(data, id, json!({"op": "exit"}));
        thread::sleep(Duration::from_millis(100));
    }
    Ok(())
}
