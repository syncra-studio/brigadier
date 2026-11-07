//! Provider-neutral session model: Session (a folder), Backend (an adapter), Turn and Item.
//! Everything here is shared by both owner designs; only how the owner is reached differs.

pub mod adapters;
pub mod fold;
pub mod norm;

use brigadier_frames::log::{self, Reader};
use brigadier_frames::procs;
use fold::{Fold, Live};
use norm::Norm;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
use std::path::{Path, PathBuf};

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct Spec {
    pub id: String,
    pub backend: String,
    /// "pipe" for the chat view, "pty" for a real terminal.
    pub mode: String,
    pub cwd: String,
    pub model: Option<String>,
    #[serde(default)]
    pub opts: BTreeMap<String, String>,
    pub created: u64,
    #[serde(skip)]
    pub dir: PathBuf,
}

pub fn data_dir() -> PathBuf {
    std::env::var_os("BRIGADIER_DATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| adapters::home_path("Library/Application Support/Brigadier"))
}

/// A session id names one folder under `sessions/`, so it may hold only plain name characters:
/// no separators, no `..`, nothing absolute.
pub fn check_id(id: &str) -> io::Result<()> {
    let plain = |c: char| c.is_ascii_alphanumeric() || c == '-' || c == '_';
    if id.is_empty() || id.len() > 128 || !id.chars().all(plain) {
        return Err(io::Error::other(format!("invalid session id {id:?}")));
    }
    Ok(())
}

pub fn session_dir(data: &Path, id: &str) -> PathBuf {
    data.join("sessions").join(id)
}

pub fn ids(data: &Path) -> Vec<String> {
    let mut ids: Vec<String> = fs::read_dir(data.join("sessions"))
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| e.file_name().into_string().ok())
        .collect();
    ids.sort();
    ids
}

pub fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, bytes)?;
    fs::rename(tmp, path)
}

pub fn create(data: &Path, spec: &Spec) -> io::Result<Spec> {
    check_id(&spec.id)?;
    let dir = session_dir(data, &spec.id);
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&dir)?;
    fs::set_permissions(data, fs::Permissions::from_mode(0o700))?;
    write_atomic(
        &dir.join("session.json"),
        serde_json::to_string_pretty(spec)?.as_bytes(),
    )?;
    load(data, &spec.id)
}

pub fn load(data: &Path, id: &str) -> io::Result<Spec> {
    let dir = session_dir(data, id);
    let mut spec: Spec = serde_json::from_slice(&fs::read(dir.join("session.json"))?)?;
    spec.dir = dir;
    Ok(spec)
}

/// A fold with the reader position it reached.
#[derive(Serialize, Deserialize, Default, Clone)]
pub struct Folded {
    pub v: u32,
    pub pos: u64,
    pub seq: u64,
    pub fold: Fold,
    pub norm: Norm,
}

const CHECKPOINT_EVERY: u64 = 16 << 20;

/// Folds the whole log, starting from the checkpoint when one is valid, and writes a new one when
/// the log grew a lot. The checkpoint is only a cache: deleting it changes nothing but speed.
pub fn fold(dir: &Path, use_checkpoint: bool) -> io::Result<Folded> {
    let ckpt = dir.join("fold.json");
    let log_len = fs::metadata(dir.join("log")).map(|m| m.len()).unwrap_or(0);
    let f = use_checkpoint
        .then(|| {
            fs::read(&ckpt)
                .ok()
                .and_then(|b| serde_json::from_slice::<Folded>(&b).ok())
        })
        .flatten()
        .filter(|f| f.pos <= log_len)
        .unwrap_or_default();
    let start = f.pos;
    let f = fold_from(dir, f, |_| {})?;
    // Only a fold that ended clean has its state and offset at the same frame.
    if use_checkpoint && f.norm.clean() && f.pos - start >= CHECKPOINT_EVERY {
        let _ = write_atomic(&ckpt, &serde_json::to_vec(&f)?);
    }
    Ok(f)
}

/// Carries a fold on from where `f` stopped, handing each new item to `each`. `pos` moves only at
/// frames where the normaliser is clean, so when it ends unclean the fold holds items past `pos`:
/// keep such a result for status, but resume only from a clean one. A fold from another
/// normaliser version starts over.
pub fn fold_from(dir: &Path, mut f: Folded, mut each: impl FnMut(&Value)) -> io::Result<Folded> {
    if f.v != norm::VERSION {
        f = Folded {
            v: norm::VERSION,
            ..Default::default()
        };
    }
    let log_len = fs::metadata(dir.join("log")).map(|m| m.len()).unwrap_or(0);
    if log_len > f.pos {
        let mut reader = Reader::open(&dir.join("log"), f.pos, f.seq)?;
        let mut items = vec![];
        while let Some(frame) = reader.frame()? {
            f.norm.push(&frame, &mut items);
            for item in items.drain(..) {
                each(&item);
                f.fold.push(&item);
            }
            // Any output is a sign of life, even bytes that make no item (heartbeats).
            if matches!(frame.kind, log::OUT | log::ERR | log::PTY) {
                f.fold.last_out = frame.ts;
            }
            if f.norm.clean() {
                f.pos = reader.pos;
                f.seq = reader.seq;
            }
        }
    }
    Ok(f)
}

/// Every item from the start, in order. Returns an FNV-1a hash over them, so two reads can be
/// compared exactly.
pub fn read(dir: &Path, mut each: impl FnMut(&Value)) -> io::Result<u64> {
    let mut hash: u64 = 0xcbf29ce484222325;
    let mut norm = Norm::default();
    let mut reader = Reader::open(&dir.join("log"), 0, 0)?;
    let mut items = vec![];
    while let Some(frame) = reader.frame()? {
        norm.push(&frame, &mut items);
        for item in items.drain(..) {
            for b in item.to_string().bytes().chain(*b"\n") {
                hash = (hash ^ b as u64).wrapping_mul(0x100000001b3);
            }
            each(&item);
        }
    }
    Ok(hash)
}

/// Roughly the last `n` items, read from the end only: what a long thread shows when opened.
pub fn tail(dir: &Path, spec: &Spec, n: usize) -> io::Result<Vec<Value>> {
    let path = dir.join("log");
    let len = fs::metadata(&path)?.len();
    let mut window = 256u64 << 10;
    loop {
        let mut reader = Reader::open(&path, 0, 0)?;
        reader.sync_to(len.saturating_sub(window))?;
        let mut norm = Norm::default();
        norm.backend = spec.backend.clone();
        let (mut items, mut out) = (vec![], vec![]);
        while let Some(frame) = reader.frame()? {
            norm.push(&frame, &mut items);
            out.append(&mut items);
        }
        if out.len() >= n || window >= len {
            let skip = out.len().saturating_sub(n);
            return Ok(out.split_off(skip));
        }
        window *= 4;
    }
}

pub type Call<'a> = &'a dyn Fn(Value) -> io::Result<Value>;

/// Sends one message: the owner logs it with its command id before writing it anywhere. Prints
/// back exactly what happened: delivered, logged (not proven delivered) or refused.
#[allow(clippy::too_many_arguments)]
pub fn send(
    spec: &Spec,
    f: &Fold,
    child: Option<i32>,
    call: Call,
    cid: &str,
    origin: &str,
    text: &str,
    backend: Option<&str>,
    retry_of: Option<&str>,
) -> Value {
    let b = backend.map(String::from).unwrap_or_else(|| {
        if f.backend.is_empty() {
            spec.backend.clone()
        } else {
            f.backend.clone()
        }
    });
    let Some(a) = adapters::get(&b) else {
        return json!({"ok": false, "error": format!("unknown backend {b}")});
    };
    let base =
        json!({"cid": cid, "origin": origin, "text": text, "backend": b, "retry_of": retry_of});
    let running = child.is_some();
    if running && f.child.as_ref().is_some_and(|c| c.backend != b) {
        return json!({"ok": false, "result": "refused", "error": "another backend's process is running; stop it first"});
    }
    if running && (!a.per_turn() || spec.mode == "pty") {
        let mut req = base.clone();
        req["op"] = "input".into();
        req["bytes"] = a.encode(spec, text).into();
        let reply = call(req).unwrap_or_else(|e| json!({"ok": false, "error": e.to_string()}));
        if reply["error"] != "no_child" {
            return reply;
        }
    } else if running {
        return json!({"ok": false, "result": "refused", "error": "busy: a turn is running"});
    }
    let resume = f.resume.get(&b).map(String::as_str);
    let launch = a.launch(spec, resume, Some(text));
    let env: serde_json::Map<String, Value> =
        launch.env.into_iter().map(|(k, v)| (k, v.into())).collect();
    let mut req = base;
    for (k, v) in [
        ("op", json!("spawn")),
        ("argv", json!(launch.argv)),
        ("env", Value::Object(env)),
        ("cwd", json!(spec.cwd)),
        ("pty", json!(spec.mode == "pty")),
        ("keep_stdin", json!(launch.keep_stdin)),
        ("input", json!(launch.input)),
        ("cli_version", json!(cli_version(spec, a))),
    ] {
        req[k] = v;
    }
    call(req).unwrap_or_else(|e| json!({"ok": false, "error": e.to_string()}))
}

/// The one recovery. An unproven delivery is re-sent only when a person asks (never by itself);
/// an interrupted turn continues through the backend's resume id.
pub fn recover(spec: &Spec, f: &Fold, live: &Live, child: Option<i32>, call: Call) -> Value {
    let status = fold::status(f, live);
    let state = status["state"].as_str().unwrap_or("");
    let now = log::now_ms();
    let note = |data: Value| call(json!({"op": "note", "data": data}));
    match state {
        "undelivered" => {
            let Some(turn) = f.turns.iter().find(|t| t.delivered.is_none()) else {
                return json!({"ok": false});
            };
            let old = turn.cid.clone().unwrap_or_default();
            if let Err(e) = note(json!({"event": "interrupted", "reason": {"undelivered": old}})) {
                return json!({"ok": false, "error": e.to_string()});
            }
            let cid = format!("{old}.r{now}");
            let mut reply = send(
                spec,
                f,
                child,
                call,
                &cid,
                &turn.origin,
                &turn.text,
                Some(&turn.backend),
                Some(&old),
            );
            reply["recovered"] = "resent".into();
            reply
        }
        "interrupted" => {
            let swept = sweep(f);
            let last = f
                .turns
                .first()
                .map(|t| (t.cid.clone(), t.retry_of.clone(), t.backend.clone()));
            let last = last.or_else(|| {
                f.last.as_ref().map(|l| {
                    (
                        l["cid"].as_str().map(String::from),
                        l["retry_of"].as_str().map(String::from),
                        l["backend"].as_str().unwrap_or("").to_string(),
                    )
                })
            });
            let (cid, retry_of, backend) = last.unwrap_or_default();
            let root = retry_of.or(cid).unwrap_or_default();
            if let Err(e) = note(json!({"event": "interrupted", "reason": status["reason"]})) {
                return json!({"ok": false, "error": e.to_string()});
            }
            if !f.resume.contains_key(&backend) {
                return json!({"ok": false, "swept": swept, "error": "no resume id was announced, so there is nothing to continue; send a new message"});
            }
            let text = "Continue where you left off; your previous run was cut off.";
            let mut reply = send(
                spec,
                f,
                None,
                call,
                &format!("rc{now}"),
                "system",
                text,
                Some(&backend),
                Some(&root),
            );
            reply["recovered"] = "continued".into();
            reply["swept"] = swept.into();
            reply
        }
        _ => json!({"ok": false, "error": format!("nothing to recover: {state}")}),
    }
}

/// Kills what is left of process groups this session recorded, checked by start time. Only for
/// when no owner holds them any more.
pub fn sweep(f: &Fold) -> usize {
    fold::live_groups(f, &procs::all())
        .iter()
        .map(|&(g, s)| procs::signal_group(g, s, libc::SIGKILL))
        .sum()
}

/// The backend's CLI version, cached by executable path and modification time.
pub fn cli_version(spec: &Spec, a: &dyn adapters::Adapter) -> String {
    let Some(exe) = a.exe() else {
        return String::new();
    };
    let mtime = fs::metadata(&exe)
        .and_then(|m| m.modified())
        .map(|t| format!("{t:?}"))
        .unwrap_or_default();
    let cache = spec
        .dir
        .parent()
        .and_then(Path::parent)
        .map(|d| d.join("versions.json"))
        .unwrap_or_default();
    let mut map: BTreeMap<String, (String, String)> = fs::read(&cache)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();
    let key = exe.display().to_string();
    if let Some((m, v)) = map.get(&key)
        && *m == mtime
    {
        return v.clone();
    }
    let out = std::process::Command::new(&exe)
        .arg("--version")
        .env_clear()
        .env("HOME", adapters::home_path(""))
        .output();
    let version = out
        .map(|o| {
            String::from_utf8_lossy(&o.stdout)
                .lines()
                .next()
                .unwrap_or("")
                .trim()
                .to_string()
        })
        .unwrap_or_default();
    map.insert(key, (mtime, version.clone()));
    let _ = write_atomic(&cache, &serde_json::to_vec(&map).unwrap_or_default());
    version
}

/// Removes the session folder and every recorded path outside it. Reports what stayed.
pub fn delete(spec: &Spec, f: &Fold) -> Value {
    let swept = sweep(f);
    let (mut removed, mut left) = (vec![], vec![]);
    for (backend, id) in &f.resume {
        let Some(a) = adapters::get(backend) else {
            continue;
        };
        // The id came from the CLI's output: never let an odd one widen what gets deleted.
        if check_id(id).is_err() {
            left.push(format!(
                "{backend}: unusual resume id {id:?}, nothing removed"
            ));
            continue;
        }
        a.forget(spec, id);
        for path in a.external(spec, id) {
            let gone = if path.is_dir() {
                fs::remove_dir_all(&path)
            } else {
                fs::remove_file(&path)
            };
            match gone {
                Ok(()) => removed.push(path.display().to_string()),
                Err(e) if e.kind() == io::ErrorKind::NotFound => {}
                Err(e) => left.push(format!("{}: {e}", path.display())),
            }
        }
        // Shared folders go only once empty: other sessions may still have files in them.
        for path in a.shared(spec) {
            if fs::remove_dir(&path).is_ok() {
                removed.push(path.display().to_string());
            }
        }
    }
    match fs::remove_dir_all(&spec.dir) {
        Ok(()) => removed.push(spec.dir.display().to_string()),
        Err(e) => left.push(format!("{}: {e}", spec.dir.display())),
    }
    json!({"ok": left.is_empty(), "swept": swept, "removed": removed, "left": left})
}
