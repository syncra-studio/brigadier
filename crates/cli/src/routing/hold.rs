//! A worker held for the user's call, its row out of quota: Rust's question on its card, the
//! parent told once, and the answer that lets it go on [D2028, D342].

use super::pick::{account_for, label, place};
use super::*;
use brigadier_frames::procs;

/// Asks the user on worker `wid`'s own card, with Rust's question, and tells its parent once
/// [D2028, D342]: "Use ‹the lower row's first›" and "Wait until ‹reset›", only Wait with no row
/// below. The parent keeps working; only the user settles it.
pub(crate) fn ask(data: &Path, wid: &str, hold: &Value) -> io::Result<()> {
    if core::fold(&core::session_dir(data, wid), true)?
        .fold
        .hold
        .is_some()
    {
        return Ok(());
    }
    let id = format!("hold-{}", &adapters::uuid()[..8]);
    let until = hold["resets"].as_u64().unwrap_or(log::now_ms() + SKIP_MS);
    let when = clock(until);
    let lower = &hold["lower"];
    let why = str_of(hold, "why");
    let mut options = vec![];
    // Past a retry's ladder: retry on the row's first, or stop here [D2037] (proposed words).
    if hold["retry"] == true {
        let (row, model) = (title(str_of(lower, "row")), str_of(lower, "model"));
        let options = json!([
            {"label": format!("Retry on {} · {model}", str_of(lower, "agent")),
                "description": format!("The first in your {row} row")},
            {"label": "Stop here", "description": "It doesn't run again"}]);
        let item = json!({"text": format!("{why}. How should it go on?"), "options": options,
            "recommended": null, "multiSelect": false});
        let request = json!({"id": id, "title": "Out of retries", "items": [item], "held": true});
        let note = json!({"event": "hold", "phase": "asked", "id": id, "why": why, "retry": true,
            "lower": lower, "row": hold["row"], "request": request});
        owner::call(data, wid, json!({"op": "note", "data": note}))?;
        return workers::told_held(data, wid, &id, why);
    }
    if lower.is_object() {
        let (row, model) = (title(str_of(lower, "row")), str_of(lower, "model"));
        options.push(
            json!({"label": format!("Use {} · {model}", str_of(lower, "agent")),
            "description": format!("The first in your {row} row")}),
        );
    }
    options.push(
        json!({"label": format!("Wait until {when}"), "description": "Then it starts as picked"}),
    );
    let item = json!({"text": format!("{why} until {when}. How should it go on?"), "options": options,
        "recommended": null, "multiSelect": false});
    // `held`: its card offers only these answers, no words of the user's and no Skip.
    let request = json!({"id": id, "title": "Out of quota", "items": [item], "held": true});
    let note = json!({"event": "hold", "phase": "asked", "id": id, "why": why, "resets": until,
        "lower": lower, "row": hold["row"], "request": request});
    owner::call(data, wid, json!({"op": "note", "data": note}))?;
    workers::told_held(data, wid, &id, &format!("{why}, resets {when}"))
}

/// The user's answer on a hold's card: "Use …" runs the lower row's entry now, "Wait …" waits for
/// the reset, then goes on as picked (`resume`). Its note goes only once the answer is taken, so a
/// refused one, or a crash before it, leaves the card up to answer again.
pub(super) fn answer(data: &Path, wid: &str, request: &str, choice: &str) -> io::Result<Value> {
    let f = core::fold(&core::session_dir(data, wid), true)?.fold;
    let Some(hold) = f
        .hold
        .clone()
        .filter(|h| h["id"] == request && core::fold::held(&f))
    else {
        return Ok(
            json!({"ok": false, "error": "not_waiting", "message": "This isn't waiting on you."}),
        );
    };
    let offered = hold["request"]["items"][0]["options"].as_array();
    if !offered.is_some_and(|o| o.iter().any(|o| o["label"] == choice)) {
        return Ok(json!({"ok": false, "error": "invalid",
            "message": "A held worker takes only one of its card's answers."}));
    }
    if hold["retry"] == true {
        let reply = match choice.starts_with("Retry on ") {
            true => go(data, wid, Some(&hold["lower"]))?,
            false => {
                let pid = workers::link(data, wid)
                    .map(|l| l.parent)
                    .unwrap_or_default();
                crate::workers::run(data, &["workers", &pid, "stop", wid].map(String::from))?
            }
        };
        let note = json!({"event": "hold", "phase": "answered", "id": request, "choice": choice});
        return taken(data, wid, reply, note);
    }
    let lower = choice.starts_with("Use ") && hold["lower"].is_object();
    let phase = if lower { "answered" } else { "waiting" };
    let note = json!({"event": "hold", "phase": phase, "id": request, "choice": choice,
        "resets": hold["resets"], "lower": hold["lower"], "row": hold["row"]});
    let reply = match lower {
        true => go(data, wid, Some(&hold["lower"]))?,
        false => json!({"ok": true}),
    };
    taken(data, wid, reply, note)
}

/// A hold's answer taken: its note settles the card.
fn taken(data: &Path, wid: &str, reply: Value, note: Value) -> io::Result<Value> {
    if reply["ok"] == true {
        owner::call(data, wid, json!({"op": "note", "data": note}))?;
    }
    Ok(reply)
}

/// Whether Stop (not Pause) ends a start record now: one being made, or one held on its card, so
/// neither its reset nor a later answer starts it [D2028].
pub(crate) fn stops(r: &workers::Record, by: &str) -> bool {
    r.state == "starting" || (r.state == "held" && by == "user")
}

/// A stopped worker's hold card goes, its wait with it.
pub(crate) fn stopped(data: &Path, wid: &str, by: &str) {
    let f = core::fold(&core::session_dir(data, wid), true);
    if by == "user" && f.is_ok_and(|f| f.fold.hold.is_some()) {
        let note = json!({"event": "hold", "phase": "answered", "choice": "Stop"});
        let _ = owner::call(data, wid, json!({"op": "note", "data": note}));
    }
}

/// The daemon's: a hold whose reset has passed goes on as picked.
pub(super) fn resume(data: &Path, wid: &str) -> io::Result<Value> {
    let f = core::fold(&core::session_dir(data, wid), true)?.fold;
    let Some(hold) = f.hold.clone().filter(|h| h["phase"] == "waiting") else {
        return Ok(json!({"ok": false, "error": "not_waiting"}));
    };
    let note =
        json!({"event": "hold", "phase": "answered", "id": hold["id"], "choice": hold["choice"]});
    let reply = go(data, wid, None)?;
    taken(data, wid, reply, note)
}

/// Goes on after a hold: on `entry` (the lower row's), else as picked. One never started is made
/// now; one that ran is moved through the switch path, behind its divider [D241, D245].
fn go(data: &Path, wid: &str, entry: Option<&Value>) -> io::Result<Value> {
    let l = workers::link(data, wid).ok_or_else(|| io::Error::other("not a worker"))?;
    let spec = core::load(data, wid)?;
    let f = core::fold(&spec.dir, true)?.fold;
    // Where it runs now: a move in its row may have taken it to another agent.
    let now = if f.backend.is_empty() {
        &spec.backend
    } else {
        &f.backend
    };
    let backend = entry.map_or(now.clone(), |e| str_of(e, "agent").into());
    let a = adapters::get(&backend).ok_or_else(|| io::Error::other("unknown agent"))?;
    let parent = core::load(data, &l.parent)?;
    let pf = core::fold(&parent.dir, true)?.fold;
    let mut ran = l.ran.clone();
    let (model, effort, account) = match entry {
        Some(e) => {
            let _one = lock(data)?;
            let groups = groups(data, Some(wid));
            let rules = table(data, &groups)["rules"].clone();
            let m = model_of(&groups, &backend, str_of(e, "model"))
                .cloned()
                .unwrap_or_default();
            // Its row's effort within the user's rules, as any pick's [D338].
            let rules = rules.as_array().map_or(&[][..], Vec::as_slice);
            let (effort, capped) = match effort_of(rules, &backend, &m, e["effort"].as_str(), false)
            {
                Ok(x) => x,
                Err(why) => return Ok(json!({"ok": false, "error": "invalid", "message": why})),
            };
            let base = account_for(data, &parent, &pf, &backend);
            let (account, kept) = place(data, a, str_of(e, "model"), &base, &spec.cwd, wid, "\0")
                .unwrap_or_else(|_| {
                    (
                        base.clone(),
                        json!({"label": label(&accounts::load(data), &backend, &base)}),
                    )
                });
            ran = json!({"agent": backend, "model": e["model"], "effort": effort.clone().or(m["default_effort"].as_str().map(String::from)),
                "account": account, "row": e["row"], "name": m.get("name").unwrap_or(&e["model"]),
                "label": kept["label"], "quota": kept["quota"], "capped": capped, "note": "the user chose this row",
                "retry": l.ran["retry"], "failed": l.ran["failed"]});
            (e["model"].as_str().map(String::from), effort, account)
        }
        None => (
            ran["model"].as_str().map(String::from),
            l.ran["effort"].as_str().map(String::from),
            ran["account"].as_str().unwrap_or("").to_string(),
        ),
    };
    if core::fold::switchable(&f).is_some() {
        let to = (a, account, model, effort);
        let reply = crate::switching::switch_to(data, wid, to)?;
        if reply["ok"] == true {
            set_ran(data, wid, ran)?;
        }
        return Ok(reply);
    }
    unhold(
        data,
        &l.parent,
        wid,
        &backend,
        model,
        effort,
        Some(account).filter(|x| !x.is_empty()),
        ran,
    )
}

/// A worker's `ran` after a move within its row or the user's call on its hold [D2037, D2041].
pub(crate) fn set_ran(data: &Path, wid: &str, ran: Value) -> io::Result<()> {
    let mut l = workers::link(data, wid).ok_or_else(|| io::Error::other("not a worker"))?;
    l.ran = ran;
    workers::write_json(&core::session_dir(data, wid).join("worker.json"), &l)
}

/// A worker moved at its limit: its `ran` says where it runs now (`ran` null: as it was), and
/// the turn that carries on (the switch's own cid, `sw-‹ts›`) reports in place of the one cut.
pub(crate) fn moved(data: &Path, wid: &str, ran: Value, f: &Fold) -> io::Result<()> {
    let mut l = workers::link(data, wid).ok_or_else(|| io::Error::other("not a worker"))?;
    if !ran.is_null() {
        l.ran = ran;
    }
    let ts = f.last.as_ref().map_or(Value::Null, |l| l["ts"].clone());
    l.report.pop();
    l.report.push(format!("sw-{ts}"));
    workers::write_json(&core::session_dir(data, wid).join("worker.json"), &l)
}

/// A worker held before it started goes on, on what the user's call gave it: its session, made
/// with no turn yet, takes it, and it's made as any start [D2028]: refused with start's words while
/// its family runs its most [D3001], its hold kept.
#[allow(clippy::too_many_arguments)]
pub(crate) fn unhold(
    data: &Path,
    pid: &str,
    wid: &str,
    backend: &str,
    model: Option<String>,
    effort: Option<String>,
    account: Option<String>,
    ran: Value,
) -> io::Result<Value> {
    let not = || io::Error::other("It isn't held.");
    let root = workers::record(data, pid, wid).ok_or_else(not)?.root;
    {
        let _family = workers::family_lock(data, &root)?;
        // Under the lock, so a Stop or another answer meanwhile wins.
        let mut r =
            (workers::record(data, pid, wid).filter(|r| r.state == "held")).ok_or_else(not)?;
        let all = procs::all();
        if let Some(no) = workers::full(data, &root, &|id| crate::sessions::working(data, id, &all))
        {
            return Ok(no);
        }
        let mut spec = core::load(data, wid)?;
        (spec.backend, spec.model, spec.effort, spec.starts_on) = (
            backend.into(),
            model.clone(),
            effort.clone(),
            account.clone(),
        );
        core::write_atomic(
            &spec.dir.join("session.json"),
            serde_json::to_string_pretty(&spec)?.as_bytes(),
        )?;
        (r.backend, r.model, r.effort, r.account) = (backend.into(), model, effort, account);
        (r.pick, r.hold, r.state) = (ran.clone(), Value::Null, "starting".into());
        workers::save(data, pid, &r)?;
        let mut l = workers::link(data, wid).ok_or_else(|| io::Error::other("not a worker"))?;
        l.ran = ran;
        workers::write_json(&spec.dir.join("worker.json"), &l)?;
    }
    workers::begin(data, pid, wid);
    Ok(json!({"ok": true}))
}
