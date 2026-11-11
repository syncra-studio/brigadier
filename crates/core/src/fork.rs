//! Fork [D1063]: a new session from one of a session's answers, in a new worktree with the files
//! as they were at that answer [D1068], or a chat's conversation only. One check per answer says
//! what the menu offers and what the command does (proposed). The crash record is the source's
//! `fork.json`, in rewind's phases, finished or rolled back by rewind's settle [D35, D54, D1089].

use crate::adapters::{self, Failed, Forked};
use crate::fold::Fold;
use crate::rewind::{fork as rf, now_of, write_shot};
use crate::{CallIn, Spec, as_run, projects, session, session_dir, worktrees, write_atomic};
use brigadier_frames::log::now_ms;
use serde_json::{Value, json};
use std::hash::{DefaultHasher, Hash, Hasher};
use std::path::Path;
use std::{fs, io};

/// The fork's own record: where it came from and what it holds.
const RECORD: &str = "forked.json";
/// The source's thread up to the answer, normalised items, one per line [D35].
const COPY: &str = "inherited.jsonl";
/// There while the fork is being made: it takes no work until its record is written.
pub const FORKING: &str = "forking";

/// Where an answer's conversation and files come from: `src`, the session whose turn it is, or,
/// with `gone`, the clicked session's own inherited copy, its source being gone [D1079].
pub struct Source {
    pub src: Spec,
    pub gone: bool,
}

/// What the command was asked: the new session's id and title, the answer (its turn's message
/// id), the place (else the one rule's), the menu's fingerprint, and the agent, model and effort
/// it goes on with when another was picked [D1081].
pub struct Ask<'a> {
    pub fork: &'a str,
    pub title: &'a str,
    pub at: &'a str,
    pub place: Option<&'a str>,
    pub fingerprint: Option<&'a str>,
    pub to: Option<(&'a str, &'a str, Option<&'a str>)>,
}

pub fn record(dir: &Path) -> Option<Value> {
    serde_json::from_slice(&fs::read(dir.join(RECORD)).ok()?).ok()
}

/// A fork's inherited copy; empty for any other session.
pub fn inherited(dir: &Path) -> Vec<Value> {
    let text = fs::read_to_string(dir.join(COPY)).unwrap_or_default();
    text.lines()
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect()
}

/// Whether the fork's conversation begins from the hand-off, built from its inherited copy.
pub fn summary(dir: &Path) -> bool {
    record(dir).is_some_and(|r| r["summary"] == true)
}

/// Whether the fork's next turn on `backend` begins from the hand-off, without asking [D90]: it
/// holds no conversation of its own, or its first launch was to fork one that no longer has the
/// answer, its source deleted first [D1089].
pub fn handoff(spec: &Spec, f: &Fold, backend: &str) -> bool {
    if !f.resume.contains_key(backend) {
        return summary(&spec.dir) || f.branching.contains(backend);
    }
    let at = (f.boundaries.iter()).find(|b| b.origin == "fork" && b.backend == backend);
    let native = at.zip(adapters::get(backend).and_then(|a| a.forking()));
    let run = || as_run(spec, f, backend, None);
    f.branching.contains(backend)
        && !native.is_some_and(|(at, a)| a.fork(&run(), at, None, Path::new(&spec.cwd)).is_ok())
}

fn inherits(dir: &Path, at: &str) -> bool {
    record(dir)
        .is_some_and(|r| (r["inherited"].as_array()).is_some_and(|a| a.iter().any(|c| c == at)))
}

/// Whose turn `at` is: an inherited answer forks from its source while that's there [D1079].
pub fn source(data: &Path, spec: &Spec, at: &str) -> io::Result<Source> {
    let f = crate::fold(&spec.dir, true)?.fold;
    let mine = Source {
        src: spec.clone(),
        gone: false,
    };
    if f.boundaries
        .iter()
        .any(|b| b.cid == at && b.origin != "fork")
        || !inherits(&spec.dir, at)
    {
        return Ok(mine);
    }
    let from = record(&spec.dir).and_then(|r| r["source"].as_str().map(String::from));
    match from.map(|id| crate::load(data, &id)) {
        // An archived or retired source counts as gone [D1079].
        Some(Ok(src)) if session::retired(&src.dir).is_none() => source(data, &src, at),
        _ => Ok(Source { gone: true, ..mine }),
    }
}

fn refused(error: &str, message: &str) -> Value {
    json!({"ok": false, "error": error, "message": message})
}

/// The one check for an answer [D1068, D1070]: the worktree row's files (`snapshot`, `none`,
/// `gone`, `sourceGone`; null where the folder isn't a git repository), what Fork here shares,
/// the place the one rule picks, and a fingerprint the command compares (proposed).
pub fn offer(data: &Path, spec: &Spec, s: &Source, at: &str) -> Value {
    if session::lifecycle(&spec.dir).0.is_some() {
        return refused("archived", "Restore this session to fork from it.");
    }
    // The agent whose conversation the answer is in: picking it forks natively [D1081].
    let agent = if s.gone {
        inherits(&s.src.dir, at).then_some(None)
    } else {
        crate::fold(&s.src.dir, true).ok().and_then(|f| {
            (f.fold.boundaries.into_iter())
                .find(|b| b.cid == at && b.origin != "fork")
                .map(|b| Some(b.backend))
        })
    };
    let Some(agent) = agent else {
        return refused("gone", "This answer can't be forked any more.");
    };
    let project = (s.src.project.as_deref()).and_then(|p| projects::get(data, p).ok());
    let git = project
        .as_ref()
        .is_some_and(|p| Path::new(&p.folder).join(".git").exists());
    let mut print = format!("{}:{at}", s.src.id);
    let worktree = match crate::rewind::end_of(&s.src, at) {
        _ if !git => None,
        _ if s.gone => Some("sourceGone"),
        Some(shot) => {
            print += &format!(":{}:{:?}", shot.tree, shot.head);
            Some(if shot.head.is_some() {
                "snapshot"
            } else {
                "gone"
            })
        }
        None => Some("none"),
    };
    let own = Path::new(&spec.cwd) == worktrees::path(data, &spec.id);
    let here = project
        .as_ref()
        .map(|_| if own { "worktree" } else { "folder" });
    let place = match (worktree, here) {
        (Some(_), _) => "worktree",
        (_, Some(_)) => "here",
        _ => "chat",
    };
    print += &format!(":{worktree:?}:{here:?}");
    let mut hash = DefaultHasher::new();
    print.hash(&mut hash);
    json!({"ok": true, "worktree": worktree, "here": here, "default": place, "agent": agent,
        "fingerprint": format!("{:016x}", hash.finish())})
}

/// The turns `f`'s session holds, oldest first: inherited, its own, then one running.
fn order(dir: &Path, f: &Fold) -> Vec<String> {
    let inherited = record(dir)
        .map(|r| r["inherited"].clone())
        .unwrap_or_default();
    let mut order: Vec<String> = (inherited.as_array().into_iter().flatten())
        .filter_map(|c| c.as_str().map(String::from))
        .collect();
    order.extend(
        (f.boundaries.iter())
            .filter(|b| b.origin != "fork")
            .map(|b| b.cid.clone()),
    );
    order.extend(f.turns.iter().map(|t| t.id.clone()));
    order
}

/// The thread up to the end of turn `at`'s answer: the inherited copy, then what still stands.
fn copy_of(dir: &Path, order: &[String], at: &str) -> io::Result<Vec<Value>> {
    let mut items = inherited(dir);
    crate::rewind::read_active(dir, |item| items.push(item.clone()))?;
    let next = order.iter().skip_while(|c| *c != at).nth(1);
    let input = |i: &Value| i["kind"] == "input" && next.is_some_and(|n| i["cid"] == n.as_str());
    if let Some(cut) = items.iter().position(input) {
        items.truncate(cut);
    }
    Ok(items)
}

/// Writes the fork's own record and its note, once each, then lets it take work.
pub fn made(data: &Path, record: &Value, call_in: CallIn) -> io::Result<()> {
    let id = record["fork"].as_str().unwrap_or("");
    crate::check_id(id)?;
    let dir = session_dir(data, id);
    write_atomic(&dir.join(RECORD), &serde_json::to_vec(record)?)?;
    let mut noted = false;
    if dir.join("log").exists() {
        crate::read(&dir, |i| {
            noted |= i["kind"] == "note" && i["event"] == "forked"
        })?;
    }
    if !noted {
        let mut note = record.clone();
        note["event"] = "forked".into();
        let reply = call_in(id, json!({"op": "note", "data": note}))?;
        if reply["ok"] != true {
            return Err(io::Error::other(format!(
                "the fork's note: {}",
                reply["error"]
            )));
        }
    }
    match fs::remove_file(dir.join(FORKING)) {
        Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e),
        _ => Ok(()),
    }
}

/// Makes the fork under the source's fence, held until its record is written [D1072, D1089]. The
/// caller settled the source first. Success only once the fork holds all it needs [D35].
pub fn fork(data: &Path, spec: &Spec, s: &Source, ask: &Ask, call_in: CallIn) -> io::Result<Value> {
    let _fence = session::fence(data, &s.src)?;
    let offer = offer(data, spec, s, ask.at);
    if offer["ok"] != true {
        return Ok(offer);
    }
    if ask.fingerprint.is_some_and(|p| offer["fingerprint"] != p) {
        return Ok(refused(
            "changed",
            "This answer changed. Open the menu again.",
        ));
    }
    if ask.to.is_some_and(|(b, ..)| adapters::get(b).is_none()) {
        return Ok(refused("agent", "That agent isn't available."));
    }
    if session_dir(data, ask.fork).exists() {
        return Ok(refused("taken", "There's already a session with that id."));
    }
    let place = ask.place.unwrap_or(offer["default"].as_str().unwrap_or(""));
    let offered = match place {
        "worktree" => !offer["worktree"].is_null(),
        // In the source's own folder, today's files [D1070]; an inherited answer whose source is
        // gone has no folder to share.
        "here" => !offer["here"].is_null() && !s.gone,
        "chat" => s.src.project.is_none(),
        _ => false,
    };
    if !offered {
        return Ok(refused("place", "This answer can't be forked there."));
    }
    let f = crate::fold(&s.src.dir, true)?.fold;
    let at = (f.boundaries.iter())
        .find(|b| b.cid == ask.at && !s.gone)
        .cloned();
    // The agent and account the answer was on, which may not be the session's now [D1081].
    let (backend, account) = match &at {
        Some(b) => (b.backend.clone(), b.account.clone()),
        None => {
            let now = if f.backend.is_empty() {
                &s.src.backend
            } else {
                &f.backend
            };
            (
                now.clone(),
                f.accounts.get(now).cloned().unwrap_or_default(),
            )
        }
    };
    let mut op = rf::Op {
        fork: ask.fork.into(),
        account,
        at,
        backend,
        ..rf::Op::default()
    };
    rf::write(&s.src, &mut op, "prepared")?;
    match build(data, s, &f, ask, place, &mut op, call_in) {
        Ok(reply) => Ok(reply),
        // Rolled back on proof: an unheard native fork is removed first, or it all stays recorded.
        Err(e) if op.phase != "made" => {
            if op.phase == "conversation" && rf::unfork(&s.src, &op).is_err() {
                return Ok(refused(
                    "uncertain",
                    &format!(
                        "The fork didn't finish: {e}. It finishes before the next message here."
                    ),
                ));
            }
            rf::remove(data, ask.fork).and_then(|()| rf::clear(&s.src))?;
            Ok(refused("failed", &format!("Couldn't fork: {e}")))
        }
        Err(e) => Ok(refused(
            "unfinished",
            &format!("The fork didn't finish: {e}. It finishes before the next message here."),
        )),
    }
}

fn build(
    data: &Path,
    s: &Source,
    f: &Fold,
    ask: &Ask,
    place: &str,
    op: &mut rf::Op,
    call_in: CallIn,
) -> io::Result<Value> {
    let src = &s.src;
    rf::write(src, op, "files")?;
    let run = as_run(src, f, &op.backend, Some(&op.account));
    // Another vendor's agent has no native fork: it begins from the hand-off [D1081, D90].
    let other = ask.to.filter(|(b, ..)| *b != op.backend);
    let worktree = place == "worktree";
    let here = place == "here";
    let cwd = if worktree {
        worktrees::path(data, ask.fork)
    } else if here {
        src.cwd.clone().into()
    } else {
        session_dir(data, ask.fork).join("scratch")
    };
    let new = crate::create(
        data,
        &Spec {
            id: ask.fork.into(),
            backend: other.map_or(op.backend.clone(), |(b, ..)| b.into()),
            mode: "pipe".into(),
            cwd: cwd.display().to_string(),
            project: src.project.clone(),
            // The picked model in the fork's own record, as a model switch; no effort is the CLI's
            // default, as `set` [D1081, D1089].
            model: ask.to.map_or(run.model.clone(), |(_, m, _)| Some(m.into())),
            effort: ask
                .to
                .map_or(run.effort.clone(), |(.., e)| e.map(String::from)),
            // Full access isn't carried into a session nobody picked it for [D187].
            level: src.level.clone().filter(|l| l != "full"),
            opts: src.opts.clone(),
            created: now_ms(),
            fork_of: Some(src.id.clone()),
            ..Spec::default()
        },
    )?;
    fs::write(new.dir.join(FORKING), b"")?;
    write_atomic(&new.dir.join("title"), ask.title.as_bytes())?;
    let left_out = if worktree {
        let project = projects::get(data, src.project.as_deref().unwrap_or(""))?;
        // The answer's end snapshot; with none, or its source gone, the files as they are now [D1068].
        let ended = (!s.gone)
            .then(|| crate::rewind::end_of(src, ask.at))
            .flatten();
        let shot = match ended {
            Some(shot) => shot,
            None => now_of(src)?,
        };
        let base = crate::share::base(data, src);
        worktrees::create(
            &new,
            &project,
            base.as_deref(),
            shot.head.as_deref(),
            ask.title,
        )?;
        write_shot(src, &shot, &cwd)?
    } else if here {
        vec![]
    } else {
        fs::create_dir_all(&cwd)?;
        vec![]
    };
    let order = order(&src.dir, f);
    let lines: String = (copy_of(&src.dir, &order, ask.at)?.iter())
        .map(|item| format!("{item}\n"))
        .collect();
    write_atomic(&new.dir.join(COPY), lines.as_bytes())?;
    let forked = match other {
        Some(_) => None,
        None => conversation(src, f, op, &run, &cwd)?,
    };
    let mut inherited: Vec<&str> = order
        .iter()
        .map(String::as_str)
        .take_while(|c| *c != ask.at)
        .collect();
    inherited.push(ask.at);
    let at = op.at.as_ref();
    // Written under the source's fence, so no restore sits between its check and this [D1073].
    let place = (worktree.then_some("worktree")).or(here.then_some("folder"));
    op.record = json!({"fork": ask.fork, "source": src.id, "at": ask.at,
        "where": place, "root": here.then(|| crate::share::root(src)), "summary": forked.is_none(), "leftOut": left_out,
        "backend": op.backend, "account": op.account, "moved": forked.as_ref().map(|k| &k.conv),
        "branch": forked.as_ref().zip(at).is_some_and(|(k, b)| k.conv == b.conv),
        "turns": forked.as_ref().map(|k| k.turns), "end": at.and_then(|b| b.end.clone()),
        "inherited": inherited});
    rf::write(src, op, "made")?;
    made(data, &op.record, call_in)?;
    rf::clear(src)?;
    Ok(json!({"ok": true, "session": ask.fork}))
}

/// The adapter's own fork where it can; None: the fork begins from the hand-off [D43, D90]. An
/// uncertain one is cleared up before any other conversation starts [D54].
fn conversation(
    src: &Spec,
    f: &Fold,
    op: &mut rf::Op,
    run: &Spec,
    cwd: &Path,
) -> io::Result<Option<Forked>> {
    let (Some(at), Some(a)) = (
        op.at.clone(),
        adapters::get(&op.backend).and_then(|a| a.forking()),
    ) else {
        return Ok(None);
    };
    let Some(before) = a.forks(run, &at.conv) else {
        return Ok(None);
    };
    op.before = before;
    rf::write(src, op, "conversation")?;
    let next = f.boundaries.iter().skip_while(|b| b.cid != at.cid).nth(1);
    match a.fork(run, &at, next, cwd) {
        Ok(forked) => Ok(Some(forked)),
        Err(Failed::Refused(_)) => Ok(None),
        Err(Failed::Uncertain(why)) => {
            rf::unfork(src, op).map_err(|e| io::Error::other(format!("{why}; {e}")))?;
            Ok(None)
        }
    }
}
