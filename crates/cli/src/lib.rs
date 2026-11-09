//! The commands every client shares: the `brigadier` CLI and drills, and the daemon that is the
//! app's one way to every host. Each command answers one JSON value.

mod accounts;
mod control;
pub mod index;
mod models;
pub mod owner;
pub mod queue;
mod sessions;
mod setup;
mod side;
mod switching;
mod title;

use brigadier_core::fold::{self, Owner};
use brigadier_core::{self as core, Spec, adapters};
use brigadier_frames::{log, procs, take_lock};
use serde_json::{Value, json};
use std::io::{self, Write};
use std::path::Path;
use std::time::{Duration, Instant};
use std::{env, fs, thread};

pub const USAGE: &str = "usage: brigadier start <id> --backend B [--project P | --scratch] [--local] [--base B] [--cwd D] [--model M] [--effort E] [--level L] [--opt K=V] [--text T]
       brigadier send <id> <text> [--cid C] [--backend B] [--steer] | side <id> <new-id> --text T --cid C [--qid Q]
       brigadier answer <id> <request> allow|allowSession|deny [--reason R] | answer <id> <request> --answers JSON
       brigadier status [<id>...|--all] | seen <id> <ms>
       brigadier rename <id> <title> | pin <id> [--off]
       brigadier stop <id> | recover <id> | archive <id> | restore <id> | delete <id> [--check | --branch keep|delete] | owner <id> | up <id>...
       brigadier level <id> [ask|auto|full] [--op OP] | queue <id> add <text> --qid Q [--at N] | move <qid> <to> | remove|edit|steer <qid> | restore | resume
       brigadier read <id> [--follow] [--hash] [--tail N]
       brigadier index [--cold] | transcript <id> | thread <id> | title <text>
       brigadier awake [off|work|always]
       brigadier agents [<agent>] [--cwd D] | setup <agent> install|sign-in|close [--cols N] [--rows N]
       brigadier profile [--name N] [--intro] [--done] | projects [--check P | add P [--id I] [--name N] | rename I N | set I [--name N] [--folder P] [--trusted true|false|none] [--setup S] [--include LINES] | ignored I [--in D] | reveal I | remove I]
       brigadier accounts [add <agent> [--name N] | sign-in <id> | close <id> | remove <id>]
       brigadier switching [--agent A [--auto on|off] [--release on|off]] [--agents on|off]
       brigadier switch <id> [--account A] [--auto]";

fn flag<'a>(args: &'a [String], name: &str) -> Option<&'a str> {
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1))
        .map(String::as_str)
}

fn has(args: &[String], name: &str) -> bool {
    args.iter().any(|a| a == name)
}

fn arg(args: &[String], i: usize) -> io::Result<&str> {
    args.get(i)
        .map(String::as_str)
        .ok_or_else(|| io::Error::other(USAGE))
}

fn call_fn<'a>(data: &'a Path, id: &'a str) -> impl Fn(Value) -> io::Result<Value> + 'a {
    move |req| owner::call(data, id, req)
}

/// The child the owner holds right now, if any. An owner that doesn't answer reads as none.
fn child(data: &Path, id: &str) -> core::Running {
    let ping = owner::call(data, id, json!({"op": "ping"})).ok()?;
    ping["child"].as_i64()?;
    Some(ping["spawn"].as_u64().unwrap_or(0))
}

fn status_of(data: &Path, id: &str, all: &[procs::Proc]) -> io::Result<Value> {
    let dir = core::session_dir(data, id);
    let f = core::fold(&dir, true)?;
    let live = fold::live(&f.fold, owner::state(data, id), data, all);
    let mut s = fold::status(&f.fold, &live);
    s["id"] = id.into();
    Ok(s)
}

pub use switching::{switch_settings, wants};

/// Home's unsent words have no session to live in; this can't be a session id.
const HOME_DRAFT: &str = "@home";

pub fn run(data: &Path, args: &[String]) -> io::Result<Value> {
    let cmd = args.first().map(String::as_str).unwrap_or("");
    // Every session id this command names, checked before any path is built from it.
    let ids = match cmd {
        "status" | "up" => &args[1..],
        "index" | "awake" | "agents" | "setup" | "profile" | "projects" | "accounts"
        | "switching" | "models" | "title" => &[][..],
        _ => &args[1.min(args.len())..2.min(args.len())],
    };
    for id in ids
        .iter()
        .filter(|a| *a != "--all" && !(cmd == "draft" && *a == HOME_DRAFT))
    {
        core::check_id(id)?;
    }
    match cmd {
        "start" => {
            let id = arg(args, 1)?;
            if id.starts_with(core::SETUP) {
                return Err(io::Error::other(format!(
                    "{:?} is kept for setup runs",
                    core::SETUP
                )));
            }
            let backend = flag(args, "--backend").unwrap_or("fake");
            if adapters::get(backend).is_none() {
                return Err(io::Error::other(format!("unknown backend {backend}")));
            }
            let opts = args
                .windows(2)
                .filter(|w| w[0] == "--opt")
                .filter_map(|w| w[1].split_once('='))
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect();
            // New project sessions have their own worktree unless Local checkout is chosen [D160].
            let (projects_lock, projects) = core::projects::locked(data)?;
            let project = flag(args, "--project")
                .map(|p| {
                    let found = projects.into_iter().find(|r| r.id == p);
                    found.ok_or_else(|| io::Error::other(format!("no project {p}")))
                })
                .transpose()?;
            if project.as_ref().is_some_and(|p| p.removing) {
                return Err(io::Error::other("This project is being removed."));
            }
            let worktree = project.is_some() && !has(args, "--local");
            // A chat with no project works in a folder of its own, gone with the session [D35, D388].
            let scratch =
                has(args, "--scratch").then(|| core::session_dir(data, id).join("scratch"));
            let cwd = flag(args, "--cwd")
                .map(String::from)
                .or_else(|| worktree.then(|| core::worktrees::path(data, id).display().to_string()))
                .or_else(|| project.as_ref().map(|p| p.folder.clone()))
                .or_else(|| scratch.as_ref().map(|d| d.display().to_string()))
                .unwrap_or_else(|| env::current_dir().unwrap_or_default().display().to_string());
            let spec = Spec {
                project: project.as_ref().map(|p| p.id.clone()),
                id: id.into(),
                backend: backend.into(),
                mode: "pipe".into(),
                cwd,
                model: flag(args, "--model").map(String::from),
                // Unpicked, Rust's default for the agent and the project's trust [D187, D239].
                level: flag(args, "--level").map(String::from).or_else(|| {
                    let held = models::held(data, project.as_ref().map(|p| p.id.as_str()));
                    adapters::get(backend)
                        .and_then(|a| models::default_level(a, held).map(String::from))
                }),
                effort: flag(args, "--effort").map(String::from),
                opts,
                created: log::now_ms(),
                ..Default::default()
            };
            if let Some(a) = adapters::get(backend) {
                core::level(&spec, a, false).map_err(io::Error::other)?;
            }
            let fresh = !core::session_dir(data, id).join("session.json").exists();
            let spec = if fresh {
                core::create(data, &spec)?
            } else {
                core::load(data, id)?
            };
            if let Some(dir) = &scratch {
                fs::create_dir_all(dir)?;
            }
            // Only a session made for its worktree: a Local checkout one, started again, never gets one.
            let own = Path::new(&spec.cwd) == core::worktrees::path(data, id);
            if let Some(project) = project.filter(|_| worktree && own) {
                let base = flag(args, "--base");
                core::worktrees::ensure(&spec, &project, fresh, base)?;
            }
            drop(projects_lock);
            owner::ensure(data, &spec)?;
            match flag(args, "--text") {
                Some(text) => send(data, &spec, text, flag(args, "--cid"), None),
                None => Ok(json!({"ok": true, "id": id})),
            }
        }
        "send" => {
            let (id, text) = (arg(args, 1)?, arg(args, 2)?);
            if has(args, "--steer") {
                return control::steer(data, id, text, flag(args, "--cid"));
            }
            if let Some(reply) = control::reply(data, id, text, flag(args, "--cid"))? {
                return Ok(reply);
            }
            let spec = core::load(data, id)?;
            owner::ensure(data, &spec)?;
            send(
                data,
                &spec,
                text,
                flag(args, "--cid"),
                flag(args, "--backend"),
            )
        }
        // The user saw the session up to `at`, the end time its row showed; it only moves on [D173].
        "seen" => {
            let (id, at) = (arg(args, 1)?, arg(args, 2)?);
            let at: u64 = at
                .parse()
                .map_err(|_| io::Error::other(format!("bad time {at:?}")))?;
            core::load(data, id)?;
            let dir = core::session_dir(data, id);
            let old: u64 = fs::read_to_string(dir.join("seen"))
                .ok()
                .and_then(|s| s.trim().parse().ok())
                .unwrap_or(0);
            if at > old {
                core::write_atomic(&dir.join("seen"), at.to_string().as_bytes())?;
            }
            Ok(json!({"ok": true, "at": index::touched(&dir)}))
        }
        // The user's own marks, one small file each in the session's folder [D185, D186]. Each
        // answers the folder's time after the write: the row that shows it has `touched` as late.
        "rename" | "pin" => {
            let id = arg(args, 1)?;
            core::load(data, id)?;
            let dir = core::session_dir(data, id);
            match args[0].as_str() {
                "rename" => {
                    let name = title::clean(arg(args, 2)?).map_err(io::Error::other)?;
                    core::write_atomic(&dir.join("title"), name.as_bytes())?;
                }
                _ if has(args, "--off") => remove(&dir.join("pinned"))?,
                _ => core::write_atomic(&dir.join("pinned"), log::now_ms().to_string().as_bytes())?,
            }
            Ok(json!({"ok": true, "at": index::touched(&dir)}))
        }
        // What the composer holds unsent, as the UI's own JSON [D109, D237]; a deleted session refuses.
        "draft" => {
            let id = arg(args, 1)?;
            let path = if id == HOME_DRAFT {
                data.join("home-draft")
            } else {
                core::load(data, id)?;
                core::session_dir(data, id).join("draft")
            };
            match args.get(2).map(String::as_str) {
                None => return Ok(json!({"ok": true, "draft": fs::read_to_string(&path).ok()})),
                Some("") => remove(&path)?,
                Some(parts) => core::write_atomic(&path, parts.as_bytes())?,
            }
            Ok(json!({"ok": true}))
        }
        "status" => {
            let all = procs::all();
            let ids: Vec<String> = if has(args, "--all") {
                core::ids(data)
            } else {
                args[1..].to_vec()
            };
            let mut stdout = io::stdout().lock();
            for id in &ids {
                let s = status_of(data, id, &all)
                    .unwrap_or_else(|e| json!({"id": id, "ok": false, "error": e.to_string()}));
                writeln!(stdout, "{s}")?;
            }
            Ok(Value::Null)
        }
        "stop" => queue::stop(data, arg(args, 1)?),
        "side" => side::run(data, args),
        "queue" => queue::run(data, args),
        "recover" => {
            let id = arg(args, 1)?;
            let spec = core::load(data, id)?;
            owner::ensure(data, &spec)?;
            let _fence = core::session::fence(data, &spec)?;
            let f = core::fold(&spec.dir, true)?;
            let live = fold::live(&f.fold, Owner::Alive, data, &procs::all());
            let call = call_fn(data, id);
            Ok(core::recover(&spec, &f.fold, &live, child(data, id), &call))
        }
        "archive" | "restore" | "delete" => sessions::run(data, args),
        // The short title a first message gives its session, for the app's row before Rust's [D186].
        "title" => Ok(json!({"ok": true, "title": title::from(arg(args, 1)?)})),
        "level" => control::level(data, args),
        "answer" => control::answer(data, args),
        "up" => {
            for id in &args[1..] {
                owner::ensure(data, &core::load(data, id)?)?;
            }
            Ok(json!({"ok": true}))
        }
        "owner" => Ok(
            json!({"pid": owner::pid(data, arg(args, 1)?), "state": format!("{:?}", owner::state(data, arg(args, 1)?))}),
        ),
        "read" => read(data, arg(args, 1)?, args),
        // (proposed) A diagnostic: the thread the app draws, from the same fold [D64, D65].
        "thread" => {
            let id = arg(args, 1)?;
            let spec = core::load(data, id)?;
            let mut thread = core::thread::Thread::default();
            // A visible setup marker guarantees SPAWNED is logged before this read starts.
            let setup = core::worktrees::setup_state(&spec.dir, true);
            core::read(&spec.dir, |item| thread.push(item))?;
            let f = thread.status_fold();
            let live = fold::live(f, owner::state(data, id), data, &procs::all());
            if thread.running() && fold::status(f, &live)["state"] == "interrupted" {
                thread.interrupt(log::now_ms());
            }
            thread.sync_setup(setup, live.child.is_some());
            Ok(thread.session(id, ""))
        }
        "index" => index(data, has(args, "--cold")),
        "agents" | "setup" | "profile" | "projects" => setup::run(data, args),
        "models" | "set" => models::run(data, args),
        "accounts" | "switching" | "switch" => accounts::run(data, args),
        "awake" => {
            if let Some(mode) = args.get(1) {
                if !core::AWAKE_MODES.contains(&mode.as_str()) {
                    return Err(io::Error::other(USAGE));
                }
                core::write_atomic(&data.join("awake"), mode.as_bytes())?;
            }
            Ok(json!({"ok": true, "awake": core::awake_mode(data)}))
        }
        "transcript" => {
            let id = arg(args, 1)?;
            let spec = core::load(data, id)?;
            // A tool may be announced at start and again at its end: count it once, by id. Ids are
            // only unique within a turn (a backend may number them afresh per process).
            let (mut texts, mut turn, mut tools) = (0u64, 0u64, std::collections::BTreeSet::new());
            core::read(&spec.dir, |i| match i["kind"].as_str() {
                Some("text") => texts += 1,
                Some("turn_start") => turn += 1,
                // A subagent's own steps are in its own transcript, not the parent's.
                Some("tool") if i["parent"].is_null() => {
                    tools.insert((turn, i["id"].as_str().unwrap_or("").to_string()));
                }
                _ => {}
            })?;
            let tools = tools.len();
            let f = core::fold(&spec.dir, true)?;
            let theirs: Vec<Value> = f
                .fold
                .resume
                .iter()
                .filter_map(|(b, r)| {
                    adapters::get(b)?
                        .transcript(&spec, r)
                        .map(|(x, t)| json!({"backend": b, "texts": x, "tools": t}))
                })
                .collect();
            Ok(json!({"ok": true, "ours": {"texts": texts, "tools": tools}, "theirs": theirs}))
        }
        _ => Err(io::Error::other(USAGE)),
    }
}

fn send(
    data: &Path,
    spec: &Spec,
    text: &str,
    cid: Option<&str>,
    backend: Option<&str>,
) -> io::Result<Value> {
    let _fence = core::session::fence(data, spec)?;
    let cid = cid.map_or_else(control::new_cid, String::from);
    let call = call_fn(data, &spec.id);
    let go = || -> io::Result<Value> {
        let f = core::fold(&spec.dir, true)?;
        let running = child(data, &spec.id);
        Ok(core::send(
            spec, &f.fold, running, &call, &cid, "user", text, backend, None,
        ))
    };
    let mut reply = go()?;
    let logged = || core::fold(&spec.dir, true).is_ok_and(|f| f.fold.cids.contains_key(&cid));
    // Retry a busy race or moving host only when the log proves the command never got in;
    // an uncertain delivery is never sent again by itself [D54].
    if reply["result"].is_null() && !logged() {
        thread::sleep(Duration::from_millis(200));
        // If no host answers, the resend fails too and the log decides the result below.
        let _ = owner::ensure(data, spec);
        reply = go()?;
    }
    // A dropped connection says nothing about the log: the log itself does.
    if reply["result"].is_null() {
        reply["result"] = match (reply["ok"] == true, logged()) {
            (true, _) => "delivered",
            (false, true) => "logged",
            (false, false) => "not_logged",
        }
        .into();
    }
    Ok(reply)
}

fn read(data: &Path, id: &str, args: &[String]) -> io::Result<Value> {
    let spec = core::load(data, id)?;
    let started = Instant::now();
    if let Some(n) = flag(args, "--tail") {
        let items = core::tail(&spec.dir, &spec, n.parse().unwrap_or(50))?;
        return Ok(
            json!({"ok": true, "items": items.len(), "ms": started.elapsed().as_secs_f64() * 1000.0}),
        );
    }
    let quiet = has(args, "--hash");
    let mut stdout = io::BufWriter::new(io::stdout().lock());
    let mut count = 0u64;
    if !has(args, "--follow") {
        let hash = core::read(&spec.dir, |item| {
            count += 1;
            if !quiet {
                let _ = writeln!(stdout, "{item}");
            }
        })?;
        stdout.flush()?;
        return Ok(
            json!({"ok": true, "items": count, "hash": format!("{hash:016x}"), "ms": started.elapsed().as_millis() as u64}),
        );
    }
    // Follow: the same normaliser over the same frames, as they arrive.
    let mut reader = log::Reader::open(&spec.dir.join("log"), 0, 0)?;
    let mut norm = brigadier_core::norm::Norm::default();
    let mut items = vec![];
    loop {
        while let Some(frame) = reader.frame()? {
            norm.push(&frame, &mut items);
            for item in items.drain(..) {
                writeln!(stdout, "{item}")?;
            }
        }
        stdout.flush()?;
        thread::sleep(Duration::from_millis(100));
    }
}

fn index(data: &Path, cold: bool) -> io::Result<Value> {
    let started = Instant::now();
    // The daemon keeps the index while it runs; a second writer would only fight it.
    let Some(_lock) = take_lock(&data.join("daemon.lock"))? else {
        return Err(io::Error::other(
            "the daemon is running and keeps the index",
        ));
    };
    let mut ix = index::Index::open(data, cold)?;
    ix.sync()?;
    Ok(json!({"ok": true, "sessions": ix.rows.len(), "ms": started.elapsed().as_millis() as u64}))
}

/// Removes a file that may already be gone.
fn remove(path: &Path) -> io::Result<()> {
    match fs::remove_file(path) {
        Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e),
        _ => Ok(()),
    }
}
