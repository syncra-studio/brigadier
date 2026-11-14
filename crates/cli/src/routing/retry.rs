//! `start --retry <id> "<what failed>"` [D2037, D342]: a fresh worker, never the failed one's
//! transcript, from its chain's first brief and a note, one step up the ladder: more effort on
//! the same model, then a row up, at most two steps; past them, the user's call on its card
//! [D2028]. The chain's steps are read from its start outcome notes, so a restart keeps them.

use super::pick::{Pick, first};
use super::*;

/// A retry's plan: its brief and title, the flags its pick takes, and what it keeps.
pub(crate) struct Retry {
    pub brief: String,
    pub title: String,
    flags: Vec<(&'static str, String)>,
    /// Its start outcome's `retry_of`, `chain`, `step` and `note` [D2037].
    pub note: Value,
    /// Laid over its pick's `ran`, for the receipt: `retry`, `failed`, and the row it stays on.
    ran: Value,
    /// Past the ladder: why it holds for the user; its card's pick reserves only on Retry on.
    pub ask: Option<String>,
}

impl Retry {
    pub(crate) fn flag(&self, name: &str) -> Option<String> {
        (self.flags.iter())
            .find(|(n, _)| *n == name)
            .map(|(_, v)| v.clone())
    }

    /// Its pick's `ran` gains the retry's words; past the ladder it holds, asking the user
    /// "Retry on ‹the row's first›" or "Stop here" (proposed).
    pub(crate) fn apply(&self, p: &mut Pick) {
        for (k, v) in self.ran.as_object().into_iter().flatten() {
            p.ran[k] = v.clone();
        }
        if let Some(why) = &self.ask {
            let lower = json!({"agent": p.agent, "model": p.model, "effort": p.effort, "row": p.ran["row"]});
            p.hold = json!({"retry": true, "why": why, "row": p.ran["row"], "lower": lower});
        }
    }
}

fn start_of(data: &Path, wid: &str) -> Value {
    (workers::outcomes(data, wid).into_iter())
        .find(|o| o["phase"] == "start")
        .unwrap_or_default()
}

/// The plan for `me`'s retry of its worker `id`. Only its parent may; the ladder picks, so
/// `--row`, `--agent`, `--model` and `--effort` are refused. One whose last end was temporary
/// runs again on the same pick, no ladder step [D340] (proposed).
pub(crate) fn plan(
    data: &Path,
    me: &str,
    id: &str,
    failed: &str,
    flags: &dyn Fn(&str) -> Option<String>,
) -> Result<Retry, Value> {
    let refuse = workers::refuse;
    let given = ["--row", "--agent", "--model", "--effort"];
    if let Some(f) = given.into_iter().find(|f| flags(f).is_some()) {
        return Err(refuse(&format!(
            "--retry takes no {f}: the ladder picks, more effort first, then a row up."
        )));
    }
    if failed.trim().is_empty() {
        return Err(refuse(
            "`brigadier start --retry <id> \"<what failed>\"` needs what failed, in quotes.",
        ));
    }
    let Some(l) = workers::link(data, id).filter(|l| l.parent == me && !l.session) else {
        return Err(refuse(&format!(
            "No worker {id:?} of yours: only the session that started a worker may retry it."
        )));
    };
    // One review, one fix pass, never a loop [D3026] (proposed).
    if l.review["of"].is_string() {
        return Err(refuse(&format!(
            "{id} is a review: it runs once and isn't retried."
        )));
    }
    if l.last.is_null() {
        return Err(refuse(&format!(
            "{id} hasn't ended. Wait for its result, or `brigadier stop {id}`, then retry it."
        )));
    }
    let chain = start_of(data, id)["chain"]
        .as_str()
        .unwrap_or(id)
        .to_string();
    let head = workers::link(data, &chain).unwrap_or_else(|| l.clone());
    let kin: Vec<String> = (workers::records(data, me).into_iter())
        .filter(|r| r.retry["chain"] == chain.as_str())
        .map(|r| r.wid)
        .collect();
    let steps: Vec<Value> = kin
        .iter()
        .map(|w| start_of(data, w)["step"].clone())
        .collect();
    let taken = |s: &str| steps.iter().any(|x| x == s);
    let rung = if taken("row") {
        2
    } else {
        taken("effort") as usize
    };
    let ladder = steps
        .iter()
        .filter(|s| *s == "effort" || *s == "row")
        .count()
        + 1;
    let n = kin.len() + 1;
    let temporary = (workers::outcomes(data, id).iter().rev())
        .find(|o| o["phase"] == "end")
        .is_some_and(|o| o["temporary"] == true);

    let ran = &l.ran;
    let (agent, model) = (str_of(ran, "agent"), str_of(ran, "model"));
    // One started on a named model has no row: Standard's, as a start with none (proposed).
    let row = ran["row"].as_str().unwrap_or("standard");
    let up = (ROWS.iter().position(|r| *r == row))
        .and_then(|i| i.checked_sub(1))
        .map(|i| ROWS[i]);
    let groups = groups(data, Some(me));
    let t = table(data, &groups);
    let rules = t["rules"].as_array().cloned().unwrap_or_default();
    // The same model at its next effort, by its own list, within the "never above" rules.
    let more = || {
        let m = allowed(data, &groups, &rules, agent, model).ok()?;
        let efforts: Vec<&str> = (m["efforts"].as_array().into_iter().flatten())
            .filter_map(Value::as_str)
            .collect();
        let at = efforts.iter().position(|e| ran["effort"] == *e)? + 1;
        let ok = cap(&rules, agent, &efforts).is_none_or(|c| at <= c);
        efforts.get(at).filter(|_| ok).map(|e| e.to_string())
    };
    let same = |effort: Option<String>| {
        let mut f = vec![("--agent", agent.to_string()), ("--model", model.into())];
        f.extend(effort.map(|e| ("--effort", e)));
        f
    };
    let label = format!("Retry {ladder} of 2");
    let (step, flags, label, ask) = if temporary {
        let e = ran["effort"].as_str().map(String::from);
        ("same", same(e), format!("Retry {n} on the same pick"), None)
    } else if let Some(e) = more().filter(|_| rung == 0) {
        ("effort", same(Some(e)), label, None)
    } else if let Some(r) = up.filter(|r| rung < 2 && first(data, &groups, &t, r).is_object()) {
        ("row", vec![("--row", r.to_string())], label, None)
    } else {
        let why = format!(
            "{} failed again ({failed}) with no step up left",
            head.title
        );
        let r = up.unwrap_or("best").to_string();
        (
            "asked",
            vec![("--row", r)],
            format!("Retry {n}, the user's call"),
            Some(why),
        )
    };
    let mut over = json!({"retry": label, "failed": failed});
    if matches!(step, "same" | "effort") {
        over["row"] = ran["row"].clone();
    }
    let note = format!(
        "The last try ({id}) failed: {failed}. Its commits, if any, are already on your branch."
    );
    Ok(Retry {
        brief: format!("{}\n\n{note}", head.brief.trim_end()),
        title: format!("{} · retry {n}", head.title),
        flags,
        note: json!({"retry_of": id, "chain": chain, "step": step, "note": note}),
        ran: over,
        ask,
    })
}
