//! `brigadierd --install`, run by the packaged app from inside its bundle [D40, D71]. It puts this
//! build's binaries in `bin/<build>/` under the data folder, points `bin/current` at them, and
//! starts the daemon there. On macOS it is a launchd job of its own, labelled by data folder: in
//! the app's coalition, a quit with a helper left running had macOS force-quit the daemon, every
//! host and every agent [D598, D606]. The job runs the build's small `Brigadier.app`, copied to
//! `bin/Brigadier.app`, which starts the daemon as its child and stays its parent (launcher.rs), so
//! macOS's privacy prompts read as Brigadier and their answers last across builds: what asks is the
//! responsible process, kept as its bundle's id, where a bare binary is kept, and shown, as its path.
//! That path outlives the daemon in the hosts it started, so the bundle's never moves with a build
//! and is never swept. If launchd refuses it, or elsewhere, the daemon is exec'd as before.
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
#[cfg(unix)]
use std::os::unix::process::CommandExt;
use std::path::Path;
#[cfg(target_os = "macos")]
use std::path::PathBuf;
use std::process::{self, Command};
use std::thread;
use std::time::{Duration, Instant};

/// The launcher's program in `bin`.
#[cfg(target_os = "macos")]
const LAUNCHER: &str = "Brigadier.app/Contents/MacOS/Brigadier";

pub fn install_and_exec(data: &Path) -> io::Result<()> {
    let bin = data.join("bin");
    fs::create_dir_all(&bin)?;
    let mine = wire::build();
    // The bundle's computer-use helper, which the daemon launches [D913]: Resources/bin/.. here.
    let helper = (std::env::current_exe()?.parent().and_then(Path::parent))
        .map(|resources| resources.join("Brigadier Computer Use.app"))
        .filter(|app| app.is_dir());
    let file = data.join(brigadier::computer::HELPER_FILE);
    match helper {
        Some(app) => fs::write(&file, app.as_os_str().as_encoded_bytes())?,
        None => drop(fs::remove_file(&file)),
    }
    {
        let _lock = wait_lock(&bin.join("install.lock"))?;
        let current = build_of(&bin.join("current"));
        // Never replace a newer build: an older app copy runs the newer daemon instead [D82].
        if current.is_none_or(|c| c < mine) {
            let here = std::env::current_exe()?;
            put(&bin, here.parent().unwrap_or(Path::new(".")), mine)?;
            sweep(data, &bin, mine, current);
        }
        #[cfg(target_os = "macos")]
        if start_job(data, &bin)? {
            return Ok(());
        }
        #[cfg(target_os = "linux")]
        if start_unit(data, &bin)? {
            return Ok(());
        }
    }
    #[cfg(unix)]
    return Err(Command::new(bin.join("current/brigadierd")).exec());
    // No exec: the daemon starts out of every job around this one, which then ends [D157].
    #[cfg(windows)]
    {
        let build = build_of(&bin.join("current")).unwrap_or(mine);
        let daemon = bin.join(build.to_string()).join("brigadierd.exe");
        brigadier_frames::spawn::detached(&mut Command::new(daemon)).map(drop)
    }
}

/// Starts the daemon as the data folder's launchd job unless this build or a newer one runs, and
/// says whether launchd took it. Runs under the install lock, which it holds until the daemon holds
/// its own, so a second install can't boot out a job just started.
#[cfg(target_os = "macos")]
fn start_job(data: &Path, bin: &Path) -> io::Result<bool> {
    let lock = data.join("daemon.lock");
    let mut older = None;
    if lock_held(&lock) {
        // The job can't be loaded twice, so an older daemon is stopped here rather than by the new one.
        match crate::answering(data)? {
            Some((pid, build)) if build.is_none_or(|b| b < wire::build() as u64) => {
                older = Some(pid)
            }
            _ => return Ok(true),
        }
    }
    // Copied while the older daemon still runs, so an install cut off here leaves it running.
    let staged = stage_launcher(bin);
    if let Some(pid) = older {
        crate::stop(data, pid);
        if lock_held(&lock) {
            return Ok(true);
        }
    }
    // Only now the last daemon, and its launcher, is gone: macOS refuses what a process asks for
    // while the code it runs isn't what its path holds. Failed, the job runs the launcher there is,
    // else the bare daemon.
    if let Err(e) = staged.and_then(|stage| stage.map_or(Ok(()), |s| swap_launcher(bin, &s))) {
        eprintln!("brigadierd: the launcher: {e}");
    }
    let launcher = Some(bin.join(LAUNCHER)).filter(|p| p.exists());
    // FNV-1a: the same label from every build.
    let path = data.to_string_lossy();
    let hash = path.bytes().fold(0xcbf29ce484222325u64, |h, b| {
        (h ^ b as u64).wrapping_mul(0x100000001b3)
    });
    let label = format!("ai.brigadier.daemon.{hash:016x}");
    let esc = |s: &str| {
        s.replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
    };
    let env: String = std::env::vars_os()
        .map(|(k, v)| {
            (
                k.to_string_lossy().into_owned(),
                v.to_string_lossy().into_owned(),
            )
        })
        // XML can't hold other control characters; such a variable would fail the whole plist.
        .filter(|(k, v)| {
            !format!("{k}{v}")
                .chars()
                .any(|c| c.is_control() && !"\t\n\r".contains(c))
        })
        .map(|(k, v)| format!("<key>{}</key><string>{}</string>", esc(&k), esc(&v)))
        .collect();
    let argv: String = (launcher.into_iter())
        .chain([bin.join("current/brigadierd")])
        .map(|p| format!("<string>{}</string>", esc(&p.to_string_lossy())))
        .collect();
    let log = data.join("daemon.log");
    let mut output = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log)?;
    crate::logging::trim(&mut output)?;
    let stderr = esc(&log.to_string_lossy());
    let plist = data.join("daemon.plist");
    // Interactive: no resource limits, as when the app started it. No KeepAlive: the app starts it.
    fs::write(
        &plist,
        format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>{label}</string>
<key>ProgramArguments</key><array>{argv}</array>
<key>EnvironmentVariables</key><dict>{env}</dict>
<key>StandardErrorPath</key><string>{stderr}</string>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><false/>
<key>AbandonProcessGroup</key><true/>
<key>ProcessType</key><string>Interactive</string>
</dict></plist>
"#
        ),
    )?;
    let domain = format!("gui/{}", unsafe { libc::geteuid() });
    // A loaded job whose daemon has exited; its hosts are in sessions of their own and stay.
    let bootout = || {
        let _ = Command::new("/bin/launchctl")
            .args(["bootout", &format!("{domain}/{label}")])
            .status();
    };
    bootout();
    if !Command::new("/bin/launchctl")
        .args(["bootstrap", &domain])
        .arg(&plist)
        .status()?
        .success()
    {
        return Ok(false);
    }
    let deadline = Instant::now() + Duration::from_secs(10);
    while !lock_held(&lock) && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(20));
    }
    // Taken but never started, as with a launcher that can't run, is refused too.
    let started = lock_held(&lock);
    if !started {
        bootout();
    }
    Ok(started)
}

/// Starts the daemon as the data folder's systemd user service, as `start_job` does with launchd,
/// and says whether systemd took it: the app's scope ending never reaches it, and its hosts run in
/// scopes of their own (owner.rs), so stopping it never reaches them. Runs under the install lock.
#[cfg(target_os = "linux")]
fn start_unit(data: &Path, bin: &Path) -> io::Result<bool> {
    use std::process::Stdio;
    if !brigadier::owner::user_manager() {
        return Ok(false);
    }
    let lock = data.join("daemon.lock");
    if lock_held(&lock) {
        match crate::answering(data)? {
            Some((pid, build)) if build.is_none_or(|b| b < wire::build() as u64) => {
                crate::stop(data, pid);
                if lock_held(&lock) {
                    return Ok(true);
                }
            }
            _ => return Ok(true),
        }
    }
    let unit = format!("{}.service", brigadier::owner::unit(data));
    let systemctl = |verb: &str| {
        let _ = (Command::new("systemctl").args(["--user", verb, &unit]))
            .stderr(Stdio::null())
            .status();
    };
    // A unit name is taken until its last run is gone, failed or not.
    systemctl("stop");
    systemctl("reset-failed");
    let log = data.join("daemon.log");
    let mut output = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log)?;
    crate::logging::trim(&mut output)?;
    let mut run = Command::new("systemd-run");
    run.args(["--user", "--quiet", "--collect", "--service-type=exec"])
        .arg(format!("--unit={unit}"))
        .arg(format!("--property=StandardError=append:{}", log.display()))
        .arg("--property=StandardOutput=null");
    // The whole environment, as the plist gives it, so the data folder and homes are this one's.
    let vars = std::env::vars_os()
        .filter_map(|(k, v)| Some((k.into_string().ok()?, v.into_string().ok()?)));
    for (k, v) in vars {
        if !format!("{k}{v}")
            .chars()
            .any(|c| c.is_control() && !"\t\n".contains(c))
        {
            run.arg(format!("--setenv={k}={v}"));
        }
    }
    if !run
        .arg("--")
        .arg(bin.join("current/brigadierd"))
        .status()?
        .success()
    {
        return Ok(false);
    }
    let deadline = Instant::now() + Duration::from_secs(10);
    while !lock_held(&lock) && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(20));
    }
    let started = lock_held(&lock);
    if !started {
        systemctl("stop");
    }
    Ok(started)
}

/// The build `current` points at, if its folder holds a daemon.
#[cfg(unix)]
fn build_of(current: &Path) -> Option<u32> {
    let build = fs::read_link(current).ok()?.to_str()?.parse().ok()?;
    current.join("brigadierd").exists().then_some(build)
}

/// On Windows `current` is a file naming the build: symlinks need Developer Mode.
#[cfg(windows)]
fn build_of(current: &Path) -> Option<u32> {
    let build: u32 = fs::read_to_string(current).ok()?.trim().parse().ok()?;
    let folder = current.with_file_name(build.to_string());
    folder.join("brigadierd.exe").exists().then_some(build)
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

/// `current`'s launcher, copied beside its one path, `bin/Brigadier.app`, unless its Info.plist,
/// which names the build, is there already.
#[cfg(target_os = "macos")]
fn stage_launcher(bin: &Path) -> io::Result<Option<PathBuf>> {
    let from = bin.join("current/Brigadier.app");
    let plist = fs::read(from.join("Contents/Info.plist"))?;
    if fs::read(bin.join("Brigadier.app/Contents/Info.plist")).is_ok_and(|old| old == plist) {
        return Ok(None);
    }
    let stage = bin.join(format!(".stage-app-{}", process::id()));
    let _ = fs::remove_dir_all(&stage);
    copy(&from, &stage)?;
    Ok(Some(stage))
}

/// Puts the copy at its path by one rename, so it is there whole or not at all.
#[cfg(target_os = "macos")]
fn swap_launcher(bin: &Path, stage: &Path) -> io::Result<()> {
    use std::os::unix::ffi::OsStrExt;
    let app = bin.join("Brigadier.app");
    if !app.exists() {
        return fs::rename(stage, &app);
    }
    let c = |p: &Path| std::ffi::CString::new(p.as_os_str().as_bytes());
    let (a, b) = (c(stage)?, c(&app)?);
    if unsafe { libc::renamex_np(a.as_ptr(), b.as_ptr(), libc::RENAME_SWAP) } != 0 {
        return Err(io::Error::last_os_error());
    }
    let _ = fs::remove_dir_all(stage);
    Ok(())
}

/// Copies a folder, each file on disk before it returns.
fn copy(from: &Path, to: &Path) -> io::Result<()> {
    fs::create_dir(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let to = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy(&entry.path(), &to)?;
        } else {
            copy_file(&entry.path(), &to)?;
        }
    }
    Ok(())
}

fn copy_file(from: &Path, to: &Path) -> io::Result<()> {
    fs::copy(from, to)?;
    // Written to: Windows flushes only a file open for writing.
    fs::OpenOptions::new().write(true).open(to)?.sync_all()
}

fn put(bin: &Path, here: &Path, build: u32) -> io::Result<()> {
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
        for entry in fs::read_dir(here)? {
            let entry = entry?;
            let to = stage.join(entry.file_name());
            if entry.file_type()?.is_file() {
                copy_file(&entry.path(), &to)?;
            } else if entry.file_name() == "Brigadier.app" {
                copy(&entry.path(), &to)?;
            }
        }
        fs::rename(&stage, &dest)?;
    }
    let link = bin.join(format!(".current-{}", process::id()));
    #[cfg(unix)]
    std::os::unix::fs::symlink(build.to_string(), &link)?;
    #[cfg(windows)]
    fs::write(&link, build.to_string())?;
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
