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
mod labels;
mod last;
pub mod mcp;
pub mod mention;
mod models;
mod out;
mod outcomes;
pub mod overnight;
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
mod start;
mod storage;
mod switching;
mod tabs;
pub mod usage;
pub mod workers;
pub use brigadier_core::title;

use attach::book::unsent;
use brigadier_core::{self as core, adapters, fold};
use brigadier_frames::{log, procs};
use serde_json::{Value, json};
use std::fs;
use std::io::{self, Write};
use std::path::Path;

pub const USAGE: &str = "usage: brigadier start <id> [--backend B] (B: fake, the test agent, if none) [--project P | --scratch] [--local] [--base B] [--cwd D] [--model M] [--effort E] [--fast] [--level L] [--opt K=V] [--text T] [--cid C] [--parts JSON] [--from F] [--carry-tabs] [--overnight] [--home <@home…> --draft JSON [--draft-rev R]]
       brigadier send <id> <text> [--cid C] [--backend B] [--steer] [--from F] [--parts JSON] [--retry-of C] [--draft JSON [--draft-rev R] [--chips <id,…>]] | side <id> <new-id> --text T --cid C [--qid Q]
       brigadier answer <id> <request> allow|allowSession|deny [--reason R] | answer <id> <request> --answers JSON
       brigadier status [<id>...|--all] | seen <id> <ms>
       brigadier rename <id> <title> [--preview] [--branch <name|->] | pin <id> [--off] | label <id> <name> [--off]
       brigadier draft <@home|@home:P|id> [<json>|\"\" [--base R] [--took <cid,…>] | retry|drop <cid> | adopt <cid> --kind send|queue|start --op JSON --draft JSON [--draft-rev R]] | command <id> <name> | commands <id> [reveal <name>] | commands @home --backend B [--project P]
       brigadier attach <@home|id> add <aid> <name> --backend B (--path P | --data BASE64) [--in IDS] | read <aid> | write <aid> <text> | remove <aid> | list | view <path> | reveal <path> | back <session> <parts JSON|null> [--carry-tabs] (back: @home only)
       brigadier chips <id> [add <chip-json> | drop <chip>… | take <msg> [--in <id>] <chip>… | back <msg> | draft <json|->]
       brigadier tabs <@home|@home:P|id> [open|replace <tab> <kind> [<target>] | url <tab> <url> | drive <tab> <url> <driver> | user <tab> | profile <tab> <profile> | ungroup <driver> | file <tab> <path> <line|-> <keep|preview> | keep <tab> | scope <tab> <scope> | select|close|close-others|close-right <tab> | move <tab> <to> | reopen | take <@home…> <tab>…] [--behind]
       brigadier terminal <owner> start|restart <tab> [cols] [rows] [--run <line>] | terminal sweep | shell <session> stop|output <command id> | shell settle
       brigadier note <@home|id> [--project P] read <note> [--first] | write <note> <head> <body> [--base R] [--from <note>] | image <note> <name> (--path P | --from <note>/<name> | --data BASE64) | list [--q Q] | pin <note> on|off | rename <note> <name> | delete <note> | chat <note> <chat> [--new | --open] [--backend B --model M --effort E --project P] | chats
       brigadier rewind <id> <cid> --preview | rewind <id> <cid> --op OP [--restore | --undo]
       brigadier fork <id> --check <cid> | fork <id> --latest | fork <id> <new-id> --at <cid> [--where worktree|chat] [--fingerprint F] [--to B --model M [--effort E] [--fast]]
       brigadier stop <id> | recover <id> | archive <id>... [--check] | restore <id> | delete <id>... --check | delete <id> [--branch keep|delete] [--delete-in <repo>]... | owner <id> | up <id>...
       brigadier jobs <id> history | servers | stop <pid> <start_us>
       brigadier workers <id> [stop [<wid>...] | pause|resume <wid>] | peers <id> send <mid> | mockup <wid> [draft '<notes>' | send '<notes>' | use <letter> '<notes>']
       brigadier level <id> [ask|auto|full] [--op OP] | overnight <id> on|start|off [--op OP] | queue <id> add <text> --qid Q [--at N] [--from F] [--origin O] [--parts JSON] [--to W | --shell] [--draft JSON [--draft-rev R] [--chips <id,…>]] | move <qid> <to> | remove|edit|steer <qid> | restore | resume | background <command id>
       brigadier read <id> [--follow] [--hash] [--tail N] | audit <id> [--recall] [--json]
       brigadier git <id>|--project P [--watch]
       brigadier source <id> | source --project P [review <scope> | review-file <scope> <path> [<from>] | review-file last <before> <after> <path> [<from>] | file <path> | image <path>]
       brigadier source <id>|--project P truth | status | source <id> restore-checkout
       brigadier source <id> files [<repo>...] | folder <path> | find <query> | reveal [<path>] | since | repos
       brigadier source <id>|--project P branches | switch <branch> [--remote] | create <name> [--from <ref>]
       brigadier browser <session|-|@home> profiles list|create|rename|recolour|move|make-default|delete-mark|forget|session-pick|tab-pick|resolve ... [--json]
       brigadier browser <session|-|@home> imports sources|origins|read|place | certs trust|clear | dates record|since|clear [--profile ID | --tab T] [--json] | browser answer <call> <json> | browser <session> paused <tab> true|false [<agent>]
       brigadier computer status|on|off|grant accessibility|screenRecording|test <pid> <window>
       brigadier panel [open on|off | width <px>]
       brigadier host <id> view <n|owner/name#n> [kept] | host <id> files <n|owner/name#n> [kept] | host <id> list | host <id> search <query>... [--kept] [--after <cursor>] | host <id> runs <query>... [--kept] | host <id> run <run> [kept] | host <id> job-log <job> | host <id> rerun <run> <all|failed> | host <id> sides <n|owner/name#n> <path> | host <id> project <owner/name> | host <id> base (<id>: a session or a project)
       brigadier host <id>|@ (@: the Code Review page; ref = host/owner/name#n; (in): --text T, else stdin) view|files <ref> [kept] | search <query>... [--as <login>] (@ only) | scopes (@ only) | users <ref> <text> | stack|generated <ref> | comment <ref> (in) | comment-edit <ref> <node> (in) | comment-delete <ref> <node> | react <ref> <node> <content> on|off | edit <ref> --title T | --body (in) | reply <ref> <thread> (in) | resolve|unresolve <ref> <thread> | viewed|unviewed <ref> <path> | pending <ref> <path> <line> LEFT|RIGHT [<start>] (in) | review <ref> approve|comment|changes (in) | review-discard <ref>
       brigadier host <id>|@ reviewers <ref> add|remove|rerequest <login|org/team>... | merge <ref> squash|merge|rebase --head <sha> | automerge <ref> on <method> | off | close|reopen|draft|ready <ref> | host <session> create [--branch NEW] [--commit] [--title T] [--message M] [--draft] [--base B] [--head H] | attach|detach <ref> | compare <base> <head>
       brigadier index [--cold] | transcript <id> | thread <id> | title <text>
       brigadier awake [off|work|always|lid|lid-setup|lid-seen AT] | storage [build|worktrees|temp|history|browser|programs | free build|left ID]
       brigadier settings [KEY VALUE | chat-layout bubbles|stacked | agent NAME on|off | agent-path NAME PATH | model NAME ID on|off | star NAME ID on|off]
       brigadier models [--session S | --project P | --cwd D] [--fresh] [--all] | set <session> --agent B --model M [--effort E] [--fast] --op OP | set <session> --now --op OP
       brigadier routing [--json | set <json> | offer <id> use|later|never | results | resume <wid> | answer <wid> <request> <choice>]
       brigadier plugins [add '<json>' | install <id> '<scope>' [client_id] | use <id> '<scope>' | sync | ask | set <key> '<json>' | remove <key> | show|reveal <key> | signin|wait|cancel|signout <key> | browse server|skill <query>]
       brigadier agents [<agent>] [--cwd D] [--cached] | agents test <agent> | forges [github|gitlab sign-in|close] | setup <agent> install|sign-in|update|close|code <code> [--account <id>] [--cols N] [--rows N]
       brigadier feedback account|sign-in [wait|cancel]|write NOTE|file REPORTS | profile [--name N] [--intro] [--done] [--tour] [--git-writer JSON|null] (null: choose the first available writer again) | projects [--check P | add P [--id I] [--name N] | rename I N | set I [--name N] [--folder P] [--trusted true|false|none] [--setup S] [--include LINES] [--branch-prefix PREFIX] [--github-account LOGIN] [--browser-profile ID] [--icon tag:N|emoji:E|image:P] (empty: find a GitHub account again, save the default browser profile, or restore the default icon) | pin I [--off] | accounts I | reveal I | remove I [--check]]
       brigadier projects branches I | drop-branches <repo> <branch>... | put-branches <repo> <branch>=<commit>... | find | inspect <path> | clone <url|owner/name> --to <dest> [--github [--account <login>]] --id <id> | init <dest> [--here] --id <id> | github | warm
       brigadier accounts [add <agent> [--name N] [--cols N] [--rows N] | remove <id> | use <agent> <id> | rename <agent> <id> <name>]
       brigadier switching [--agent A --auto on|off] [--agents on|off]
       brigadier switch <id> [--account A] [--auto] | rebirth <id> [--go-on] | reconnect <id> [--now]";

fn flag<'a>(args: &'a [String], name: &str) -> Option<&'a str> {
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1))
        .map(String::as_str)
}

/// A message's `--parts`: the composer's draft as its JSON, chips and files; Null for plain text [D109].
/// Opens a file, folder or URL with its default app: `open` on macOS, `xdg-open` on Linux.
#[cfg(unix)]
pub(crate) fn open(target: impl AsRef<std::ffi::OsStr>) -> io::Result<std::process::ExitStatus> {
    let opener = if cfg!(target_os = "linux") {
        "xdg-open"
    } else {
        "open"
    };
    std::process::Command::new(opener).arg(target).status()
}

/// Shows a file or folder in the file manager, selected in its folder.
/// shortcut: Linux opens the folder it's in without selecting it; use the file manager's D-Bus
/// ShowItems if users miss it.
#[cfg(unix)]
pub(crate) fn reveal(path: impl AsRef<Path>) -> io::Result<std::process::ExitStatus> {
    let path = path.as_ref();
    if cfg!(target_os = "linux") {
        return open(path.parent().unwrap_or(path));
    }
    std::process::Command::new("open")
        .arg("-R")
        .arg(path)
        .status()
}

/// Opens it with its default app, through the shell as Explorer does.
#[cfg(windows)]
pub(crate) fn open(target: impl AsRef<std::ffi::OsStr>) -> io::Result<std::process::ExitStatus> {
    shell_open(target.as_ref(), None)
}

/// Explorer, its folder open and it selected.
#[cfg(windows)]
pub(crate) fn reveal(path: impl AsRef<Path>) -> io::Result<std::process::ExitStatus> {
    let select = format!("/select,\"{}\"", path.as_ref().display());
    shell_open("explorer.exe".as_ref(), Some(select.as_ref()))
}

#[cfg(windows)]
fn shell_open(
    file: &std::ffi::OsStr,
    args: Option<&std::ffi::OsStr>,
) -> io::Result<std::process::ExitStatus> {
    use brigadier_frames::win::wide;
    use std::os::windows::process::ExitStatusExt;
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    let (verb, file, args) = (wide("open"), wide(file), args.map(wide));
    let args = args.as_ref().map_or(std::ptr::null(), |a| a.as_ptr());
    let null = std::ptr::null();
    // SW_SHOWNORMAL; above 32 is success.
    let done = unsafe { ShellExecuteW(std::ptr::null_mut(), verb.as_ptr(), file.as_ptr(), args, null, 1) };
    Ok(std::process::ExitStatus::from_raw(u32::from(done as isize <= 32)))
}

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
    let live = fold::live(&f.fold, owner::state(data, id), &dir, all);
    let mut s = fold::status(&f.fold, &live);
    s["id"] = id.into();
    Ok(s)
}

pub use attach::slot::forget_device;
pub use out::heard;
use start::start;
pub use switching::{switch_settings, wants};

/// Home's unsent words have no session to live in; this can't be a session id.
const HOME_DRAFT: &str = "@home";

pub fn run(data: &Path, args: &[String]) -> io::Result<Value> {
    let cmd = args.first().map(String::as_str).unwrap_or("");
    // Every session id this command names, checked before any path is built from it [D706].
    let ids = match cmd {
        "status" | "up" | "archive" => &args[1..],
        "index" | "awake" | "settings" | "agents" | "setup" | "profile" | "projects" | "forges"
        | "accounts" | "switching" | "models" | "title" | "feedback" | "git" | "source"
        | "panel" | "routing" | "plugins" | "browser" | "computer" | "terminal" | "storage" => {
            &[][..]
        }
        _ => &args[1.min(args.len())..2.min(args.len())],
    };
    let home = matches!(cmd, "draft" | "tabs" | "attach" | "note" | "commands");
    // `host @`: the Code Review page, which names no folder [D159].
    let page = cmd == "host" && args.get(1).is_some_and(|a| a == core::host::REVIEW);
    let checked = |a: &&String| {
        *a != "--all"
            && !(cmd == "archive" && (*a == "--check" || a.starts_with("--named=")))
            && !(home && *a == HOME_DRAFT)
            && !page
    };
    for id in ids.iter().filter(checked) {
        let bare = id
            .strip_prefix("@home:")
            .filter(|_| matches!(cmd, "tabs" | "draft"));
        core::check_id(bare.unwrap_or(id))?;
    }
    // A paired device's own draft and files, its slot named last, by the daemon alone [D51].
    if let [rest @ .., slot, device] = args
        && slot == "--slot"
    {
        return attach::slot::run(data, rest, device);
    }
    match cmd {
        // A new chat from Home's draft (`--home`) is kept in its book until it settles [C65].
        "start" => match attach::book::opt(args, "--home") {
            Some(key) if key == HOME_DRAFT || key.starts_with("@home:") => {
                attach::book::going(&attach::place(data, key, None)?, args, |a| start(data, a))
            }
            Some(_) => Err(io::Error::other(USAGE)),
            None => start(data, args),
        },
        "send" => {
            let dir = core::session_dir(data, arg(args, 1)?);
            attach::book::going(&attach::book::Place::Session(dir, None), args, |a| {
                send(data, a)
            })
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
        "label" => labels::run(data, args),
        "draft" if matches!(arg(args, 2), Ok("retry" | "adopt" | "drop")) => {
            let place = attach::place(data, arg(args, 1)?, None)?;
            attach::book::ops(&place, args, |a| match a[0].as_str() {
                "send" => send(data, a),
                "start" => start(data, a),
                _ => queue::run(data, a),
            })
        }
        "draft" => attach::kept(data, args, None),
        "attach" | "note" => attach::run(data, args, None),
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
                if !heard(writeln!(stdout, "{s}"))? {
                    break;
                }
            }
            Ok(Value::Null)
        }
        "stop" => queue::stop(data, arg(args, 1)?, "user", None)
            .inspect(|_| workers::still(data, &args[1])),
        "workers" => workers::run(data, args),
        "peers" => peers::run(data, args),
        "rewind" => rewind::run(data, args),
        "fork" => fork::run(data, args),
        "side" => side::run(data, args),
        "tabs" | "terminal" | "shell" => tabs::run(data, args),
        "browser" => browser::run(data, args),
        "computer" => computer::run(data, args),
        "chips" => chips::run(data, args),
        "queue" if args.get(2).is_some_and(|a| a == "add") => {
            let dir = core::session_dir(data, arg(args, 1)?);
            attach::book::going(&attach::book::Place::Session(dir, None), args, |a| {
                queue::run(data, a)
            })
        }
        "queue" => queue::run(data, args),
        "recover" => {
            let id = arg(args, 1)?;
            let reply = queue::recover(data, id, false)?;
            // Its agent's reply to what it sent is waited for here, with no lock held [D66].
            let cid = reply["cid"].as_str().unwrap_or("").to_string();
            Ok(core::applied(&core::session_dir(data, id), &cid, reply))
        }
        "archive" | "restore" | "delete" | "jobs" | "audit" => sessions::run(data, args),
        // The short title a first message gives its session, for the app's row before Rust's [D186].
        "feedback" => feedback::run(data, args),
        "title" => Ok(json!({"ok": true, "title": title::from(arg(args, 1)?)})),
        "level" => control::level(data, args),
        "overnight" => overnight::run(data, args),
        "answer" => control::answer(data, args),
        "up" => (args[1..].iter())
            .try_for_each(|id| owner::ensure(data, &core::load(data, id)?))
            .map(|()| json!({"ok": true})),
        "mockup" => relay::mockup::app(data, args),
        "owner" => Ok(
            json!({"pid": owner::pid(data, arg(args, 1)?), "state": format!("{:?}", owner::state(data, arg(args, 1)?))}),
        ),
        "read" => out::read(data, arg(args, 1)?, args),
        // (proposed) A diagnostic: the thread the app draws, from the same fold [D64, D65].
        "thread" => {
            let id = arg(args, 1)?;
            let spec = core::load(data, id)?;
            let mut saved = core::thread::Saved::default();
            // A visible setup marker guarantees SPAWNED is logged before this read starts.
            let setup = core::worktrees::setup_state(&spec.dir, true);
            saved.advance(&spec.dir, false)?;
            let mut thread = saved.thread;
            let f = thread.status_fold();
            let live = fold::live(f, owner::state(data, id), &spec.dir, &procs::all());
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
        "accounts" | "switching" | "switch" | "rebirth" | "reconnect" => accounts::run(data, args),
        "reset" => accounts::run(data, args),
        "awake" => settings::awake(data, args),
        "storage" => storage::run(data, args),
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

/// `send`: a message from the composer, at once or steered [D30, D54].
fn send(data: &Path, args: &[String]) -> io::Result<Value> {
    let (id, text, parts) = (arg(args, 1)?, arg(args, 2)?, parts(args)?);
    if has(args, "--steer") {
        // A worker's message from its parent's composer brings the parent's files [D3013].
        if let Some(from) = flag(args, "--from") {
            let dir = core::load(data, id).map_err(unsent)?.dir;
            core::message::take(data, &dir, &parts, Some(from)).map_err(unsent)?;
        }
        let cid = flag(args, "--cid").map_or_else(control::new_cid, String::from);
        let reply = control::steer_as(data, id, text, &parts, Some(&cid), "user", false)?;
        // A summary turn takes no steer: as a message, it waits in the queue [rev 3 §2.2].
        if reply["error"] != "busy" {
            // Its agent's reply is waited for here, with no lock held [D66].
            return Ok(core::applied(&core::session_dir(data, id), &cid, reply));
        }
    }
    let spec = core::load(data, id).map_err(unsent)?;
    core::message::take(data, &spec.dir, &parts, flag(args, "--from")).map_err(unsent)?;
    if !has(args, "--retry-of")
        && let Some(reply) = control::reply(data, id, text, &parts, flag(args, "--cid"), None)?
    {
        return Ok(reply);
    }
    owner::ensure(data, &spec).map_err(unsent)?;
    let cid = flag(args, "--cid").map_or_else(control::new_cid, String::from);
    // A held block queues ordinary messages; retries must keep their sender and id [D521].
    let reply = match workers::holding(data, id) {
        true => json!({"ok": false, "error": "busy: a turn is running"}),
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
    if has(args, "--retry-of") || reply["error"] != "busy: a turn is running" {
        return Ok(core::applied(&spec.dir, &cid, reply));
    }
    let mut queued = vec!["queue".into(), id.into(), "add".into(), text.into()];
    queued.extend(["--qid".into(), cid.clone()]);
    queued.extend(args.iter().skip_while(|a| *a != "--parts").take(2).cloned());
    queue::run(data, &queued)?;
    Ok(json!({"ok": true, "result": "queued", "cid": cid}))
}

/// Removes a file that may already be gone.
fn remove(path: &Path) -> io::Result<()> {
    match fs::remove_file(path) {
        Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e),
        _ => Ok(()),
    }
}
