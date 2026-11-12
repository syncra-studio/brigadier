//! Signing the user's `gh` in to github.com for Send feedback, as the old app did: `gh auth login
//! --web` in the daemon, its one-time code shown in the dialog with Open GitHub; the app's own
//! sign-in (no OAuth app or token of Brigadier's). One at a time: a new one stops the last.

use super::{gh, signed_in};
use brigadier_core::adapters::setup;
use serde_json::{Value, json};
use std::io::{self, BufRead, BufReader};
use std::os::unix::process::CommandExt;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant};

/// How long a sign-in may take to show its code; how long the user has to enter it (GitHub's codes
/// last 15 minutes).
const CODE_TIMEOUT: Duration = Duration::from_secs(30);
const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(15 * 60);
/// GitHub's page for entering the code, when `gh` didn't print one.
const DEVICE_PAGE: &str = "https://github.com/login/device";
const STOPPED: &str = "Signing in to GitHub was stopped. Try again.";

/// The last sign-in: its `gh`'s process group, and how it ended once it has (kept for `wait`).
struct Running {
    pgid: i32,
    ended: Mutex<Option<Result<(), String>>>,
    changed: Condvar,
}

impl Running {
    fn end(&self, outcome: Result<(), String>) {
        let mut ended = self.ended.lock().unwrap();
        ended.get_or_insert(outcome);
        self.changed.notify_all();
    }
}

static AT_WORK: Mutex<Option<Arc<Running>>> = Mutex::new(None);
/// Counts starts and cancels: a start that a later one passed while it began stops itself.
static STARTS: AtomicU64 = AtomicU64::new(0);

/// `sign-in`: starts one, answering signed in already, no GitHub CLI, or its code and page;
/// `sign-in wait`: until it ends, signed in or why not; `sign-in cancel`: stops it.
pub fn run(step: &str) -> io::Result<Value> {
    match step {
        "" => start(),
        "wait" => wait()
            .map(|()| json!({"ok": true}))
            .map_err(io::Error::other),
        "cancel" => {
            cancel();
            Ok(json!({"ok": true}))
        }
        _ => Err(io::Error::other(
            "usage: brigadier feedback sign-in [wait|cancel]",
        )),
    }
}

/// Stops the sign-in at work, and one still starting; the count a start begun after it carries.
fn cancel() -> u64 {
    let now = STARTS.fetch_add(1, Ordering::SeqCst) + 1;
    if let Some(running) = AT_WORK.lock().unwrap().take() {
        // One that ended keeps its outcome; its group may be gone or reused.
        if running.ended.lock().unwrap().is_none() {
            unsafe { libc::killpg(running.pgid, libc::SIGKILL) };
        }
        running.end(Err(STOPPED.into()));
    }
    now
}

fn start() -> io::Result<Value> {
    let mine = cancel();
    let Some(gh) = gh() else {
        return Ok(json!({"ok": true, "state": "no-gh"}));
    };
    if signed_in().is_some() {
        return Ok(json!({"ok": true, "state": "signed-in"}));
    }
    let args = [
        "auth",
        "login",
        "--hostname",
        "github.com",
        "--web",
        "--git-protocol",
        "https",
    ];
    let spawned = Command::new(&gh)
        .args(args)
        .env("PATH", setup::login().path)
        // The app opens the page itself (Open GitHub), once the code is shown.
        .env("BROWSER", "true")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .process_group(0)
        .spawn();
    let mut child = match spawned {
        Ok(child) => child,
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            return Ok(json!({"ok": true, "state": "no-gh"}));
        }
        Err(e) => {
            eprintln!("feedback: gh auth login didn't start: {e}");
            return Err(io::Error::other(
                "GitHub’s sign-in didn’t start. Try again.",
            ));
        }
    };
    let (tx, lines) = mpsc::channel();
    let stderr = child.stderr.take().expect("piped");
    // Read on to its end, so it never blocks on a full pipe; its page line may come after the code.
    thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            let _ = tx.send(line);
        }
    });
    let pgid = child.id() as i32;
    let running = Arc::new(Running {
        pgid,
        ended: Mutex::new(None),
        changed: Condvar::new(),
    });
    {
        // Held while it checks, so a cancel either sees it here or has already passed it.
        let mut at_work = AT_WORK.lock().unwrap();
        if STARTS.load(Ordering::SeqCst) != mine {
            unsafe { libc::killpg(pgid, libc::SIGKILL) };
            let _ = child.wait();
            return Err(io::Error::other(STOPPED));
        }
        *at_work = Some(running.clone());
    }
    let (mut page, mut last, mut code) = (None, String::new(), None);
    let deadline = Instant::now() + CODE_TIMEOUT;
    while code.is_none() {
        match lines.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
            Ok(line) => {
                page = page.or_else(|| device_page(&line));
                code = device_code(&line);
                if !line.trim().is_empty() {
                    last = line.trim().to_string();
                }
            }
            Err(RecvTimeoutError::Timeout | RecvTimeoutError::Disconnected) => break,
        }
    }
    let cancelled = running.ended.lock().unwrap().is_some();
    if cancelled || code.is_none() {
        unsafe { libc::killpg(pgid, libc::SIGKILL) };
        let _ = child.wait();
    }
    if cancelled {
        return Err(io::Error::other(STOPPED));
    }
    let Some(code) = code else {
        running.end(Err("GitHub’s sign-in didn’t start. Try again.".into()));
        eprintln!("feedback: gh auth login showed no code: {last}");
        return Err(io::Error::other(match last.is_empty() {
            true => "GitHub’s sign-in didn’t start. Try again.".to_string(),
            false => format!("GitHub’s sign-in didn’t start: {last}"),
        }));
    };
    thread::spawn(move || {
        let deadline = Instant::now() + SIGN_IN_TIMEOUT;
        let outcome = loop {
            match child.try_wait() {
                Ok(Some(status)) if status.success() => match signed_in() {
                    Some(_) => break Ok(()),
                    None => break Err("GitHub didn’t sign you in. Try again.".to_string()),
                },
                Ok(Some(_)) | Err(_) => {
                    break Err("Signing in to GitHub didn’t finish. Try again.".into());
                }
                Ok(None) if Instant::now() > deadline => {
                    unsafe { libc::killpg(pgid, libc::SIGKILL) };
                    let _ = child.wait();
                    break Err("Signing in to GitHub took too long. Try again.".into());
                }
                Ok(None) => thread::sleep(Duration::from_millis(200)),
            }
        };
        eprintln!("feedback: the GitHub sign-in ended: {outcome:?}");
        running.end(outcome);
    });
    let url = page.unwrap_or_else(|| DEVICE_PAGE.to_string());
    Ok(json!({"ok": true, "state": "code", "code": code, "url": url}))
}

/// Waits for the sign-in at work to end: signed in, or why not, in plain words.
fn wait() -> Result<(), String> {
    let Some(running) = AT_WORK.lock().unwrap().clone() else {
        return Err(STOPPED.into());
    };
    let mut ended = running.ended.lock().unwrap();
    while ended.is_none() {
        ended = running.changed.wait(ended).unwrap();
    }
    ended.clone().unwrap()
}

/// The one-time code in a line `gh auth login --web` printed ("! One-time code (ABCD-1234) copied
/// to clipboard", older: "! First copy your one-time code: ABCD-1234").
fn device_code(line: &str) -> Option<String> {
    if !line.to_lowercase().contains("code") {
        return None;
    }
    line.split(|c: char| !(c.is_ascii_alphanumeric() || c == '-'))
        .find(|word| {
            let bytes = word.as_bytes();
            bytes.len() == 9
                && bytes[4] == b'-'
                && (word.chars().filter(|c| *c != '-'))
                    .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit())
        })
        .map(str::to_owned)
}

/// The page a line `gh auth login --web` printed sends the user to.
fn device_page(line: &str) -> Option<String> {
    (line.split_whitespace())
        .find(|word| word.starts_with("https://"))
        .map(|word| word.trim_end_matches(['.', ',']).to_owned())
}
