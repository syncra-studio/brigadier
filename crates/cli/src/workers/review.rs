//! Adversarial review [D3026, D2042]: one review, two triggers. The agent's `start --reviewing
//! <id>|session`; and Settings › Routing's switch, which holds a worker's result when it ends with
//! commits, starts the same review as its sibling, sends it the findings as one peer message
//! [D299, D300], and delivers its one result after one fix turn, with the review's line. It never
//! blocks: a review that can't run says why in the result. Each review's note goes to the outcome
//! log (`outcomes.rs`) [D2038]. One review, one fix pass, never a loop.
//!
//! A reviewer's `worker.json` `review` is `{"of": <id> | "session", "switch": bool}`; a reviewed
//! worker's is `{"state", "by", "turn", "tried", "model", "reviewer", "findings", "line"}`, its
//! state running (its reviewer works), sending (its findings go), sent (its fix turn runs), done
//! or off (its result goes, with `line`), or agent (reviewed by `--reviewing`, so the switch never
//! reviews it again). `tried`: the reviewers that failed or met their limit, each passed by for
//! the next eligible one; only when none is left does the review not run.

mod line;
mod plan;
pub(crate) use plan::{plan_gone, plan_held};

use super::{Link, git, link, records, refuse, result, write_json};
use crate::{owner, routing};
use brigadier_core::{self as core, fold::Fold};
use brigadier_frames::procs;
use line::{count, cut, reviewed, word};
use serde_json::{Value, json};
use std::fs::{self, OpenOptions};
use std::io;
use std::path::Path;

/// Its brief, fixed in Rust, verbatim [D3026] (w07).
const BRIEF: &str = "Try to break it. For each finding give file:line and either a command with its output or a concrete input and the wrong result. Run every 'done when' and report pass or fail with output. Correctness, safety and missing work only, no style. If you find nothing real, say so. Don't commit.";
/// Proposed: in its fixed line, the merge sentence's place, so Rust reads its count [D74].
pub(super) const FINDINGS: &str =
    "End your last message with one line: `Findings: N`, N the number of real findings.";
/// The flags only the switch's own start gives; no agent can type them. `review-tried` (read by
/// routing's pick): the reviewers passed by.
const SWITCH: &str = "review-switch";
const TRIED: &str = "review-tried";

/// What a review starts with: its brief and title, the commit its worktree is made at (none for
/// `session`: the caller's head), the agents whose work it reviews, and its mark.
pub(crate) struct Plan {
    pub brief: String,
    pub title: String,
    pub base: Option<String>,
    pub authors: Vec<String>,
    pub mark: Value,
}

/// Whether a worker at its limit moves within its job: a reviewer and a fix turn end there [D3026].
pub(crate) fn moves(l: &Link) -> bool {
    l.review["of"].is_null() && l.review["state"] != "sent"
}

/// A worker's own commits, `base_commit..head`, none when it made none.
fn span(data: &Path, wid: &str) -> Option<(String, String)> {
    let base = (core::worktrees::lands(&core::session_dir(data, wid))
        .ok()
        .flatten())?
    .base_commit;
    let cwd = core::load(data, wid).ok()?.cwd;
    let head = git(&cwd, &["rev-parse", "HEAD"])?;
    let n = git(&cwd, &["rev-list", "--count", &format!("{base}..{head}")])?;
    (n != "0").then_some((base, head))
}

/// `start --reviewing <id>|session "<brief>"` for session `me` [D3026]: the reviewed task and its
/// done-when, its commits by `base..head`, never its summary or transcript; the agent's brief,
/// then the fixed one. Refusals and the authors of `session` are proposed.
pub(crate) fn plan(
    data: &Path,
    me: &str,
    of: &str,
    given: &str,
    flags: &dyn Fn(&str) -> Option<String>,
) -> Result<Plan, Value> {
    let named = ["--job", "--agent", "--model", "--effort", "--retry"];
    if let Some(f) = named.into_iter().find(|f| flags(f).is_some()) {
        return Err(refuse(&format!(
            "--reviewing takes no {f}: a review runs on your Review job, on another agent than the author's."
        )));
    }
    let switch = flags(SWITCH).is_some();
    let mut mark = json!({"of": of, "switch": switch});
    if let Some(id) = flags(plan::PLAN) {
        mark["plan"] = id.into();
        return plan::plan_of(data, me, mark);
    }
    let given = match given.trim() {
        "" => String::new(),
        g => format!("\n\nFrom the session that asked for this review:\n{g}"),
    };
    if of == "session" {
        let task = link(data, me).map(|l| l.brief);
        if task.is_none() && given.is_empty() {
            return Err(refuse(
                "`brigadier start --reviewing session \"<plan>\"` needs the plan or work to review, in quotes: your session has no brief of its own.",
            ));
        }
        let spec = core::load(data, me).map_err(|e| refuse(&e.to_string()))?;
        let f = core::fold(&spec.dir, true).map_err(|e| refuse(&e.to_string()))?;
        // Its author is the session's own agent [D385, §6].
        let authors = vec![crate::models::next_agent(&spec, &f.fold).to_string()];
        let task = task.map_or(String::new(), |t| {
            format!("\n\nIts task, as it was given:\n{}", t.trim_end())
        });
        let brief = format!(
            "Adversarial review of {}'s plan or merged work; your worktree is at its current head.{task}{given}\n\n{BRIEF}",
            core::share::title(&spec)
        );
        let title = "Adversarial review".into();
        return Ok(Plan {
            brief,
            title,
            base: None,
            authors,
            mark,
        });
    }
    let Some(l) = link(data, of).filter(|l| l.parent == me && !l.session && moves(l)) else {
        return Err(refuse(
            "--reviewing takes one of your own workers, by its id, or `session`.",
        ));
    };
    if !switch && (l.last.is_null() || l.review["state"] == "running") {
        return Err(refuse(&format!(
            "{of} hasn't ended. Wait for its result, then review it."
        )));
    }
    let Some((base, head)) = span(data, of) else {
        return Err(refuse(&format!("Nothing to review: {of} made no commits.")));
    };
    let brief = format!(
        "Adversarial review of {} ({of}). Its task, as it was given:\n{}\n\nIts work is the commits {base}..{head}; your worktree is checked out at {head}: `git log -p {base}..{head}`.{given}\n\n{BRIEF}",
        l.title,
        l.brief.trim_end()
    );
    let authors = (l.ran["agent"].as_str().map(String::from))
        .into_iter()
        .collect();
    let title = format!("Adversarial review of {}", l.title);
    Ok(Plan {
        brief,
        title,
        base: Some(head),
        authors,
        mark,
    })
}

/// After `--reviewing <id>` is reserved as `rid`: its worker is marked, so the switch never
/// reviews it a second time.
pub(crate) fn marked(data: &Path, plan: &Plan, rid: &str) {
    let Some(of) = plan.mark["of"].as_str().filter(|o| *o != "session") else {
        return;
    };
    if let Some(mut l) =
        link(data, of).filter(|l| l.review.is_null() && plan.mark["switch"] != true)
    {
        l.review = json!({"state": "agent", "by": rid});
        let _ = save(data, of, &l);
    }
}

fn save(data: &Path, id: &str, l: &Link) -> io::Result<()> {
    write_json(&core::session_dir(data, id).join("worker.json"), l)
}

/// Held while a review moves on, across the daemon's pass and a parent's `wait`.
fn lock(data: &Path) -> io::Result<fs::File> {
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(data.join("review.lock"))?;
    file.lock()?;
    Ok(file)
}

/// w185's review note [D2038], into `into`'s log.
fn note(data: &Path, into: &str, r: &Value, counts: [Option<u64>; 3], why: Option<&str>) {
    let [findings, fixed, rejected] = counts;
    let n = json!({"event": "outcome", "phase": "review", "reviewer": r["reviewer"], "findings": findings,
        "fixed": fixed, "rejected": rejected, "ran": why.is_none(), "why": why});
    if let Ok(spec) = core::load(data, into) {
        let _ = owner::ensure(data, &spec);
        let _ = owner::call(data, into, json!({"op": "note", "data": n}));
    }
}

/// A review that won't run: its worker's result goes on now, saying why [D3026].
fn off(data: &Path, a: &mut Link, wid: &str, why: &str) {
    let why = why.trim_end_matches('.');
    let why = why.strip_prefix("Review didn't run: ").unwrap_or(why);
    (a.review["state"], a.review["line"]) =
        ("off".into(), format!("Review didn't run: {why}").into());
    note(data, wid, &a.review, [None; 3], Some(why));
}

/// `write_ended`'s one call, for a reported turn of `wid` that ended `how` with no result yet: the
/// end its result is written with, or none while a review holds it [D3026]. A reviewer's own
/// result is written here.
pub(super) fn holds(
    data: &Path,
    l: &mut Link,
    wid: &str,
    turn: &str,
    how: &'static str,
    f: &Fold,
) -> Option<&'static str> {
    if l.review["of"].is_string() {
        after(data, l, wid, turn, how, None);
        return None;
    }
    let on = how == "finished" && !l.session && routing::review_on(data);
    if l.review.is_null() && !on {
        return Some(how);
    }
    let _one = lock(data).ok()?;
    *l = link(data, wid)?;
    // Moved on while this waited for the lock: its fix turn reports now, or it's written [D3006].
    let path = result::path_of(data, &l.parent, wid, turn);
    if !result::reported(l, f).iter().any(|t| t == turn) || path.exists() {
        return None;
    }
    let r = l.review.clone();
    match r["state"].as_str() {
        None if r.is_null() && span(data, wid).is_some() => {
            match next(data, l, wid) {
                Ok(by) => l.review = json!({"state": "running", "by": by, "turn": turn}),
                Err(why) => off(data, l, wid, &why),
            }
            let _ = save(data, wid, l);
            (l.review["state"] != "running").then_some(how)
        }
        // Its reviewer's result is written with its next step, under this lock: none yet, it still
        // works or is being made, its start's failure too. One whose next step a restart cut
        // short, or stopped before it was made, never hangs it, never sends twice.
        Some("running") => {
            let by = r["by"].as_str().unwrap_or("");
            let made = records(data, &l.parent).into_iter().find(|x| x.wid == by);
            let ended = result::all(data, &l.parent)
                .iter()
                .any(|(_, x)| x.wid == by);
            if !ended && made.is_some_and(|x| x.state != "stopped") {
                return None;
            }
            off(data, l, wid, "interrupted");
            let _ = save(data, wid, l);
            Some(how)
        }
        // A restart cut its findings' send: the reviewer's own record says whether it went.
        Some("sending") => {
            let out = core::session_dir(data, r["by"].as_str().unwrap_or("")).join("peers/out");
            let mid = (fs::read_dir(out).into_iter().flatten().flatten())
                .filter_map(|e| super::read_json::<Value>(&e.path()))
                .find(|o| o["to"] == wid && o["state"] != "stopped")
                .and_then(|o| o["mid"].as_str().map(String::from));
            let Some(mid) = mid else {
                off(data, l, wid, "its findings couldn't be sent");
                let _ = save(data, wid, l);
                return Some(how);
            };
            (l.report, l.review["state"]) = (vec![mid], "sent".into());
            let _ = save(data, wid, l);
            None
        }
        Some("sent") => {
            let said = last_of_turn(data, wid, turn).unwrap_or_default();
            let (fixed, rejected) = (count(&said, "fixed:"), count(&said, "rejected:"));
            let mut line = reviewed(&r, fixed, rejected);
            if how != "finished" {
                line += &format!("; the fix turn {}", word(how));
            }
            (l.review["state"], l.review["line"]) = ("done".into(), line.into());
            note(
                data,
                wid,
                &r,
                [r["findings"].as_u64(), fixed, rejected],
                None,
            );
            let _ = save(data, wid, l);
            Some(how)
        }
        _ if l.last["how"] == "stopped" => Some("stopped"),
        _ => Some(how),
    }
}

/// Starts the switch's reviewer of `wid`, its sibling, on the next eligible model past those
/// tried; one a restart cut short is reserved already: taken, never a second [D54]. The why it
/// can't, once none is left.
fn next(data: &Path, a: &Link, wid: &str) -> Result<String, String> {
    let tried = a.review["tried"].as_array().cloned().unwrap_or_default();
    let new = |x: &str| tried.iter().all(|t| t["by"] != x);
    let made = (records(data, &a.parent).into_iter())
        .find(|x| x.review["of"] == wid && x.review["switch"] == true && new(&x.wid));
    if let Some(x) = made {
        return Ok(x.wid);
    }
    let all = procs::all();
    let running = |id: &str| crate::sessions::working(data, id, &all);
    let past = tried
        .iter()
        .map(|t| json!({"agent": t["agent"], "model": t["model"]}));
    let past = Value::from_iter(past).to_string();
    let flags = |k: &str| match k {
        "--reviewing" => Some(wid.to_string()),
        SWITCH => Some("1".into()),
        TRIED => Some(past.clone()),
        _ => None,
    };
    let reply = super::make::start(data, &a.parent, "", &flags, &running, false);
    if let Some(id) = reply["id"].as_str().filter(|_| reply["ok"] == true) {
        return Ok(id.to_string());
    }
    let why = reply["error"].as_str().unwrap_or("its start failed");
    if tried.is_empty() {
        return Err(why.into());
    }
    // "qwen3:4b failed and fake-large stopped at a usage limit", then any left without room.
    let gone = tried.iter().map(|t| {
        let name = t["name"].as_str().unwrap_or("its reviewer");
        format!("{name} {}", word(t["how"].as_str().unwrap_or("")))
    });
    let mut gone = gone.collect::<Vec<_>>().join(" and ");
    let room = why.strip_prefix("Review didn't run: ");
    if let Some(room) = room.filter(|w| w.contains("has room")) {
        gone += &format!("; {room}");
    }
    Err(gone)
}

/// A reviewer's end, its start's failure too: its result, then what comes next, under the lock.
pub(super) fn after(data: &Path, l: &Link, wid: &str, turn: &str, how: &str, error: Option<&str>) {
    let next = {
        let Ok(_one) = lock(data) else { return };
        let path = result::path_of(data, &l.parent, wid, turn);
        if path.exists() || result::write(data, l, wid, turn, how, error).is_err() {
            return;
        }
        act(data, l, wid, turn, how)
    };
    if let Some(of) = next {
        let _ = result::write_ended(data, &of, false);
    }
}

/// Under the lock, after a reviewer's result: its note; under the switch, its findings to its
/// worker as one peer message, which starts the fix turn, the next reviewer after one that failed
/// or met its limit, or the worker whose result goes now.
fn act(data: &Path, l: &Link, wid: &str, turn: &str, how: &str) -> Option<String> {
    let of = l.review["of"].as_str().unwrap_or("");
    let said = (how == "finished")
        .then(|| last_of_turn(data, wid, turn))
        .flatten();
    let findings = said.as_deref().and_then(|t| count(t, "findings:"));
    if l.review["plan"].is_string() {
        plan::reviewed(data, l, how, said, findings);
        return None;
    }
    let reviewer = json!({"agent": l.ran["agent"], "model": l.ran["model"]});
    let why = (how != "finished").then(|| format!("the reviewer {}", word(how)));
    if l.review["switch"] != true {
        let into = if of == "session" { wid } else { of };
        let r = json!({"reviewer": reviewer});
        note(data, into, &r, [findings, None, None], why.as_deref());
        return None;
    }
    let mut a =
        link(data, of).filter(|a| a.review["by"] == wid && a.review["state"] == "running")?;
    {
        let model = l
            .ran
            .get("name")
            .filter(|n| n.is_string())
            .unwrap_or(&l.ran["model"]);
        (a.review["model"], a.review["reviewer"]) = (model.clone(), reviewer);
        a.review["findings"] = json!(findings);
        match (why, findings, said) {
            (Some(_), ..) if matches!(how, "failed" | "limit") => {
                let me = json!({"by": wid, "agent": l.ran["agent"], "model": l.ran["model"], "name": model, "how": how});
                let mut tried = a.review["tried"].as_array().cloned().unwrap_or_default();
                tried.push(me);
                a.review["tried"] = tried.into();
                match next(data, &a, of) {
                    Ok(by) => {
                        a.review["by"] = by.into();
                        let _ = save(data, of, &a);
                        return None;
                    }
                    Err(why) => off(data, &mut a, of, &why),
                }
            }
            (Some(why), ..) => off(data, &mut a, of, &why),
            (None, Some(0), _) => {
                a.review["state"] = "done".into();
                a.review["line"] = reviewed(&a.review, None, None).into();
                note(data, of, &a.review, [Some(0), None, None], None);
            }
            (None, _, None) => off(data, &mut a, of, "the reviewer ended without a message"),
            (None, _, Some(said)) => {
                let text = format!(
                    "{}\n\nAbove are the findings {}, another agent, made reviewing your work adversarially. Fix the valid ones, commit, and merge as before; for each one you reject, give the reason. Don't reply to it: your last message goes to your parent. End it with one line: `Fixed: N, rejected: M`.",
                    cut(said, 15 << 10),
                    model.as_str().unwrap_or("another model")
                );
                // Saved first: a send a restart cuts short is found by the reviewer's record.
                a.review["state"] = "sending".into();
                let _ = save(data, of, &a);
                let sent = crate::peers::send(data, wid, &json!({"id": of}), &text, None, &|| true);
                match sent["mid"].as_str().filter(|_| sent["ok"] == true) {
                    // Its fix turn reports in place of the turn it held [D3006].
                    Some(mid) => {
                        (a.report, a.review["state"]) = (vec![mid.to_string()], "sent".into());
                        let _ = save(data, of, &a);
                        return None;
                    }
                    None => {
                        let e = sent["error"].as_str().unwrap_or("it wasn't taken");
                        off(
                            data,
                            &mut a,
                            of,
                            &format!("its findings couldn't be sent: {e}"),
                        );
                    }
                }
            }
        }
        let _ = save(data, of, &a);
    }
    Some(of.to_string())
}

/// A stop of a worker waiting on its review stops its reviewer too, and its own result goes on,
/// quietly as any stop's [D330].
pub(super) fn stop(data: &Path, top: &str, wid: &str) {
    let by = {
        let Ok(_one) = lock(data) else { return };
        let Some(mut a) = link(data, wid).filter(|a| a.review["state"] == "running") else {
            return;
        };
        off(data, &mut a, wid, "it was stopped");
        let _ = save(data, wid, &a);
        a.review["by"].as_str().unwrap_or("").to_string()
    };
    let _ = super::end(data, top, &by, "user");
    let _ = result::write_ended(data, wid, false);
}

/// What a reviewed worker's result says of its review: the line, then, after a fix turn, the
/// last message of the turn its review held.
pub(super) fn said(data: &Path, l: &Link, wid: &str, turn: &str) -> String {
    let Some(line) = l.review["line"].as_str() else {
        return String::new();
    };
    let held = l.review["turn"]
        .as_str()
        .filter(|t| *t != turn && l.review["state"] == "done");
    match held.and_then(|t| last_of_turn(data, wid, t)) {
        Some(m) => format!(
            "{line}.\nIts last message before the review:\n{}\n",
            cut(m, 8 << 10).trim_end()
        ),
        None => format!("{line}.\n"),
    }
}

/// A turn's own last message, by the turn's stable id: its rows carry the id of the block it went
/// into, the one it carried on for a wake or a rebirth's carry-on [D88, D118].
pub(crate) fn last_of_turn(data: &Path, id: &str, turn: &str) -> Option<String> {
    let mut thread = core::thread::Thread::default();
    let _ = core::rewind::read_active(&core::session_dir(data, id), |i| thread.push(i));
    let turn = thread.block_of(turn).to_string();
    let items = thread.session(id, "", None, None)["items"].take();
    (items.as_array().into_iter().flatten().rev())
        .find(|i| i["kind"] == "message" && i["role"] == "assistant" && i["turnId"] == turn)
        .and_then(|i| i["text"].as_str().map(String::from))
}
