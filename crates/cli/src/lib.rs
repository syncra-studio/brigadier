//! The commands every client shares: the `brigadier` CLI and drills, and the daemon that is the
//! app's one way to every host. Each command answers one JSON value.

mod accounts;
pub mod agent;
pub mod archived;
mod attach;
pub mod browser;
mod chips;
mod command;
mod commands;
mod commit;
pub mod computer;
pub mod control;
mod feedback;
mod fork;
mod git;
mod host;
pub mod index;
mod last;
pub mod mcp;
pub mod mention;
mod models;
mod outcomes;
pub mod owner;
mod panel;
pub mod peers;
mod plugins;
pub mod queue;
mod relay;
mod rename;
pub mod rewind;
mod routing;
mod sessions;
mod settings;
mod setup;
mod side;
pub mod signin;
mod switching;
mod tabs;
pub mod usage;
pub mod workers;
pub use brigadier_core::title;

use brigadier_core::{self as core, Spec, adapters, fold};
use brigadier_frames::{log, procs};
use serde_json::{Value, json};
use std::io::{self, Write};
use std::path::Path;
use std::time::{Duration, Instant};
use std::{env, fs, thread};

pub const USAGE: &str = "usage: brigadier start <id> --backend B [--project P | --scratch] [--local] [--base B] [--cwd D] [--model M] [--effort E] [--fast] [--level L] [--opt K=V] [--text T] [--carry-tabs | --carry-chat-tabs] [--brigade] [--pr N --head BRANCH [--fork] [--title T] [--url U]]
       brigadier send <id> <text> [--cid C] [--backend B] [--steer] [--from F] | side <id> <new-id> --text T --cid C [--qid Q]
       brigadier answer <id> <request> allow|allowSession|deny [--reason R] | answer <id> <request> --answers JSON
       brigadier status [<id>...|--all] | seen <id> <ms>
       brigadier rename <id> <title> [--preview] [--branch <name|->] | pin <id> [--off]
       brigadier chips <id> [add <chip-json> | drop <chip>… | take <msg> [--in <id>] <chip>… | back <msg> | draft <json|->]
       brigadier tabs <id> [open|replace <tab> <kind> [<target>] | url <tab> <url> | drive <tab> <url> <driver> | ungroup <driver> | scope <tab> <scope> | select|close|close-others|close-right <tab> | move <tab> <to> | reopen] | note <id> read <note> | write <note> <head> <body> [--base R] | list | delete <note> | chat <note> <chat> [--new | --open] [--backend B --model M --effort E --project P] | chats
       brigadier rewind <id> <cid> --preview | rewind <id> <cid> --op OP [--restore | --undo]
       brigadier fork <id> --check <cid> | fork <id> <new-id> --at <cid> [--where worktree|here|chat] [--fingerprint F] [--to B --model M [--effort E] [--fast]]
       brigadier stop <id> | recover <id> | archive <id>... [--check] | restore <id> | delete <id> [--check | --branch keep|delete] | owner <id> | up <id>...
       brigadier level <id> [ask|auto|full] [--op OP] | queue <id> add <text> --qid Q [--at N] [--from F] [--to W] | move <qid> <to> | remove|edit|steer <qid> | restore | resume
       brigadier read <id> [--follow] [--hash] [--tail N] | audit <id> [--recall] [--json]
       brigadier git <id> | git --project P [--watch]
       brigadier source <id> | source --project P [review <scope> | review-file <scope> <path> [<from>] | review-file last <before> <after> <path> [<from>] | file <path>]
       brigadier source <id>|--project P truth | status | source <id> restore-checkout
       brigadier source <id> files [<repo>...] | folder <path> | find <query> | since | repos
       brigadier source <id>|--project P branches | switch <branch> [--remote] | create <name> [--from <ref>]
       brigadier browser <session|-> profiles|imports <op> ... [--profile ID] [--json]
       brigadier panel [open on|off | width <px>]
       brigadier host <id> view <n|owner/name#n> [kept] | host <id> files <n|owner/name#n> [kept] | host <id> list | host <id> search <query>... [--kept] | host <id> runs <query>... [--kept] | host <id> run <run> [kept] | host <id> job-log <job> | host <id> rerun <run> <all|failed> | host <id> sides <n|owner/name#n> <path> | host <id> project <owner/name> | host <project> session <branch>
       brigadier index [--cold] | transcript <id> | thread <id> | title <text>
       brigadier awake [off|work|always] | settings [KEY VALUE | agent NAME on|off]
       brigadier agents [<agent>] [--cwd D] | agents test <agent> | forges [github|gitlab sign-in|close] | setup <agent> install|sign-in|update|close|code <code> [--account <id>] [--cols N] [--rows N]
       brigadier feedback account|sign-in [wait|cancel]|write NOTE|file REPORTS | profile [--name N] [--intro] [--done] [--git-writer JSON|null] | projects [--check P | add P [--id I] [--name N] | rename I N | set I [--name N] [--folder P] [--trusted true|false|none] [--setup S] [--include LINES] [--branch-prefix PREFIX] [--github-account LOGIN] [--browser-profile ID] (empty: automatic) | accounts I [--local] | reveal I | remove I]
       brigadier accounts [add <agent> [--name N] | remove <id> | use <agent> <id> | rename <agent> <id> <name>]
       brigadier switching [--agent A --auto on|off] [--agents on|off]
       brigadier switch <id> [--account A] [--auto]";

fn flag<'a>(args: &'a [String], name: &str) -> Option<&'a str> {
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1))
        .map(String::as_str)
}

/// A message's `--parts`: the composer's draft as its JSON, chips and files; Null for plain text [D109].
pub(crate) fn parts(args: &[String]) -> io::Result<Value> {
    flag(args, "--parts").map_or(Ok(Value::Null), |p| Ok(serde_json::from_str(p)?))
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
    // Every session id this command names, checked before any path is built from it [D706].
    let ids = match cmd {
        "status" | "up" => &args[1..],
        "index" | "awake" | "settings" | "agents" | "setup" | "profile" | "projects" | "forges"
        | "accounts" | "switching" | "models" | "title" | "feedback" | "git" | "source"
        | "panel" | "routing" | "plugins" | "browser" | "computer" => &[][..],
        _ => &args[1.min(args.len())..2.min(args.len())],
    };
    let home = matches!(cmd, "draft" | "tabs" | "attach" | "note" | "commands");
    let checked = |a: &&String| *a != "--all" && !(home && *a == HOME_DRAFT);
    for id in ids.iter().filter(checked) {
        let bare = id
            .strip_prefix("@home:")
            .filter(|_| matches!(cmd, "tabs" | "draft"));
        core::check_id(bare.unwrap_or(id))?;
    }
    match cmd {
        "start" => {
            let id = arg(args, 1)?;
            if id.starts_with(core::SETUP) {
                let kept = format!("{:?} is kept for setup runs", core::SETUP);
                return Err(io::Error::other(kept));
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
                    let chosen = settings::get(data, "default_level");
                    adapters::get(backend)
                        .and_then(|a| models::default_level(a, held, &chosen).map(String::from))
                }),
                effort: flag(args, "--effort").map(String::from),
                fast: has(args, "--fast"),
                brigade: has(args, "--brigade"),
                opts,
                created: log::now_ms(),
                ..Default::default()
            };
            if let Some(a) = adapters::get(backend) {
                core::level(&spec, a, false).map_err(io::Error::other)?;
            }
            let fresh = !core::session_dir(data, id).join("session.json").exists();
            let spec = if fresh {
                plugins::sync(data);
                core::share::one_local(data, project.as_ref(), &spec)?;
                core::create(data, &accounts::starting(data, spec))?
            } else {
                core::load(data, id)?
            };
            // Home's files, or a message sent as new's, come into the new session first, before
            // a cleared draft can take them [D204, D2022 #18].
            let parts = parts(args)?;
            core::message::take(data, &spec.dir, &parts, flag(args, "--from"))?;
            // The tabs are extras: a failure here never stops the session from starting.
            // New chat's tabs are its own, whichever project it picked; a project's New session's are that project's [D863].
            if fresh && (has(args, "--carry-tabs") || has(args, "--carry-chat-tabs")) {
                let _ = tabs::carry(data, id, has(args, "--carry-chat-tabs"));
            }
            if let Some(dir) = &scratch {
                fs::create_dir_all(dir)?;
            }
            // Only a session made for its worktree: a Local checkout one, started again, never gets one.
            let own = Path::new(&spec.cwd) == core::worktrees::path(data, id);
            if let Some(project) = project.filter(|_| worktree && own) {
                let base = flag(args, "--base");
                let on = host::pr_branch(data, args, &project, &spec)?;
                core::folder::ensure(
                    &spec,
                    &project,
                    fresh,
                    base,
                    &title::from(flag(args, "--text").unwrap_or("")),
                    on.as_deref(),
                )?;
            }
            drop(projects_lock);
            owner::ensure(data, &spec)?;
            match flag(args, "--text") {
                Some(text) => control::send(
                    data,
                    &spec,
                    text,
                    parts,
                    flag(args, "--cid"),
                    None,
                    None,
                    false,
                ),
                None => Ok(json!({"ok": true, "id": id})),
            }
        }
        "send" => {
            let (id, text) = (arg(args, 1)?, arg(args, 2)?);
            let parts = parts(args)?;
            if has(args, "--steer") {
                // A worker's message from its parent's composer brings the parent's files [D3013].
                if let Some(from) = flag(args, "--from") {
                    core::message::take(data, &core::load(data, id)?.dir, &parts, Some(from))?;
                }
                return control::steer_as(
                    data,
                    id,
                    text,
                    &parts,
                    flag(args, "--cid"),
                    "user",
                    false,
                );
            }
            if let Some(reply) = control::reply(data, id, text, flag(args, "--cid"), None)? {
                return Ok(reply);
            }
            let spec = core::load(data, id)?;
            owner::ensure(data, &spec)?;
            core::message::take(data, &spec.dir, &parts, flag(args, "--from"))?;
            let cid = flag(args, "--cid").map_or_else(control::new_cid, String::from);
            // A block its subagents or workers hold open is still running: as mid-turn [D521].
            let reply = match workers::holding(data, id) {
                true => json!({"error": "busy: a turn is running"}),
                false => control::send(
                    data,
                    &spec,
                    text,
                    parts,
                    Some(&cid),
                    flag(args, "--backend"),
                    // A failed turn's message again, after its rewind: it replaces that attempt [D492].
                    flag(args, "--retry-of"),
                    false,
                )?,
            };
            // Mid-turn, to an agent that takes only a steer then, it waits in the queue for the
            // next turn under its own id, as the composer's Queue does: delivered once [D54, D324].
            if reply["error"] != "busy: a turn is running" {
                return Ok(reply);
            }
            let mut queued = vec!["queue".into(), id.into(), "add".into(), text.into()];
            queued.extend(["--qid".into(), cid.clone()]);
            queued.extend(args.iter().skip_while(|a| *a != "--parts").take(2).cloned());
            queue::run(data, &queued)?;
            Ok(json!({"ok": true, "result": "queued", "cid": cid}))
        }
        // The user saw the session up to `at`, the end time its row showed; it only moves on [D173].
        "seen" => {
            let (id, at) = (arg(args, 1)?, arg(args, 2)?);
            let at: u64 = at
                .parse()
                .map_err(|_| io::Error::other(format!("bad time {at:?}")))?;
            core::load(data, id)?;
            let dir = core::session_dir(data, id);
            core::host::opened(&dir)?;
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
                "rename" => return rename::run(data, args),
                _ if has(args, "--off") => remove(&dir.join("pinned"))?,
                _ => core::write_atomic(&dir.join("pinned"), log::now_ms().to_string().as_bytes())?,
            }
            Ok(json!({"ok": true, "at": index::touched(&dir)}))
        }
        "draft" => attach::kept(data, args),
        "attach" | "note" => attach::run(data, args),
        "command" => command::run(data, args),
        "commands" => commands::run(data, args),
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
        "stop" => {
            queue::stop(data, arg(args, 1)?, "user").inspect(|_| workers::still(data, &args[1]))
        }
        "workers" => workers::run(data, args),
        "peers" => peers::run(data, args),
        "rewind" => rewind::run(data, args),
        "fork" => fork::run(data, args),
        "side" => side::run(data, args),
        "tabs" => tabs::run(data, args),
        "browser" => browser::run(data, args),
        "computer" => computer::run(data, args),
        "chips" => chips::run(data, args),
        "queue" => queue::run(data, args),
        "recover" => queue::recover(data, arg(args, 1)?, false),
        "archive" | "restore" | "delete" | "jobs" | "audit" => sessions::run(data, args),
        // The short title a first message gives its session, for the app's row before Rust's [D186].
        "feedback" => feedback::run(data, args),
        "title" => Ok(json!({"ok": true, "title": title::from(arg(args, 1)?)})),
        "level" => control::level(data, args),
        "answer" => control::answer(data, args),
        "up" => (args[1..].iter())
            .try_for_each(|id| owner::ensure(data, &core::load(data, id)?))
            .map(|()| json!({"ok": true})),
        "mockup" => relay::mockup::app(data, args),
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
            core::rewind::read_active(&spec.dir, |item| thread.push(item))?;
            let f = thread.status_fold();
            let live = fold::live(f, owner::state(data, id), data, &procs::all());
            if thread.running() && fold::status(f, &live)["state"] == "interrupted" {
                thread.interrupt(log::now_ms());
            }
            thread.sync_setup(setup, live.child.is_some());
            Ok(thread.session(id, "", None, None))
        }
        "index" => index::rebuild(data, has(args, "--cold")),
        "git" => git::run(data, args),
        "source" => git::source(data, args),
        "panel" => panel::run(data, args),
        "host" => host::run(data, args),
        "agents" | "setup" | "profile" | "projects" | "forges" => setup::run(data, args),
        "settings" => settings::run(data, args),
        "routing" => routing::run(data, args),
        "plugins" => plugins::run(data, args),
        "models" | "set" => models::run(data, args),
        "accounts" | "switching" | "switch" | "rebirth" => accounts::run(data, args),
        "awake" => settings::awake(data, args.get(1)),
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

/// Removes a file that may already be gone.
fn remove(path: &Path) -> io::Result<()> {
    match fs::remove_file(path) {
        Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e),
        _ => Ok(()),
    }
}
