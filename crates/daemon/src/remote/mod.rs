//! Remote and phone access, step 1 (remote design rev 3.3 §4): the phone reaches this Mac on the
//! same Wi-Fi or Tailscale through `brigadier-remote`, a sandboxed gateway that holds the network
//! and no keys (`gateway`), and the daemon announces it on Bonjour (`bonjour`) while Allow
//! connections is on (`data/remote/on`). Hidden behind `BRIGADIER_REMOTE=1` until the owner has
//! seen it [beat-competitors D62]: without it the gateway never starts and `remote` isn't routed.

mod bonjour;
mod gateway;

use serde_json::{Value, json};
use std::fs;
use std::path::Path;
use std::sync::Mutex;
use std::sync::atomic::{AtomicI32, Ordering};
use std::time::{Duration, Instant};

/// Proposed: how soon a gateway that failed or died is started again.
const RETRY: Duration = Duration::from_secs(5);

/// The running gateway's pid, for `caller::of`; 0 while none runs.
static GATEWAY: AtomicI32 = AtomicI32::new(0);
/// What `remote status` tells of the running gateway: its port and the name Bonjour shows.
static LIVE: Mutex<Option<(u16, String)>> = Mutex::new(None);

pub(super) fn enabled() -> bool {
    std::env::var_os("BRIGADIER_REMOTE").is_some_and(|v| v == "1")
}

fn on(data: &Path) -> bool {
    data.join("remote/on").exists()
}

/// The gateway, kept by the daemon's pass: running while the switch and Allow connections are on.
#[derive(Default)]
pub(super) struct Remote {
    gateway: Option<gateway::Gateway>,
    tried: Option<Instant>,
}

impl Remote {
    pub(super) fn pass(&mut self, data: &Path) {
        let want = enabled() && on(data);
        if let Some(running) = &mut self.gateway
            && (!want || !running.alive())
        {
            self.gateway = None;
            GATEWAY.store(0, Ordering::SeqCst);
            *LIVE.lock().unwrap() = None;
        }
        if !want || self.gateway.is_some() || self.tried.is_some_and(|t| t.elapsed() < RETRY) {
            return;
        }
        self.tried = Some(Instant::now());
        match gateway::start(data) {
            Ok(started) => {
                GATEWAY.store(started.pid(), Ordering::SeqCst);
                *LIVE.lock().unwrap() = Some((started.port, name()));
                self.gateway = Some(started);
            }
            Err(e) => eprintln!("brigadierd: the phone gateway: {e}"),
        }
    }
}

/// Whether `pid` is the gateway or runs below it: its sandbox already keeps it off `daemon.sock`,
/// and this refuses it there too.
pub(super) fn under_gateway(mut pid: i32) -> bool {
    let gateway = GATEWAY.load(Ordering::SeqCst);
    while gateway > 0 && pid > 1 {
        if pid == gateway {
            return true;
        }
        let Some(info) = brigadier_frames::procs::info(pid) else {
            return false;
        };
        pid = info.ppid;
    }
    false
}

/// The Mac's name as the phone shows it.
fn name() -> String {
    let out = std::process::Command::new("/usr/sbin/scutil")
        .args(["--get", "ComputerName"])
        .output();
    out.ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| "Mac".into())
}

/// `remote status | on | off`, the app's Settings › Connections. Allow connections takes effect at
/// the daemon's next pass.
pub(super) fn cli(data: &Path, args: &[String]) -> Value {
    let done = |r: std::io::Result<()>| match r {
        Ok(()) => json!({"ok": true}),
        Err(e) => json!({"ok": false, "error": e.to_string()}),
    };
    match args.get(1).map(String::as_str) {
        Some("status") => {
            let live = LIVE.lock().unwrap().clone();
            let (port, name) = live.map_or((None, None), |(p, n)| (Some(p), Some(n)));
            json!({"ok": true, "on": on(data), "port": port, "name": name.unwrap_or_else(self::name)})
        }
        Some("on") => done(
            fs::create_dir_all(data.join("remote"))
                .and_then(|()| brigadier_core::write_atomic(&data.join("remote/on"), b"on")),
        ),
        Some("off") => done(match fs::remove_file(data.join("remote/on")) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e),
            _ => Ok(()),
        }),
        _ => json!({"ok": false, "error": "usage: remote status|on|off"}),
    }
}
