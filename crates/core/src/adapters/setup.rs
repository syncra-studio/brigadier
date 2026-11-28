//! What every adapter shares to be found, checked and signed in [D43, D45]: the user's login-shell
//! PATH and credential variables, and probes that always end.

use std::collections::BTreeMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

/// What the login shell gives: PATH, and the credential variables some adapter names (`keys`).
/// Kept in memory only, never written or logged.
#[derive(Clone, Default)]
pub struct Login {
    pub path: String,
    pub vars: BTreeMap<String, String>,
}

static LOGIN: Mutex<Option<Login>> = Mutex::new(None);
#[cfg(unix)]
const SYSTEM_PATH: &str = "/usr/bin:/bin:/usr/sbin:/sbin";
#[cfg(unix)]
const MARK: &str = "__brigadier_env__";

#[cfg(windows)]
mod windows;
#[cfg(windows)]
use windows::{exe_in, is_exe};
#[cfg(windows)]
pub use windows::{long_paths, powershell, refresh, shell, system_env};

/// The login shell's environment, read once and kept until `refresh`.
pub fn login() -> Login {
    if let Some(l) = LOGIN.lock().unwrap().clone() {
        return l;
    }
    refresh()
}

/// The user's shell: `$SHELL`, else the system's default, zsh on macOS, bash then sh on Linux.
#[cfg(unix)]
pub fn shell() -> String {
    let fallback = match cfg!(target_os = "linux") {
        true if !std::path::Path::new("/bin/bash").exists() => "/bin/sh",
        true => "/bin/bash",
        false => "/bin/zsh",
    };
    (std::env::var("SHELL").ok())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| fallback.into())
}

/// The user's shell as a terminal starts it, or as it runs `line` and exits, its profile loaded.
pub fn shell_argv(line: Option<&str>) -> Vec<String> {
    let (start, run) = match cfg!(windows) {
        true => ("-NoLogo", "-Command"),
        false => ("-l", "-c"),
    };
    let mut argv = vec![shell(), start.to_string()];
    argv.extend(
        line.into_iter()
            .flat_map(|l| [run.to_string(), l.to_string()]),
    );
    argv
}

/// How an agent's install line runs: bash, its pipes failing it; on Windows its own PowerShell,
/// which runs a downloaded script only past its policy.
pub fn install_argv(line: &str) -> Vec<String> {
    #[cfg(unix)]
    let argv = ["/bin/bash", "-c", &format!("set -o pipefail; {line}")];
    #[cfg(windows)]
    let argv = [
        &powershell(),
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        line,
    ];
    argv.map(String::from).to_vec()
}

/// Reads the login shell's environment again (an install may have changed it). A shell that
/// fails or hangs leaves the system PATH and no variables.
#[cfg(unix)]
pub fn refresh() -> Login {
    let shell = shell();
    let mut command = Command::new(shell);
    // Interactive too: many users export PATH and keys only in .zshrc.
    command.args(["-l", "-i", "-c", &format!("printf {MARK}; /usr/bin/env -0")]);
    let wanted: Vec<String> = super::all().iter().flat_map(|a| a.keys()).collect();
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
            } else if wanted.iter().any(|w| w == k) && !v.is_empty() {
                login.vars.insert(k.into(), v.into());
            }
        }
    }
    *LOGIN.lock().unwrap() = Some(login.clone());
    login
}

/// A binary in its installer's folders under HOME first, then on the login PATH, then on Windows
/// in npm's global folder, which only Node's own installer puts on its user's PATH.
pub fn find(bin: &str, folders: &[&str]) -> Option<PathBuf> {
    // A test instance's gh stand-in (a guard that fakes writes); never the real app's data folder.
    if bin == "gh"
        && std::env::var_os("BRIGADIER_DATA")
            .is_some_and(|d| Path::new(&d) != crate::default_data_dir())
        && let Some(gh) = std::env::var_os("BRIGADIER_GH")
    {
        return Some(gh.into());
    }
    let home = super::home_path("");
    let path = login().path;
    // shortcut: npm's default prefix only, not one a user's .npmrc moves; read `npm prefix -g` if one shows up.
    let npm = std::env::var_os("APPDATA")
        .filter(|_| cfg!(windows))
        .map(|a| PathBuf::from(a).join("npm"));
    folders
        .iter()
        .map(|f| home.join(f))
        .chain(std::env::split_paths(&path))
        .chain(npm)
        .find_map(|d| exe_in(&d, bin))
}

#[cfg(unix)]
fn exe_in(dir: &Path, bin: &str) -> Option<PathBuf> {
    let p = dir.join(bin);
    is_exe(&p).then_some(p)
}

/// The CLI the user chose for agent `name` in Settings › Providers (`agent_paths` in the settings),
/// while it is still a program; one that went away falls back to the one found [D2082].
pub fn chosen(name: &str) -> Option<PathBuf> {
    let settings = std::fs::read(crate::data_dir().join("settings.json")).ok()?;
    let saved: serde_json::Value = serde_json::from_slice(&settings).ok()?;
    let path = PathBuf::from(saved["agent_paths"][name].as_str()?);
    is_exe(&path).then_some(path)
}

/// Whether its CLI's own memory is on: the Configuration switch (`memory` in the settings), read
/// at each launch; never a worker's [D2049, D89].
pub fn memory(spec: &crate::Spec) -> bool {
    let saved = std::fs::read(crate::data_dir().join("settings.json")).unwrap_or_default();
    let saved: serde_json::Value = serde_json::from_slice(&saved).unwrap_or_default();
    !spec.naked && saved["memory"] == "true"
}

/// `rest` in the CLI's home for this spec: the account's home when it runs on one, else `default`
/// under HOME.
pub fn cli_home(spec: &crate::Spec, default: &str, rest: &str) -> PathBuf {
    match &spec.account {
        Some((_, home)) => home.join(rest),
        None => super::home_path(default).join(rest),
    }
}

/// The first line of its `--version`.
pub fn version(exe: &Path, cwd: &Path) -> Result<String, String> {
    let out = super::probe(exe, cwd, &[], &["--version"], 10)?;
    let text = String::from_utf8_lossy(&out.stdout);
    Ok(text.lines().next().unwrap_or("").trim().into())
}

/// Whether it really runs: a shim or wrapper whose target is gone fails its `--version` [D32]. One that
/// can't answer in time still counts, for its own check to say why.
pub fn runs(exe: &Path, cwd: &Path) -> bool {
    match super::probe(exe, cwd, &[], &["--version"], 10) {
        Ok(out) => out.status.success(),
        Err(e) => e.starts_with("timed out"),
    }
}

#[cfg(unix)]
fn is_exe(p: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    p.metadata()
        .is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}

/// Runs a probe to its end or kills its whole group after `secs`. Stdin is closed, so a probe
/// that asks a question fails instead of waiting.
pub fn run(command: &mut Command, secs: u64) -> Result<Output, String> {
    run_until(command, secs, &AtomicBool::new(false))
}

/// `run`, also ended as soon as `stop` is set, so whoever waits on it can leave at once.
pub fn run_until(command: &mut Command, secs: u64, stop: &AtomicBool) -> Result<Output, String> {
    run_fed(command, secs, stop, None)
}

/// `run_until` with `input` written to its stdin, which then closes.
pub fn run_fed(
    command: &mut Command,
    secs: u64,
    stop: &AtomicBool,
    input: Option<&str>,
) -> Result<Output, String> {
    let stdin = match input {
        Some(_) => Stdio::piped(),
        None => Stdio::null(),
    };
    let child = command
        .stdin(stdin)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = brigadier_frames::spawn::alone(child).map_err(|e| e.to_string())?;
    if let (Some(text), Some(mut w)) = (input.map(String::from), child.stdin.take()) {
        std::thread::spawn(move || {
            use std::io::Write;
            let _ = w.write_all(text.as_bytes());
        });
    }
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
            Ok(None) if Instant::now() < deadline && !stop.load(Ordering::SeqCst) => {
                std::thread::sleep(Duration::from_millis(20))
            }
            _ => {
                brigadier_frames::spawn::kill_tree(child.id());
                let _ = child.wait();
                if stop.load(Ordering::SeqCst) {
                    return Err("stopped".into());
                }
                return Err(format!("timed out after {secs} s"));
            }
        }
    };
    // A child it left in its group may hold the pipes open: end it, and never wait past the deadline.
    brigadier_frames::spawn::kill_tree(child.id());
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

/// The first `https` link a sign-in printed, up to a space or a control character (a terminal
/// link's own escape ends it).
pub fn code_page(out: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(out);
    let start = text.find("https://")?;
    let page = text[start..]
        .chars()
        .take_while(|c| !c.is_whitespace() && !c.is_control());
    Some(page.collect())
}

/// How a setup run ended, in the CLI's own words: the last line it printed, with the
/// terminal's escapes (colours, cursor moves, links, titles) taken out [D2077].
pub fn reason(out: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(out);
    let (mut plain, mut chars) = (String::new(), text.chars().peekable());
    while let Some(c) = chars.next() {
        if c != '\x1b' {
            if !c.is_control() || c == '\n' || c == '\r' {
                plain.push(c);
            }
            continue;
        }
        match chars.next() {
            // CSI: parameters up to a final byte. A move back or to a column starts the line again,
            // as a spinner redraws its frame ("\x1b[999D\x1b[J").
            Some('[') => {
                if let Some('D' | 'G') = chars.find(|c| ('@'..='~').contains(c)) {
                    plain.push('\r');
                }
            }
            // OSC (links, titles) and the other strings: up to BEL or ESC \.
            Some(']' | 'P' | 'X' | '^' | '_') => {
                while let Some(c) = chars.next() {
                    if c == '\x07' || (c == '\x1b' && chars.next_if_eq(&'\\').is_some()) {
                        break;
                    }
                }
            }
            // The rest: one byte after any intermediates.
            Some(' '..='/') => _ = chars.find(|c| !(' '..='/').contains(c)),
            _ => {}
        }
    }
    // A line's own words, without the box-drawn gutter some CLIs draw ("│", "▲", "└"); the last
    // line of more than one word, as one alone is an outro ("Done") after what it says.
    let lines = plain
        .rsplit(['\r', '\n'])
        .map(|l| l.trim_start_matches(|c: char| c.is_whitespace() || ('─'..='➿').contains(&c)))
        .map(str::trim_end)
        .filter(|l| !l.is_empty());
    let last = lines
        .clone()
        .find(|l| l.contains(' '))
        .or(lines.clone().next());
    last.map(String::from)
}

/// The version npm's `tag` of `package` names, as its updater installs it; None offline or on any
/// failure, so nothing is offered then.
pub fn npm_latest(package: &str, tag: &str) -> Option<String> {
    let url = format!("https://registry.npmjs.org/-/package/{package}/dist-tags");
    let mut command = Command::new(find("curl", &[])?);
    command.args(["-sSfL", "--max-time", "5", &url]);
    let out = run(&mut command, 8).ok().filter(|o| o.status.success())?;
    let tags: serde_json::Value = serde_json::from_slice(&out.stdout).ok()?;
    tags[tag].as_str().map(String::from)
}

/// Whether `latest` is a newer version than `current`, each as its CLI words it ("2.1.322 (Claude
/// Code)", "codex-cli 0.9"): their first dotted numbers, part by part. One that doesn't read is
/// never newer.
pub fn newer(latest: &str, current: &str) -> bool {
    let parts = |v: &str| -> Option<Vec<u64>> {
        let v = &v[v.find(|c: char| c.is_ascii_digit())?..];
        let end = v
            .find(|c: char| !c.is_ascii_digit() && c != '.')
            .unwrap_or(v.len());
        v[..end].split('.').map(|p| p.parse().ok()).collect()
    };
    matches!((parts(latest), parts(current)), (Some(l), Some(c)) if l > c)
}

/// Other Unix systems need no extra system variables.
#[cfg(all(unix, not(target_os = "linux")))]
pub fn system_env() -> Vec<(String, String)> {
    Vec::new()
}

/// The desktop session an agent, browser opener or terminal command belongs to.
#[cfg(target_os = "linux")]
pub fn system_env() -> Vec<(String, String)> {
    [
        "DISPLAY",
        "WAYLAND_DISPLAY",
        "XDG_RUNTIME_DIR",
        "DBUS_SESSION_BUS_ADDRESS",
    ]
    .into_iter()
    .filter_map(|k| Some((k.into(), std::env::var(k).ok()?)))
    .collect()
}

/// PATH's separator.
const SEP: char = if cfg!(windows) { ';' } else { ':' };

/// The environment every child starts from, the same for a session, a status check and a sign-in:
/// the basics, the login shell's PATH after the CLI's own folder, and the variables `keys` names.
pub fn base_env(spec: &crate::Spec, exe: &Path, keys: &[String]) -> Vec<(String, String)> {
    let var = |k: &str| std::env::var(k).unwrap_or_default();
    let dir = exe
        .parent()
        .map(|p| p.display().to_string())
        .unwrap_or_default();
    let login = login();
    let agent = crate::agent::env(spec);
    let bin = agent
        .as_ref()
        .map_or(String::new(), |(bin, _)| format!("{bin}{SEP}"));
    let mut env = vec![
        ("HOME".into(), var("HOME")),
        ("USER".into(), var("USER")),
        ("LANG".into(), "en_US.UTF-8".into()),
        ("TMPDIR".into(), var("TMPDIR")),
        ("PATH".into(), format!("{bin}{dir}{SEP}{}", login.path)),
    ];
    // An empty HOME there is a home of "" to Node; Windows' own variables come instead.
    #[cfg(windows)]
    env.retain(|(_, v)| !v.is_empty());
    env.extend(system_env());
    env.extend(
        keys.iter()
            .filter_map(|k| Some((k.clone(), login.vars.get(k)?.clone()))),
    );
    if let Some((var, home)) = &spec.account {
        env.push((var.clone(), home.display().to_string()));
    }
    env.extend(agent.into_iter().flat_map(|(_, vars)| vars));
    if spec.mode == "pty" {
        env.push(("TERM".into(), "xterm-256color".into()));
    }
    env
}

/// One bounded status probe of a CLI, in the environment its sessions get.
pub fn probe(
    exe: &Path,
    cwd: &Path,
    keys: &[String],
    args: &[&str],
    secs: u64,
) -> Result<std::process::Output, String> {
    probe_as(&crate::Spec::default(), exe, cwd, keys, args, secs)
}

/// `probe` on an account: `spec.account` sets its home.
pub fn probe_as(
    spec: &crate::Spec,
    exe: &Path,
    cwd: &Path,
    keys: &[String],
    args: &[&str],
    secs: u64,
) -> Result<std::process::Output, String> {
    let mut command = std::process::Command::new(exe);
    command
        .args(args)
        .env_clear()
        .envs(base_env(spec, exe, keys))
        .current_dir(cwd);
    run(&mut command, secs)
}

/// An agent's docs page, linked from its onboarding card [D616]; its adapter files are full.
pub fn docs(agent: &str) -> Option<&'static str> {
    match agent {
        "claude" => Some("https://code.claude.com/docs/en/quickstart"),
        "codex" => Some("https://developers.openai.com/codex/cli"),
        "opencode" => Some("https://opencode.ai/docs"),
        _ => None,
    }
}
