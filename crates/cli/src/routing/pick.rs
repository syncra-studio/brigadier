//! The resolver: a worker's model and account from its job, by quota where the user lets it
//! [D2037, D2040, D2041, D51, D375, D387].

use super::place::{account_for, fell_back, place};
use super::receipt::label;
use super::*;

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
    // The switch's reviewers already tried, for the next one's why line.
    let mut tried: Vec<String> = vec![];
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
                list.retain(|e| {
                    let out = gone.contains(&json!({"agent": e["agent"], "model": e["model"]}));
                    if out {
                        tried.push(str_of(e, "model").to_string());
                    }
                    !out
                });
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
    let mut by_why: Vec<(String, &str)> = (tried.into_iter()).map(|m| (m, TRIED_REVIEW)).collect();
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
                // Decided by where it was placed, so a switch onto another account says nothing [C36].
                match fell_back(data, parent, f, a, &account) {
                    Err(why) if model.is_some() => return Err(refuse(&why)),
                    Err(_) => {
                        by_why.push((shown.as_str().unwrap_or(id).into(), NO_LOGIN));
                        continue;
                    }
                    Ok(why) => pick.ran["fell_back"] = why.into(),
                }
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
                if first.is_none() {
                    // Held on its D2040 account: a Wait goes on there, and says why then.
                    pick.ran["fell_back"] =
                        fell_back(data, parent, f, a, &base).ok().flatten().into();
                }
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
        // Signed out everywhere is Providers' to fix, not Routing's.
        let fix = match !by_why.is_empty() && by_why.iter().all(|w| w.1 == NO_LOGIN) {
            true => "has a signed-in account: Providers signs you in",
            false => "is one you may use: Settings › Routing sets it",
        };
        return Err(refuse(&format!(
            "No model in your {} job {fix}.{why}",
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
        let placed = place(data, adapter, id, &base, &spec.cwd, wid, skip, true);
        // A move onto the login its Use pick fell back to says so, as a start does (proposed).
        let placed = placed.map(|(x, kept)| (fell_back(data, &parent, &pf, a, &x), x, kept));
        if let Ok((Err(_), ..)) = placed {
            let name = m.get("name").unwrap_or(&m["id"]).as_str().unwrap_or(id);
            by_why.push((name.into(), NO_LOGIN));
            continue;
        }
        match placed {
            Ok((why, account, kept)) => {
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
                ran["fell_back"] = why.ok().flatten().into();
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
