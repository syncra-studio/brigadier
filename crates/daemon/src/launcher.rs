//! `Brigadier.app`'s program: what launchd runs, with the daemon's path, on macOS (install.rs). It
//! only starts the daemon and waits for it. macOS asks the user in the name of the job's own process
//! for all the agents do, so that process is this, whose bundle's id and path no build changes.

#[cfg(unix)]
use std::process::Command;
use std::process::exit;
#[cfg(unix)]
use std::sync::atomic::{AtomicI32, Ordering};

#[cfg(not(unix))]
fn main() {
    eprintln!("brigadier-launcher is macOS's alone.");
    exit(1)
}

#[cfg(unix)]
static DAEMON: AtomicI32 = AtomicI32::new(0);

/// launchd's stop, at a logout or a `bootout`, is the daemon's.
#[cfg(unix)]
extern "C" fn stop(sig: libc::c_int) {
    unsafe { libc::kill(DAEMON.load(Ordering::Relaxed), sig) };
}

#[cfg(unix)]
fn main() -> std::io::Result<()> {
    let mut args = std::env::args_os().skip(1);
    let program =
        (args.next()).ok_or_else(|| std::io::Error::other("usage: Brigadier <daemon>"))?;
    let mut daemon = Command::new(program).args(args).spawn()?;
    DAEMON.store(daemon.id() as i32, Ordering::Relaxed);
    unsafe { libc::signal(libc::SIGTERM, stop as *const () as libc::sighandler_t) };
    exit(daemon.wait()?.code().unwrap_or(0))
}
