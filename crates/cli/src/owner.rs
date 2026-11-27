//! Each session has its own host, found at `sessions/<id>/s`. No daemon in between.

use brigadier_core::fold::Owner;
use brigadier_core::{Spec, session_dir};
use brigadier_frames::{lock_held, procs, wire};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
use std::{env, fs, io, thread};

fn host_exe() -> io::Result<PathBuf> {
    match env::var_os("BRIGADIER_HOST") {
        Some(p) => Ok(PathBuf::from(p)),
        None => Ok(brigadier_frames::beside("brigadier-host")),
    }
}

/// Starts the session's host unless one holds its lock, then waits until it answers. Two racing
/// starts both spawn; the lock lets one win and the other exits at once. A session that takes no
/// new work is refused with why.
pub fn ensure(data: &Path, spec: &Spec) -> io::Result<()> {
    let dir = session_dir(data, &spec.id);
    // Archived, or being archived, restored or deleted: no new work [D180].
    if let Some(why) = brigadier_core::session::retired(&dir) {
        return Err(io::Error::other(why));
    }
    // Its project being removed: no new work either [D172, D179].
    if brigadier_core::projects::removing(data, spec) {
        return Err(io::Error::other("This project is being removed."));
    }
    if !lock_held(&dir.join("owner.lock")) {
        spawn_host(data, &dir, true)?;
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

/// Whether a systemd user manager runs here; `BRIGADIER_SYSTEMD=0` says not to use it.
pub fn user_manager() -> bool {
    cfg!(target_os = "linux")
        && env::var_os("BRIGADIER_SYSTEMD").is_none_or(|v| v != "0")
        && env::var_os("XDG_RUNTIME_DIR")
            .is_some_and(|d| Path::new(&d).join("systemd/private").exists())
}

/// The data folder's systemd units' prefix, the same from every build: FNV-1a of its path.
pub fn unit(data: &Path) -> String {
    let hash = (data.to_string_lossy().bytes()).fold(0xcbf29ce484222325u64, |h, b| {
        (h ^ b as u64).wrapping_mul(0x100000001b3)
    });
    format!("brigadier-{hash:016x}")
}

/// Starts a host in a session of its own. Under a systemd user manager it runs in a scope of its
/// own too, so stopping the daemon's unit, or the app's scope at logout, never reaches it; a scope
/// that couldn't be made falls back to a plain start (proposed).
fn spawn_host(data: &Path, dir: &Path, scoped: bool) -> io::Result<()> {
    let scoped = scoped && user_manager();
    let mut host = match scoped {
        true => {
            let id = dir.file_name().unwrap_or_default().to_string_lossy();
            let at = brigadier_frames::log::now_ms();
            let mut run = Command::new("systemd-run");
            run.args(["--user", "--scope", "--quiet", "--collect"])
                .arg(format!("--unit={}-{id}-{at}", unit(data)))
                .arg("--")
                .arg(host_exe()?);
            run
        }
        false => Command::new(host_exe()?),
    };
    {
        // Another session's agent can be who starts it: its mark and grant stay its own.
        host.arg(dir)
            .env_remove(brigadier_core::agent::SESSION)
            .env_remove(brigadier_core::agent::GRANT)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        // Its own session: no terminal, no signals from whoever started it.
        let mut child = brigadier_frames::spawn::detached(&mut host)?;
        let (data, dir, at) = (data.to_path_buf(), dir.to_path_buf(), Instant::now());
        thread::spawn(move || {
            // systemd-run fails at once when it can't make the scope, before any host holds the lock.
            let failed = child.wait().is_ok_and(|s| !s.success());
            let soon = at.elapsed() < Duration::from_secs(3);
            if scoped && failed && soon && !lock_held(&dir.join("owner.lock")) {
                let _ = spawn_host(&data, &dir, false);
            }
        });
    }
    Ok(())
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
