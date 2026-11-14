//! The resolver: a worker's model and account from its row, by quota where the user lets it
//! [D2037, D2040, D2041, D51], and its receipt [D3018].

use super::*;

/// The account work on `agent` takes by D2040: the parent's own on the parent's agent, else that
/// agent's starting account; "" is the computer's login.
pub(super) fn account_for(data: &Path, parent: &Spec, f: &Fold, agent: &str) -> String {
    match agent == models::next_agent(parent, f) {
        true => f.accounts.get(agent).cloned().or(parent.starts_on.clone()),
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

/// An account as Providers names it, for the receipt [D24]: its name, else which login it is.
pub(super) fn label(v: &Value, agent: &str, id: &str) -> String {
    if adapters::get(agent).is_none_or(|a| a.accounts().is_none()) {
        return String::new();
    }
    let name = (accounts_of(v, agent).into_iter())
        .find(|(x, _)| x == id)
        .map(|(_, n)| n)
        .unwrap_or_default();
    match (name.is_empty(), id.is_empty()) {
        (false, _) => name,
        (true, true) => "This computer's login".into(),
        (true, false) => "Another account".into(),
    }
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
/// pick reserved for `wid`. Room: shortest window under 90% and weekly under 98%, or unknown, and
/// no limit lately. Each live reservation counts +10 points on its account's shortest window
/// until its worker ends, a newer sample comes or an hour passes (proposed, Codex review 3).
/// Its quota at the start, or the soonest reset of those without room. `wid` "": placed only to
/// be shown, nothing reserved (a card the user may never press, D352).
pub(super) fn place(
    data: &Path,
    a: &dyn adapters::Adapter,
    model: &str,
    base: &str,
    cwd: &str,
    wid: &str,
    skip: &str,
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
                usage::signed_in(data, name, id).unwrap_or_else(|| {
                    let c = accounts::check(a, data, id, cwd);
                    c["signed_in"] == true && c["kept_apart"] == true
                })
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
        let short = ws.iter().min_by_key(|w| w.minutes.unwrap_or(u64::MAX));
        let long = ws.iter().max_by_key(|w| w.minutes.unwrap_or(0));
        let used = |w: Option<&usage::Window>| w.and_then(|w| w.used).map(|u| u + 10 * n);
        let full = [(short, 90), (long, 98)]
            .into_iter()
            .find(|(w, most)| used(*w).is_some_and(|u| u >= *most));
        if let Some((w, _)) = full {
            let at = w.and_then(|w| w.resets);
            soonest = at.map_or(soonest, |at| Some(soonest.map_or(at, |s| s.min(at))));
            continue;
        }
        let quota = short.filter(|w| w.used.is_some()).map_or(
            Value::Null,
            |w| json!({"name": w.name, "used": w.used, "resets": w.resets}),
        );
        let rank = (
            short.and_then(|w| w.resets).unwrap_or(u64::MAX),
            used(short).unwrap_or(10 * n),
        );
        room.push((id, rank, quota));
    }
    room.sort_by_key(|r| r.1);
    let first = room.first().ok_or(soonest)?;
    let kept = room.iter().find(|r| r.0 == base && r.1.1 <= first.1.1 + 5);
    let (id, _, quota) = kept.unwrap_or(first).clone();
    if auto && !wid.is_empty() {
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
/// row, the account's name and quota at the start, and the same-row note) [D2041, D3018]; with
/// `hold` set when its row is out [D2028].
pub(crate) struct Pick {
    pub agent: String,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub account: Option<String>,
    pub ran: Value,
    pub hold: Value,
}

/// The first entry of the row below `row` the user allows: the hold's "Use …" [D2028].
pub(super) fn lower(data: &Path, groups: &[Value], t: &Value, row: Option<&str>) -> Value {
    let next = row
        .and_then(|r| ROWS.iter().position(|x| *x == r))
        .and_then(|i| ROWS.get(i + 1));
    next.map_or(Value::Null, |r| first(data, groups, t, r))
}

/// The first entry of `row` the user allows, with its row.
pub(super) fn first(data: &Path, groups: &[Value], t: &Value, row: &str) -> Value {
    let rules = t["rules"].as_array().cloned().unwrap_or_default();
    let list = t["rows"][row].as_array().cloned().unwrap_or_default();
    (list.into_iter())
        .find(|e| allowed(data, groups, &rules, str_of(e, "agent"), str_of(e, "model")).is_ok())
        .map_or(Value::Null, |mut e| {
            e["row"] = row.into();
            e
        })
}

/// The pick for a worker of `parent` [D339]: the agent's `--model` when it's allowed (refused with
/// the reason otherwise, never replaced), else the row's order, `--row` or Standard; the first
/// entry with an account that has room, a later one with a note [D2041]. `--agent` alone takes
/// the row's entries on it, else its default model; `--effort` alone applies to the entry taken
/// (proposed). Runs under the data dir's lock, so the reservation it makes is seen by the next.
/// A review's (`review`: its authors' agents) is Best on another agent first, then on theirs, at
/// high where the model has it; it never holds: none placed, it doesn't run [D3026].
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
    let row = flags("--row");
    if let Some(r) = row.as_deref().filter(|r| !ROWS.contains(r)) {
        return Err(refuse(&format!(
            "--row takes best, standard or quick, not {r:?}."
        )));
    }
    let _one = lock(data).map_err(|e| refuse(&e.to_string()))?;
    let groups = groups(data, Some(me));
    let t = table(data, &groups);
    let rules = t["rules"].as_array().cloned().unwrap_or_default();
    let mine = models::next_agent(parent, f).to_string();
    let (row, list) = match &model {
        Some(m) => {
            let a = agent.clone().unwrap_or(mine);
            (
                None,
                vec![json!({"agent": a, "model": m, "effort": effort})],
            )
        }
        None => {
            let row =
                row.unwrap_or_else(|| (if review.is_some() { "best" } else { "standard" }).into());
            let mut list = t["rows"][&row].as_array().cloned().unwrap_or_default();
            if let Some(authors) = review {
                list.sort_by_key(|e| authors.iter().any(|a| e["agent"] == a.as_str()));
            }
            if let Some(a) = &agent {
                list.retain(|e| e["agent"] == a.as_str());
                if list.is_empty() {
                    let own: Vec<Value> = groups
                        .iter()
                        .filter(|g| g["provider"] == a.as_str())
                        .cloned()
                        .collect();
                    list = default_row(&own, "standard");
                }
                if list.is_empty() {
                    return Err(refuse(&format!(
                        "{a:?} isn't an agent you may use. `brigadier models` lists them."
                    )));
                }
            }
            for e in list.iter_mut().filter(|_| effort.is_some()) {
                e["effort"] = json!(effort);
            }
            (Some(row), list)
        }
    };
    let v = accounts::load(data);
    let (mut first, mut out, mut soonest) = (None, vec![], None::<u64>);
    for e in &list {
        let (a, id) = (str_of(e, "agent"), str_of(e, "model"));
        let m = match allowed(data, &groups, &rules, a, id) {
            Ok(m) => m,
            Err(why) if model.is_some() => return Err(refuse(&why)),
            Err(_) => continue,
        };
        let high = (m["efforts"].as_array().into_iter().flatten()).any(|x| x == "high");
        let want = if review.is_some() && high {
            Some("high")
        } else {
            e["effort"].as_str()
        };
        let (runs_at, capped) =
            effort_of(&rules, a, m, want, effort.is_some()).map_err(|w| refuse(&w))?;
        let Some(adapter) = adapters::get(a) else {
            continue;
        };
        let base = account_for(data, parent, f, a);
        let name = m.get("name").unwrap_or(&m["id"]).clone();
        let mut pick = Pick {
            agent: a.into(),
            model: Some(id.into()),
            effort: runs_at.clone(),
            account: Some(base.clone()).filter(|b| !b.is_empty()),
            ran: json!({"row": row, "name": name, "label": label(&v, a, &base), "quota": null,
                "effort": runs_at.or(m["default_effort"].as_str().map(String::from)), "capped": capped}),
            hold: Value::Null,
        };
        match place(data, adapter, id, &base, &parent.cwd, wid, "\0") {
            Ok((account, kept)) => {
                pick.account = Some(account).filter(|x| !x.is_empty());
                (pick.ran["label"], pick.ran["quota"]) =
                    (kept["label"].clone(), kept["quota"].clone());
                if !out.is_empty() {
                    let row = title(row.as_deref().unwrap_or("standard"));
                    pick.ran["note"] = format!(
                        "{} had no account with room, so the next in {row} ran",
                        out.join(" and ")
                    )
                    .into();
                }
                return Ok(pick);
            }
            Err(at) => {
                out.push(name.as_str().unwrap_or(id).to_string());
                soonest = at.map_or(soonest, |at| Some(soonest.map_or(at, |s| s.min(at))));
                first.get_or_insert(pick);
            }
        }
    }
    if review.is_some() {
        let why = match out.is_empty() {
            true => "no model in your Best row is one you may use".into(),
            false => format!("{} had no account with room", out.join(" and ")),
        };
        return Err(refuse(&format!("Review didn't run: {why}.")));
    }
    let Some(mut pick) = first else {
        let row = title(row.as_deref().unwrap_or("standard"));
        return Err(refuse(&format!(
            "No model in your {row} row is one you may use: Settings › Routing sets it."
        )));
    };
    let why = match &row {
        Some(r) => format!("{}'s models are at their limit", title(r)),
        None => format!("{} is at its limit", out.join(", ")),
    };
    pick.hold = json!({"row": row, "why": why, "resets": soonest,
        "lower": lower(data, &groups, &t, row.as_deref())});
    Ok(pick)
}

/// The receipt [D3018]: "Standard → ‹model› · medium · Work (5-hour 40%, resets 15:10)", from
/// the start's snapshot in `ran`; once the reset has passed, without it, or "Usage limit" for a
/// window that was at its limit [D379]; the account alone with no quota known (proposed).
pub(crate) fn receipt(ran: &Value) -> Option<String> {
    ran.get("label")?;
    let row = ran["row"].as_str().map(title);
    let model = ran["name"].as_str().or(ran["model"].as_str())?;
    // A retry's: "Retry 1 of 2 → Quick: fake · high (tests failed)" [D2037] (proposed).
    let mut text = match (ran["retry"].as_str(), row) {
        (Some(t), Some(r)) => format!("{t} → {r}: {model}"),
        (None, Some(r)) => format!("{r} → {model}"),
        (Some(t), None) => format!("{t} → {model}"),
        (None, None) => model.to_string(),
    };
    if let Some(e) = ran["effort"].as_str() {
        text += &format!(" · {e}");
    }
    if let Some(f) = ran["failed"].as_str() {
        text += &format!(" ({f})");
    }
    let q = &ran["quota"];
    let passed = q["resets"].as_u64().is_some_and(|at| at <= log::now_ms());
    let quota = match (q["used"].as_u64(), passed) {
        (None, _) => String::new(),
        (Some(u), true) if u >= 100 => " (Usage limit)".into(),
        (Some(u), true) => format!(" ({} {u}%)", str_of(q, "name")),
        (Some(u), false) => match q["resets"].as_u64() {
            Some(at) => format!(" ({} {u}%, resets {})", str_of(q, "name"), clock(at)),
            None => format!(" ({} {u}%)", str_of(q, "name")),
        },
    };
    if let Some(l) = ran["label"].as_str().filter(|l| !l.is_empty()) {
        text += &format!(" · {l}{quota}");
    }
    for note in [&ran["capped"], &ran["note"]] {
        if let Some(n) = note.as_str() {
            text += &format!("; {n}");
        }
    }
    Some(text)
}

/// A worker at its limit moves within its own row [D2037, D2041]: another account on the same
/// model where automatic switching is on for its agent [D51], else the row's next entry the user
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
    let row = l.ran["row"].as_str();
    let list = row.map_or(vec![], |r| {
        t["rows"][r].as_array().cloned().unwrap_or_default()
    });
    let at = list
        .iter()
        .position(|e| e["agent"] == backend.as_str() && e["model"] == now.as_str());
    let same = json!({"agent": backend, "model": now, "effort": l.ran["effort"]});
    let v = accounts::load(data);
    let mut out = vec![str_of(&l.ran, "name").to_string()];
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
            continue;
        };
        let Some(adapter) = adapters::get(a) else {
            continue;
        };
        // The same model only on another account, where its agent places by quota [D51].
        if same && !listed(&v, "auto", a) {
            continue;
        }
        let Ok((runs_at, capped)) = effort_of(&rules, a, m, e["effort"].as_str(), false) else {
            continue;
        };
        let base = account_for(data, &parent, &pf, a);
        let skip = if same { cur } else { "\0" };
        match place(data, adapter, id, &base, &spec.cwd, wid, skip) {
            Ok((account, kept)) => {
                let name = m.get("name").unwrap_or(&m["id"]).clone();
                let note = match same {
                    true => format!(
                        "{} hit its limit, so it went on with another account",
                        out[0]
                    ),
                    false => format!(
                        "{} had no account with room, so the next in {} ran",
                        out.join(" and "),
                        title(row.unwrap_or(""))
                    ),
                };
                let ran = json!({"agent": a, "model": id, "account": account, "row": row, "name": name,
                    "effort": runs_at.clone().or(m["default_effort"].as_str().map(String::from)),
                    "label": kept["label"], "quota": kept["quota"], "capped": capped, "note": note});
                return Ok(Some(((adapter, account, Some(id.into()), runs_at), ran)));
            }
            Err(r) => {
                if !same && out.last().is_none_or(|x| x != id) {
                    out.push(
                        m.get("name")
                            .unwrap_or(&m["id"])
                            .as_str()
                            .unwrap_or(id)
                            .to_string(),
                    );
                }
                soonest = r.map_or(soonest, |r| Some(soonest.map_or(r, |s| s.min(r))));
            }
        }
    }
    let why = match row {
        Some(r) => format!("{}'s models are at their limit", title(r)),
        None => format!("{} is at its limit", out[0]),
    };
    let resets = soonest.or(f.resets);
    let hold =
        json!({"row": row, "why": why, "resets": resets, "lower": lower(data, &groups, &t, row)});
    drop(_one);
    ask(data, wid, &hold)?;
    Ok(None)
}
