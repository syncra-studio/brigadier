//! The resolver: a worker's model and account from its job, by quota where the user lets it
//! [D2037, D2040, D2041, D51, D375, D387].

use super::receipt::label;
use super::*;

/// The account work on `agent` takes by D2040: the parent's own on the parent's agent, else that
/// agent's starting account; "" is the computer's login.
pub(super) fn account_for(data: &Path, parent: &Spec, f: &Fold, agent: &str) -> String {
    match agent == models::next_agent(parent, f) {
        true => f.accounts.get(agent).cloned(),
        false => {
            let spec = Spec {
                backend: agent.into(),
                ..Default::default()
            };
            accounts::starting(data, spec).starts_on
        }
    }
    .unwrap_or_default()
}

/// Reservations go when their worker ends, a newer sample of their account arrives, or after
/// C1's hour, whichever is first.
fn prune(data: &Path, held: &mut Value) {
    let now = log::now_ms();
    for (key, list) in held.as_object_mut().into_iter().flatten() {
        let (agent, account) = key.split_once('/').unwrap_or((key, ""));
        let newest = (usage::of(data, agent, account).iter())
            .map(|w| w.at)
            .max()
            .unwrap_or(0);
        if let Some(l) = list.as_array_mut() {
            l.retain(|r| {
                let at = r["at"].as_u64().unwrap_or(0);
                let ended =
                    workers::link(data, str_of(r, "wid")).is_some_and(|l| !l.last.is_null());
                now.saturating_sub(at) < usage::STALE_MS && newest <= at && !ended
            });
        }
    }
}

/// Where `model` of `agent` runs [D2040, D51], under the caller's lock: with automatic switching
/// off, the D2040 account `base` alone, if it has room; on, the account with room whose shortest
/// window resets soonest (`base` kept unless another is more than 5 points ahead, proposed), its
/// pick reserved for `wid`. Room: the shortest window under 90% where it's shorter than a day, each
/// other under 98%, or unknown, and no limit lately. Each live reservation counts on its account's
/// shortest window, 10 points of 5 hours and less of a longer one, until its worker ends, a newer
/// sample comes or an hour passes (proposed, Codex review 3).
/// Its quota at the start, or the soonest reset of those without room. `wid` "": placed only to
/// be shown, nothing reserved (a card the user may never press, D352). `ask`: an account never
/// checked is, which runs its CLI; else it's taken as usable.
#[allow(clippy::too_many_arguments)]
pub(super) fn place(
    data: &Path,
    a: &dyn adapters::Adapter,
    model: &str,
    base: &str,
    cwd: &str,
    wid: &str,
    skip: &str,
    ask: bool,
) -> Result<(String, Value), Option<u64>> {
    let name = a.name();
    let v = accounts::load(data);
    let auto = listed(&v, "auto", name) && a.accounts().is_some();
    let mut held = read(&data.join(RESERVED));
    prune(data, &mut held);
    let ids: Vec<String> = match auto {
        true => (accounts_of(&v, name).into_iter().map(|(id, _)| id))
            .filter(|id| id != skip)
            // Its last check's word, so a pick makes no sample newer than the reservations.
            .filter(|id| {
                usage::usable(data, name, id)
                    .unwrap_or_else(|| !ask || accounts::usable(&accounts::check(a, data, id, cwd)))
            })
            .collect(),
        false => (base != skip)
            .then(|| base.to_string())
            .into_iter()
            .collect(),
    };
    let now = log::now_ms();
    let mut soonest: Option<u64> = None;
    let mut room = vec![];
    for id in ids {
        let key = format!("{name}/{id}");
        let n = if auto {
            held[&key].as_array().map_or(0, Vec::len)
        } else {
            0
        } as u32;
        let ws: Vec<usage::Window> = (usage::of(data, name, &id).into_iter())
            .filter(|w| {
                w.models
                    .as_ref()
                    .is_none_or(|m| m.iter().any(|x| x == model))
            })
            .collect();
        // A limit lately keeps it out until its time unless a sample newer than the mark says
        // otherwise: one model's window at its limit leaves another with room on the account.
        let marked = v["limited_at"][&key].as_u64().unwrap_or(0);
        let known = ws.iter().any(|w| w.used.is_some() && w.at > marked);
        if let Some(until) = v["limited"][&key].as_u64().filter(|u| now < *u && !known) {
            soonest = Some(soonest.map_or(until, |s| s.min(until)));
            continue;
        }
        // Every window it runs under: the shortest at 90 unless it's a day or more, each other at
        // 98, reservations counted on the shortest only, by its length [D343].
        let short = ws.iter().min_by_key(|w| w.minutes.unwrap_or(u64::MAX));
        let shortest = |w: &usage::Window| short.is_some_and(|s| s.minutes == w.minutes);
        let taken =
            |w: &usage::Window| (3000 * n).div_ceil(w.minutes.unwrap_or(300).max(300) as u32);
        let used = |w: &usage::Window| w.used.map(|u| u + if shortest(w) { taken(w) } else { 0 });
        let brief = |w: &usage::Window| w.minutes.is_none_or(|m| m < 24 * 60);
        let most = |w: &usage::Window| if shortest(w) && brief(w) { 90 } else { 98 };
        let full = ws.iter().find(|w| used(w).is_some_and(|u| u >= most(w)));
        if let Some(w) = full {
            let at = w.resets;
            soonest = at.map_or(soonest, |at| Some(soonest.map_or(at, |s| s.min(at))));
            continue;
        }
        let quota = short.filter(|w| w.used.is_some()).map_or(
            Value::Null,
            |w| json!({"name": w.name, "used": w.used, "resets": w.resets}),
        );
        let rank = (
            short.and_then(|w| w.resets).unwrap_or(u64::MAX),
            short.and_then(used).unwrap_or(10 * n),
        );
        room.push((id, rank, quota));
    }
    room.sort_by_key(|r| r.1);
    let first = room.first().ok_or(soonest)?;
    let kept = room.iter().find(|r| r.0 == base && r.1.1 <= first.1.1 + 5);
    let (id, _, quota) = kept.unwrap_or(first).clone();
    if auto && !wid.is_empty() {
        // One per worker: an answer tried again, or a move, replaces its last.
        for list in held
            .as_object_mut()
            .into_iter()
            .flat_map(|m| m.values_mut())
        {
            if let Some(l) = list.as_array_mut() {
                l.retain(|r| r["wid"] != wid);
            }
        }
        let key = format!("{name}/{id}");
        if !held[&key].is_array() {
            held[&key] = json!([]);
        }
        held[&key]
            .as_array_mut()
            .unwrap()
            .push(json!({"wid": wid, "at": now}));
        let _ = core::write_atomic(&data.join(RESERVED), held.to_string().as_bytes());
    }
    let label = label(&v, name, &id);
    Ok((id, json!({"label": label, "quota": quota})))
}

/// A worker's pick [D2037]: what it runs, and what its `ran` keeps beside that for its life (its
/// job, the account's name and quota at the start, and the next-entry note) [D2041, D3018]; with
/// `hold` set when its job is out [D2028].
pub(crate) struct Pick {
    pub agent: String,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub account: Option<String>,
    pub ran: Value,
    pub hold: Value,
}

/// The pick for a worker of `parent` [D339, D387]: the agent's `--model` when it's allowed
/// (refused with the reason otherwise, never replaced), else its `--job`'s order; the first entry
/// with an account that has room, a later one with a note [D375]. A start naming neither is
/// refused with the user's jobs. `--agent` takes the job's entries on it, else its
/// default model; `--effort` applies to the entry taken [D392 P4]. Runs under the data dir's lock,
/// so the reservation it makes is seen by the next. A review's (`review`: its authors' agents) is
/// the Review job's first entry on another agent, at its effort, high where it names none; it never holds:
/// none placed, it doesn't run [D385, D3026].
/// Where the agent finds the models that make images.
const DRAWING: &str = "`brigadier models` marks the ones that make images.";

pub(crate) fn resolve(
    data: &Path,
    me: &str,
    parent: &Spec,
    f: &Fold,
    flags: &dyn Fn(&str) -> Option<String>,
    wid: &str,
    review: Option<&[String]>,
) -> Result<Pick, Value> {
    let refuse = |m: &str| workers::refuse(m);
    let (agent, model, effort) = (flags("--agent"), flags("--model"), flags("--effort"));
    // Image work goes only to a model that makes images, on no job [D298].
    let images = flags("--images").is_some();
    let _one = lock(data).map_err(|e| refuse(&e.to_string()))?;
    let groups = groups(data, Some(me));
    let t = table(data, &groups);
    let rules = t["rules"].as_array().cloned().unwrap_or_default();
    let all = jobs::all(&read(&data.join(FILE)), &groups);
    let asked = if review.is_some() {
        Some(jobs::REVIEW.into())
    } else {
        flags("--job")
    };
    let job = asked.as_deref().and_then(|j| jobs::named(&all, j)).cloned();
    if review.is_none() && !images && (job.is_none() && (asked.is_some() || model.is_none())) {
        return Err(refuse(&jobs::refusal(&all)));
    }
    let name = job.as_ref().map(|j| str_of(j, "name").to_string());
    let mine = models::next_agent(parent, f).to_string();
    let by: Vec<String> = (review.into_iter().flatten())
        .map(|a| {
            adapters::get(a)
                .map_or(a.as_str(), |x| x.short_label())
                .to_string()
        })
        .collect();
    let mut passed = false;
    let list = match &model {
        Some(m) => {
            let a = agent.clone().unwrap_or(mine);
            vec![json!({"agent": a, "model": m, "effort": effort})]
        }
        None if images => jobs::drawing(&groups, &t["images"]),
        None => {
            let mut list = job
                .as_ref()
                .and_then(|j| j["entries"].as_array().cloned())
                .unwrap_or_default();
            // A retry's next step: the entries after the one that ran [D350].
            if let Some(ran) =
                flags("job-after").and_then(|x| serde_json::from_str::<Value>(&x).ok())
            {
                let at = list
                    .iter()
                    .position(|e| e["agent"] == ran["agent"] && e["model"] == ran["model"]);
                list.drain(..at.map_or(0, |i| i + 1));
            }
            if let Some(authors) = review {
                // Never on its author's agent [D385]; overnight last, with nobody to ask for another.
                let theirs = |e: &Value| authors.iter().any(|a| e["agent"] == a.as_str());
                let (own, others): (Vec<_>, Vec<_>) = list.into_iter().partition(theirs);
                (list, passed) = (others, !own.is_empty());
                if crate::overnight::of(data, me).is_some() {
                    list.extend(own);
                }
                // The switch's reviewers that failed or met their limit are passed by [D3026].
                let gone = flags("review-tried").and_then(|t| serde_json::from_str(&t).ok());
                let gone: Vec<Value> = gone.unwrap_or_default();
                list.retain(|e| !gone.contains(&json!({"agent": e["agent"], "model": e["model"]})));
            }
            if let Some(a) = &agent {
                list.retain(|e| e["agent"] == a.as_str());
                list.extend(
                    list.is_empty()
                        .then(|| jobs::default_of(&groups, Some(a)))
                        .flatten(),
                );
                if list.is_empty() {
                    return Err(refuse(&format!(
                        "{a:?} isn't an agent you may use. `brigadier models` lists them."
                    )));
                }
            }
            for e in list.iter_mut().filter(|_| effort.is_some()) {
                e["effort"] = json!(effort);
            }
            list
        }
    };
    let v = accounts::load(data);
    let (mut first, mut out, mut soonest) = (None, vec![], None::<u64>);
    // Every entry passed by, and why: never skipped in silence [D375].
    let mut by_why: Vec<(String, &str)> = vec![];
    for e in &list {
        let (a, id) = (str_of(e, "agent"), str_of(e, "model"));
        let m = match allowed(data, &groups, &rules, a, id) {
            Ok(m) => m,
            Err(why) if model.is_some() => return Err(refuse(&why)),
            Err(_) => {
                by_why.push(unusable(data, &groups, &rules, a, id));
                continue;
            }
        };
        if images && m["draws"] != true {
            if model.is_some() {
                return Err(refuse(&format!("{id} doesn't make images. {DRAWING}")));
            }
            continue;
        }
        let high = (m["efforts"].as_array().into_iter().flatten()).any(|x| x == "high");
        let want = (e["effort"].as_str()).or((review.is_some() && high).then_some("high"));
        // An effort a job's entry lacks passes it by, as a model it can't run does [D375].
        let (runs_at, capped) = match effort_of(&rules, a, m, want) {
            Ok(e) => e,
            Err(why) if model.is_some() => return Err(refuse(&why)),
            Err(_) => {
                let shown = m.get("name").unwrap_or(&m["id"]).as_str().unwrap_or(id);
                by_why.push((shown.into(), NO_EFFORT));
                continue;
            }
        };
        let Some(adapter) = adapters::get(a) else {
            continue;
        };
        let base = account_for(data, parent, f, a);
        let shown = m.get("name").unwrap_or(&m["id"]).clone();
        let mut pick = Pick {
            agent: a.into(),
            model: Some(id.into()),
            effort: runs_at.clone(),
            account: Some(base.clone()).filter(|b| !b.is_empty()),
            ran: json!({"job": name, "name": shown, "label": label(&v, a, &base), "quota": null,
                "effort": runs_at.or(m["default_effort"].as_str().map(String::from)), "capped": capped}),
            hold: Value::Null,
        };
        if images {
            pick.ran["images"] = true.into();
        }
        if passed && !review.is_some_and(|by| by.iter().any(|x| x == a)) {
            // Its why line: "the first in Review on another agent than Claude" [D385].
            pick.ran["other_than"] = jobs::and(&by).into();
        }
        match place(data, adapter, id, &base, &parent.cwd, wid, "\0", true) {
            Ok((account, kept)) => {
                pick.account = Some(account).filter(|x| !x.is_empty());
                (pick.ran["label"], pick.ran["quota"]) =
                    (kept["label"].clone(), kept["quota"].clone());
                if let Some(job) = name.as_ref().filter(|_| !by_why.is_empty()) {
                    pick.ran["note"] =
                        format!("{}, so the next in {job} ran", jobs::reasons(&by_why)).into();
                }
                return Ok(pick);
            }
            Err(at) => {
                out.push(shown.as_str().unwrap_or(id).to_string());
                by_why.push((shown.as_str().unwrap_or(id).into(), FULL));
                soonest = at.map_or(soonest, |at| Some(soonest.map_or(at, |s| s.min(at))));
                first.get_or_insert(pick);
            }
        }
    }
    if review.is_some() {
        // Full ones, or none there at all (or none left after those that failed).
        let room = if out.is_empty() {
            "is left"
        } else {
            "has room"
        };
        return Err(refuse(&format!(
            "Review didn't run: no model in your {} job on another agent than {} {room}.",
            jobs::REVIEW,
            jobs::and(&by)
        )));
    }
    let Some(mut pick) = first else {
        if images {
            return Err(refuse(&format!(
                "No model you may use makes images. {DRAWING}"
            )));
        }
        let why = match by_why.is_empty() {
            true => String::new(),
            false => format!(" {}.", jobs::reasons(&by_why)),
        };
        return Err(refuse(&format!(
            "No model in your {} job is one you may use: Settings › Routing sets it.{why}",
            name.unwrap_or_default()
        )));
    };
    let why = match &name {
        Some(j) => format!("{j}'s models are at their limit"),
        None => format!("{} is at its limit", out.join(", ")),
    };
    pick.hold = json!({"job": name, "why": why, "out": jobs::and(&out), "resets": soonest,
        "use": super::hold::other(data, &groups, &t, name.as_deref(), parent, f)});
    Ok(pick)
}

/// A worker at its limit moves within its own job [D2037, D2041, D375]: another account on the same
/// model where automatic switching is on for its agent [D51], else the job's next entry the user
/// allows with an account that has room; none, and it holds for the user's call [D2028].
pub(crate) fn next(
    data: &Path,
    wid: &str,
    spec: &Spec,
    f: &Fold,
    cur: &str,
) -> io::Result<Option<(crate::switching::To, Value)>> {
    let Some(l) = workers::link(data, wid) else {
        return Ok(None);
    };
    let parent = core::load(data, &l.parent)?;
    let pf = core::fold(&parent.dir, true)?.fold;
    let _one = lock(data)?;
    let groups = groups(data, Some(wid));
    let t = table(data, &groups);
    let rules = t["rules"].as_array().cloned().unwrap_or_default();
    let backend = if f.backend.is_empty() {
        &spec.backend
    } else {
        &f.backend
    };
    let now = f
        .models
        .get(backend)
        .cloned()
        .or(spec.model.clone())
        .unwrap_or_default();
    let all = jobs::all(&read(&data.join(FILE)), &groups);
    let job = (l.ran["job"].as_str()).and_then(|j| jobs::named(&all, j));
    let images = l.ran["images"] == true;
    let list = match job {
        _ if images => jobs::drawing(&groups, &t["images"]),
        Some(j) => j["entries"].as_array().cloned().unwrap_or_default(),
        None => vec![],
    };
    let job = job.map(|j| str_of(j, "name").to_string());
    let at = list
        .iter()
        .position(|e| e["agent"] == backend.as_str() && e["model"] == now.as_str());
    let same = json!({"agent": backend, "model": now, "effort": l.ran["effort"]});
    let v = accounts::load(data);
    let mut out = vec![str_of(&l.ran, "name").to_string()];
    let mut by_why = vec![(out[0].clone(), FULL)];
    let mut soonest = None::<u64>;
    let mut tries: Vec<(Value, bool)> = vec![(same, true)];
    tries.extend(
        list.into_iter()
            .skip(at.map_or(0, |i| i + 1))
            .filter(|e| !(e["agent"] == backend.as_str() && e["model"] == now.as_str()))
            .map(|e| (e, false)),
    );
    for (e, same) in tries {
        let (a, id) = (str_of(&e, "agent"), str_of(&e, "model"));
        let Ok(m) = allowed(data, &groups, &rules, a, id) else {
            if !same {
                by_why.push(unusable(data, &groups, &rules, a, id));
            }
            continue;
        };
        let Some(adapter) = adapters::get(a).filter(|_| !images || m["draws"] == true) else {
            continue;
        };
        // The same model only on another account, where its agent places by quota [D51].
        if same && !listed(&v, "auto", a) {
            continue;
        }
        let Ok((runs_at, capped)) = effort_of(&rules, a, m, e["effort"].as_str()) else {
            continue;
        };
        let base = account_for(data, &parent, &pf, a);
        let skip = if same { cur } else { "\0" };
        match place(data, adapter, id, &base, &spec.cwd, wid, skip, true) {
            Ok((account, kept)) => {
                let name = m.get("name").unwrap_or(&m["id"]).clone();
                let note = match same {
                    true => format!(
                        "{} hit its limit, so it went on with another account",
                        out[0]
                    ),
                    false if images => format!(
                        "{} had no account with room, so another model that makes images ran",
                        jobs::and(&out)
                    ),
                    false => format!(
                        "{}, so the next in {} ran",
                        jobs::reasons(&by_why),
                        job.as_deref().unwrap_or("")
                    ),
                };
                // Said outright, so another model never keeps the last one's effort.
                let effort = runs_at.or(m["default_effort"].as_str().map(String::from));
                let mut ran = json!({"agent": a, "model": id, "account": account, "job": job, "name": name,
                    "effort": effort, "label": kept["label"], "quota": kept["quota"], "capped": capped, "note": note});
                if images {
                    ran["images"] = true.into();
                }
                return Ok(Some(((adapter, account, Some(id.into()), effort), ran)));
            }
            Err(r) => {
                if !same && out.last().is_none_or(|x| x != id) {
                    let name = m.get("name").unwrap_or(&m["id"]).as_str().unwrap_or(id);
                    out.push(name.into());
                    by_why.push((name.into(), FULL));
                }
                soonest = r.map_or(soonest, |r| Some(soonest.map_or(r, |s| s.min(r))));
            }
        }
    }
    let why = match &job {
        Some(j) => format!("{j}'s models are at their limit"),
        None => format!("{} is at its limit", out[0]),
    };
    let resets = soonest.or(f.resets);
    let hold = json!({"job": job, "why": why, "out": jobs::and(&out), "resets": resets,
            "use": super::hold::other(data, &groups, &t, job.as_deref(), &parent, &pf)});
    drop(_one);
    ask(data, wid, &hold)?;
    Ok(None)
}
