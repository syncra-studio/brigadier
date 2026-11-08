//! `brigadierd --install`, run by the packaged app from inside its bundle [D40, D71]. It puts this
//! build's binaries in `bin/<build>/` under the data folder, points `bin/current` at them, and
//! execs the daemon there (same pid, so macOS still credits the app with everything it starts).
//!
//! A build folder is never written once it is in place: a busy host keeps running its old build's
//! files, while an idle one sees `current/brigadier-host` change and re-execs onto the new build
//! [D60, D82]. Folders appear whole (staged, then renamed) and `current` moves by one rename, so an
//! install cut off at any point leaves the previous build running.

use brigadier_core::{ids, session_dir};
use brigadier_frames::{lock_held, take_lock, wire};
use serde_json::Value;
use std::fs::{self, File};
use std::io;
use std::os::unix::fs::symlink;
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{self, Command};
use std::thread;
use std::time::{Duration, Instant};

pub fn install_and_exec(data: &Path) -> io::Result<()> {
    let bin = data.join("bin");
    fs::create_dir_all(&bin)?;
    let mine = wire::build();
    {
        let _lock = wait_lock(&bin.join("install.lock"))?;
        let current = build_of(&bin.join("current"));
        // Never replace a newer build: an older app copy runs the newer daemon instead [D82].
        if current.is_none_or(|c| c < mine) {
            put(&bin, mine)?;
            sweep(data, &bin, mine, current);
        }
    }
    Err(Command::new(bin.join("current/brigadierd")).exec())
}

/// The build `current` points at, if its folder holds a daemon.
fn build_of(current: &Path) -> Option<u32> {
    let build = fs::read_link(current).ok()?.to_str()?.parse().ok()?;
    current.join("brigadierd").exists().then_some(build)
}

fn wait_lock(path: &Path) -> io::Result<File> {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        if let Some(lock) = take_lock(path)? {
            return Ok(lock);
        }
        if Instant::now() > deadline {
            return Err(io::Error::other("another install still holds the lock"));
        }
        thread::sleep(Duration::from_millis(50));
    }
}

fn put(bin: &Path, build: u32) -> io::Result<()> {
    // Under the lock, so these are what a cut-off or failed install left.
    for entry in fs::read_dir(bin)?.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with(".stage-") || name.starts_with(".current-") {
            let path = entry.path();
            let _ = fs::remove_dir_all(&path).or_else(|_| fs::remove_file(&path));
        }
    }
    let dest = bin.join(build.to_string());
    // A folder only ever appears whole, so one that exists is complete.
    if !dest.exists() {
        let stage = bin.join(format!(".stage-{}", process::id()));
        fs::create_dir(&stage)?;
        let here = std::env::current_exe()?;
        for entry in fs::read_dir(here.parent().unwrap_or(Path::new(".")))? {
            let entry = entry?;
            if entry.file_type()?.is_file() {
                let to = stage.join(entry.file_name());
                fs::copy(entry.path(), &to)?;
                File::open(&to)?.sync_all()?;
            }
        }
        fs::rename(&stage, &dest)?;
    }
    let link = bin.join(format!(".current-{}", process::id()));
    symlink(build.to_string(), &link)?;
    fs::rename(&link, bin.join("current"))
}

/// Removes builds older than the one just replaced that no live host runs. The replaced build
/// stays: its daemon may still be running.
fn sweep(data: &Path, bin: &Path, mine: u32, replaced: Option<u32>) {
    let live: Vec<u64> = ids(data)
        .iter()
        .map(|id| session_dir(data, id))
        .filter(|dir| lock_held(&dir.join("owner.lock")))
        .filter_map(|dir| {
            let info: Value =
                serde_json::from_slice(&fs::read(dir.join("owner.json")).ok()?).ok()?;
            info["build"].as_u64()
        })
        .collect();
    for entry in fs::read_dir(bin).into_iter().flatten().flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name
            .parse::<u32>()
            .is_ok_and(|b| b != mine && Some(b) != replaced && !live.contains(&(b as u64)))
        {
            let _ = fs::remove_dir_all(entry.path());
        }
    }
}
