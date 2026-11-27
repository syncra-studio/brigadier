//! Where a worker's model runs: the account by D2040, and with automatic switching the one with
//! room, its pick reserved till it ends [D2040, D51, D343].

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

/// Why work on `agent` that `place` put on `placed` is on this computer's login when the user
/// picked another account with Use [C36, C38, D2040]: Ok(Some) for its note, Err where that login
/// can't be used either, which only switching off lets through (`place` takes the D2040 account
/// unchecked then). The parent's own account, or an added one placed, is no fallback.
pub(super) fn fell_back(
    data: &Path,
    parent: &Spec,
    f: &Fold,
    agent: &str,
    placed: &str,
) -> Result<Option<String>, String> {
    if !placed.is_empty() || agent == models::next_agent(parent, f) {
        return Ok(None);
    }
    let spec = Spec {
        backend: agent.into(),
        ..Default::default()
    };
    let (spec, c) = accounts::picked(data, spec);
    if spec.starts_on.is_none() {
        return accounts::fell_back(data, &spec, c.as_ref(), "worker");
    }
    // Its Use pick usable since `place` chose the login: nothing to tell, but the login it runs on
    // must still be one Providers shows [C36].
    match adapters::get(agent).is_none_or(|a| accounts::login_ok(data, a)) {
        true => Ok(None),
        false => Err("This computer's login is signed out. Sign in to start this worker.".into()),
    }
}

/// Before any start lock, as C66's check: each account of an agent switching automatically whose
/// "usable" is over an hour old, or never read, is checked now, so placement finds one signed out
/// since and no other start waits on it [C97].
pub(crate) fn recheck(data: &Path, cwd: &str) {
    let v = accounts::load(data);
    for a in accounts::agents().filter(|a| listed(&v, "auto", a.name()) && a.accounts().is_some()) {
        for (id, _) in accounts_of(&v, a.name()) {
            if usage::usable_lately(data, a.name(), &id).is_none() {
                accounts::check(a, data, &id, cwd);
            }
        }
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
        // Not its own: an answer tried again, or a move, replaces it below.
        let n = if auto {
            (held[&key].as_array().into_iter().flatten())
                .filter(|r| r["wid"] != wid)
                .count()
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
