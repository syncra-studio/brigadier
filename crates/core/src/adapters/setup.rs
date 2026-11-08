//! What every adapter shares to be found, checked and signed in [D43, D45]: the user's login-shell
//! PATH and credential variables, and probes that always end.

use std::collections::BTreeMap;
use std::io::Read;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// What the login shell gives: PATH, and the credential variables some adapter names (`keys`).
/// Kept in memory only, never written or logged.
#[derive(Clone, Default)]
pub struct Login {
    pub path: String,
    pub vars: BTreeMap<String, String>,
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

/// Reads the login shell's environment again (an install may have changed it). A shell that
/// fails or hangs leaves the system PATH and no variables.
pub fn refresh() -> Login {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let mut command = Command::new(shell);
    // Interactive too: many users export PATH and keys only in .zshrc.
    command.args(["-l", "-i", "-c", &format!("printf {MARK}; /usr/bin/env -0")]);
    let wanted: Vec<&str> = super::all()
        .iter()
        .flat_map(|a| a.keys())
        .copied()
        .collect();
    let mut login = Login {
        path: SYSTEM_PATH.into(),
        vars: BTreeMap::new(),
    };
    if let Ok(out) = run(&mut command, 5) {
        let text = String::from_utf8_lossy(&out.stdout);
        let env = text.rsplit_once(MARK).map_or("", |(_, e)| e);
        for (k, v) in env.split('\0').filter_map(|kv| kv.split_once('=')) {
            if k == "PATH" && !v.is_empty() {
                login.path = v.into();
            } else if wanted.contains(&k) && !v.is_empty() {
                login.vars.insert(k.into(), v.into());
            }
        }
    }
    *LOGIN.lock().unwrap() = Some(login.clone());
    login
}

/// A binary in its installer's folders under HOME first, then on the login PATH.
pub fn find(bin: &str, folders: &[&str]) -> Option<PathBuf> {
    let home = super::home_path("");
    let path = login().path;
    folders
        .iter()
        .map(|f| home.join(f))
        .chain(path.split(':').map(PathBuf::from))
        .map(|d| d.join(bin))
        .find(|p| is_exe(p))
}

fn is_exe(p: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    p.metadata()
        .is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
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

/// The git repository a folder is in: its top folder, found by walking up to a `.git`.
pub fn repo(dir: &Path) -> Option<PathBuf> {
    dir.is_absolute()
        .then(|| dir.ancestors().find(|d| d.join(".git").exists()))
        .flatten()
        .map(Path::to_path_buf)
}

/// The `key` field of the first lines of a JSON-lines file: a CLI's record names its folder there.
pub fn first_field(path: &Path, key: &[&str]) -> Option<String> {
    use std::io::BufRead;
    let file = std::fs::File::open(path).ok()?;
    std::io::BufReader::new(file)
        .lines()
        .take(20)
        .map_while(Result::ok)
        .filter_map(|l| serde_json::from_str::<serde_json::Value>(&l).ok())
        .map(|v| super::s(&v, key).to_string())
        .find(|s| !s.is_empty())
}

/// Files under `dir` (recursively, at most `depth` levels) ending in `suffix`, newest first.
pub fn newest(dir: &Path, suffix: &str, depth: u32, limit: usize) -> Vec<PathBuf> {
    fn walk(dir: &Path, suffix: &str, depth: u32, out: &mut Vec<(std::time::SystemTime, PathBuf)>) {
        for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
            let (p, Ok(m)) = (e.path(), e.metadata()) else {
                continue;
            };
            if m.is_dir() && depth > 0 {
                walk(&p, suffix, depth - 1, out);
            } else if p.to_string_lossy().ends_with(suffix) {
                out.push((m.modified().unwrap_or(std::time::UNIX_EPOCH), p));
            }
        }
    }
    let mut all = vec![];
    walk(dir, suffix, depth, &mut all);
    all.sort_by_key(|e| std::cmp::Reverse(e.0));
    all.into_iter().take(limit).map(|(_, p)| p).collect()
}
