//! What every adapter shares to run as the user would: the user's login-shell PATH.

use std::io::Read;
use std::os::unix::process::CommandExt;
use std::process::{Command, Output, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// What the login shell gives. Kept in memory only, never written or logged.
#[derive(Clone, Default)]
pub struct Login {
    pub path: String,
}

static LOGIN: Mutex<Option<Login>> = Mutex::new(None);
const SYSTEM_PATH: &str = "/usr/bin:/bin:/usr/sbin:/sbin";
const MARK: &str = "__brigadier_env__";

/// The login shell's environment, read once and kept until `refresh`.
pub fn login() -> Login {
    if let Some(l) = LOGIN.lock().unwrap().clone() {
        return l;
    }
    refresh()
}

/// Reads the login shell's environment again. A shell that fails or hangs leaves the system PATH.
pub fn refresh() -> Login {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let mut command = Command::new(shell);
    // Interactive too: many users export PATH only in .zshrc.
    command.args(["-l", "-i", "-c", &format!("printf {MARK}; /usr/bin/env -0")]);
    let mut login = Login {
        path: SYSTEM_PATH.into(),
    };
    if let Ok(out) = run(&mut command, 5) {
        let text = String::from_utf8_lossy(&out.stdout);
        let env = text.rsplit_once(MARK).map_or("", |(_, e)| e);
        for (k, v) in env.split('\0').filter_map(|kv| kv.split_once('=')) {
            if k == "PATH" && !v.is_empty() {
                login.path = v.into();
            }
        }
    }
    *LOGIN.lock().unwrap() = Some(login.clone());
    login
}

/// Runs a probe to its end or kills its whole group after `secs`. Stdin is closed, so a probe
/// that asks a question fails instead of waiting.
pub fn run(command: &mut Command, secs: u64) -> Result<Output, String> {
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0)
        .spawn()
        .map_err(|e| e.to_string())?;
    let pipe = |r: Option<Box<dyn Read + Send>>| {
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut buf = vec![];
            if let Some(mut r) = r {
                let _ = r.read_to_end(&mut buf);
            }
            let _ = tx.send(buf);
        });
        rx
    };
    let out = pipe(child.stdout.take().map(|s| Box::new(s) as _));
    let err = pipe(child.stderr.take().map(|s| Box::new(s) as _));
    let deadline = Instant::now() + Duration::from_secs(secs);
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            _ => {
                unsafe { libc::killpg(child.id() as i32, libc::SIGKILL) };
                let _ = child.wait();
                return Err(format!("timed out after {secs} s"));
            }
        }
    };
    // A child it left in its group may hold the pipes open: end it, and never wait past the deadline.
    unsafe { libc::killpg(child.id() as i32, libc::SIGKILL) };
    let drain = |rx: std::sync::mpsc::Receiver<Vec<u8>>| {
        rx.recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .unwrap_or_default()
    };
    Ok(Output {
        status,
        stdout: drain(out),
        stderr: drain(err),
    })
}
