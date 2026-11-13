//! A worker's start [D3000, D3001, D3007, D2040]: checked against its family's depth and count,
//! reserved under the family's lock, answered at once, then made off the caller's turn, each
//! step safe to run again under the same ids after a restart [D54].

use super::{
    Link, Record, below, closing, family_lock, git, place, record, refuse, result, save, setting,
    write_json,
};
use crate::{accounts, control, models, owner, settings, title};
use brigadier_core::{self as core, Spec, adapters, projects};
use brigadier_frames::log;
use serde_json::{Value, json};
use std::collections::HashSet;
use std::fs;
use std::io;
use std::path::Path;
use std::sync::Mutex;
use std::thread;

/// Starts in this daemon now, so its pass never makes one twice at once.
static MAKING: Mutex<Option<HashSet<String>>> = Mutex::new(None);

/// Proposed: the line every worker gets after its brief [D3000, D3023].
/// `merge`: the parent's folder, the worker's branch and the parent's branch, for one with a
/// worktree, which merges itself back [D89, D97].
fn fixed_line(parent: &str, pid: &str, merge: Option<(&str, &str, &str)>) -> String {
    let land = match merge {
        Some((to, branch, base)) => format!(
            "When your work is done and right, commit it on your branch and merge it into {base}: `git -C {to} merge --no-edit {branch}`. If that conflicts, run `git -C {to} merge --abort` at once, rebase your branch onto {base}, resolve there, then merge again; never leave {to} mid-merge, and never touch its uncommitted changes. If it can't merge, say why."
        ),
        None => "Commit your work on your branch and don't merge it.".into(),
    };
    format!(
        "You're a worker for {parent} ({pid}). When you end your turn, your last message goes back to it by itself, so end with what you did and found. To ask it something, `brigadier send {pid} \"<question>\"` and wait for its answer there; don't end your turn on a question. {land} `brigadier read {pid} --user` has the user's own words. Your CLI loads no skills or MCP servers of its own: `brigadier skill`, `brigadier mcp` and `brigadier search` (past sessions) bring what you need."
    )
}

/// The agent, model and effort a worker runs: the parent's own where none is named, else what
/// the user allows in Rust's catalog [D2040, D3030]. Never the app path's `fake` default.
fn pick(
    data: &Path,
    me: &str,
    parent: &Spec,
    f: &core::fold::Fold,
    flags: &dyn Fn(&str) -> Option<String>,
) -> Result<(String, Option<String>, Option<String>), Value> {
    let now = models::next_agent(parent, f).to_string();
    let run = core::as_run(parent, f, &now, None);
    let (agent, model, effort) = (flags("--agent"), flags("--model"), flags("--effort"));
    let agent = agent.unwrap_or_else(|| now.clone());
    if agent == now && model.is_none() {
        return Ok((agent, run.model, effort.or(run.effort)));
    }
    let args = ["models", "--session", me].map(String::from);
    let groups = models::run(data, &args).map_err(|e| refuse(&e.to_string()))?;
    let group = (groups["groups"].as_array().into_iter().flatten())
        .find(|g| g["provider"] == agent.as_str() && g["unavailable"].is_null());
    let Some(group) = group else {
        return Err(refuse(&format!(
            "{agent:?} isn't an agent you may use. `brigadier models` lists them."
        )));
    };
    let Some(model) = model else {
        return match effort {
            Some(_) => Err(refuse("--effort needs --model for another agent.")),
            None => Ok((agent, None, None)),
        };
    };
    let found =
        (group["models"].as_array().into_iter().flatten()).find(|m| m["id"] == model.as_str());
    let Some(found) = found else {
        return Err(refuse(&format!(
            "{model:?} isn't a model of {agent} you may use. `brigadier models` lists them."
        )));
    };
    if let Some(e) = &effort
        && !(found["efforts"].as_array().into_iter().flatten()).any(|x| x == e.as_str())
    {
        return Err(refuse(&format!(
            "{model} has no effort {e:?}. `brigadier models` lists its efforts."
        )));
    }
    Ok((agent, Some(model), effort))
}

/// How deep workers may start workers of their own; a worker at this depth can't [D2026, D3038].
const DEEPEST: u64 = 4;

/// `brigadier start "<brief>" [--agent A] [--model M] [--effort E] [--title T]`, for session `me`'s
/// agent: reserves the worker under its family's lock and answers at once [D3000]; the worker is
/// made and launched off this call. `running`: whether a session's turn runs now.
pub fn start(
    data: &Path,
    me: &str,
    brief: &str,
    flags: &dyn Fn(&str) -> Option<String>,
    running: &dyn Fn(&str) -> bool,
) -> Value {
    let (root, depth) = place(data, me);
    if depth >= DEEPEST {
        return refuse(&format!(
            "You're a worker at depth {depth}, the deepest allowed, so you can't start workers. Do it yourself, or use your own subagents."
        ));
    }
    if brief.trim().is_empty() {
        return refuse("`brigadier start` needs a brief: what to do, in quotes.");
    }
    let Ok(parent) = core::load(data, me) else {
        return refuse("Your session can't be read.");
    };
    let f = match core::fold(&parent.dir, true) {
        Ok(f) => f.fold,
        Err(e) => return refuse(&e.to_string()),
    };
    let (backend, model, effort) = match pick(data, me, &parent, &f, flags) {
        Ok(p) => p,
        Err(e) => return e,
    };
    let Some(a) = adapters::get(&backend) else {
        return refuse(&format!("{backend:?} isn't an agent."));
    };
    // The parent's account on its own agent; another agent's in use [D2040].
    let account = if backend == models::next_agent(&parent, &f) {
        f.accounts
            .get(&backend)
            .cloned()
            .or(parent.starts_on.clone())
    } else {
        let spec = Spec {
            backend: backend.clone(),
            ..Default::default()
        };
        accounts::starting(data, spec).starts_on
    }
    .filter(|a| !a.is_empty());
    // Ask and Auto carry over; Full access doesn't, as a session made from another [D205, O3000].
    let held = models::held(data, parent.project.as_deref());
    let level = (parent.level.as_deref())
        .filter(|l| *l != "full" && a.can().levels.contains(l))
        .or_else(|| models::default_level(a, held, &settings::get(data, "default_level")))
        .map(String::from);
    let project = parent
        .project
        .clone()
        .filter(|p| projects::get(data, p).is_ok());
    let base = project.as_ref().and_then(|_| {
        git(&parent.cwd, &["symbolic-ref", "--quiet", "--short", "HEAD"])
            .or_else(|| git(&parent.cwd, &["rev-parse", "--verify", "HEAD"]))
    });
    let dirty = base.is_some()
        && git(&parent.cwd, &["status", "--porcelain"]).is_some_and(|s| !s.is_empty());
    // Proposed: `--title` names it; else its brief does [D3029].
    let named = flags("--title").filter(|t| !t.trim().is_empty());
    let title = named.unwrap_or_else(|| title::from(brief));
    let asked =
        json!({"agent": flags("--agent"), "model": flags("--model"), "effort": flags("--effort")});
    let reserved = (|| -> Result<Record, Value> {
        let _family = family_lock(data, &root).map_err(|e| refuse(&e.to_string()))?;
        if closing(data, me) || !parent.dir.join("session.json").exists() {
            return Err(refuse(
                "This session is being deleted, so it starts no workers.",
            ));
        }
        let limit = setting(data, "workers", 6);
        let busy = (below(data, &root).iter())
            // Its own log, not only the row, which lags just after a launch.
            .filter(|r| {
                r.state == "starting"
                    || (r.state == "started" && (running(&r.wid) || super::busy(data, &r.wid)))
            })
            .count() as u64;
        if busy >= limit {
            return Err(refuse(&format!(
                "{} running in this family, the most allowed. Wait for one to finish (its result comes to you), then start this one.",
                if busy == 1 {
                    "1 worker is".into()
                } else {
                    format!("{busy} workers are")
                }
            )));
        }
        let wid = loop {
            let id = format!("w{}", &adapters::uuid()[..8]);
            if !core::session_dir(data, &id).exists() {
                break id;
            }
        };
        let r = Record {
            wid,
            cid: control::new_cid(),
            title: title.clone(),
            brief: brief.to_string(),
            at: log::now_ms(),
            depth: depth + 1,
            root: root.clone(),
            state: "starting".into(),
            error: None,
            asked,
            backend: backend.clone(),
            model: model.clone(),
            effort: effort.clone(),
            level,
            account,
            project,
            base: base.clone(),
        };
        save(data, me, &r).map_err(|e| refuse(&e.to_string()))?;
        Ok(r)
    })();
    let r = match reserved {
        Ok(r) => r,
        Err(e) => return e,
    };
    let note = json!({"event": "worker", "phase": "started", "id": r.wid, "title": r.title});
    let _ = owner::call(data, me, json!({"op": "note", "data": note}));
    begin(data, me, &r.wid);
    let ran = [Some(backend.as_str()), model.as_deref(), effort.as_deref()];
    let ran: Vec<&str> = ran.into_iter().flatten().collect();
    let place = match &base {
        Some(b) => format!("in its own worktree off {b}"),
        None => "in a folder of its own".into(),
    };
    let mut text = format!(
        "Started worker {} ({}) on {}, {place}. Its result comes to you by itself when it finishes, so end your turn; `brigadier wait {}` only if you need it now.",
        r.title,
        r.wid,
        ran.join(" · "),
        r.wid
    );
    if dirty {
        text +=
            " Your uncommitted edits aren't in its worktree; commit them first if it needs them.";
    }
    json!({"ok": true, "id": r.wid, "title": r.title, "agent": backend, "model": model, "effort": effort,
        "base": base, "uncommitted": dirty, "text": text})
}

/// Makes a reserved worker off the caller's thread, once at a time in this daemon.
pub(super) fn begin(data: &Path, pid: &str, wid: &str) {
    {
        let mut making = MAKING.lock().unwrap();
        if !making
            .get_or_insert_with(HashSet::new)
            .insert(wid.to_string())
        {
            return;
        }
    }
    let (data, pid, wid) = (data.to_path_buf(), pid.to_string(), wid.to_string());
    thread::spawn(move || {
        if let Some(mut r) = record(&data, &pid, &wid).filter(|r| r.state == "starting") {
            let made = make(&data, &pid, &r);
            let _family = family_lock(&data, &r.root);
            // A stop while it was being made keeps its word: no result, never started.
            if record(&data, &pid, &wid).is_none_or(|now| now.state != "stopped") {
                match made {
                    Ok(()) => r.state = "started".into(),
                    Err(e) => {
                        r.state = "failed".into();
                        r.error = Some(e.to_string());
                    }
                }
                let _ = save(&data, &pid, &r);
                if r.state == "failed" {
                    result::failed(&data, &pid, &r);
                }
            } else if let Some(mut l) = super::link(&data, &wid).filter(|l| l.last.is_null()) {
                l.last = json!({"how": "stopped", "at": log::now_ms()});
                let _ = write_json(&core::session_dir(&data, &wid).join("worker.json"), &l);
            }
        }
        MAKING.lock().unwrap().as_mut().map(|m| m.remove(&wid));
    });
}

/// The making, every step safe to run again under the same ids after a restart: the session, its
/// link, its worktree off the parent's branch, its host, its start outcome, then its brief.
fn make(data: &Path, pid: &str, r: &Record) -> io::Result<()> {
    let parent = core::load(data, pid)?;
    if closing(data, pid) {
        return Err(io::Error::other("Its family is being deleted."));
    }
    let dir = core::session_dir(data, &r.wid);
    let cwd = match &r.project {
        Some(_) => core::worktrees::path(data, &r.wid),
        None => dir.join("scratch"),
    };
    let spec = match dir.join("session.json").exists() {
        true => core::load(data, &r.wid)?,
        false => core::create(
            data,
            &Spec {
                id: r.wid.clone(),
                backend: r.backend.clone(),
                mode: "pipe".into(),
                cwd: cwd.display().to_string(),
                project: r.project.clone(),
                model: r.model.clone(),
                level: r.level.clone(),
                effort: r.effort.clone(),
                created: log::now_ms(),
                starts_on: r.account.clone(),
                naked: true,
                ..Default::default()
            },
        )?,
    };
    let ran =
        json!({"agent": r.backend, "model": r.model, "effort": r.effort, "account": r.account});
    if !dir.join("worker.json").exists() {
        let l = Link {
            parent: pid.into(),
            root: r.root.clone(),
            depth: r.depth,
            title: r.title.clone(),
            brief: r.brief.clone(),
            at: r.at,
            report: vec![r.cid.clone()],
            ran: ran.clone(),
            last: Value::Null,
            paused: false,
        };
        write_json(&dir.join("worker.json"), &l)?;
        core::write_atomic(&dir.join("title"), r.title.as_bytes())?;
    }
    let mut branch = None;
    match &r.project {
        Some(p) => {
            let (_lock, all) = projects::locked(data)?;
            let project = all.into_iter().find(|x| &x.id == p);
            let project = project
                .filter(|x| !x.removing)
                .ok_or_else(|| io::Error::other("Its project is gone or being removed."))?;
            core::worktrees::ensure(&spec, &project, false, r.base.as_deref(), &r.title)?;
            branch = core::worktrees::branch(&dir)?;
        }
        None => fs::create_dir_all(&cwd)?,
    }
    owner::ensure(data, &spec)?;
    if core::fold(&dir, true)?.fold.cids.contains_key(&r.cid) {
        return Ok(());
    }
    let outcome = json!({"event": "outcome", "phase": "start", "asked": r.asked, "ran": ran,
        "parent": pid, "depth": r.depth});
    owner::call(data, &r.wid, json!({"op": "note", "data": outcome}))?;
    let merge =
        (branch.as_deref().zip(r.base.as_deref())).map(|(b, base)| (parent.cwd.as_str(), b, base));
    let text = format!(
        "{}\n\n{}",
        r.brief.trim_end(),
        fixed_line(&core::share::title(&parent), pid, merge)
    );
    if record(data, pid, &r.wid).is_some_and(|now| now.state == "stopped") {
        return Err(io::Error::other("It was stopped before it started."));
    }
    let reply = say(data, &r.wid, &text, &r.cid)?;
    match reply["result"].as_str() {
        Some("delivered" | "logged") => Ok(()),
        _ => Err(io::Error::other(
            reply["message"]
                .as_str()
                .or(reply["error"].as_str())
                .unwrap_or("its brief wasn't taken")
                .to_string(),
        )),
    }
}

/// Every message text 4.3 sends goes through here, so wave 3's message payload changes it in one
/// place: a worker's brief, as the user's (`send`), and a result into its parent (`core::send`).
fn say(data: &Path, id: &str, text: &str, cid: &str) -> io::Result<Value> {
    crate::run(data, &["send", id, text, "--cid", cid].map(String::from))
}

/// The same for a result into its parent: under its own id, with the parent's idle guard in
/// `call`, and its origin naming the worker and how it ended.
pub(super) fn say_result(
    spec: &Spec,
    f: &core::fold::Fold,
    child: core::Running,
    call: core::Call,
    id: &str,
    origin: &str,
    text: &str,
) -> Value {
    let msg = core::message::Message::plain(text);
    core::send(spec, f, child, call, id, origin, &msg, None, None)
}

/// Whether any of `ids` is being made in this daemon now.
pub(super) fn making(ids: &[String]) -> bool {
    let making = MAKING.lock().unwrap();
    making
        .as_ref()
        .is_some_and(|m| ids.iter().any(|id| m.contains(id)))
}
