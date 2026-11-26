//! A worker's start [D3000, D3001, D3007, D2040]: checked against its family's depth and count,
//! reserved under the family's lock, answered at once, then made off the caller's turn, each
//! step safe to run again under the same ids after a restart [D54].

use super::{
    Link, Record, below, closing, family_lock, git, place, record, refuse, result, save, setting,
    write_json,
};
use crate::{control, models, owner, routing, settings, title};
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

/// How a worker lands its work: reviewed first [D385], merged into `base` in `to` with plain git
/// [D97], or kept on its branch; a commit and merge only if it changed files [D311].
pub(crate) fn land_line(merge: Option<(&str, &str, &str)>, review: bool) -> String {
    match merge {
        _ if review => super::review::FINDINGS.into(),
        Some((to, branch, base)) => {
            let (dir, b) = (sh(to), sh(branch));
            format!(
                "If you changed files, commit them on your branch when your work is done and right, then merge it into {base}: `git -C {dir} merge --no-edit {b}`. If that conflicts, run `git -C {dir} merge --abort` at once, rebase your branch onto {base}, resolve there, then merge again; never leave {to} mid-merge, and never touch its uncommitted changes. If it can't merge, say why. If you committed nothing, don't merge."
            )
        }
        None => "If you changed files, commit them on your branch and don't merge it.".into(),
    }
}

/// `s` as one shell word: as is when plain, else single-quoted ("Application Support") [D309].
fn sh(s: &str) -> String {
    let plain = |c: char| c.is_ascii_alphanumeric() || "_./:@%+=,-".contains(c);
    match !s.is_empty() && s.chars().all(plain) {
        true => s.into(),
        false => format!("'{}'", s.replace('\'', "'\\''")),
    }
}

/// Proposed: the line every worker gets after its brief [D3000, D3023].
/// `merge`: the parent's folder, the worker's branch and the parent's branch, for one with a
/// worktree, which merges itself back [D89, D97].
/// A reviewer's commits nothing: its count takes the merge sentence's place [D3026].
/// `root`: the family's first session, where the user's own words are, however deep it is.
fn fixed_line(
    parent: &str,
    pid: &str,
    root: &str,
    merge: Option<(&str, &str, &str)>,
    review: bool,
) -> String {
    let land = land_line(merge, review);
    format!(
        "You're a worker for {parent} ({pid}). When you end your turn, your last message goes back to it by itself, so end with what you did and found. To ask it something, `brigadier send {pid} \"<question>\"` and wait for its answer there; don't end your turn on a question. {land} `brigadier read {root} --user` has the user's own words. What you leave running ends when you finish. Your CLI loads no skills of its own, and no MCP servers but any only it can sign in to: `brigadier skill`, `brigadier mcp` and `brigadier search` (past sessions) bring what you need."
    )
}

/// How deep workers may start workers of their own; a worker at this depth can't [D2026, D3038].
const DEEPEST: u64 = 4;

/// `brigadier start --job J "<brief>" [--agent A] [--model M] [--effort E] [--title T]`, for session `me`'s
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
    // A review's brief is Rust's: the reviewed task, its commits, then the fixed one [D3026].
    let review = match flags("--reviewing") {
        Some(of) => match super::review::plan(data, me, &of, brief, flags) {
            Ok(r) => Some(r),
            Err(e) => return e,
        },
        None => None,
    };
    let brief = review.as_ref().map_or(brief, |r| r.brief.as_str());
    // A retry's brief is its chain's first and a note; `brief` says what failed [D2037, D342].
    let retry = match flags("--retry") {
        Some(id) => match routing::retry(data, me, &id, brief, flags) {
            Ok(r) => Some(r),
            Err(e) => return e,
        },
        None => None,
    };
    let brief = retry.as_ref().map_or(brief, |r| r.brief.as_str());
    let picked = |k: &str| retry.as_ref().map_or_else(|| flags(k), |r| r.flag(k));
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
    let held = models::held(data, parent.project.as_deref());
    let project = parent
        .project
        .clone()
        .filter(|p| projects::get(data, p).is_ok());
    // A review of a worker starts at that worker's head.
    let at = review.as_ref().and_then(|r| r.base.clone());
    let base = project.as_ref().and_then(|_| {
        (at.clone())
            .or_else(|| git(&parent.cwd, &["symbolic-ref", "--quiet", "--short", "HEAD"]))
            .or_else(|| git(&parent.cwd, &["rev-parse", "--verify", "HEAD"]))
    });
    let dirty = base.is_some()
        && at.is_none()
        && git(&parent.cwd, &["status", "--porcelain"]).is_some_and(|s| !s.is_empty());
    // Proposed: `--title` names it; else its brief does [D3029].
    let named = flags("--title").filter(|t| !t.trim().is_empty());
    let title = (named.or(retry.as_ref().map(|r| r.title.clone())))
        .or(review.as_ref().map(|r| r.title.clone()))
        .unwrap_or_else(|| title::from(brief));
    let mut asked = json!({"job": flags("--job"), "agent": flags("--agent"), "model": flags("--model"),
        "effort": flags("--effort")});
    // A mockup worker's variant count, from its offer's Yes [D2067]; agents can't pass --mockup.
    if let Some(n) = flags("--mockup").and_then(|n| n.parse::<u64>().ok()) {
        asked["mockup"] = n.into();
    }
    let reserved = (|| -> Result<Record, Value> {
        let _family = family_lock(data, &root).map_err(|e| refuse(&e.to_string()))?;
        if closing(data, me) || !parent.dir.join("session.json").exists() {
            return Err(refuse(
                "This session is being deleted, so it starts no workers.",
            ));
        }
        // A review Brigadier itself starts takes the slot of the work that waits on it.
        let own = |r: &super::review::Plan| r.mark["switch"] == true || r.mark["plan"].is_string();
        if !review.as_ref().is_some_and(own)
            && let Some(no) = full(data, &root, running)
        {
            return Err(no);
        }
        if let Some(no) = retry.as_ref().and_then(|r| r.taken(data, me)) {
            return Err(no);
        }
        let wid = loop {
            let id = format!("w{}", &adapters::uuid()[..8]);
            if !core::session_dir(data, &id).exists() {
                break id;
            }
        };
        let shown = retry.as_ref().is_some_and(|r| r.ask.is_some());
        let wid_ = if shown { "" } else { wid.as_str() };
        let authors = review.as_ref().map(|r| r.authors.as_slice());
        let mut p = routing::resolve(data, me, &parent, &f, &picked, wid_, authors)?;
        if let Some(rt) = &retry {
            rt.apply(&mut p);
        }
        let Some(a) = adapters::get(&p.agent) else {
            return Err(refuse(&format!("{:?} isn't an agent.", p.agent)));
        };
        // The parent's level carries over, Full access too, as the old app's; a held project's is
        // Ask [D187, D313, D316].
        let level = (parent.level.as_deref())
            .filter(|l| (!held || *l == "ask") && a.can().levels.contains(l))
            .or_else(|| models::default_level(a, held, &settings::get(data, "default_level")))
            .map(String::from);
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
            backend: p.agent,
            model: p.model,
            effort: p.effort,
            level,
            account: p.account,
            project,
            base: base.clone(),
            pick: p.ran,
            hold: p.hold,
            retry: retry.as_ref().map_or(Value::Null, |r| r.note.clone()),
            review: review.as_ref().map_or(Value::Null, |r| r.mark.clone()),
            waits: false,
        };
        save(data, me, &r).map_err(|e| refuse(&e.to_string()))?;
        Ok(r)
    })();
    let r = match reserved {
        Ok(r) => r,
        Err(e) => return e,
    };
    if let Some(rv) = &review {
        super::review::marked(data, rv, &r.wid);
    }
    let note = json!({"event": "worker", "phase": "started", "id": r.wid, "title": r.title});
    let _ = owner::call(data, me, json!({"op": "note", "data": note}));
    begin(data, me, &r.wid);
    let (backend, model, effort) = (&r.backend, &r.model, &r.effort);
    let mut ran = r.pick.clone();
    (ran["agent"], ran["model"]) = (json!(backend), json!(model));
    ran["account"] = json!(r.account);
    let why = routing::why(&r.asked, &ran, &r.retry);
    let receipt = routing::receipt(&ran).unwrap_or_else(|| {
        let ran = [Some(backend.as_str()), model.as_deref(), effort.as_deref()];
        ran.into_iter().flatten().collect::<Vec<_>>().join(" · ")
    });
    let place = match &base {
        Some(b) => format!("in its own worktree off {b}"),
        None => "in a folder of its own".into(),
    };
    let mut text = match r.hold["why"].as_str() {
        Some(why) if r.hold["retry"] == true => format!(
            "Held worker {} ({}): {why}, so the user decides on its card whether it retries on {} · {} or stops here. Go on with your work; its result comes to you if it runs.",
            r.title,
            r.wid,
            backend,
            model.as_deref().unwrap_or("")
        ),
        Some(why) => format!(
            "Held worker {} ({}): {why}, so {}. Go on with your work; its result comes to you when it runs.",
            r.title,
            r.wid,
            match r.hold["use"].is_object() {
                true =>
                    "the user decides on its card whether it runs on a model from another job or waits",
                false => "it waits for the user's answer on its card, which offers only Wait",
            }
        ),
        None => format!(
            "Started worker {} ({}) on {receipt}, {place}. Its result comes to you by itself when it finishes, so end your turn.",
            r.title, r.wid
        ),
    };
    if dirty {
        text +=
            " Your uncommitted edits aren't in its worktree; commit them first if it needs them.";
    }
    json!({"ok": true, "id": r.wid, "title": r.title, "agent": backend, "model": model, "effort": effort,
        "account": r.account, "receipt": receipt, "asked": r.asked, "ran": ran, "why": why, "retry": r.retry,
        "held": r.hold["why"], "base": base, "uncommitted": dirty, "text": text})
}

/// Start's refusal when `root`'s family runs its most workers at once, under its lock [D3001];
/// a held one let go counts the same way.
pub(crate) fn full(data: &Path, root: &str, running: &dyn Fn(&str) -> bool) -> Option<Value> {
    let limit = setting(data, "workers", 6);
    // Ended, waiting on its review: its reviewer has its slot.
    let reviewed = |id: &str| super::link(data, id).is_some_and(|l| l.review["state"] == "running");
    let busy = (below(data, root).iter())
        // Its own log, not only the row, which lags just after a launch.
        .filter(|r| {
            r.state == "starting"
                || (r.state == "started"
                    && (running(&r.wid) || (!reviewed(&r.wid) && super::busy(data, &r.wid))))
        })
        .count() as u64;
    (busy >= limit).then(|| refuse(&format!(
        "{} running in this family, the most allowed. Wait for one to finish (its result comes to you), then start this one.",
        if busy == 1 { "1 worker is".into() } else { format!("{busy} workers are") }
    )))
}

/// Makes a reserved worker off the caller's thread, once at a time in this daemon.
pub(crate) fn begin(data: &Path, pid: &str, wid: &str) {
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
            let family = family_lock(&data, &r.root);
            // A stop while it was being made keeps its word: no result, never started.
            if record(&data, &pid, &wid).is_none_or(|now| now.state != "stopped") {
                match made {
                    Ok(()) if !r.hold.is_null() => r.state = "held".into(),
                    Ok(()) => r.state = "started".into(),
                    Err(e) => {
                        r.state = "failed".into();
                        r.error = Some(e.to_string());
                    }
                }
                let _ = save(&data, &pid, &r);
                // Its result, past the family lock: a reviewer's takes `review.lock`, which is
                // never taken under it.
                drop(family);
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
                opts: (r.review["plan"]
                    .is_string()
                    .then(|| ("plan_review".into(), "1".into())))
                .into_iter()
                .collect(),
                ..Default::default()
            },
        )?,
    };
    let mut ran = r.pick.clone();
    for (k, v) in [
        ("agent", json!(r.backend)),
        ("model", json!(r.model)),
        ("account", json!(r.account)),
    ] {
        ran[k] = v;
    }
    if ran["effort"].is_null() {
        ran["effort"] = json!(r.effort);
    }
    if !dir.join("worker.json").exists() {
        let l = Link {
            parent: pid.into(),
            root: r.root.clone(),
            depth: r.depth,
            title: r.title.clone(),
            brief: r.brief.clone(),
            at: r.at,
            // A mockup worker reports only once the user's pick is wired in [D560].
            report: match r.asked["mockup"].is_null() {
                true => vec![r.cid.clone()],
                false => vec![],
            },
            ran: ran.clone(),
            asked: r.asked.clone(),
            last: Value::Null,
            paused: false,
            review: r.review.clone(),
        };
        write_json(&dir.join("worker.json"), &l)?;
        core::write_atomic(&dir.join("title"), r.title.as_bytes())?;
        if let Some(n) = r.asked["mockup"].as_u64() {
            crate::relay::mockup::begin(&dir, &r.title, n)?;
        }
    }
    let mut branch = None;
    match &r.project {
        Some(p) => {
            let (_lock, all) = projects::locked(data)?;
            let project = all.into_iter().find(|x| &x.id == p);
            let project = project
                .filter(|x| !x.removing)
                .ok_or_else(|| io::Error::other("Its project is gone or being removed."))?;
            core::folder::ensure(&spec, &project, r.base.as_deref(), &r.title)?;
            branch = core::worktrees::branch(&dir)?;
        }
        None => fs::create_dir_all(&cwd)?,
    }
    owner::ensure(data, &spec)?;
    // Its row out of quota: it waits on the user's call, its brief unsent [D2028].
    if !r.hold.is_null() {
        return crate::routing::ask(data, &r.wid, &r.hold);
    }
    if core::fold(&dir, true)?.fold.cids.contains_key(&r.cid) {
        return Ok(());
    }
    // A retry's chain and step go in its start note, so the next retry counts from the log [D2037].
    let mut outcome = json!({"event": "outcome", "phase": "start", "asked": r.asked, "ran": ran,
        "why": crate::routing::why(&r.asked, &ran, &r.retry), "parent": pid, "depth": r.depth});
    for (k, v) in r.retry.as_object().into_iter().flatten() {
        outcome[k] = v.clone();
    }
    owner::call(data, &r.wid, json!({"op": "note", "data": outcome}))?;
    // Why it isn't on its Use pick, before its brief; made again after a restart, drawn once [C38].
    let key = format!("start:{}", r.cid);
    crate::accounts::told(data, &r.wid, ran["fell_back"].as_str(), &key)?;
    // A mockup's rounds stay on its branch: it merges only after Use wires the pick in [D560].
    let merge = (branch.as_deref().zip(r.base.as_deref()))
        .filter(|_| r.asked["mockup"].is_null())
        .map(|(b, base)| (parent.cwd.as_str(), b, base));
    let line = fixed_line(
        &core::share::title(&parent),
        pid,
        &r.root,
        merge,
        !r.review.is_null(),
    );
    let text = format!("{}\n\n{line}", r.brief.trim_end());
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
    let spec = &crate::routing::told(&core::data_of(spec), spec);
    core::send(spec, f, child, call, id, origin, &msg, None, None)
}

/// Whether any of `ids` is being made in this daemon now.
pub(super) fn making(ids: &[String]) -> bool {
    let making = MAKING.lock().unwrap();
    making
        .as_ref()
        .is_some_and(|m| ids.iter().any(|id| m.contains(id)))
}
