//! `brigadier new`: an ordinary session of the user's, started by a lead's agent because the user
//! asked for one, fresh as New chat or forked as Fork. Recorded in its starter's folder before
//! anything is made, every step safe to run again under the same ids: the daemon's pass finishes
//! one a restart cut short, and a failed one takes its session away [D54]. Not a worker and no
//! link between them: the first message goes as a peer's, and only setup failures are reported here.

use super::refuse;
use crate::{control, models, owner, peers, queue, routing, side, title, workers};
use brigadier_core::{self as core, Spec, adapters, worktrees};
use brigadier_frames::log;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::{fs, io, thread};

/// The most a session starts between two of its user's messages.
const MOST: usize = 3;
/// The longest first message, as any between sessions.
const LONGEST: usize = 16 << 10;

#[derive(Serialize, Deserialize, Clone)]
struct Record {
    id: String,
    /// The first message's id.
    mid: String,
    at: u64,
    /// starting | started | failed
    state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    title: String,
    text: String,
    /// What was asked: a call that asks the same again is the same start.
    asked: Value,
    /// The `start` or `fork` that makes it, and the level it runs at.
    args: Vec<String>,
    level: Option<String>,
}

fn folder(data: &Path, me: &str) -> PathBuf {
    core::session_dir(data, me).join("begun")
}

fn records(data: &Path, me: &str) -> Vec<Record> {
    (fs::read_dir(folder(data, me)).into_iter().flatten())
        .flatten()
        .filter_map(|e| workers::read_json(&e.path()))
        .collect()
}

/// Saved only while its starter is there: a deleted one's folder never comes back.
fn save(data: &Path, me: &str, r: &Record) -> io::Result<()> {
    let dir = folder(data, me);
    fs::create_dir_all(&dir)?;
    workers::write_json(&dir.join(format!("{}.json", r.id)), r)
}

/// When the user last wrote or answered in the session; 0 when they never have.
fn told(dir: &Path) -> io::Result<u64> {
    let mut at = 0;
    core::read(dir, |i| {
        let words = matches!(
            i["control"]["kind"].as_str(),
            None | Some("answer" | "steer")
        );
        if i["kind"] == "input" && i["origin"] == "user" && words {
            at = at.max(i["ts"].as_u64().unwrap_or(0));
        }
    })?;
    Ok(at)
}

pub(super) fn new(
    data: &Path,
    me: &str,
    text: &str,
    value: &dyn Fn(&str) -> Option<String>,
    has: &dyn Fn(&str) -> bool,
) -> Value {
    start(data, me, text, value, has).unwrap_or_else(|e| e)
}

fn start(
    data: &Path,
    me: &str,
    text: &str,
    value: &dyn Fn(&str) -> Option<String>,
    has: &dyn Fn(&str) -> bool,
) -> Result<Value, Value> {
    let said = |e: io::Error| refuse(&e.to_string());
    if let Some(l) = workers::link(data, me) {
        let role = if l.review["of"].is_string() {
            "a reviewer"
        } else {
            "a worker"
        };
        return Err(refuse(&format!(
            "You're {role}. Only a lead session can use `brigadier new`."
        )));
    }
    if text.trim().is_empty() {
        return Err(refuse(
            "`brigadier new` needs the session's first message, in quotes.",
        ));
    }
    if text.len() > LONGEST {
        return Err(refuse(
            "Keep the message under 16 KB. Point to a file for more.",
        ));
    }
    let (fork, branch) = (has("--fork"), has("--branch"));
    if fork && branch {
        return Err(refuse("A fork already has your files: leave out --branch."));
    }
    // A named model is picked as a worker's is, so a never-checked instance checks first [C66].
    if (value("--model").is_some() || value("--effort").is_some())
        && let Ok(p) = core::load(data, me)
    {
        routing::check_unchecked(data, &p.cwd);
    }
    let family = workers::family_lock(data, me).map_err(said)?;
    if workers::closing(data, me) {
        return Err(refuse("This session is being deleted."));
    }
    let parent = core::load(data, me).map_err(said)?;
    if core::session::lifecycle(&parent.dir).0.is_some() {
        return Err(refuse("Restore this session before starting another."));
    }
    let f = core::fold(&parent.dir, true).map_err(said)?.fold;
    let since = told(&parent.dir).map_err(said)?;
    if since == 0 || f.turns.first().is_some_and(|turn| since < turn.ts) {
        return Err(refuse(
            "Ask the user in this chat before starting a session.",
        ));
    }
    settle(data, me).map_err(said)?;
    let asked = json!([
        text,
        fork,
        branch,
        value("--title"),
        value("--model"),
        value("--agent"),
        value("--effort")
    ]);
    let recent: Vec<Record> = (records(data, me).into_iter())
        .filter(|r| r.at > since && r.state != "failed")
        .collect();
    if let Some(r) = recent.iter().find(|r| r.asked == asked) {
        return Ok(
            json!({"ok": true, "id": r.id, "title": r.title, "fork": fork, "state": r.state, "text": format!("Already started {} ({}).", r.title, r.id)}),
        );
    }
    if recent.len() >= MOST {
        return Err(refuse(&format!(
            "Ask the user before starting more: you started {MOST} sessions since their last message, the most allowed."
        )));
    }
    let r = reserve(data, &parent, &f, text, value, fork, branch, asked)?;
    let ran = |name: &str| {
        (r.args.iter().position(|a| a == name)).and_then(|at| r.args.get(at + 1).cloned())
    };
    let how = match fork {
        true => "a fork of this conversation up to your last finished answer, so without this turn"
            .into(),
        false if parent.project.is_none() => "in a chat of its own".into(),
        false if core::folder::of(&parent).is_some() => "in a folder of its own".into(),
        false => match ran("--base") {
            Some(b) => format!("in its own worktree off {b}"),
            None => "in its own worktree off the project folder's current branch".to_string(),
        },
    };
    let mut reply = format!(
        "Starting session {} ({}), {how}. Tell the user it's starting and where to find it. It works and answers in its own chat. Brigadier will tell you here if setup fails.",
        r.title, r.id
    );
    let dirty = || workers::git(&parent.cwd, &["status", "--porcelain"]);
    if branch && dirty().is_some_and(|s| !s.is_empty()) {
        reply += " Your uncommitted edits aren't in its worktree.";
    }
    save(data, me, &r).map_err(said)?;
    let intent = json!({"event": "side", "phase": "intent", "session": r.id, "title": r.title});
    let _ = owner::call(data, me, json!({"op": "note", "data": intent}));
    let reply = json!({"ok": true, "id": r.id, "title": r.title, "fork": fork, "state": "starting", "text": reply});
    let (data, me) = (data.to_path_buf(), me.to_string());
    thread::spawn(move || {
        let _family = family;
        if let Err(e) = finish(&data, &me, r) {
            eprintln!("brigadierd: a session {me} started: {e}");
        }
    });
    Ok(reply)
}

/// Works out the whole start, checked as every launch is, so its making has nothing to decide.
#[allow(clippy::too_many_arguments)]
fn reserve(
    data: &Path,
    parent: &Spec,
    f: &core::fold::Fold,
    text: &str,
    value: &dyn Fn(&str) -> Option<String>,
    fork: bool,
    branch: bool,
    asked: Value,
) -> Result<Record, Value> {
    let said = |e: io::Error| refuse(&e.to_string());
    let me = &parent.id;
    // The caller's own agent, model and effort; a named one as `start --model` takes it.
    let mut run = side::next_run(parent, f);
    let (model, effort) = (value("--model"), value("--effort"));
    let named = model.is_some() || effort.is_some();
    if value("--agent").is_some() && model.is_none() {
        return Err(refuse(
            "--agent needs --model. `brigadier models` lists them.",
        ));
    }
    if named {
        let Some(m) = model.or(run.model.clone()) else {
            return Err(refuse("--effort needs --model here."));
        };
        let want = |k: &str| match k {
            "--model" => Some(m.clone()),
            "--agent" => value(k),
            "--effort" => value(k).or_else(|| run.effort.clone()),
            _ => None,
        };
        let p = routing::resolve(data, me, parent, f, &want, "", None)?;
        (run.backend, run.model, run.effort, run.fast) = (p.agent, p.model, p.effort, false);
    }
    run.rules = Some(routing::launch);
    run = run.ruled(&run.backend).map_err(|e| refuse(&e))?;
    // Its level is the caller's, never looser; an untrusted project's is Ask [D166].
    let held = models::held(data, parent.project.as_deref());
    let level = |spec: &Spec, backend: &str| match adapters::get(backend) {
        Some(a) => core::level(spec, a, held).map_err(|e| refuse(&e)),
        None => Err(refuse(&format!("{backend:?} isn't an agent."))),
    };
    let mut at_level = parent.clone();
    // A night's Full access is its own session's alone.
    at_level.level = core::overnight::own_level(&parent.dir, &parent.level);
    at_level.level = level(&at_level, models::next_agent(parent, f))?.map(String::from);
    let level = level(&at_level, &run.backend)?.map(String::from);

    let id = loop {
        let id = format!("s-{}", &adapters::uuid()[..8]);
        if !core::session_dir(data, &id).exists() {
            break id;
        }
    };
    let given = value("--title")
        .map(|t| title::clean(&t).map_err(|e| refuse(&e)))
        .transpose()?;
    let mut title = given.clone().unwrap_or_else(|| title::from(text));
    let args = match fork {
        true => {
            let offer = crate::run(data, &["fork", me, "--latest"].map(String::from));
            let offer = offer.map_err(said)?;
            if offer["ok"] != true {
                let why = match offer["error"].as_str() {
                    Some("none") => {
                        "there's no finished answer to fork from yet, and the turn you're in can't be forked"
                    }
                    _ => offer["message"].as_str().unwrap_or("it can't be forked"),
                };
                return Err(refuse(&format!(
                    "Couldn't fork: {}. `brigadier new` without --fork starts a fresh session.",
                    why.trim_end_matches('.')
                )));
            }
            if given.is_none() {
                title = format!("Fork of {}", core::share::title(parent));
            }
            let at = offer["at"].as_str().unwrap_or("");
            let mut args = vec![
                "fork".into(),
                me.into(),
                id.clone(),
                "--at".into(),
                at.into(),
            ];
            if let Some(m) = run.model.clone() {
                args.extend(["--to".into(), run.backend.clone(), "--model".into(), m]);
                args.extend(
                    (run.effort.clone())
                        .into_iter()
                        .flat_map(|e| ["--effort".into(), e]),
                );
                args.extend(run.fast.then(|| "--fast".into()));
            }
            args
        }
        false => {
            let mut args = vec!["start".into(), id.clone()];
            let mut push = |k: &str, v: Option<String>| {
                args.extend(v.into_iter().flat_map(|v| [k.to_string(), v]));
            };
            push("--backend", Some(run.backend.clone()));
            push("--project", parent.project.clone());
            push("--model", run.model.clone());
            push("--effort", run.effort.clone());
            push("--level", level.clone());
            if branch {
                let on = workers::git(&parent.cwd, &["symbolic-ref", "--quiet", "--short", "HEAD"])
                    .filter(|_| parent.project.is_some())
                    .ok_or_else(|| refuse("This session has no branch to build on."))?;
                push("--base", Some(on));
            }
            args.extend(run.fast.then(|| "--fast".into()));
            args.extend(parent.project.is_none().then(|| "--scratch".into()));
            args
        }
    };
    Ok(Record {
        id,
        mid: control::new_cid(),
        at: log::now_ms(),
        state: "starting".into(),
        error: None,
        title,
        text: text.into(),
        asked,
        args,
        level,
    })
}

/// Makes a recorded start, then settles it: its row in the starter's thread, or on a failure
/// nothing left of it. One whose message is on its way was made.
fn finish(data: &Path, me: &str, mut r: Record) -> io::Result<()> {
    let dir = core::session_dir(data, &r.id);
    // A failure already recorded is only cleaned up and reported after a restart.
    if r.error.is_none()
        && let Err(e) = make(data, me, &r, &dir)
    {
        r.error = Some(e.to_string());
        save(data, me, &r)?;
    }
    if r.error.is_some() {
        if dir.join("session.json").exists() {
            let reply =
                crate::sessions::delete(data, &r.id, &core::session::Chosen::All(true), "delete")?;
            if reply["ok"] != true {
                return Err(io::Error::other(reply.to_string()));
            }
        } else if dir.exists() {
            fs::remove_dir_all(&dir)?;
        }
    }
    let src = core::load(data, me)?;
    let mut note = json!({"event": "side", "phase": "done", "session": r.id, "ok": r.error.is_none(),
        "base": worktrees::base(&dir), "title": r.title, "error": r.error});
    if r.error.is_some() {
        note["text"] = json!(r.text);
    }
    owner::ensure(data, &src)?;
    owner::call(data, me, json!({"op": "note", "data": note}))?;
    if let Some(error) = &r.error {
        let text = format!(
            "[Brigadier] Couldn't start session {} ({}): {error}. The user can put its first message back from the failed start row.",
            r.title, r.id
        );
        queue::add_peer(
            &src.dir,
            &format!("{}-failed", r.mid),
            "system",
            &text,
            || Ok(None),
        )?;
    }
    r.state = if r.error.is_none() {
        "started"
    } else {
        "failed"
    }
    .into();
    save(data, me, &r)?;
    r.error.map_or(Ok(()), |e| Err(io::Error::other(e)))
}

fn make(data: &Path, me: &str, r: &Record, dir: &Path) -> io::Result<()> {
    if queue::pending(dir, &r.mid)
        || core::fold(dir, true).is_ok_and(|f| f.fold.cids.contains_key(&r.mid))
    {
        return Ok(());
    }
    let fork = r.args[0] == "fork";
    if !fork {
        // Its name before its row shows.
        fs::create_dir_all(dir)?;
        core::write_atomic(&dir.join("title"), r.title.as_bytes())?;
    }
    let run = || match fork {
        true => crate::fork::run_named(data, &r.args, Some(&r.title)),
        false => crate::run(data, &r.args),
    };
    let mut reply = run()?;
    // A fork cut short finishes or rolls back first, then this makes it [D54].
    if matches!(reply["error"].as_str(), Some("uncertain" | "unfinished")) {
        reply = run()?;
    }
    if reply["ok"] != true {
        let why = reply["message"].as_str().or(reply["error"].as_str());
        return Err(io::Error::other(why.unwrap_or("refused").to_string()));
    }
    // Fork drops Full access; this one is at its starter's level.
    if let Some(level) = r.level.as_ref().filter(|_| fork) {
        crate::run(data, &["level".into(), r.id.clone(), level.clone()])?;
    }
    peers::begin(data, me, dir, &r.mid, &r.text)
}

/// Settles a start cut short, while the caller holds the source's family lock.
pub(crate) fn settle(data: &Path, me: &str) -> io::Result<()> {
    for r in records(data, me)
        .into_iter()
        .filter(|r| r.state == "starting")
    {
        let p = folder(data, me).join(format!("{}.json", r.id));
        if let Err(e) = finish(data, me, r)
            && workers::read_json::<Record>(&p).is_some_and(|r| r.state == "starting")
        {
            return Err(e);
        }
    }
    Ok(())
}

pub(crate) fn resume(data: &Path, me: &str) {
    if !records(data, me).iter().any(|r| r.state == "starting") {
        return;
    }
    let (data, me) = (data.to_path_buf(), me.to_string());
    thread::spawn(move || {
        let lock = core::session_dir(&data, &me).join("family.lock");
        let Ok(Some(_family)) = brigadier_frames::take_lock(&lock) else {
            return;
        };
        if let Err(e) = settle(&data, &me) {
            eprintln!("brigadierd: a session {me} started: {e}");
        }
    });
}
