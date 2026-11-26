//! What's kept so a screen shows it at once: each agent's last check, per folder [D30]; the
//! Projects step's two lists, in the daemon's memory [D627].

use brigadier_core::adapters::{self, Adapter};
use brigadier_core::host::{self, accounts};
use brigadier_core::{self as core, projects, repos};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::{fs, io, thread};

/// `agents/<name>.json`, `{cwd: check}`.
fn checks_path(data: &Path, a: &dyn Adapter) -> PathBuf {
    data.join("agents").join(format!("{}.json", a.name()))
}

/// This folder's own check: under its canonical key, else as it was kept before keys were [C27].
pub(super) fn last_check(data: &Path, a: &dyn Adapter, cwd: &Path) -> Option<Value> {
    core::checked::saved(data, a.name(), cwd)
}

/// Keeps the check before releasing the lock, so a waiting caller gets the same result.
pub(super) fn keep_check(data: &Path, a: &dyn Adapter, cwd: &Path, out: &Value) -> io::Result<()> {
    let path = checks_path(data, a);
    let mut all: Value = fs::read(&path)
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .filter(|v| v.is_object())
        .unwrap_or_else(|| json!({}));
    if let (Some(map), Some(raw)) = (all.as_object_mut(), cwd.to_str()) {
        let cwd = core::checked::key(cwd);
        // A deleted session's folder goes with it, under either form of the sessions root.
        let own = data.join("sessions");
        let real = PathBuf::from(core::checked::key(data)).join("sessions");
        let mine = |f: &Path| f.starts_with(&own) || f.starts_with(&real);
        map.retain(|f, _| !mine(Path::new(f)) || Path::new(f).is_dir());
        // The one entry for this folder, under its canonical key.
        map.remove(raw);
        map.insert(cwd, out.clone());
        fs::create_dir_all(path.parent().unwrap())?;
        core::write_atomic(&path, all.to_string().as_bytes())?;
    }
    Ok(())
}

/// A read kept in the daemon's memory, so a screen shows it at once [D627]: answered from what's
/// kept and read again behind it, so the next asker has it fresh (a list already open gets it
/// when opened again); asked under another key (other GitHub accounts signed in), it waits for
/// its own read. Asked while a read runs, it waits for that one, never starting a second.
struct Kept {
    value: Mutex<Option<(String, Value)>>,
    reading: Mutex<()>,
}

static HISTORY: Kept = Kept::new();
static GITHUB: Kept = Kept::new();

impl Kept {
    const fn new() -> Self {
        Kept {
            value: Mutex::new(None),
            reading: Mutex::new(()),
        }
    }

    fn kept(&self, key: &str) -> Option<Value> {
        let value = self.value.lock().unwrap();
        value
            .as_ref()
            .filter(|(k, _)| k == key)
            .map(|(_, v)| v.clone())
    }

    fn read(&self, key: String, read: impl Fn() -> io::Result<Value>) -> io::Result<Value> {
        let value = read()?;
        *self.value.lock().unwrap() = Some((key, value.clone()));
        Ok(value)
    }

    fn get(
        &'static self,
        key: String,
        read: impl Fn() -> io::Result<Value> + Send + 'static,
    ) -> io::Result<Value> {
        if let Some(value) = self.kept(&key) {
            thread::spawn(move || {
                if let Ok(_reading) = self.reading.try_lock() {
                    let _ = self.read(key, read);
                }
            });
            return Ok(value);
        }
        let _reading = self.reading.lock().unwrap();
        match self.kept(&key) {
            Some(value) => Ok(value),
            None => self.read(key, read),
        }
    }

    /// Read now in the background, unless it's kept under `key` already.
    fn warm(&'static self, key: String, read: impl Fn() -> io::Result<Value> + Send + 'static) {
        if self.kept(&key).is_none() {
            thread::spawn(move || {
                let _reading = self.reading.lock().unwrap();
                if self.kept(&key).is_none() {
                    let _ = self.read(key, read);
                }
            });
        }
    }
}

/// Keyed by the accounts gh has signed in, read from its own file [D625].
fn github_key() -> String {
    accounts::logins(&accounts::GH, "github.com").join(" ")
}

pub(super) fn github(data: &Path) -> io::Result<Value> {
    let avatars = data.join("avatars");
    GITHUB.get(github_key(), move || host::github_repos(&avatars))
}

pub(super) fn history(data: &Path) -> io::Result<Value> {
    let data = data.to_path_buf();
    HISTORY.get(String::new(), move || read_history(&data))
}

pub(super) fn warm(data: &Path) {
    let (avatars, owned) = (data.join("avatars"), data.to_path_buf());
    GITHUB.warm(github_key(), move || host::github_repos(&avatars));
    HISTORY.warm(String::new(), move || read_history(&owned));
}

/// The repositories the agents' own history ran in, 30 not yet projects, for onboarding's Projects
/// step [D45]; and `parent`, the folder most known projects are in, where a clone or a new one goes
/// (`~/Development/` when none) [D627].
fn read_history(data: &Path) -> io::Result<Value> {
    let taken: Vec<String> = projects::list(data)?
        .into_iter()
        .map(|p| p.folder)
        .collect();
    let found = thread::scope(|s| {
        let all = adapters::all().map(|a| s.spawn(move || a.projects()));
        all.into_iter()
            .flat_map(|t| t.join().unwrap_or_default())
            .collect::<Vec<_>>()
    });
    // Each folder checked once (the history repeats them), and none macOS asks about.
    let home = adapters::home_path("");
    let home = fs::canonicalize(&home).unwrap_or(home);
    let (mut checked, mut seen) = (BTreeSet::new(), BTreeSet::new());
    let roots: Vec<String> = found
        .iter()
        .filter(|p| !repos::protected(&home, p) && checked.insert(p.as_path()))
        .filter_map(|p| projects::root(p))
        .map(|p| p.display().to_string())
        .filter(|p| seen.insert(p.clone()))
        .collect();
    let mut count = BTreeMap::<&Path, usize>::new();
    for root in roots.iter().chain(&taken) {
        if let Some(up) = Path::new(root).parent() {
            *count.entry(up).or_default() += 1;
        }
    }
    let parent = (count
        .into_iter()
        .max_by_key(|(_, n)| *n)
        .map(|(p, _)| p.to_path_buf()))
    .unwrap_or_else(|| home.join("Development"));
    let parent = match parent.strip_prefix(&home) {
        Ok(rest) => format!("~/{}/", rest.display()),
        Err(_) => format!("{}/", parent.display()),
    };
    let found: Vec<&String> = roots
        .iter()
        .filter(|p| !taken.contains(p))
        .take(30)
        .collect();
    Ok(json!({"found": found, "parent": parent.replace("~//", "~/")}))
}
