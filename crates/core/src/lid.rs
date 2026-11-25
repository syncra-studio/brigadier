//! Keeping going with the lid closed, the old app's way [D333, D336]: no sleep assertion stops a
//! closed lid sleeping a Mac, so while it is wanted the daemon sets `pmset disablesleep 1` through
//! `sudo -n`, allowed by a sudoers rule for those two commands alone. That's Brigadier's own,
//! installed once behind an administrator prompt, or any other keep-awake app's rule. The setting
//! outlives the daemon and a reboot, so a marker in the data folder records it before it is set:
//! a guard process restores sleep when the daemon dies, and a starting daemon restores what a
//! crash or reboot left behind. Sleep another app disabled is that app's: never turned back on.
//!
//! Before the battery is that low, the app warns once per discharge (`warned-low`, so a restart
//! doesn't warn again); after a low battery slept the Mac, `slept-low` says when and at what charge
//! until the user has seen it.
//!
//! `awake lid` says how it stands, `awake lid-setup` installs the rule, `awake lid-seen` clears the
//! sleep the user has seen. A debug build started with
//! `BRIGADIER_LID_DRY_RUN=1` runs neither sudo nor pmset: the marker alone stands for the setting.

use brigadier_frames::log::now_ms;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};
use std::{fs, io, thread};

const SUDO: &str = "/usr/bin/sudo";
const PMSET: &str = "/usr/bin/pmset";
/// Sudo skips files in sudoers.d whose name has a dot, so the rule is checked as `RULE.new` first.
const RULE: &str = "/etc/sudoers.d/brigadier-lid-closed";
/// On battery at or below this charge the lid sleeps the Mac again, as the old app and Vorssaint.
const MIN_PERCENT: u32 = 10;
/// On battery at or below this charge, above MIN_PERCENT, the app warns of it.
const WARN_PERCENT: u32 = 15;
/// On power or above WARN_PERCENT this long, the next discharge warns again: a moment's plug-in doesn't.
const RECHARGED: Duration = Duration::from_secs(120);
/// How often battery and another app's hold are looked at again while the lid is wanted.
const CHECK_EVERY: Duration = Duration::from_secs(10);

fn dry_run() -> bool {
    cfg!(debug_assertions)
        && std::env::var_os("BRIGADIER_LID_DRY_RUN").is_some_and(|v| !v.is_empty())
}

/// Sleep disabled by this daemon; holds its pid.
fn marker(data: &Path) -> PathBuf {
    data.join("sleep-disabled")
}

/// This discharge's warning, `{at, percent}`: there until the battery has been charged.
fn warned(data: &Path) -> PathBuf {
    data.join("warned-low")
}

/// The last sleep a low battery had Brigadier ask for, `{at, percent}`, until the user has seen it.
fn slept(data: &Path) -> PathBuf {
    data.join("slept-low")
}

fn write_note(file: &Path, at: u64, percent: u32) {
    let note = json!({"at": at, "percent": percent}).to_string();
    if let Err(e) = crate::write_atomic(file, note.as_bytes()) {
        eprintln!("brigadierd: {}: {e}", file.display());
    }
}

fn read_note(file: &Path) -> Value {
    fs::read(file)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

/// `awake lid-seen`: the user has seen that the Mac slept.
pub fn seen(data: &Path) -> io::Result<Value> {
    match fs::remove_file(slept(data)) {
        Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e),
        _ => Ok(json!({"ok": true})),
    }
}

/// `awake lid`: `setup` (no rule lets sudo do it without a password), `low` (on battery at or below
/// MIN_PERCENT), `on` (sleep is off now, by Brigadier or another app) or `ready`.
pub fn status(data: &Path) -> io::Result<Value> {
    let state = if sleep_disabled(data) == Some(true) {
        "on"
    } else if !authorized() {
        "setup"
    } else if battery().is_some_and(|b| b.low()) {
        "low"
    } else {
        "ready"
    };
    Ok(json!({"ok": true, "lid": state}))
}

/// `awake lid-setup`: installs the rule behind one administrator prompt, then says how it stands.
pub fn set_up(data: &Path) -> io::Result<Value> {
    if !dry_run() && !authorized() {
        let uid = unsafe { libc::getuid() };
        let rule =
            format!("#{uid} ALL=(root) NOPASSWD: {PMSET} disablesleep 1, {PMSET} disablesleep 0");
        let script = format!(
            "mkdir -p /etc/sudoers.d && echo '{rule}' > {RULE}.new && chmod 0440 {RULE}.new \
             && /usr/sbin/visudo -c -q -f {RULE}.new && mv -f {RULE}.new {RULE} || {{ rm -f {RULE}.new; exit 1; }}"
        );
        let prompt = "Brigadier wants to keep working with the lid closed. It asks once; after that it can only turn sleep off and on again.";
        let apple = format!(
            "do shell script \"{script}\" with administrator privileges with prompt \"{prompt}\""
        );
        let out = Command::new("/usr/bin/osascript")
            .args(["-e", &apple])
            .stdin(Stdio::null())
            .output()?;
        if !out.status.success() {
            let err = String::from_utf8_lossy(&out.stderr);
            return Err(io::Error::other(match err.contains("-128") {
                true => "The administrator password was not given.".to_string(),
                false => format!("Setting up failed: {}", err.trim()),
            }));
        }
    }
    status(data)
}

/// Whether sudo lets this user run both commands without a password: Brigadier's rule or another's.
fn authorized() -> bool {
    if dry_run() {
        return true;
    }
    let Ok(out) = Command::new(SUDO)
        .args(["-n", "-l"])
        .stdin(Stdio::null())
        .output()
    else {
        return false;
    };
    out.status.success() && allows(&String::from_utf8_lossy(&out.stdout))
}

/// Reads `sudo -l`: an entry, wrapped lines joined, `(root|ALL) NOPASSWD: …` whose commands include
/// both `pmset disablesleep` values, the bare program, or `ALL`.
fn allows(listing: &str) -> bool {
    let Some((_, rules)) = listing.split_once("may run the following commands") else {
        return false;
    };
    let mut entries: Vec<String> = Vec::new();
    for line in rules.lines().skip(1) {
        match entries.last_mut() {
            Some(entry) if line.starts_with("        ") => entry.extend([" ", line.trim()]),
            _ if line.starts_with("    ") => entries.push(line.trim().to_string()),
            _ => {}
        }
    }
    entries.iter().any(|entry| {
        let Some((runas, commands)) = entry.strip_prefix('(').and_then(|e| e.split_once(')'))
        else {
            return false;
        };
        let users = runas.split(':').next().unwrap_or_default();
        if !users.split(',').any(|u| matches!(u.trim(), "root" | "ALL")) {
            return false;
        }
        let Some((_, commands)) = commands.split_once("NOPASSWD:") else {
            return false;
        };
        let specs: Vec<String> = commands
            .split(',')
            .map(|c| c.split_whitespace().collect::<Vec<_>>().join(" "))
            .collect();
        ["1", "0"].iter().all(|v| {
            specs
                .iter()
                .any(|s| s == "ALL" || s == PMSET || *s == format!("{PMSET} disablesleep {v}"))
        })
    })
}

/// `SleepDisabled` in `pmset -g`; a dry run reads the marker instead.
fn sleep_disabled(data: &Path) -> Option<bool> {
    if dry_run() {
        return Some(marker(data).exists());
    }
    let out = Command::new(PMSET).arg("-g").output().ok()?;
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .find_map(|line| {
            let mut words = line.split_whitespace();
            (words.next()? == "SleepDisabled").then(|| words.next() == Some("1"))
        })
}

fn pmset_disablesleep(on: bool) -> io::Result<()> {
    if dry_run() {
        eprintln!(
            "brigadierd: dry run: would run sudo -n pmset disablesleep {}",
            on as u8
        );
        return Ok(());
    }
    let v = if on { "1" } else { "0" };
    let out = Command::new(SUDO)
        .args(["-n", PMSET, "disablesleep", v])
        .stdin(Stdio::null())
        .output()?;
    match out.status.success() {
        true => Ok(()),
        false => Err(io::Error::other(
            String::from_utf8_lossy(&out.stderr).trim().to_string(),
        )),
    }
}

#[derive(Clone, Copy)]
struct Battery {
    percent: u32,
    /// Running on it, not on power.
    used: bool,
}

impl Battery {
    /// On battery at or below MIN_PERCENT.
    fn low(self) -> bool {
        self.used && self.percent <= MIN_PERCENT
    }
}

/// From `pmset -g batt`; none on a Mac with no battery.
fn battery() -> Option<Battery> {
    let out = Command::new(PMSET).args(["-g", "batt"]).output().ok()?;
    let report = String::from_utf8_lossy(&out.stdout);
    let percent = report
        .split_whitespace()
        .find_map(|w| w.strip_suffix("%;")?.parse().ok())?;
    Some(Battery {
        percent,
        used: report.contains("'Battery Power'"),
    })
}

/// Whether keeping awake should hold with the lid closed too: Settings' `awake_lid`, off by default.
pub fn wanted(data: &Path) -> bool {
    let saved: Value = fs::read(data.join("settings.json"))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();
    saved["awake_lid"] == "true"
}

/// A starting daemon restores sleep a crash or reboot left disabled; only its own, by the marker.
pub fn recover(data: &Path) {
    if !marker(data).exists() {
        return;
    }
    match pmset_disablesleep(false) {
        Ok(()) => {
            let _ = fs::remove_file(marker(data));
            eprintln!("brigadierd: restored sleep left disabled by an earlier run");
        }
        Err(e) => eprintln!("brigadierd: can't restore sleep left disabled: {e}"),
    }
}

/// Sleep held off for the lid. Not `owned` when another app had disabled it already: left to it.
struct Held {
    owned: bool,
    guard: Option<Child>,
}

#[derive(Default)]
pub struct Lid {
    held: Option<Held>,
    next: Option<Instant>,
    /// When a restore that failed is tried again.
    retry: Option<Instant>,
    /// When the battery is next looked at with the lid not wanted, to see a warned one charged.
    look: Option<Instant>,
    /// Since when it has been on power or above WARN_PERCENT.
    charged: Option<Instant>,
}

impl Lid {
    /// Holds or lets go, each daemon pass. Battery and another app's hold are looked at every
    /// CHECK_EVERY, and a failed hold tried again then.
    pub fn set(&mut self, data: &Path, want: bool) {
        if !want {
            self.release(data, None);
            self.next = None;
            let due = self.look.is_none_or(|look| Instant::now() >= look);
            if due && warned(data).exists() {
                self.look = Some(Instant::now() + CHECK_EVERY);
                self.warn(data, battery());
            }
            return;
        }
        if self.next.is_some_and(|next| Instant::now() < next) {
            return;
        }
        self.next = Some(Instant::now() + CHECK_EVERY);
        let battery = battery();
        self.warn(data, battery);
        if let Some(low) = battery.filter(|b| b.low()) {
            self.release(data, Some(low.percent));
            return;
        }
        // Borrowed from another app that has since let sleep back on: take it over.
        if self.held.as_ref().is_some_and(|h| !h.owned) && sleep_disabled(data) == Some(false) {
            self.held = None;
        }
        if self.held.is_none() {
            self.held = hold(data)
                .inspect_err(|e| eprintln!("brigadierd: can't keep going with the lid closed: {e}"))
                .ok();
        }
    }

    /// Warns once per discharge, while the lid is held by this daemon: another app's hold isn't let go.
    fn warn(&mut self, data: &Path, battery: Option<Battery>) {
        let Some(battery) = battery else {
            return;
        };
        let file = warned(data);
        if !battery.used || battery.percent > WARN_PERCENT {
            let since = *self.charged.get_or_insert_with(Instant::now);
            if since.elapsed() >= RECHARGED {
                let _ = fs::remove_file(file);
            }
            return;
        }
        self.charged = None;
        let held = self.held.as_ref().is_some_and(|h| h.owned);
        if held && !battery.low() && !file.exists() {
            write_note(&file, now_ms(), battery.percent);
        }
    }

    /// What the app shows: whether the lid is held, this discharge's warning and the sleep not seen yet.
    pub fn shown(&self, data: &Path) -> Value {
        json!({"held": self.held.is_some(), "warned": read_note(&warned(data)),
            "slept": read_note(&slept(data))})
    }

    /// Restores sleep if this daemon disabled it, then sleeps now if the lid is shut and that
    /// sleeps the Mac: macOS looks at the lid only when it opens or closes. A failed restore keeps
    /// the hold, its marker and guard, and is tried again after CHECK_EVERY. Let go at a `low`
    /// charge, the sleep it asked for is kept to tell the user.
    fn release(&mut self, data: &Path, low: Option<u32>) {
        let Some(held) = &mut self.held else {
            return;
        };
        if held.owned {
            if self.retry.is_some_and(|retry| Instant::now() < retry) {
                return;
            }
            if let Err(e) = pmset_disablesleep(false) {
                eprintln!("brigadierd: can't restore sleep: {e}");
                self.retry = Some(Instant::now() + CHECK_EVERY);
                return;
            }
            if let Some(guard) = &mut held.guard {
                let _ = guard.kill();
                let _ = guard.wait();
            }
            let _ = fs::remove_file(marker(data));
            if !dry_run() {
                let slept = slept(data);
                thread::spawn(move || {
                    if let (Some(at), Some(percent)) = (sleep_if_lid_closed(), low) {
                        write_note(&slept, at, percent);
                    }
                });
            }
        }
        self.held = None;
        self.retry = None;
    }
}

/// Disables sleep, the marker first so that it is undone even after a crash.
fn hold(data: &Path) -> io::Result<Held> {
    if sleep_disabled(data) == Some(true) {
        return Ok(Held {
            owned: false,
            guard: None,
        });
    }
    let pid = std::process::id().to_string();
    fs::write(marker(data), &pid)?;
    if let Err(e) = pmset_disablesleep(true) {
        let _ = fs::remove_file(marker(data));
        return Err(e);
    }
    Ok(Held {
        owned: true,
        guard: guard(&pid, &marker(data)),
    })
}

/// A process of its own that restores sleep once the daemon is gone, unless a newer daemon took
/// the marker over.
fn guard(pid: &str, marker: &Path) -> Option<Child> {
    use std::os::unix::process::CommandExt;
    let restore = if dry_run() {
        ":"
    } else {
        "/usr/bin/sudo -n /usr/bin/pmset disablesleep 0"
    };
    let script = format!(
        r#"while kill -0 "$1" 2>/dev/null; do sleep 5; done
if [ "$(cat "$2" 2>/dev/null)" = "$1" ]; then {restore} && rm -f "$2"; fi"#
    );
    Command::new("/bin/sh")
        .args(["-c", &script, "brigadier-sleep-guard", pid])
        .arg(marker)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .process_group(0)
        .spawn()
        .inspect_err(|e| eprintln!("brigadierd: can't start the sleep guard: {e}"))
        .ok()
}

/// powerd takes a moment to apply sleep coming back on and refuses until then, so a few tries.
/// Says when it asked, once macOS took it.
fn sleep_if_lid_closed() -> Option<u64> {
    for _ in 0..10 {
        let out = Command::new("/usr/sbin/ioreg")
            .args(["-r", "-k", "AppleClamshellState", "-d", "1"])
            .output()
            .ok()?;
        let report = String::from_utf8_lossy(&out.stdout);
        // Open, or plugged in with an external display (the closed lid doesn't sleep it): leave it.
        if !report.contains("\"AppleClamshellState\" = Yes")
            || !report.contains("\"AppleClamshellCausesSleep\" = Yes")
        {
            return None;
        }
        let at = now_ms();
        if Command::new(PMSET)
            .arg("sleepnow")
            .stdout(Stdio::null())
            .status()
            .is_ok_and(|s| s.success())
        {
            return Some(at);
        }
        thread::sleep(Duration::from_millis(500));
    }
    None
}
