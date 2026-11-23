//! Keeps the Mac awake, screen on, the old app's way [D30, D36]: `caffeinate -d -i -s -w <daemon>`
//! holds the display, idle and (on power) system sleep assertions. `-w` ends it with the daemon,
//! SIGKILL included, and powerd drops a dead process's assertions, so normal sleep comes back
//! however the daemon stops; assertions never outlive a reboot. The lid needs root
//! (`pmset disablesleep`): `brigadier_core::lid` holds it [D333].

use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};
use std::{process, thread};

#[derive(Default)]
pub struct Awake(Option<Child>);

impl Awake {
    /// Holds or lets go. A caffeinate that exited on its own is started again.
    pub fn set(&mut self, on: bool) {
        if let Some(child) = &mut self.0
            && (!on || !matches!(child.try_wait(), Ok(None)))
        {
            let _ = child.kill();
            let _ = child.wait();
            self.0 = None;
        }
        if on && self.0.is_none() {
            let child = Command::new("/usr/bin/caffeinate")
                .args(["-d", "-i", "-s", "-w", &process::id().to_string()])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn();
            self.0 = child
                .inspect_err(|e| eprintln!("brigadierd: can't keep the Mac awake: {e}"))
                .ok();
        }
    }

    /// Holds, and waits up to 2 s until powerd lists the hold: a daemon replacing an older one holds
    /// before it stops it, so the Mac never goes a moment unheld [D60, D82].
    pub fn hold_confirmed(&mut self) {
        self.set(true);
        let Some(pid) = self.0.as_ref().map(Child::id) else {
            return;
        };
        let mine = format!("pid {pid}(caffeinate)");
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            let listed = Command::new("/usr/bin/pmset")
                .args(["-g", "assertions"])
                .output()
                .is_ok_and(|o| String::from_utf8_lossy(&o.stdout).contains(&mine));
            if listed {
                return;
            }
            thread::sleep(Duration::from_millis(50));
        }
        eprintln!("brigadierd: the keep-awake hold isn't listed yet; replacing anyway");
    }
}
