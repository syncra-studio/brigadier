//! The calls log under a session's `computer/` folder [D2032].

use std::cell::RefCell;
use std::fs;
use std::io::Write;
use std::path::PathBuf;

thread_local! {
    /// This call's line for the calls log, until it is written.
    pub(super) static UNLOGGED: RefCell<Option<(PathBuf, &'static str)>> = const { RefCell::new(None) };
}

/// Brigadier's own count of the calls that went through or reached the app, not those it refused,
/// which a worker's result carries so its lead needn't take its word [D2032]. Written as the
/// action leaves, so a turn stopped while it waits still counts it.
pub(super) fn sent() {
    let Some((calls, verb)) = UNLOGGED.take() else {
        return;
    };
    let _ = fs::create_dir_all(&calls).and_then(|()| {
        let mut f = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(calls.join("calls"))?;
        writeln!(f, "{} {verb}", brigadier_frames::log::now_ms())
    });
}
