//! A worker held for the user's call, its job out of quota: Rust's question on its card, the
//! parent told once, and the answer that lets it go on [D2028, D342, D388 Q7].

use super::pick::{account_for, place};
use super::receipt::label;
use super::*;
use brigadier_frames::procs;
use std::collections::BTreeSet;
use std::sync::Mutex;

/// "Claude · Sonnet 5.5 · High": an entry as its card names it.
fn words(e: &Value) -> String {
    let agent = adapters::get(str_of(e, "agent")).map_or(str_of(e, "agent"), |a| a.short_label());
    let model = e["name"].as_str().unwrap_or(str_of(e, "model"));
    let effort = e["effort"]
        .as_str()
        .map_or(String::new(), |x| format!(" · {}", capital(x)));
    format!("{agent} · {model}{effort}")
}

/// The hold's "Use …" [D388 Q7, D392 P6]: the first model the rules allow with room, from the
/// other jobs in order, at `job`'s first effort, or the model's default where it lacks that one.
/// Only shown, nothing reserved; none for a worker with no job.
pub(super) fn other(
    data: &Path,
    groups: &[Value],
    t: &Value,
    job: Option<&str>,
    parent: &Spec,
    f: &Fold,
) -> Value {
    let all = t["jobs"].as_array().map_or(&[][..], Vec::as_slice);
    let Some(own) = job.and_then(|j| jobs::named(all, j)) else {
        return Value::Null;
    };
    let mine = own["entries"].as_array().cloned().unwrap_or_default();
    let want = mine.first().and_then(|e| e["effort"].as_str());
    let rules = t["rules"].as_array().cloned().unwrap_or_default();
    (all.iter().filter(|j| j["name"] != own["name"]))
        .flat_map(|j| j["entries"].as_array().cloned().unwrap_or_default())
        .filter(|e| !mine.contains(e))
        .find_map(|e| {
            let (a, id) = (str_of(&e, "agent"), str_of(&e, "model"));
            let m = allowed(data, groups, &rules, a, id).ok()?;
            let has = |w: &&str| (m["efforts"].as_array().into_iter().flatten()).any(|x| x == w);
            let (effort, _) = effort_of(&rules, a, m, want.filter(has), false).ok()?;
            let base = account_for(data, parent, f, a);
            place(data, adapters::get(a)?, id, &base, &parent.cwd, "", "\0", true).ok()?;
            let effort = effort.or(m["default_effort"].as_str().map(String::from));
            Some(json!({"agent": a, "model": id, "effort": effort, "name": m.get("name").unwrap_or(&m["id"])}))
        })
        .unwrap_or_default()
}

/// Asks the user on worker `wid`'s own card, with Rust's question, and tells its parent once
/// [D2028, D342]: "Use ‹the first model with room in another job›" and "Wait until ‹reset›", only
/// Wait with none [D388 Q7]. The parent keeps working; only the user settles it.
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
    let to = &hold["use"];
    let why = str_of(hold, "why");
    let job = hold["job"].as_str();
    // Past a retry's ladder: retry on the job's first, or stop here [D2037, D350].
    if hold["retry"] == true {
        let from = job.map_or("The model it ran on".into(), |j| {
            format!("The first in {j}")
        });
        let options = json!([
            {"label": format!("Retry on {}", words(to)), "description": from},
            {"label": "Stop here", "description": "It doesn't run again"}]);
        let item = json!({"text": format!("{why}. How should it go on?"), "options": options,
            "recommended": null, "multiSelect": false});
        let request = json!({"id": id, "title": "Out of retries", "items": [item], "held": true});
        let note = json!({"event": "hold", "phase": "asked", "id": id, "why": why, "retry": true,
            "use": to, "job": job, "request": request});
        owner::call(data, wid, json!({"op": "note", "data": note}))?;
        return workers::told_held(data, wid, &id, why);
    }
    let mut options = vec![
        json!({"label": format!("Wait until {when}"), "description": "Then it starts as picked"}),
    ];
    if to.is_object() {
        options.push(json!({"label": format!("Use {}", words(to)),
            "description": format!("Has room; it's not in {}", job.unwrap_or(""))}));
    }
    let out = hold["out"]
        .as_str()
        .filter(|o| !o.is_empty() && job.is_some());
    let text = format!(
        "{why} until {when}{}. How should it go on?",
        out.map_or(String::new(), |o| format!(": {o}"))
    );
    let item = json!({"text": text, "options": options, "recommended": null, "multiSelect": false});
    // `held`: its card offers only these answers, no words of the user's and no Skip.
    let request = json!({"id": id, "title": "Out of quota", "items": [item], "held": true});
    let note = json!({"event": "hold", "phase": "asked", "id": id, "why": why, "resets": until,
        "use": to, "job": job, "request": request});
    owner::call(data, wid, json!({"op": "note", "data": note}))?;
    workers::told_held(data, wid, &id, &format!("{why}, resets {when}"))
}

/// The user's answer on a hold's card: "Use …" runs its model now, "Wait …" waits for
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
    // A card from before jobs named its model `lower`; it still answers.
    let to = if hold["use"].is_object() {
        &hold["use"]
    } else {
        &hold["lower"]
    };
    if hold["retry"] == true {
        let reply = match choice.starts_with("Retry on ") {
            true => go(data, wid, Some(to))?,
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
    let used = choice.starts_with("Use ") && to.is_object();
    let phase = if used { "answered" } else { "waiting" };
    let note = json!({"event": "hold", "phase": phase, "id": request, "choice": choice,
        "resets": hold["resets"], "use": to, "job": hold["job"]});
    let reply = match used {
        true => go(data, wid, Some(to))?,
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

/// A stopped worker's hold card goes, by its id as its own answer's does, its wait with it. One
/// the user ended before it ever ran has no turn to report: this is its one result [D364].
pub(crate) fn stopped(data: &Path, wid: &str, by: &str) {
    let Ok(f) = core::fold(&core::session_dir(data, wid), true).map(|f| f.fold) else {
        return;
    };
    let Some(hold) = f.hold.filter(|_| by == "user") else {
        return;
    };
    let choice = if hold["retry"] == true {
        "Stop here"
    } else {
        "Stop"
    };
    let note = json!({"event": "hold", "phase": "answered", "id": hold["id"], "choice": choice});
    let _ = owner::call(data, wid, json!({"op": "note", "data": note}));
    if f.cids.is_empty() {
        let _ = workers::unrun(data, wid);
    }
}

/// The daemon's: worker `wid`'s wait is over, so it goes on, off the loop and once at a time.
pub(crate) fn due(data: &Path, wid: &str) {
    static GOING: Mutex<BTreeSet<String>> = Mutex::new(BTreeSet::new());
    if !GOING.lock().unwrap().insert(wid.into()) {
        return;
    }
    let (data, wid) = (data.to_path_buf(), wid.to_string());
    std::thread::spawn(move || {
        if let Err(e) = resume(&data, &wid) {
            eprintln!("brigadierd: hold {wid}: {e}");
        }
        GOING.lock().unwrap().remove(&wid);
    });
}

/// A hold whose reset has passed goes on as picked.
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

/// Goes on after a hold: on `entry` (the card's), else as picked. One never started is made
/// now; one that ran is moved through the switch path, behind its divider [D241, D245].
fn go(data: &Path, wid: &str, entry: Option<&Value>) -> io::Result<Value> {
    let l = workers::link(data, wid).ok_or_else(|| io::Error::other("not a worker"))?;
    let spec = core::load(data, wid)?;
    let f = core::fold(&spec.dir, true)?.fold;
    // Where it runs now: a move in its job may have taken it to another agent.
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
            // The card's effort within the user's rules, as any pick's [D338].
            let rules = rules.as_array().map_or(&[][..], Vec::as_slice);
            let (effort, capped) = match effort_of(rules, &backend, &m, e["effort"].as_str(), false)
            {
                Ok(x) => x,
                Err(why) => return Ok(json!({"ok": false, "error": "invalid", "message": why})),
            };
            let base = account_for(data, &parent, &pf, &backend);
            let (account, kept) = place(
                data,
                a,
                str_of(e, "model"),
                &base,
                &spec.cwd,
                wid,
                "\0",
                true,
            )
            .unwrap_or_else(|_| {
                (
                    base.clone(),
                    json!({"label": label(&accounts::load(data), &backend, &base)}),
                )
            });
            // It keeps its job (or a row from before jobs), its retry and what failed.
            let effort_ran = effort
                .clone()
                .or(m["default_effort"].as_str().map(String::from));
            let now = json!({"agent": backend, "model": e["model"], "effort": effort_ran, "account": account,
                "name": m.get("name").unwrap_or(&e["model"]), "label": kept["label"], "quota": kept["quota"],
                "capped": capped, "note": "the user chose this model"});
            for (k, v) in now.as_object().into_iter().flatten() {
                ran[k] = v.clone();
            }
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

/// A worker's `ran` after a move within its job or the user's call on its hold [D2037, D2041].
pub(crate) fn set_ran(data: &Path, wid: &str, ran: Value) -> io::Result<()> {
    let mut l = workers::link(data, wid).ok_or_else(|| io::Error::other("not a worker"))?;
    l.ran = ran;
    workers::write_json(&core::session_dir(data, wid).join("worker.json"), &l)
}

/// The model its CLI said a worker's pick runs, by its own id, kept on its `ran` once: a move
/// replaces `ran` [D383].
pub(crate) fn real(dir: &Path, ran: &mut Value) {
    let given = core::fold(dir, true).ok().and_then(|f| f.fold.given);
    let real = given.as_ref().and_then(|g| g["real"].as_str());
    if let Some(r) = real.filter(|_| ran.is_object() && ran["real"].is_null()) {
        ran["real"] = r.into();
    }
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
