//! Brigadier's offers [D383, D386]: from the CLIs' own model lists, what the last read saw
//! (`seen`) and the user's own results; never web data or shipped scores [D2037], and nothing
//! changes without the user's yes [D2038]. Worked out on each `routing` read, under its lock.
//! Agents never see them: `brigadier models` and the lead text read the plain table.

use super::*;

const DAY: u64 = 24 * 3600 * 1000;
/// "Not now" hides an offer this long [D386].
const LATER: u64 = 7 * DAY;
/// Counted runs each model needs in a job before (b) compares them [D386].
const RUNS: u64 = 20;

/// "agent/id", as offers and `refused` name a model.
fn key(agent: &str, id: &str) -> String {
    format!("{agent}/{id}")
}

fn split(k: &str) -> (&str, &str) {
    k.split_once('/').unwrap_or((k, ""))
}

fn entry_key(e: &Value) -> String {
    key(str_of(e, "agent"), str_of(e, "model"))
}

fn holds(job: &Value, k: &str) -> bool {
    (job["entries"].as_array().into_iter().flatten()).any(|e| entry_key(e) == k)
}

fn listed<'a>(groups: &'a [Value], k: &str) -> Option<&'a Value> {
    let (agent, id) = split(k);
    model_of(groups, agent, id)
}

/// A model whose agent lists its models now and not this one.
fn gone(groups: &[Value], k: &str) -> bool {
    let agent = split(k).0;
    groups.iter().any(|g| g["provider"] == agent) && listed(groups, k).is_none()
}

fn name(groups: &[Value], k: &str) -> String {
    let id = split(k).1;
    listed(groups, k)
        .map_or(id, |m| m["name"].as_str().unwrap_or(id))
        .into()
}

fn label(agent: &str) -> &str {
    adapters::get(agent).map_or(agent, |a| a.short_label())
}

/// A name's family, its version cut and case, spaces and hyphens dropped, and its version:
/// "GPT-6.2-Sol" → ("gptsol", [6, 2]).
pub(super) fn family(name: &str) -> Option<(String, Vec<u32>)> {
    let (f, v) = adapters::versioned(name)?;
    Some((f.to_lowercase().replace([' ', '-'], ""), v))
}

/// "GPT-Sol" from "GPT-6.2-Sol": the name with its version token and one separator cut.
fn family_words(name: &str) -> String {
    let token = name
        .split([' ', '-'])
        .find(|t| t.split('.').all(|p| p.parse::<u32>().is_ok()));
    token.map_or(name.into(), |t| {
        let at = name.find(t).unwrap_or(0);
        let (head, tail) = (&name[..at], &name[at + t.len()..]);
        match head.chars().last() {
            Some(' ' | '-') => format!("{}{tail}", &head[..head.len() - 1]),
            _ => format!("{head}{}", tail.trim_start_matches([' ', '-'])),
        }
    })
}

/// The Wilson 95% range of `kept` of `of`, as fractions.
fn wilson(kept: u64, of: u64) -> (f64, f64) {
    let (z, n) = (1.96f64, of as f64);
    let p = kept as f64 / n;
    let d = 1.0 + z * z / n;
    let mid = (p + z * z / (2.0 * n)) / d;
    let half = z * (p * (1.0 - p) / n + z * z / (4.0 * n * n)).sqrt() / d;
    (mid - half, mid + half)
}

/// Whether `a` (kept, of) clearly beat `b`: both counted enough, their ranges apart.
fn beat(a: (u64, u64), b: (u64, u64)) -> bool {
    a.1 >= RUNS && b.1 >= RUNS && wilson(a.0, a.1).0 > wilson(b.0, b.1).1
}

/// New facts in one agent's list since the last read: (a) a newer model of a family a job holds,
/// the alias notice, (c) a mark moved to a model no job holds. `moved` takes each alias's move.
fn found(
    groups: &[Value],
    agent: &str,
    models: &[Value],
    was: &Value,
    jobs: &[Value],
    moved: &mut Value,
    now: u64,
) -> Vec<Value> {
    let mut out = vec![];
    let old_names: Vec<(String, &str)> = (was["names"].as_object().into_iter().flatten())
        .filter_map(|(id, n)| Some((id.clone(), n.as_str()?)))
        .collect();
    let replaced = renamed::replaced(groups, agent, was);
    let seen = |id: &str| (was["ids"].as_array().into_iter().flatten()).any(|x| x == id);
    for m in models {
        let (id, now_name) = (str_of(m, "id"), str_of(m, "name"));
        let k = key(agent, id);
        // (a): new since the last read, not legacy or retiring, a higher version of one a job holds.
        if !seen(id)
            && m["legacy"] != true
            && m["retiring"].is_null()
            && let Some((fam, version)) = family(now_name)
        {
            for j in jobs {
                let older = (j["entries"].as_array().into_iter().flatten())
                    .filter(|e| e["agent"] == agent)
                    .find(|e| {
                        let n = (models.iter())
                            .find(|x| x["id"] == e["model"])
                            .map_or("", |x| str_of(x, "name"));
                        family(n).is_some_and(|(f, v)| f == fam && v < version)
                    });
                if let Some(e) = older {
                    out.push(json!({"job": j["name"], "kind": "newer", "from": entry_key(e), "to": k, "at": now}));
                }
            }
        }
        // The alias notice [D388 Q15], on the first job that holds it: the same id now runs a new
        // version of its family, or it took the place of one gone.
        let same = (old_names.iter()).find(|(x, n)| x == id && *n != now_name);
        let before = same.or_else(|| replaced.iter().find(|(x, _)| x == id));
        let (before, took) = (before.map(|(_, n)| *n), same.is_none());
        if let Some(was_name) = before.filter(|n| *n != now_name)
            && family(was_name)
                .zip(family(now_name))
                .is_some_and(|(a, b)| a.0 == b.0)
        {
            (!took).then(|| moved[id] = now.into());
            if let Some(j) = jobs.iter().find(|j| holds(j, &k)) {
                out.push(
                    json!({"job": j["name"], "kind": "alias", "from": k, "to": k,
                    "was": was_name, "now": now_name, "took": took, "at": now}),
                );
            }
        }
    }
    // (c): the default or top mark now on a model no job holds.
    for mark in ["default", "top"] {
        let new = models
            .iter()
            .find(|m| m[mark] == true)
            .map(|m| str_of(m, "id"));
        let (Some(new), Some(old)) = (new, was[mark].as_str()) else {
            continue;
        };
        let (to, from) = (key(agent, new), key(agent, old));
        if new == old || jobs.iter().any(|j| holds(j, &to)) {
            continue;
        }
        let mut on: Vec<Value> = (jobs.iter().filter(|j| holds(j, &from)))
            .map(|j| j["name"].clone())
            .collect();
        if on.is_empty() {
            on.push(Value::Null);
        }
        for job in on {
            out.push(json!({"job": job, "kind": "mark", "mark": mark, "from": from, "to": to, "at": now}));
        }
    }
    out
}

/// The real model each of `agent`'s entries runs now [D392 P7]: the latest `ran.real` of a worker
/// started on it since its alias last moved; the alias itself where none says and it never
/// moved; none (compare nothing) where it moved and no worker has run on it since.
fn real(links: &[workers::Link], seen: &Value, agent: &str, model: &str) -> Option<String> {
    let since = seen[agent]["moved"][model].as_u64();
    let latest = (links.iter())
        .filter(|l| l.ran["agent"] == agent && l.ran["model"] == model && l.ran["real"].is_string())
        .filter(|l| since.is_none_or(|s| l.at >= s))
        .max_by_key(|l| l.at)
        .map(|l| str_of(&l.ran, "real").to_string());
    match since {
        Some(_) => latest,
        None => latest.or(Some(model.into())),
    }
}

/// (b): in each job, a model lower in its list that clearly beat one above it, by the user's own
/// results there; moved up past the highest it beat, never removed [D386].
fn results(data: &Path, jobs: &[Value], seen: &Value, groups: &[Value], r: &Value) -> Vec<Value> {
    let links: Vec<workers::Link> = (core::ids(data).iter())
        .filter_map(|w| workers::link(data, w))
        .filter(|l| !l.session)
        .collect();
    let mut out = vec![];
    for j in jobs {
        let job = str_of(j, "name");
        let Some(tally) = (r["jobs"].as_array().into_iter().flatten()).find(|t| t["job"] == job)
        else {
            continue;
        };
        let counts = |e: &Value| {
            let agent = str_of(e, "agent");
            let real = real(&links, seen, agent, str_of(e, "model"))?;
            let m = (tally["models"].as_array().into_iter().flatten())
                .find(|m| m["agent"] == agent && m["model"] == real.as_str())?;
            Some((m["kept"].as_u64()?, m["of"].as_u64()?))
        };
        let entries = j["entries"].as_array().cloned().unwrap_or_default();
        let runs: Vec<Option<(u64, u64)>> = entries.iter().map(counts).collect();
        for (low, l) in runs.iter().enumerate() {
            let Some(l) = l else { continue };
            let Some((up, u)) = (runs[..low].iter().enumerate())
                .find_map(|(i, u)| u.filter(|u| beat(*l, *u)).map(|u| (i, u)))
            else {
                continue;
            };
            let (to, from) = (entry_key(&entries[low]), entry_key(&entries[up]));
            let (a, b) = (name(groups, &to), name(groups, &from));
            let pct = |(k, n): (u64, u64)| {
                let (lo, hi) = wilson(k, n);
                format!(
                    "{}% ({}–{}%)",
                    (100 * k + n / 2) / n,
                    (lo * 100.0).round(),
                    (hi * 100.0).round()
                )
            };
            out.push(json!({"id": format!("{job}|results|{to}"), "job": job, "kind": "results",
                "from": from, "to": to,
                "title": format!("In {job}, {a} kept {} of {} and {b} kept {} of {}. Move {a} above {b}?", l.0, l.1, u.0, u.1),
                "facts": format!("Your own results in this job, each over at least {RUNS} counted runs: {} against {}. Only the order changes.", pct(*l), pct(u)),
                "done": format!("{a} is above {b} in {job} now")}));
        }
    }
    out
}

/// An offer's words: its title, its grey facts and its line once taken [C5].
fn words(groups: &[Value], jobs: &[Value], o: &Value, now: u64) -> Value {
    let (from, to) = (str_of(o, "from"), str_of(o, "to"));
    let (old, new) = (name(groups, from), name(groups, to));
    let agent = label(split(to).0);
    let job = o["job"].as_str();
    let mark = match o["mark"].as_str() {
        Some("top") => "top model",
        _ => "default",
    };
    // Where it goes: the entry's own effort where the new model has it, else its default [P6].
    let keeps = || {
        let e = job.and_then(|j| jobs::named(jobs, j)).and_then(|j| {
            (j["entries"].as_array().into_iter().flatten()).find(|e| entry_key(e) == from)
        });
        let effort = e.and_then(|e| e["effort"].as_str());
        let has = listed(groups, to).is_some_and(|m| {
            (m["efforts"].as_array().into_iter().flatten())
                .any(|x| Some(x.as_str().unwrap_or("")) == effort)
        });
        match (effort, has) {
            (Some(e), true) => format!("It keeps the same place and effort ({}).", capital(e)),
            _ => "It keeps the same place, at its own default effort.".into(),
        }
    };
    let (title, facts) = match (str_of(o, "kind"), job) {
        ("newer", Some(j)) => {
            let days = (now.saturating_sub(o["at"].as_u64().unwrap_or(now))) / DAY;
            let since = match days {
                0 => "since today".into(),
                1 => "since yesterday".into(),
                n => format!("for {n} days"),
            };
            (
                format!("{new} is new. Use it in place of {old} in {j}?"),
                format!(
                    "{agent} lists it {since}, a newer {} than the one in this list. {}",
                    family_words(&new),
                    keeps()
                ),
            )
        }
        ("mark", Some(j)) => (
            format!("{agent}'s {mark} is now {new}. Use it in place of {old} in {j}?"),
            format!(
                "{agent} moved its {mark} from {old} to {new}, which none of your jobs holds. {}",
                keeps()
            ),
        ),
        ("mark", None) => (
            format!("{agent}'s {mark} is now {new}, which none of your jobs holds."),
            String::new(),
        ),
        _ if o["took"] == true => (
            format!(
                "{agent} replaced {} with {}",
                str_of(o, "was"),
                str_of(o, "now")
            ),
            String::new(),
        ),
        _ => (
            format!(
                "{} now runs {} (was {})",
                split(to).1,
                str_of(o, "now"),
                str_of(o, "was")
            ),
            String::new(),
        ),
    };
    let done = match job {
        Some(j) if o["kind"] != "alias" => format!("{new} is in {j} now"),
        _ => String::new(),
    };
    json!({"title": title, "facts": facts, "done": done})
}

fn id_of(o: &Value) -> String {
    let mut id = format!(
        "{}|{}|{}",
        o["job"].as_str().unwrap_or(""),
        str_of(o, "kind"),
        str_of(o, "to")
    );
    if o["kind"] == "alias" {
        id += &format!("|{}", str_of(o, "now"));
    }
    id
}

/// The offers open now, after taking in what changed since the last read [C5]; the caller holds
/// the routing lock. The very first read of an agent only fills its `seen`.
pub(super) fn open(data: &Path, groups: &[Value], t: &Value, r: &Value) -> io::Result<Vec<Value>> {
    let path = data.join(FILE);
    let object = |v: Value| if v.is_object() { v } else { json!({}) };
    let before = object(read(&path));
    let mut saved = object(renamed::settled(data, groups));
    let jobs = t["jobs"].as_array().cloned().unwrap_or_default();
    let now = log::now_ms();
    let mut kept = saved["offers"].as_array().cloned().unwrap_or_default();
    for g in groups {
        let agent = str_of(g, "provider");
        let models = g["models"].as_array().cloned().unwrap_or_default();
        if models.is_empty() {
            continue;
        }
        let was = saved["seen"][agent].clone();
        let mut moved = match &was["moved"] {
            m @ Value::Object(_) => m.clone(),
            _ => json!({}),
        };
        if was.is_object() {
            for o in found(groups, agent, &models, &was, &jobs, &mut moved, now) {
                // (a) and (c) for one model in one job are one offer.
                let same = |k: &Value| match o["kind"] == "alias" {
                    true => id_of(k) == id_of(&o),
                    false => k["job"] == o["job"] && k["to"] == o["to"] && k["kind"] != "alias",
                };
                if !kept.iter().any(same) {
                    kept.push(o);
                }
            }
        }
        // A model gone from the list keeps the name it last had: its agent may list it under a new id.
        let mut names = was["names"].as_object().cloned().unwrap_or_default();
        names.extend((models.iter()).map(|m| (str_of(m, "id").to_string(), m["name"].clone())));
        let ids: Vec<&Value> = models.iter().map(|m| &m["id"]).collect();
        let mark = |k: &str| {
            models
                .iter()
                .find(|m| m[k] == true)
                .map(|m| m["id"].clone())
        };
        saved["seen"][agent] = json!({"ids": ids, "names": names,
            "default": mark("default"), "top": mark("top"), "moved": moved});
    }
    // Kept while it still fits: its job there and holding what it replaces, both models listed,
    // a mark's model still marked.
    kept.retain(|o| {
        let (from, to) = (str_of(o, "from"), str_of(o, "to"));
        let marked = |m: &Value| o["kind"] != "mark" || m[str_of(o, "mark")] == true;
        let fits = match o["job"].as_str() {
            Some(n) => jobs::named(&jobs, n)
                .is_some_and(|j| holds(j, from) && (o["kind"] == "alias" || !holds(j, to))),
            None => !jobs.iter().any(|j| holds(j, to)),
        };
        fits && !gone(groups, to)
            && (o["job"].is_null() || !gone(groups, from))
            && listed(groups, to).is_none_or(marked)
    });
    let mut refused = match &saved["refused"] {
        Value::Object(m) => m.clone(),
        _ => Default::default(),
    };
    // Cleared once its job is deleted or its model leaves the list; Not now's after 7 days.
    refused.retain(|_, r| {
        r["job"]
            .as_str()
            .is_none_or(|n| jobs::named(&jobs, n).is_some())
            && !gone(groups, str_of(r, "to"))
            && r["until"].as_u64().is_none_or(|u| u > now)
    });
    let mut all: Vec<Value> = (kept.iter())
        .map(|o| {
            let mut o = o.clone();
            o["id"] = id_of(&o).into();
            let w = words(groups, &jobs, &o, now);
            for k in ["title", "facts", "done"] {
                o[k] = w[k].clone();
            }
            o
        })
        .collect();
    all.extend(results(data, &jobs, &saved["seen"], groups, r));
    // Never one the user refused, or a model their rules bar.
    let rules = t["rules"].as_array().cloned().unwrap_or_default();
    all.retain(|o| {
        let (agent, id) = split(str_of(o, "to"));
        !refused.contains_key(str_of(o, "id"))
            && listed(groups, str_of(o, "to")).is_some()
            && !barred(&rules, agent, id)
    });
    (saved["offers"], saved["refused"]) = (kept.into(), refused.into());
    if saved != before {
        core::write_atomic(&path, saved.to_string().as_bytes())?;
    }
    Ok(all)
}

/// `routing offer <id> use|later|never` [C5, D386]: Use it edits only that job's list, through the
/// normal save; Not now hides it 7 days; Don't offer again is forever, for that job, kind and
/// model. Returns the table, or why not.
pub(super) fn answer(data: &Path, groups: &[Value], id: &str, how: &str) -> io::Result<Value> {
    let r = crate::outcomes::results(data);
    let _one = lock(data)?;
    let t = table(data, groups);
    let open = open(data, groups, &t, &r)?;
    let no = |why: &str| Ok(shown(data, groups, &r, Some(why.into())));
    let Some(o) = open.iter().find(|o| o["id"] == id) else {
        return no("That offer isn't open any more.");
    };
    let path = data.join(FILE);
    let (from, to) = (str_of(o, "from"), str_of(o, "to"));
    if how == "use" {
        let Some(job) = o["job"].as_str() else {
            return no("It names no job to change.");
        };
        let mut jobs = t["jobs"].as_array().cloned().unwrap_or_default();
        let j = (jobs.iter_mut())
            .find(|j| j["name"] == job)
            .ok_or_else(|| io::Error::other("no such job"))?;
        let list = j["entries"]
            .as_array_mut()
            .ok_or_else(|| io::Error::other("no entries"))?;
        let at = list.iter().position(|e| entry_key(e) == from).unwrap_or(0);
        match o["kind"].as_str() {
            Some("results") => {
                let mover = list.iter().position(|e| entry_key(e) == to).unwrap_or(at);
                let e = list.remove(mover);
                list.insert(at.min(mover), e);
            }
            Some("newer" | "mark") => {
                let (agent, model) = split(to);
                let effort = list[at]["effort"].clone();
                let has = listed(groups, to).is_some_and(|m| {
                    (m["efforts"].as_array().into_iter().flatten()).any(|x| *x == effort)
                });
                list[at] = json!({"agent": agent, "model": model, "effort": if has { effort } else { Value::Null }});
            }
            _ => return no("A notice has only OK."),
        }
        let v = json!({"jobs": jobs, "rules": t["rules"], "review": t["review"]});
        if let Some(why) = save(data, groups, &v, &t)? {
            return Ok(shown(data, groups, &r, Some(why)));
        }
    } else if matches!(how, "later" | "never") {
        let until = (how == "later").then_some(log::now_ms() + LATER);
        let mut saved = read(&path);
        saved["refused"][id] = json!({"job": o["job"], "to": to, "until": until});
        core::write_atomic(&path, saved.to_string().as_bytes())?;
    } else {
        return Err(io::Error::other(
            "usage: brigadier routing offer <id> use|later|never",
        ));
    }
    // A taken or refused-for-good offer is done with; Not now's comes back after its days.
    if how != "later" {
        let mut saved = read(&path);
        if let Some(l) = saved["offers"].as_array_mut() {
            l.retain(|k| id_of(k) != id);
        }
        core::write_atomic(&path, saved.to_string().as_bytes())?;
    }
    Ok(shown(data, groups, &r, None))
}
