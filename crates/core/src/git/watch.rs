//! One checkout's watch, taken from the old app's workspace watch [D48, D71]. It reads the status at
//! its start, then again after the checkout's files, its index, its HEAD, its branch or that
//! branch's upstream change, on a poke (window focus, a turn's start or end), and every so often in
//! case macOS dropped an event. A burst of changes is read once. What happens only in an ignored
//! folder (a build's output) or in git's own objects doesn't count.

use super::{Checkout, Status, read, status};
use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher as _};
use std::io;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

/// How long a change's own events gather (a save writes, then renames) before it's read.
const GATHER: Duration = Duration::from_millis(25);
/// The least time between two reads while a burst goes on: what comes meanwhile is read once, at
/// its end. Also the longest the thread waits before it looks at `stop`.
const SETTLE: Duration = Duration::from_millis(250);
/// Read again with no event: macOS drops events on a busy machine and in a new watch's first
/// seconds, and a change it drops is never told.
const FIRST: Duration = Duration::from_secs(5);
const EVERY: Duration = Duration::from_secs(60);
/// How often a checkout that can't be watched is read anyway.
const POLL: Duration = Duration::from_secs(10);

enum Msg {
    Fs(notify::Result<notify::Event>),
    Poke,
}

/// A watched checkout. Dropping it stops the watch and waits for its thread, at most about one
/// `SETTLE`: every wait inside, git's included, looks at `stop`.
pub struct Watch {
    tx: Sender<Msg>,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl Watch {
    /// Starts watching. `send` gets the first read, then each one that differs from the last, or
    /// a read error. Errors retry on a backoff; returning false ends the watch.
    pub fn start(
        checkout: Checkout,
        mut send: impl FnMut(io::Result<Status>) -> bool + Send + 'static,
    ) -> Self {
        let (tx, rx) = mpsc::channel();
        let stop = Arc::new(AtomicBool::new(false));
        let (events, stopped) = (tx.clone(), stop.clone());
        let thread = thread::spawn(move || {
            let mut backoff = Duration::from_secs(1);
            while !stopped.load(Ordering::SeqCst) {
                let began = Instant::now();
                if !run(checkout.clone(), events.clone(), &rx, &stopped, &mut send) {
                    break;
                }
                if began.elapsed() > Duration::from_secs(30) {
                    backoff = Duration::from_secs(1);
                }
                let until = Instant::now() + backoff;
                while !stopped.load(Ordering::SeqCst) && Instant::now() < until {
                    match rx
                        .recv_timeout(until.saturating_duration_since(Instant::now()).min(SETTLE))
                    {
                        Ok(Msg::Poke) => break,
                        Err(RecvTimeoutError::Disconnected) => return,
                        _ => {}
                    }
                }
                backoff = (backoff * 2).min(Duration::from_secs(30));
            }
        });
        Self {
            tx,
            stop,
            thread: Some(thread),
        }
    }

    /// Reads the checkout again now.
    pub fn poke(&self) {
        let _ = self.tx.send(Msg::Poke);
    }
}

impl Drop for Watch {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

fn run(
    mut checkout: Checkout,
    events: Sender<Msg>,
    rx: &Receiver<Msg>,
    stop: &AtomicBool,
    mut send: impl FnMut(io::Result<Status>) -> bool,
) -> bool {
    // Restore can give the same path a new registration; never keep the removed git folder.
    let reopened = read(&checkout.root, &["rev-parse", "--absolute-git-dir"], stop)
        .and_then(|out| std::fs::canonicalize(String::from_utf8_lossy(&out).trim()));
    match reopened {
        Ok(dir) => checkout.git_dir = dir,
        Err(e) => return !stop.load(Ordering::SeqCst) && send(Err(e)),
    }
    let mut watcher = notify::recommended_watcher(move |e| {
        let _ = events.send(Msg::Fs(e));
    })
    .and_then(|mut w| {
        w.watch(&checkout.root, RecursiveMode::Recursive)
            .map(|()| w)
    })
    .inspect_err(|e| eprintln!("brigadier: watching {}: {e}", checkout.root.display()))
    .ok();
    let mut filter = Filter {
        root: checkout.root.clone(),
        ..Filter::default()
    };
    let mut last: Option<Status> = None;
    let mut due = Instant::now() + if watcher.is_some() { FIRST } else { POLL };
    let (mut pending, mut read_at) = (true, Instant::now() - SETTLE);
    while !stop.load(Ordering::SeqCst) {
        if pending && read_at.elapsed() >= SETTLE {
            pending = false;
            read_at = Instant::now();
            let read = status(&checkout, stop).and_then(|s| {
                let moved = filter.update(&checkout, &s, stop, watcher.as_mut())?;
                // A new watch restarts the stream, which can drop events on their way: read again.
                pending |= moved;
                Ok(s)
            });
            match read {
                Ok(s) if last.as_ref() == Some(&s) => {}
                Ok(s) => {
                    last = Some(s.clone());
                    if !send(Ok(s)) {
                        return false;
                    }
                }
                Err(e) => {
                    return !stop.load(Ordering::SeqCst) && send(Err(e));
                }
            }
            continue;
        }
        let wait = match pending {
            true => SETTLE.saturating_sub(read_at.elapsed()),
            false => due.saturating_duration_since(Instant::now()).min(SETTLE),
        };
        let first = match rx.recv_timeout(wait) {
            Ok(msg) => msg,
            Err(RecvTimeoutError::Timeout) => {
                if Instant::now() >= due {
                    due = Instant::now() + if watcher.is_some() { EVERY } else { POLL };
                    pending = true;
                }
                continue;
            }
            Err(RecvTimeoutError::Disconnected) => return false,
        };
        // A change is read after its own few events.
        let mut batch = vec![first];
        let until = Instant::now() + GATHER;
        while let Some(left) = until.checked_duration_since(Instant::now()) {
            match rx.recv_timeout(left) {
                Ok(msg) => batch.push(msg),
                Err(_) => break,
            }
        }
        for msg in batch {
            match msg {
                Msg::Poke => pending = true,
                Msg::Fs(Err(e)) => {
                    // A backend that fails after starting falls back to the poll.
                    eprintln!("brigadier: watching {}: {e}", checkout.root.display());
                    watcher = None;
                    due = Instant::now() + POLL;
                    pending = true;
                }
                Msg::Fs(Ok(event)) => pending |= filter.counts(&event),
            }
        }
    }
    false
}

/// Which reported paths change what the panel shows.
#[derive(Default)]
struct Filter {
    root: PathBuf,
    /// The git files outside the checkout's own files that its status reads: index, HEAD,
    /// packed-refs, its branch's ref and its upstream's, as the old app's `Repo::status_files`.
    refs: Vec<PathBuf>,
    /// The branch and upstream `refs` was found for.
    found_for: Option<(String, String)>,
    /// The folders above `refs` being watched.
    watched: Vec<PathBuf>,
    /// Ignored folders, from the checkout's top. An ignored file still counts.
    ignored: Vec<PathBuf>,
}

impl Filter {
    fn counts(&self, event: &notify::Event) -> bool {
        if matches!(event.kind, EventKind::Access(_)) {
            return false;
        }
        // Missed events: read again to be safe.
        event.need_rescan() || event.paths.iter().any(|path| self.counts_path(path))
    }

    fn counts_path(&self, path: &Path) -> bool {
        if self.refs.iter().any(|file| file == path) {
            return true;
        }
        let Ok(relative) = path.strip_prefix(&self.root) else {
            return false;
        };
        !relative
            .components()
            .any(|part| part == Component::Normal(".git".as_ref()))
            && !self
                .ignored
                .iter()
                .any(|folder| relative.starts_with(folder))
    }

    /// Lists the ignored folders again (a build's new output stops counting), and when the branch
    /// or its upstream moved, finds their refs and watches the folders they're in. Says whether it
    /// added a watch.
    fn update(
        &mut self,
        checkout: &Checkout,
        status: &Status,
        stop: &AtomicBool,
        watcher: Option<&mut RecommendedWatcher>,
    ) -> io::Result<bool> {
        let args = [
            "ls-files",
            "--others",
            "--ignored",
            "--exclude-standard",
            "--directory",
            "-z",
        ];
        let listed = read(&checkout.root, &args, stop)?;
        self.ignored = (listed.split(|b| *b == 0))
            .filter_map(|entry| entry.strip_suffix(b"/"))
            .map(|folder| PathBuf::from(String::from_utf8_lossy(folder).into_owned()))
            .collect();
        let text = |key: &str| status.head[key].as_str().unwrap_or("").to_string();
        let now = Some((text("branch"), text("upstream")));
        if now == self.found_for {
            return Ok(false);
        }
        let mut names = vec!["index".to_string(), "HEAD".into(), "packed-refs".into()];
        if let Some((branch, _)) = now.as_ref().filter(|(b, _)| !b.is_empty()) {
            names.push(format!("refs/heads/{branch}"));
            // HEAD's branch's upstream: `refs/heads/<b>@{upstream}` isn't a name git takes.
            let full = read(
                &checkout.root,
                &["rev-parse", "--symbolic-full-name", "@{upstream}"],
                stop,
            );
            if let Ok(full) = full.map(|f| String::from_utf8_lossy(&f).trim().to_string())
                && full.starts_with("refs/")
            {
                names.push(full);
            }
        }
        let mut args = vec!["rev-parse", "--path-format=absolute"];
        names
            .iter()
            .for_each(|name| args.extend(["--git-path", name]));
        let paths = read(&checkout.root, &args, stop)?;
        self.refs = (String::from_utf8_lossy(&paths).lines())
            .map(|path| resolved(Path::new(path)))
            .collect();
        self.found_for = now;
        let Some(watcher) = watcher else {
            return Ok(false);
        };
        let mut added = false;
        for dir in self.refs.iter().filter_map(|file| file.parent()) {
            // A branch's folder that isn't there yet (its ref only packed) is heard from the
            // nearest folder above it that is.
            let Some(existing) = dir.ancestors().find(|d| d.is_dir()) else {
                continue;
            };
            if existing.starts_with(&self.root) || self.watched.iter().any(|w| w == existing) {
                continue;
            }
            let mode = match existing == dir {
                true => RecursiveMode::NonRecursive,
                false => RecursiveMode::Recursive,
            };
            match watcher.watch(existing, mode) {
                Ok(()) => {
                    self.watched.push(existing.to_path_buf());
                    added = true;
                }
                Err(e) => eprintln!("brigadier: watching {}: {e}", existing.display()),
            }
        }
        Ok(added)
    }
}

/// A path as events name it, links resolved (`/private/tmp`, not `/tmp`), also when its last parts
/// aren't there yet.
fn resolved(path: &Path) -> PathBuf {
    for existing in path.ancestors() {
        if let (Ok(base), Ok(rest)) = (existing.canonicalize(), path.strip_prefix(existing)) {
            return match rest.as_os_str().is_empty() {
                true => base,
                false => base.join(rest),
            };
        }
    }
    path.to_path_buf()
}
