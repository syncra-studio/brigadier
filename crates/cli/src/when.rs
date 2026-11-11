//! `source <id> when <ask|merge|pr|pushPr|cancel>`: "When it's done", set per session and off
//! unless picked [D1201, D1206, D1212]. Brigadier's own step lands the work once every gate holds:
//! the turn ended, the last test or build run passed after the last change, and the step merges
//! cleanly; a countdown with Cancel comes first [D1201, D1206]. Never in your own folder [D1201].
//!
//! When a passing run is seen, the folder is captured as the commit would take it, and kept only
//! if nothing in it is newer than the run's start, so the capture is what the run tested. Before
//! acting the capture is handed to the landing, which refuses anything else [D1213]. The daemon's
//! loop only schedules this, one attempt per session at a time, in the background [D30].

use super::first;
use brigadier_core::fold::{Fold, runs};
use brigadier_core::git::{self, Target, commit, step};
use brigadier_core::{fold, session_dir, write_atomic};
use brigadier_frames::log::now_ms;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
use std::os::unix::fs::MetadataExt;
use std::path::Path;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::time::{Duration, Instant};
use std::{fs, io, thread};

const FILE: &str = "when.json";
/// The countdown before a rule lands (proposed) [D1201, D1206].
const WAIT_MS: u64 = 10_000;
/// How often a ruled session is looked at again, for a PR's checks or a base that moved.
const EVERY: Duration = Duration::from_secs(1);
const RULES: [&str; 3] = ["merge", "pr", "pushPr"];

#[derive(Serialize, Deserialize, Default, Clone)]
struct When {
    rule: String,
    /// When it was picked (ms): a pick after the turn ended counts down from the pick.
    set: u64,
    #[serde(default)]
    proof: Option<Proof>,
    #[serde(default)]
    done: Option<Done>,
}

/// The folder as the last passing run tested it: `tree` as a commit of every change would hold
/// it, none when something in the folder changed during or after the run [D1213].
#[derive(Serialize, Deserialize, Clone)]
struct Proof {
    run: u64,
    tree: Option<String>,
}

/// The turn (its end, ms) the rule already acted on: `why` none when it landed, else `cancelled`,
/// `writer`, `prText` or the landing's refusal. It never acts twice on one turn.
#[derive(Serialize, Deserialize, Clone)]
struct Done {
    turn: u64,
    why: Option<String>,
}

/// Sessions with a rule, read from their folders once; a pick adds one, `ask` or a gone folder
/// takes it out.
static RULED: Mutex<Option<BTreeSet<String>>> = Mutex::new(None);
/// When each was last looked at, and those with a look or a landing under way.
static SEEN: Mutex<BTreeMap<String, Instant>> = Mutex::new(BTreeMap::new());
static BUSY: Mutex<BTreeSet<String>> = Mutex::new(BTreeSet::new());
static ACTING: Mutex<BTreeSet<String>> = Mutex::new(BTreeSet::new());
/// Every read-then-write of a rule's file in this process.
static FILES: Mutex<()> = Mutex::new(());

fn read(dir: &Path) -> Option<When> {
    let when: When = serde_json::from_slice(&fs::read(dir.join(FILE)).ok()?).ok()?;
    RULES.contains(&when.rule.as_str()).then_some(when)
}

fn save(dir: &Path, when: &When) -> io::Result<()> {
    write_atomic(&dir.join(FILE), &serde_json::to_vec(when)?)
}

fn fold_of(dir: &Path) -> io::Result<Fold> {
    Ok(fold(dir, true)?.fold)
}

pub(super) fn set(data: &Path, id: &str, word: &str) -> io::Result<Value> {
    let dir = session_dir(data, id);
    let _files = FILES.lock().unwrap();
    match word {
        "ask" => {
            let _ = fs::remove_file(dir.join(FILE));
            (RULED.lock().unwrap().as_mut()).map(|all| all.remove(id));
        }
        "cancel" => {
            let mut when = read(&dir).ok_or_else(|| io::Error::other("Nothing to cancel."))?;
            if ACTING.lock().unwrap().contains(id) {
                return Err(io::Error::other("It's landing already."));
            }
            let turn = fold_of(&dir)?.finished;
            when.done = Some(Done {
                turn,
                why: Some("cancelled".into()),
            });
            save(&dir, &when)?;
        }
        rule if RULES.contains(&rule) => {
            if !git::checkout(data, &Target::Session(id))?.worktree {
                return Err(io::Error::other("Never in your own folder."));
            }
            let proof = read(&dir).and_then(|w| w.proof);
            let when = When {
                rule: rule.into(),
                set: now_ms(),
                proof,
                done: None,
            };
            save(&dir, &when)?;
            (RULED.lock().unwrap().get_or_insert_default()).insert(id.into());
        }
        _ => return Err(io::Error::other(super::USAGE)),
    }
    Ok(json!({"ok": true}))
}

/// One test or build command, plainly: a failure can't hide behind `;`, `||`, a pipe, a background
/// `&` or a substitution. An `&&` chain of `cd` and test or build commands fails as a whole, so it
/// counts [D74, D1192, D1201] (proposed).
fn plain(line: &str) -> bool {
    let line = line.replace("2>&1", "");
    if line.contains([';', '|', '\n', '`', '(', ')']) {
        return false;
    }
    let parts: Vec<&str> = line.split("&&").map(str::trim).collect();
    let test = |part: &&str| runs::tests_or_builds(part);
    !parts.iter().any(|p| p.is_empty() || p.contains('&'))
        && parts.iter().all(|p| p.starts_with("cd ") || test(p))
        && parts.iter().any(test)
}

/// The gate that holds the rule back, or none [D1201, D1206]. `step`: Rust's step reply.
fn gate(when: &When, f: &Fold, read: &Value) -> Option<Value> {
    let Some(run) = f.runs.last.as_ref() else {
        return Some(json!({"why": "noRun"}));
    };
    if !plain(&run.command) {
        return Some(json!({"why": "compound", "command": run.command}));
    }
    match run.exit {
        None => return Some(json!({"why": "unreported"})),
        Some(0) => {}
        Some(exit) => return Some(json!({"why": "exit", "exit": exit})),
    }
    if !run.after.is_empty() {
        return Some(json!({"why": "changed"}));
    }
    match when.proof.as_ref().filter(|p| p.run == run.at) {
        None => return Some(json!({"why": "checking"})),
        Some(Proof { tree: None, .. }) => return Some(json!({"why": "changed"})),
        Some(_) => {}
    }
    let step = &read["step"];
    let fits = match when.rule.as_str() {
        "merge" => step["kind"] == "merge" && step["blocked"].is_null(),
        // A PR needs no local base: only conflicts or another session's landing hold it [D1177].
        "pr" => step["kind"] == "merge" && step["blocked"]["why"] != "shared",
        "pushPr" => step["kind"] == "pushPr",
        _ => false,
    };
    (!fits).then(|| json!({"why": "step"}))
}

/// What the step reply carries: the rule, and its countdown's end, why it waits, or that it lands
/// now; `ran`, the last run's end, so the brief is read again when only a run changed [D1199].
pub(super) fn attach(data: &Path, id: &str, reply: &mut Value) {
    let dir = session_dir(data, id);
    let Ok(f) = fold_of(&dir) else { return };
    reply["ran"] = f.runs.last.as_ref().map(|r| r.at).into();
    let Some(when) = read(&dir) else { return };
    reply["when"] = state(id, &when, &f, reply);
}

fn state(id: &str, when: &When, f: &Fold, read: &Value) -> Value {
    let mut out = json!({"rule": when.rule});
    if ACTING.lock().unwrap().contains(id) {
        out["acting"] = true.into();
    } else if !f.turns.is_empty() {
        out["working"] = true.into();
    } else if let Some(done) = when.done.as_ref().filter(|d| d.turn == f.finished) {
        out["done"] = done.why.clone().into();
    } else if let Some(why) = gate(when, f, read) {
        out["stopped"] = why;
    } else {
        out["at"] = (f.finished.max(when.set) + WAIT_MS).into();
    }
    out
}

/// From the daemon's loop: each ruled session looked at again in the background, at most one at a
/// time per session and once a second [D30].
pub fn tick(data: &Path, rows: &BTreeMap<String, Value>) {
    let ruled: Vec<String> = {
        let mut ruled = RULED.lock().unwrap();
        let all = ruled.get_or_insert_with(|| {
            (rows.keys())
                .filter(|id| session_dir(data, id).join(FILE).exists())
                .cloned()
                .collect()
        });
        all.retain(|id| rows.contains_key(id));
        all.iter().cloned().collect()
    };
    for id in ruled {
        let row = &rows[&id];
        if row["archived"].as_u64().is_some() {
            continue;
        }
        let due = SEEN
            .lock()
            .unwrap()
            .get(&id)
            .is_none_or(|at| at.elapsed() >= EVERY);
        if !due || !BUSY.lock().unwrap().insert(id.clone()) {
            continue;
        }
        SEEN.lock().unwrap().insert(id.clone(), Instant::now());
        let data = data.to_path_buf();
        thread::spawn(move || {
            unsafe { libc::pthread_set_qos_class_self_np(libc::qos_class_t::QOS_CLASS_UTILITY, 0) };
            if let Err(e) = advance(&data, &id) {
                eprintln!("when it's done: {id}: {e}");
            }
            BUSY.lock().unwrap().remove(&id);
        });
    }
}

fn advance(data: &Path, id: &str) -> io::Result<()> {
    let dir = session_dir(data, id);
    let Some(when) = read(&dir) else {
        (RULED.lock().unwrap().as_mut()).map(|all| all.remove(id));
        return Ok(());
    };
    if brigadier_core::session::closed(&dir).is_some() {
        return Ok(());
    }
    let f = fold_of(&dir)?;
    // A new passing run: the folder as it tested it, or none [D1213].
    if let Some(run) = (f.runs.last.as_ref())
        .filter(|r| r.exit == Some(0) && plain(&r.command) && r.after.is_empty())
        && when.proof.as_ref().is_none_or(|p| p.run != run.at)
    {
        let tree = prove(data, id, run.start).unwrap_or(None);
        let _files = FILES.lock().unwrap();
        if let Some(mut now) = read(&dir) {
            now.proof = Some(Proof { run: run.at, tree });
            save(&dir, &now)?;
        }
        return Ok(());
    }
    if !f.turns.is_empty() || when.done.as_ref().is_some_and(|d| d.turn == f.finished) {
        return Ok(());
    }
    let never = AtomicBool::new(false);
    let mut read_now = step::step(data, &Target::Session(id), false, &never)?;
    read_now = json!({"step": read_now["step"], "at": read_now["at"], "merge": read_now["merge"]});
    let shown = state(id, &when, &f, &read_now);
    if shown["at"].as_u64().is_none_or(|at| now_ms() < at) {
        return Ok(());
    }
    // A Cancel or a new pick that came meanwhile wins; then this session is landing [D1201].
    {
        let _files = FILES.lock().unwrap();
        match read(&dir) {
            Some(now)
                if now.set == when.set
                    && now.done.as_ref().is_none_or(|d| d.turn != f.finished) => {}
            _ => return Ok(()),
        }
        ACTING.lock().unwrap().insert(id.into());
    }
    let tree = (when.proof.as_ref())
        .and_then(|p| p.tree.clone())
        .unwrap_or_default();
    let why = match act(data, id, &when.rule, &tree, &read_now) {
        Ok(()) => None,
        Err(e) => Some(e.to_string()),
    };
    let _files = FILES.lock().unwrap();
    ACTING.lock().unwrap().remove(id);
    if let Some(mut now) = read(&dir) {
        now.done = Some(Done {
            turn: f.finished,
            why,
        });
        save(&dir, &now)?;
    }
    Ok(())
}

/// The folder's tree as a commit of every change would hold it, kept only when nothing listed in
/// it, nor any folder holding it, changed since the run began: then it's what the run tested.
fn prove(data: &Path, id: &str, start: u64) -> io::Result<Option<String>> {
    let checkout = git::checkout(data, &Target::Session(id))?;
    let never = AtomicBool::new(false);
    let tree = commit::tree(&checkout, true, &never)?;
    let listed = git::files::listed(&checkout, &never)?;
    let mut folders = BTreeSet::from([checkout.root.clone()]);
    for path in &listed {
        let path = checkout.root.join(path);
        folders.extend(
            path.ancestors()
                .skip(1)
                .take_while(|p| p.starts_with(&checkout.root))
                .map(Path::to_path_buf),
        );
        if fs::symlink_metadata(&path).is_ok_and(|m| newer(&m, start)) {
            return Ok(None);
        }
    }
    let changed =
        (folders.iter()).any(|dir| fs::symlink_metadata(dir).is_ok_and(|m| newer(&m, start)));
    Ok((!changed).then_some(tree))
}

fn newer(meta: &fs::Metadata, start: u64) -> bool {
    let ms = meta.mtime() as u64 * 1000 + meta.mtime_nsec() as u64 / 1_000_000;
    // The run's start is logged as its command begins: a write in that same millisecond came first.
    ms > start
}

/// Brigadier's own step, the one button's, handed the proved tree: it commits every change first
/// only when the branch doesn't already hold it, and refuses anything else [D1201, D1203, D1213].
fn act(data: &Path, id: &str, rule: &str, tree: &str, read: &Value) -> io::Result<()> {
    let target = Target::Session(id);
    let checkout = git::checkout(data, &target)?;
    let at = &read["at"];
    let head = at["head"].as_str().unwrap_or_default();
    let base = at["base"].as_str().unwrap_or("-");
    let verb = match rule {
        "merge" if read["merge"] == "squash" => "squash",
        "merge" => "merge",
        "pr" => "pr",
        _ => "push",
    };
    let mut args: Vec<String> = ["source", id, "first", verb, head, base, "--tree", tree]
        .map(String::from)
        .to_vec();
    // The writers write what the button's own dialogs would show; one that can't stops it and the
    // user goes on by hand: no fallback text goes out unseen [D1029, D1212, D1222].
    let written = |what: &str| -> io::Result<String> {
        let reply = super::commit::write(data, &target, &checkout, what, false)?;
        match reply["text"].as_str() {
            Some(text) if reply["ok"] == true && !text.trim().is_empty() => Ok(text.trim().into()),
            _ => Err(io::Error::other(if what == "pr" {
                "prText"
            } else {
                "writer"
            })),
        }
    };
    match verb {
        "squash" => args.extend(["--message".into(), written("squash")?]),
        "pr" => {
            let text = written("pr")?;
            let (title, body) = text.split_once('\n').unwrap_or((&text, ""));
            args.extend([
                "--title".into(),
                title.trim().into(),
                "--body".into(),
                body.trim().into(),
            ]);
        }
        _ => {}
    }
    let reply = first::run(data, &target, &checkout, &args, 2)?;
    match reply["ok"] == true {
        true => Ok(()),
        false if reply["writer"] == true => Err(io::Error::other("writer")),
        false => Err(io::Error::other(
            reply["error"].as_str().unwrap_or("Look again.").to_string(),
        )),
    }
}
