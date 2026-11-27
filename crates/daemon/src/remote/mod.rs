//! Remote and phone access, step 1 (remote design rev 3.3 §4): the phone reaches this Mac on the
//! same Wi-Fi or Tailscale through `brigadier-remote`, a sandboxed gateway that holds the network
//! and no keys (`gateway`), and the daemon announces it on Bonjour (`bonjour`) while Allow
//! connections is on (`data/remote/on`). The daemon ends each phone's Noise channel (`link`),
//! pairs phones (`pair`) and keeps them (`devices`). Hidden behind `BRIGADIER_REMOTE=1` until the
//! owner has seen it [beat-competitors D62]: without it the gateway never starts and `remote`
//! isn't routed.

mod allow;
mod bonjour;
mod bridge;
mod devices;
mod files;
mod fresh;
mod gateway;
mod link;
mod pair;
mod power;
mod powers;
mod rows;

use serde_json::Value;
use std::collections::HashMap;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicI32, Ordering};
use std::sync::{Arc, LazyLock, Mutex, OnceLock};
use std::time::{Duration, Instant};

/// Proposed: how soon a gateway that failed or died is started again.
const RETRY: Duration = Duration::from_secs(5);

/// The running gateway's pid, for `caller::of`; 0 while none runs.
static GATEWAY: AtomicI32 = AtomicI32::new(0);

/// Everything the phone side holds, under one lock: the gateway's frames, the app's `remote`
/// commands and the daemon's pass all change it.
#[derive(Default)]
struct State {
    data: PathBuf,
    key: [u8; 32],
    public: [u8; 32],
    /// The running gateway's port and the Mac's name, and the way to it.
    live: Option<(u16, String)>,
    out: Option<Arc<Mutex<UnixStream>>>,
    streams: HashMap<u32, link::Stream>,
    opens: HashMap<String, Vec<Instant>>,
    offer: Option<pair::Offer>,
    made: u64,
    pending: Option<pair::Pending>,
    warning: Option<&'static str>,
    sessions: HashMap<String, devices::Session>,
    /// Revoked devices whose files are removed again for a while: when revoked, last tried.
    forgetting: HashMap<String, (Instant, Instant)>,
}

static STATE: LazyLock<Mutex<State>> = LazyLock::new(Mutex::default);

pub(super) use bridge::Device;

type Row = dyn Fn(&str) -> Option<Value> + Send + Sync;

/// What the phone side needs of the daemon: its op table, served as a device, and its own rows.
pub(super) struct Host {
    pub(super) serve: Box<dyn Fn(UnixStream, u64, Device) + Send + Sync>,
    /// A session's row, if the daemon lists it.
    pub(super) row: Box<Row>,
    pub(super) project: Box<dyn Fn(&str) -> bool + Send + Sync>,
}

static HOST: OnceLock<Host> = OnceLock::new();

/// Set once by `main`, before any phone can sign in.
pub(super) fn host(host: Host) {
    let _ = HOST.set(host);
}

pub(super) fn enabled() -> bool {
    std::env::var_os("BRIGADIER_REMOTE").is_some_and(|v| v == "1")
}

/// The gateway, kept by the daemon's pass: running while the switch and Allow connections are on.
#[derive(Default)]
pub(super) struct Remote {
    gateway: Option<gateway::Gateway>,
    tried: Option<Instant>,
}

impl Remote {
    pub(super) fn pass(&mut self, data: &Path) {
        pair::forget_again(&mut STATE.lock().unwrap(), data);
        let want = enabled() && data.join("remote/on").exists();
        if let Some(running) = &mut self.gateway
            && (!want || !running.alive())
        {
            self.gateway = None;
            GATEWAY.store(0, Ordering::SeqCst);
            // Its streams went with it; signed-in sessions stay until they time out or a restart.
            let mut s = STATE.lock().unwrap();
            (s.live, s.out, s.offer, s.pending) = (None, None, None, None);
            s.streams.clear();
        }
        if let Some(running) = &mut self.gateway {
            let mut s = STATE.lock().unwrap();
            link::tick(&mut s);
            let open = s.offer.as_ref().is_some_and(pair::Offer::open);
            if open != running.open {
                running.bonjour.update(&bonjour::txt(&s.public, open));
                running.open = open;
            }
        }
        if !want || self.gateway.is_some() || self.tried.is_some_and(|t| t.elapsed() < RETRY) {
            return;
        }
        self.tried = Some(Instant::now());
        let started = devices::mac_key(data).and_then(|(key, public)| {
            let started = gateway::start(data, &public)?;
            let mut s = STATE.lock().unwrap();
            (s.data, s.key, s.public) = (data.to_path_buf(), key, public);
            (s.live, s.out) = (Some((started.port, name())), Some(started.out.clone()));
            Ok(started)
        });
        match started {
            Ok(started) => {
                GATEWAY.store(started.pid(), Ordering::SeqCst);
                self.gateway = Some(started);
            }
            Err(e) => eprintln!("brigadierd: the phone gateway: {e}"),
        }
    }
}

/// The phone's Keep this Mac awake (remote design §4.6): held while it is asked for, Allow
/// connections is on and the Mac is plugged in. The Mac's own `awake` setting is never changed.
pub(super) fn awake(data: &Path) -> bool {
    enabled() && data.join("remote/on").exists() && pair::awake_asked(data) && power::plugged_in()
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

/// The app's `remote …` commands (Settings › Connections).
pub(super) fn cli(data: &Path, args: &[String]) -> Value {
    pair::cli(data, args)
}
