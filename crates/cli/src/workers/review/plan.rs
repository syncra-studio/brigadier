//! A plan's adversarial review [§6, D385]: a Claude plan the fold holds (`to: review`) gets a
//! reviewer, a worker of its session on another agent, whose findings go back as the plan's reply
//! [D177]; its notes (`plan_review`) move the held plan on (`core::fold::plan`).

use super::line::{cut, word};
use super::{Link, Plan, lock};
use crate::owner;
use crate::workers::{link, records, refuse};
use brigadier_core as core;
use brigadier_frames::procs;
use serde_json::{Value, json};
use std::path::Path;

/// A plan its review holds, by its request's id [§6].
pub(super) const PLAN: &str = "review-plan";
/// A plan's, the same asking for what to change, which its author needs to revise [§6] (F's
/// caveat: a reply without one gets a question back). Proposed.
const PLAN_BRIEF: &str = "Try to break this plan. For each finding say what in the plan is wrong, show it (file:line, a command with its output, or a concrete input and the wrong result), and say exactly what to change in the plan. Correctness, safety and missing work only, no style. If you find nothing real, say so. Don't commit.";

/// A held plan's review: the plan, and the session's last user message, or a worker's own brief.
pub(super) fn plan_of(data: &Path, me: &str, mark: Value) -> Result<Plan, Value> {
    let spec = core::load(data, me).map_err(|e| refuse(&e.to_string()))?;
    let f = core::fold(&spec.dir, true).map_err(|e| refuse(&e.to_string()))?;
    let asked = (f.fold.turns.first()).and_then(|t| t.asks.get(mark["plan"].as_str()?));
    let Some(plan) = asked.and_then(|r| r["body"].as_str()) else {
        return Err(refuse("The plan no longer waits."));
    };
    let asked = match link(data, me) {
        Some(l) => format!("Its task, as it was given:\n{}", l.brief.trim_end()),
        None => last_user(data, me).map_or(String::new(), |m| {
            format!("The user's last message:\n{}", m.trim_end())
        }),
    };
    let brief = format!(
        "Adversarial review of {}'s plan, before it's built; your worktree is at its current head.\n\n{asked}\n\nThe plan:\n{}\n\n{PLAN_BRIEF}",
        core::share::title(&spec),
        plan.trim_end()
    );
    Ok(Plan {
        brief,
        title: "Adversarial review of the plan".into(),
        base: None,
        authors: vec![crate::models::next_agent(&spec, &f.fold).to_string()],
        mark,
    })
}

/// The daemon's pass, for session `id` whose plan `request` its review holds: starts its reviewer
/// once, or lets the plan go to its answerer saying why it can't [§6, D392 P8].
pub(crate) fn plan_held(data: &Path, id: &str, request: &str) {
    let Ok(_one) = lock(data) else { return };
    let Ok(f) = core::fold(&core::session_dir(data, id), true) else {
        return;
    };
    let held = (f.fold.turns.first()).and_then(|t| t.asks.get(request));
    let now = &f.fold.plans.now;
    if held.is_none_or(|r| r["to"] != "review")
        || !matches!(now["state"].as_str(), None | Some("running" | "sent"))
    {
        return;
    }
    if now["state"] != Value::Null {
        // A restart cut its reviewer's end short: its result is written, never acted on, or its
        // findings said to go but never sent; the plan still held, no reply reached the log [D54].
        let by = now["by"].as_str().unwrap_or("");
        let ended = super::result::all(data, id)
            .into_iter()
            .find(|(_, x)| x.wid == by);
        match (ended, link(data, by)) {
            (Some((_, r)), Some(l)) => _ = super::act(data, &l, by, &r.turn, &r.how),
            (Some(_), None) => {
                let n = json!({"phase": "off", "why": "its reviewer's record is gone"});
                plan_note(data, id, request, n);
            }
            (None, _) => {}
        }
        return;
    }
    // One a restart cut short is reserved already: taken, never a second [D54].
    let made = records(data, id)
        .into_iter()
        .find(|x| x.review["plan"] == request);
    let by = match made {
        Some(x) => Ok(x),
        None => {
            let all = procs::all();
            let running = |s: &str| crate::sessions::working(data, s, &all);
            let flags = |k: &str| match k {
                "--reviewing" => Some("session".to_string()),
                PLAN => Some(request.to_string()),
                _ => None,
            };
            let reply = crate::workers::make::start(data, id, "", &flags, &running, false);
            let made = (reply["id"].as_str().filter(|_| reply["ok"] == true))
                .and_then(|rid| records(data, id).into_iter().find(|x| x.wid == rid));
            made.ok_or_else(|| {
                let why = reply["error"].as_str().unwrap_or("its start failed");
                match why.starts_with("You're a worker at depth") {
                    true => {
                        "this session is a worker at the deepest depth, so it starts no reviewer"
                            .into()
                    }
                    false => why
                        .strip_prefix("Review didn't run: ")
                        .unwrap_or(why)
                        .trim_end_matches('.')
                        .to_string(),
                }
            })
        }
    };
    let n = match by {
        Ok(x) => {
            let name = (x.pick["name"].as_str())
                .or(x.model.as_deref())
                .unwrap_or("");
            json!({"phase": "running", "by": x.wid, "name": name})
        }
        Err(why) => json!({"phase": "off", "why": why}),
    };
    plan_note(data, id, request, n);
}

/// The daemon's pass for session `id`: a plan reviewer still working once its plan no longer
/// waits on it (its turn stopped, the session closed, or it was answered without the review) is
/// stopped as `brigadier stop` does; its one result is written as any stopped reviewer's [D385].
pub(crate) fn plan_gone(data: &Path, id: &str) {
    let ended = super::result::all(data, id);
    let open: Vec<_> = (records(data, id).into_iter())
        .filter(|x| x.review["plan"].is_string() && x.state == "started")
        .filter(|x| ended.iter().all(|(_, r)| r.wid != x.wid))
        .collect();
    if open.is_empty() {
        return;
    }
    let Ok(f) = core::fold(&core::session_dir(data, id), true) else {
        return;
    };
    let all = procs::all();
    for x in open {
        let asked = (f.fold.turns.first()).and_then(|t| t.asks.get(x.review["plan"].as_str()?));
        if asked.is_some_and(|r| r["to"] == "review")
            || !crate::sessions::working(data, &x.wid, &all)
        {
            continue;
        }
        if crate::workers::end(data, id, &x.wid, "user").is_ok() {
            crate::workers::ended(data, id, &[x.wid], "user");
        }
    }
}

fn plan_note(data: &Path, id: &str, request: &str, mut n: Value) {
    (n["event"], n["id"]) = ("plan_review".into(), request.into());
    if let Ok(spec) = core::load(data, id) {
        let _ = owner::ensure(data, &spec);
        let _ = owner::call(data, id, json!({"op": "note", "data": n}));
    }
}

/// A plan reviewer's end: its findings go back as the plan's reply, framed so its author revises
/// and counts what it fixed [D177, D357]; or the plan goes to its answerer, with no findings or
/// saying why the review didn't run [§6].
pub(super) fn reviewed(
    data: &Path,
    l: &Link,
    how: &str,
    said: Option<String>,
    findings: Option<u64>,
) {
    let (of, request) = (&l.parent, l.review["plan"].as_str().unwrap_or(""));
    let name = (l.ran["name"].as_str()).or(l.ran["model"].as_str());
    let name = name.unwrap_or("another model");
    let off = |why: &str| plan_note(data, of, request, json!({"phase": "off", "why": why}));
    let said = match (how, findings, said) {
        ("finished", Some(0), _) => {
            let n = json!({"phase": "done", "findings": 0, "name": name});
            return plan_note(data, of, request, n);
        }
        ("finished", _, Some(said)) => said,
        ("finished", _, None) => return off("the reviewer ended without a message"),
        (how, ..) => return off(&format!("the reviewer {}", word(how))),
    };
    let n = json!({"phase": "sent", "findings": findings, "name": name});
    plan_note(data, of, request, n);
    let text = format!(
        "{}\n\nAbove are the findings {name}, another agent, made reviewing your plan adversarially. Revise the plan: change it for each valid one, and for each one you reject, give the reason in the plan. Then ask again to build it, ending the revised plan with one line: `Fixed: N, rejected: M`.",
        cut(said, 15 << 10)
    );
    match crate::control::reply(data, of, &text, &Value::Null, None, Some("review")) {
        Ok(Some(_)) => {}
        _ => off("its findings couldn't be sent"),
    }
}

/// The session's last message from its user.
fn last_user(data: &Path, id: &str) -> Option<String> {
    let mut thread = core::thread::Thread::default();
    let _ = core::rewind::read_active(&core::session_dir(data, id), |i| thread.push(i));
    let items = thread.session(id, "", None, None)["items"].take();
    (items.as_array().into_iter().flatten().rev())
        .find(|i| i["kind"] == "message" && i["role"] == "user" && i["origin"] == "user")
        .and_then(|i| i["text"].as_str().map(String::from))
}
