//! Keeps the Mac awake, screen on, the old app's way [D30, D36]: `caffeinate -d -i -s -w <daemon>`
//! holds the display, idle and (on power) system sleep assertions. `-w` ends it with the daemon,
//! SIGKILL included, and powerd drops a dead process's assertions, so normal sleep comes back
//! however the daemon stops; assertions never outlive a reboot. The lid needs root
//! (`pmset disablesleep`): `brigadier_core::lid` holds it [D333].
//!
//! On Linux logind holds idle and sleep for `systemd-inhibit`, whose command (`tail --pid`) ends with
//! the daemon, and the desktop's screensaver holds the display for as long as the daemon's session
//! bus connection lives; logind drops a dead process's hold, the bus a closed connection's (proposed).

use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};
use std::{process, thread};

#[derive(Default)]
pub struct Awake(Option<Child>, Screen);

#[cfg(not(target_os = "linux"))]
type Screen = ();
/// The display's hold: the connection the screensaver gave its cookie to, once tried while held.
#[cfg(target_os = "linux")]
type Screen = Option<Option<zbus::Connection>>;

#[cfg(not(target_os = "linux"))]
fn hold() -> Command {
    let mut c = Command::new("/usr/bin/caffeinate");
    c.args(["-d", "-i", "-s", "-w", &process::id().to_string()]);
    c
}

/// Cleared once logind refuses to hold sleep for this daemon: polkit lets only an active session's
/// processes do that, and idle alone is held from then on.
#[cfg(target_os = "linux")]
static SLEEP: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(true);

#[cfg(target_os = "linux")]
fn hold() -> Command {
    let sleep = SLEEP.load(std::sync::atomic::Ordering::Relaxed);
    let mut c = Command::new("systemd-inhibit");
    c.arg(if sleep {
        "--what=idle:sleep"
    } else {
        "--what=idle"
    })
    .args(["--mode=block", "--who=Brigadier"])
    .args(["--why=Sessions are working", "tail", "--pid"])
    .args([&process::id().to_string(), "-f", "/dev/null"]);
    c
}

/// Whether the system lists the hold `pid` keeps.
fn listed(pid: u32) -> bool {
    #[cfg(not(target_os = "linux"))]
    let (list, mine) = (
        Command::new("/usr/bin/pmset")
            .args(["-g", "assertions"])
            .output(),
        format!("pid {pid}(caffeinate)"),
    );
    #[cfg(target_os = "linux")]
    let (list, mine) = (
        (Command::new("systemd-inhibit").args(["--list", "--no-pager", "--no-legend"])).output(),
        format!(" {pid} "),
    );
    list.is_ok_and(|o| String::from_utf8_lossy(&o.stdout).contains(&mine))
}

#[cfg(not(target_os = "linux"))]
fn screen(_: &mut Screen, _: bool) {}

/// Holds the display through the screensaver's Inhibit, GNOME's session manager's where there's none
/// (proposed); dropping the connection lets it go.
#[cfg(target_os = "linux")]
fn screen(held: &mut Screen, on: bool) {
    if !on || held.is_some() {
        *held = held.take().filter(|_| on);
        return;
    }
    let why = "Sessions are working";
    let inhibit = async {
        let conn = zbus::Connection::session().await?;
        let saver = "org.freedesktop.ScreenSaver";
        let asked = (conn.call_method(
            Some(saver),
            "/org/freedesktop/ScreenSaver",
            Some(saver),
            "Inhibit",
            &("Brigadier", why),
        ))
        .await;
        if asked.is_err() {
            let gnome = "org.gnome.SessionManager";
            // Flag 8: idle.
            let args = ("Brigadier", 0u32, why, 8u32);
            (conn.call_method(
                Some(gnome),
                "/org/gnome/SessionManager",
                Some(gnome),
                "Inhibit",
                &args,
            ))
            .await?;
        }
        zbus::Result::Ok(conn)
    };
    *held = Some(
        zruntime::block_on(inhibit)
            .inspect_err(|e| eprintln!("brigadierd: can't keep the screen on: {e}"))
            .ok(),
    );
}

impl Awake {
    /// Holds or lets go. A caffeinate that exited on its own is started again.
    pub fn set(&mut self, on: bool) {
        #[cfg(target_os = "linux")]
        if let Some(child) = &mut self.0
            && matches!(child.try_wait(), Ok(Some(s)) if !s.success())
            && SLEEP.swap(false, std::sync::atomic::Ordering::Relaxed)
        {
            eprintln!("brigadierd: logind won't hold off sleep here; holding idle only");
        }
        if let Some(child) = &mut self.0
            && (!on || !matches!(child.try_wait(), Ok(None)))
        {
            let _ = child.kill();
            let _ = child.wait();
            self.0 = None;
        }
        screen(&mut self.1, on);
        if on && self.0.is_none() {
            let child = hold()
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn();
            self.0 = child
                .inspect_err(|e| eprintln!("brigadierd: can't keep the computer awake: {e}"))
                .ok();
        }
    }

    /// Holds, and waits up to 2 s until the system lists the hold: a daemon replacing an older one holds
    /// before it stops it, so the Mac never goes a moment unheld [D60, D82].
    pub fn hold_confirmed(&mut self) {
        self.set(true);
        let Some(pid) = self.0.as_ref().map(Child::id) else {
            return;
        };
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            if listed(pid) {
                return;
            }
            thread::sleep(Duration::from_millis(50));
        }
        eprintln!("brigadierd: the keep-awake hold isn't listed yet; replacing anyway");
    }
}
