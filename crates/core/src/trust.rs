//! The CLIs' own folder trust [D166, D182]. An adapter whose CLI keeps one describes it
//! (`Accounts::trust`); this module writes Brigadier's answer there, keyed on the project's main
//! checkout so one entry covers every worktree, and puts the earlier state back on remove [D35].
//! Each entry is recorded in `trust.json` before the file is touched. Proposed: the descriptor,
//! the record and lock layout, and five tries per edit.
//!
//! Lock order: `projects.lock`, then `trust.lock`, then the CLI's own lock for its file. A CLI
//! that takes no lock can still write between the last re-read and the rename; that
//! window is a known limit, accepted (D253).

use crate::adapters::{self, Adapter, home_path};
use crate::projects::{self, Project};
use crate::{Spec, data_of};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

mod doc;

/// How a CLI keeps folder trust: `<table>.<root>.<key>` in its settings file.
#[derive(Clone, Copy)]
pub struct Trust {
    /// The file under HOME for the computer's own login, and under an extra account's home.
    pub default: &'static str,
    pub file: &'static str,
    pub toml: bool,
    pub table: &'static str,
    pub key: &'static str,
    /// The value, as JSON text, for a trusted folder, and for an untrusted or unanswered one:
    /// None writes nothing there and puts back what Brigadier wrote before.
    pub trusted: &'static str,
    pub untrusted: Option<&'static str>,
    /// The lock its CLI takes for the file, added to the file's name; None: it takes none.
    pub lock: Option<&'static str>,
}

/// One value Brigadier wrote into another tool's file [D35].
#[derive(Serialize, Deserialize, Clone, Default, PartialEq)]
#[serde(default)]
struct Entry {
    /// Its CLI's name, for the words of an error.
    agent: String,
    file: PathBuf,
    key: Vec<String>,
    toml: bool,
    lock: Option<String>,
    /// What the key held before Brigadier's first write; None: it wasn't there.
    before: Option<Value>,
    /// Brigadier's value in the file now, and one recorded before a write that may not have
    /// landed: the file holding either is still Brigadier's.
    applied: Option<Value>,
    pending: Option<Value>,
    /// How many of the key's tables Brigadier made, innermost first, and whether it made the file
    /// and its folder.
    made: usize,
    made_file: bool,
    made_dir: bool,
}

type Records = BTreeMap<String, Vec<Entry>>;

fn err<T>(m: String) -> io::Result<T> {
    Err(io::Error::other(m))
}

fn load(data: &Path) -> io::Result<Records> {
    match fs::read(data.join("trust.json")) {
        Ok(b) => Ok(serde_json::from_slice(&b)?),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(Records::new()),
        Err(e) => Err(e),
    }
}

fn save(data: &Path, records: &Records) -> io::Result<()> {
    crate::write_atomic(
        &data.join("trust.json"),
        &serde_json::to_vec_pretty(records)?,
    )
}

/// Runs `f` on the current projects under `projects.lock` and `trust.lock`, in that order.
fn locked<T>(data: &Path, f: impl FnOnce(&[Project]) -> T) -> io::Result<T> {
    // Read once before the lock: a first read may migrate, which takes `projects.lock` itself.
    projects::list(data)?;
    let _projects = projects::lock(data, "projects.lock")?;
    let _trust = projects::lock(data, "trust.lock")?;
    Ok(f(&projects::list(data)?))
}

/// The file a config path names: where a symlink points, made or not (the CLIs write through it).
fn real(p: &Path) -> PathBuf {
    if let Ok(r) = fs::canonicalize(p) {
        return r;
    }
    let dir = p.parent().unwrap_or(Path::new("/"));
    let dir = fs::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf());
    match fs::read_link(p) {
        Ok(to) => dir.join(to),
        Err(_) => dir.join(p.file_name().unwrap_or_default()),
    }
}

/// The config files of each CLI that keeps trust: the computer's login (when the CLI is set up)
/// and each extra account's home that has one; or only `only`'s CLI in its run's home, new or not.
fn files(
    data: &Path,
    only: Option<(&dyn Adapter, Option<&Path>)>,
) -> Vec<(String, Trust, PathBuf)> {
    let mut out: Vec<(String, Trust, PathBuf)> = vec![];
    for a in adapters::all() {
        if only.is_some_and(|(o, _)| o.name() != a.name()) {
            continue;
        }
        let Some((home, trust)) = a.accounts().and_then(|x| Some((x.home, x.trust?))) else {
            continue;
        };
        let mut paths = vec![];
        match only {
            Some((_, Some(h))) => paths.push(h.join(trust.file)),
            // A run is about to make this home if it's new, and may trust the folder itself [D182].
            Some((_, None)) => paths.push(home_path(trust.default)),
            None if home_path(home).is_dir() => paths.push(home_path(trust.default)),
            None => {}
        }
        if only.is_none() {
            let accounts = fs::read_dir(data.join("accounts")).into_iter().flatten();
            paths.extend(
                accounts
                    .flatten()
                    .map(|d| d.path().join(trust.file))
                    .filter(|p| p.symlink_metadata().is_ok()),
            );
        }
        let mut seen: Vec<PathBuf> = out.iter().map(|(_, _, f)| f.clone()).collect();
        for p in paths.iter().map(|p| real(p)) {
            if !seen.contains(&p) {
                seen.push(p.clone());
                out.push((a.label().into(), trust, p));
            }
        }
    }
    out
}

/// Makes each of project `id`'s CLI trust entries hold its answer, in every config file, or in
/// `only`'s for its run's home (None: the computer's login), and puts back the entries of a
/// folder it no longer has. Returns what couldn't be written, as `{agent, error}`. A project
/// that's gone or being removed gets nothing.
pub fn sync(data: &Path, id: &str, only: Option<(&dyn Adapter, Option<&Path>)>) -> Vec<Value> {
    let run = || -> io::Result<Vec<Value>> {
        locked(data, |list| {
            let Some(p) = list.iter().find(|p| p.id == id && !p.removing) else {
                return Ok(vec![]);
            };
            let mut records = load(data)?;
            let old = records.clone();
            let mut entries = records.remove(id).unwrap_or_default();
            let mut failed = vec![];
            let mut wanted = vec![];
            for (agent, trust, file) in files(data, only) {
                let key = vec![trust.table.into(), p.folder.clone(), trust.key.into()];
                wanted.push((file.clone(), key.clone()));
                let value = if p.trusted == Some(true) {
                    Some(trust.trusted)
                } else {
                    trust.untrusted
                };
                let at = entries.iter().position(|e| e.file == file && e.key == key);
                let done = match (value, at) {
                    (Some(v), _) => {
                        let v: Value = serde_json::from_str(v)?;
                        if at.is_none() {
                            entries.push(Entry {
                                agent: agent.clone(),
                                file: file.clone(),
                                key,
                                toml: trust.toml,
                                lock: trust.lock.map(String::from),
                                ..Entry::default()
                            });
                        }
                        let i = at.unwrap_or(entries.len() - 1);
                        write(data, id, &mut records, &mut entries, i, v)
                    }
                    (None, Some(i)) => put_back(&entries[i]).map(|()| {
                        entries.remove(i);
                    }),
                    (None, None) => Ok(()),
                };
                if let Err(e) = done {
                    failed.push(json!({"agent": agent, "error": e.to_string()}));
                }
            }
            // Entries of an earlier folder, in the files this sync covers.
            let files: Vec<&PathBuf> = wanted.iter().map(|(f, _)| f).collect();
            let mut i = 0;
            while i < entries.len() {
                let e = &entries[i];
                if !files.contains(&&e.file) || wanted.iter().any(|w| w.0 == e.file && w.1 == e.key)
                {
                    i += 1;
                    continue;
                }
                match put_back(e) {
                    Ok(()) => drop(entries.remove(i)),
                    Err(err) => {
                        failed.push(json!({"agent": e.agent, "error": err.to_string()}));
                        i += 1;
                    }
                }
            }
            entries.retain(|e| e.applied.is_some() || e.pending.is_some());
            keep(&mut records, id, entries);
            if records != old {
                save(data, &records)?;
            }
            Ok(failed)
        })?
    };
    run().unwrap_or_else(|e| vec![json!({"agent": "", "error": e.to_string()})])
}

fn keep(records: &mut Records, id: &str, entries: Vec<Entry>) {
    if entries.is_empty() {
        records.remove(id);
    } else {
        records.insert(id.into(), entries);
    }
}

/// Before a turn: the run's CLI gets the project's answer in its own home first.
/// Err only when an untrusted answer couldn't be written, so the CLI could trust the folder on
/// its own (D182, proposed: the turn is refused).
pub fn ensure(spec: &Spec, a: &dyn Adapter) -> Result<(), String> {
    let Some(trust) = a.accounts().and_then(|x| x.trust) else {
        return Ok(());
    };
    let data = data_of(spec);
    let Some(id) = projects::list(&data)
        .ok()
        .and_then(|list| projects::of(spec, &list, &mut projects::Roots::default()))
    else {
        return Ok(());
    };
    let home = spec.account.as_ref().map(|(_, h)| h.as_path());
    let failed = sync(&data, &id, Some((a, home)));
    match failed.first() {
        Some(f)
            if trust.untrusted.is_some()
                && !projects::get(&data, &id).is_ok_and(|p| p.trusted == Some(true)) =>
        {
            let why = f["error"].as_str().unwrap_or_default();
            Err(format!(
                "This folder isn't trusted, and Brigadier couldn't record that in {}'s own settings, so it could trust the folder on its own: {why}",
                a.label()
            ))
        }
        _ => Ok(()),
    }
}

/// Puts back every CLI trust entry of project `id` [D35, D166]: removing it calls this first.
/// A failed one keeps its record, so the next try retries it; Err says which and why.
pub fn restore(data: &Path, id: &str) -> io::Result<()> {
    locked(data, |_| {
        let mut records = load(data)?;
        let mut entries = records.remove(id).unwrap_or_default();
        let mut failed = vec![];
        entries.retain(|e| match put_back(e) {
            Ok(()) => false,
            Err(err) => {
                failed.push(format!("{}: {err}", e.agent));
                true
            }
        });
        keep(&mut records, id, entries);
        save(data, &records)?;
        if failed.is_empty() {
            Ok(())
        } else {
            err(format!(
                "Brigadier couldn't put back the folder's trust in an agent's own settings: {}",
                failed.join("; ")
            ))
        }
    })?
}

/// Writes `v` at entry `i`'s key: its pending value is recorded first, its applied value after.
fn write(
    data: &Path,
    id: &str,
    records: &mut Records,
    entries: &mut [Entry],
    i: usize,
    v: Value,
) -> io::Result<()> {
    let e = entries[i].clone();
    let mut recorded = false;
    edit(&e, |text, doc| {
        let now = doc::get(doc, &e.key)?;
        if now.as_ref() == Some(&v) {
            return Ok(None);
        }
        let mut new = doc::parse(text, e.toml)?;
        let made = doc::set(&mut new, &e.key, &v)?;
        let entry = &mut entries[i];
        if entry.applied.is_none() && entry.pending.is_none() {
            // The first write: the baseline restore always goes back to.
            entry.before = now;
            entry.made = made;
            entry.made_file = text.is_none();
            entry.made_dir = !e.file.parent().is_some_and(Path::exists);
        }
        entry.pending = Some(v.clone());
        let mut all = records.clone();
        all.insert(id.into(), entries.to_vec());
        save(data, &all)?;
        recorded = true;
        Ok(Some(doc::render(&new, text)))
    })?;
    // The file holds `v` now; while any value there is Brigadier's, this one is too.
    let entry = &mut entries[i];
    if recorded || entry.applied.is_some() || entry.pending.is_some() {
        entry.applied = Some(v);
        entry.pending = None;
    }
    Ok(())
}

/// Puts back what the key held before Brigadier's first write, while the file still holds a
/// value of Brigadier's; a value someone set since is theirs and stays.
fn put_back(e: &Entry) -> io::Result<()> {
    if e.applied.is_none() && e.pending.is_none() {
        return Ok(());
    }
    let mut gone = false;
    edit(e, |text, doc| {
        let Some(text) = text else {
            return Ok(None);
        };
        let now = doc::get(doc, &e.key)?;
        if now.is_none() || (now != e.applied && now != e.pending) {
            return Ok(None);
        }
        let mut new = doc::parse(Some(text), e.toml)?;
        match &e.before {
            Some(v) => doc::set(&mut new, &e.key, v).map(drop)?,
            None => doc::unset(&mut new, &e.key, e.made)?,
        }
        let out = doc::render(&new, Some(text));
        gone = e.made_file && matches!(out.trim(), "" | "{}");
        Ok(Some(out))
    })?;
    if gone {
        fs::remove_file(&e.file)?;
        if e.made_dir {
            let _ = e.file.parent().map(fs::remove_dir);
        }
    }
    Ok(())
}

/// Under the CLI's own lock: reads the file (None: missing), lets `f` make its new text, and
/// writes it beside the file and renames it in, only if the file still reads the same right
/// before the rename. Five tries.
fn edit(
    e: &Entry,
    mut f: impl FnMut(Option<&str>, &doc::Doc) -> io::Result<Option<String>>,
) -> io::Result<()> {
    let _lock = e
        .lock
        .as_deref()
        .map(|l| Lock::take(&e.file, l))
        .transpose()?;
    for _ in 0..5 {
        let text = read(&e.file)?;
        let doc = doc::parse(text.as_deref(), e.toml)?;
        let Some(new) = f(text.as_deref(), &doc)? else {
            return Ok(());
        };
        let temp = temp(&e.file, &new)?;
        if read(&e.file)? == text {
            return fs::rename(&temp, &e.file).inspect_err(|_| drop(fs::remove_file(&temp)));
        }
        let _ = fs::remove_file(&temp);
    }
    err(format!(
        "{} kept changing while Brigadier wrote to it; try again",
        e.file.display()
    ))
}

fn read(file: &Path) -> io::Result<Option<String>> {
    match fs::read_to_string(file) {
        Ok(t) => Ok(Some(t)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => err(format!("{}: {e}", file.display())),
    }
}

/// `text` in a new file beside `file`, synced, with `file`'s mode (a new one: the user's only).
fn temp(file: &Path, text: &str) -> io::Result<PathBuf> {
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    let dir = file.parent().unwrap_or(Path::new("/"));
    let at = |e: io::Error| io::Error::other(format!("{}: {e}", dir.display()));
    fs::create_dir_all(dir).map_err(at)?;
    let name = file.file_name().unwrap_or_default().to_string_lossy();
    let temp = dir.join(format!(".{name}.brigadier-{}.tmp", std::process::id()));
    let mode = fs::metadata(file).map_or(0o600, |m| m.permissions().mode() & 0o7777);
    let mut out = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(mode)
        .open(&temp)
        .map_err(at)?;
    let done = out
        .write_all(text.as_bytes())
        .and_then(|()| out.set_permissions(fs::Permissions::from_mode(mode)))
        .and_then(|()| out.sync_all());
    done.inspect_err(|_| drop(fs::remove_file(&temp)))
        .map_err(|e| io::Error::other(format!("{}: {e}", temp.display())))?;
    Ok(temp)
}

/// A CLI's own lock for its file: the folder `<file><suffix>`, made atomically. Never taken over:
/// after five seconds the edit fails with the reason.
struct Lock(PathBuf);

impl Lock {
    fn take(file: &Path, suffix: &str) -> io::Result<Lock> {
        let mut dir = file.as_os_str().to_owned();
        dir.push(suffix);
        let dir = PathBuf::from(dir);
        let start = Instant::now();
        loop {
            match fs::create_dir(&dir) {
                Ok(()) => return Ok(Lock(dir)),
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
                Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Lock(PathBuf::new())),
                Err(e) => return err(format!("{}: {e}", dir.display())),
            }
            if start.elapsed() > Duration::from_secs(5) {
                return err(format!(
                    "{} is being written right now ({} is held). Try again in a moment; if no agent is running and it stays, remove that folder.",
                    file.display(),
                    dir.display()
                ));
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }
}

impl Drop for Lock {
    fn drop(&mut self) {
        if !self.0.as_os_str().is_empty() {
            let _ = fs::remove_dir(&self.0);
        }
    }
}
