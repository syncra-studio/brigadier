//! `start --retry <id> "<what failed>"` [D2037, D342]: a fresh worker, never the failed one's
//! transcript, from its chain's first brief and a note, one step up the ladder: more effort on
//! the same model, or where it has no more, that once more; then its job's next entry after the one
//! that ran, at most two steps; past them, the user's call on its card [D2028, D350-D353]. A worker with no job (a `--model` one,
//! one from before jobs, or its job since deleted or renamed) has no next entry [D392 P5]. The
//! chain's steps are read from its workers' records, kept under the family lock when each is
//! reserved, so a restart, or one held and never launched, keeps them [D350].

use super::pick::Pick;
use super::*;

/// The steps of a chain's ladder, one of each.
const LADDER: [&str; 3] = ["effort", "again", "next"];

/// What the failed try left for the next: its commits where they are, its edits never committed.
fn left(data: &Path, l: &workers::Link, id: &str) -> String {
    let dir = core::session_dir(data, id);
    let cwd = core::load(data, id).map_or(String::new(), |s| s.cwd);
    let lands = core::worktrees::lands(&dir).ok().flatten();
    let commits = l.last["commits"].as_u64().unwrap_or(0);
    let mut said = match (l.last["merged"] == true, commits, lands) {
        (true, ..) => "Its commits are already on your branch.".to_string(),
        (_, 0, _) => "It left no commits.".into(),
        (_, _, Some(x)) => format!(
            "Its commits are not on your branch: read `git log -p {}..{}`, and take what is right.",
            x.base_commit,
            x.branch.unwrap_or_default()
        ),
        _ => "Its commits are in its own repositories' branches, not on yours.".into(),
    };
    if workers::git(&cwd, &["status", "--porcelain"]).is_some_and(|s| !s.is_empty()) {
        said += &format!(" Edits it never committed are in {cwd}.");
    }
    said
}

/// A retry's plan: its brief and title, the flags its pick takes, and what it keeps.
pub(crate) struct Retry {
    pub brief: String,
    pub title: String,
    flags: Vec<(&'static str, String)>,
    /// Its start outcome's `retry_of`, `chain`, `step` and `note` [D2037].
    pub note: Value,
    /// Laid over its pick's `ran`, for the receipt: `retry` and `failed`.
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

    /// Start's refusal, under the family lock, when another retry of its chain took its rung
    /// since this plan was read: two never take one [D350].
    pub(crate) fn taken(&self, data: &Path, me: &str) -> Option<Value> {
        let (chain, step) = (&self.note["chain"], &self.note["step"]);
        let rung = LADDER.iter().any(|l| step == l);
        let took = |r: &workers::Record| r.retry["chain"] == *chain && r.retry["step"] == *step;
        (rung && workers::records(data, me).iter().any(took)).then(|| {
            workers::refuse("Another retry of it just took that step. Retry it again to go on.")
        })
    }

    /// Its pick's `ran` gains the retry's words; past the ladder it holds, asking the user
    /// "Retry on ‹the job's first›" or "Stop here" (proposed).
    pub(crate) fn apply(&self, p: &mut Pick) {
        for (k, v) in self.ran.as_object().into_iter().flatten() {
            p.ran[k] = v.clone();
        }
        if let Some(why) = &self.ask {
            let to = json!({"agent": p.agent, "model": p.model, "effort": p.effort.clone().or(p.ran["effort"].as_str().map(String::from)),
                "name": p.ran["name"]});
            p.hold = json!({"retry": true, "why": why, "job": p.ran["job"], "use": to});
        }
    }
}

/// The plan for `me`'s retry of its worker `id`. Only its parent may; the ladder picks, so
/// `--job`, `--agent`, `--model` and `--effort` are refused. One whose last end wasn't its model's
/// doing (a cut, a passing failure, a limit, a sign-in) runs again on the same pick, no ladder step [D340] (proposed).
pub(crate) fn plan(
    data: &Path,
    me: &str,
    id: &str,
    failed: &str,
    flags: &dyn Fn(&str) -> Option<String>,
) -> Result<Retry, Value> {
    let refuse = workers::refuse;
    let given = ["--job", "--agent", "--model", "--effort"];
    if let Some(f) = given.into_iter().find(|f| flags(f).is_some()) {
        return Err(refuse(&format!(
            "--retry takes no {f}: the ladder picks, more effort first, then the job's next model."
        )));
    }
    if failed.trim().is_empty() {
        return Err(refuse(
            "`brigadier start --retry <id> \"<what failed>\"` needs what failed, in quotes.",
        ));
    }
    let Some(l) = workers::link(data, id).filter(|l| l.parent == me) else {
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
    let records = workers::records(data, me);
    let chain = (records.iter().find(|r| r.wid == id))
        .and_then(|r| r.retry["chain"].as_str())
        .unwrap_or(id)
        .to_string();
    let head = workers::link(data, &chain).unwrap_or_else(|| l.clone());
    let steps: Vec<Value> = (records.iter())
        .filter(|r| r.retry["chain"] == chain.as_str())
        .map(|r| r.retry["step"].clone())
        .collect();
    let taken = |s: &str| steps.iter().any(|x| x == s);
    let rung = if taken("next") {
        2
    } else {
        (taken("effort") || taken("again")) as usize
    };
    let ladder = (steps.iter())
        .filter(|s| LADDER.iter().any(|l| *s == l))
        .count()
        + 1;
    let n = steps.len() + 1;
    // Nothing its model did wrong ended it: no step up.
    let temporary = matches!(
        workers::cause(&l, &workers::outcomes(data, id)),
        "infrastructure" | "environment" | "quota"
    );

    let ran = &l.ran;
    let (agent, model) = (str_of(ran, "agent"), str_of(ran, "model"));
    let groups = groups(data, Some(me));
    let t = table(data, &groups);
    let rules = t["rules"].as_array().cloned().unwrap_or_default();
    let all = t["jobs"].as_array().cloned().unwrap_or_default();
    let job = ran["job"].as_str().and_then(|j| jobs::named(&all, j));
    let entries = job
        .and_then(|j| j["entries"].as_array().cloned())
        .unwrap_or_default();
    // The entries after the one that ran that the user allows: none where it isn't in its job.
    let at = (entries.iter()).position(|e| e["agent"] == agent && e["model"] == model);
    let next = at.is_some_and(|i| {
        (entries.iter().skip(i + 1)).any(|e| {
            allowed(
                data,
                &groups,
                &rules,
                str_of(e, "agent"),
                str_of(e, "model"),
            )
            .is_ok()
        })
    });
    let job = job.map(|j| ("--job", str_of(j, "name").to_string()));
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
    // On the same model, in its job where it has one.
    let same = |effort: Option<String>| {
        let mut f = vec![("--agent", agent.to_string()), ("--model", model.into())];
        f.extend(effort.map(|e| ("--effort", e)));
        f.extend(job.clone());
        f
    };
    let label = format!("Retry {ladder} of 2");
    let (step, flags, label, ask) = if temporary {
        let e = ran["effort"].as_str().map(String::from);
        ("same", same(e), format!("Retry {n} on the same pick"), None)
    } else if let Some(e) = more().filter(|_| rung == 0) {
        ("effort", same(Some(e)), label, None)
    } else if rung == 0 {
        // No more effort for it: once more as it was, with what the last try left.
        let e = ran["effort"].as_str().map(String::from);
        ("again", same(e), label, None)
    } else if let Some(j) = job.clone().filter(|_| next && rung < 2) {
        let after = json!({"agent": agent, "model": model}).to_string();
        ("next", vec![j, ("job-after", after)], label, None)
    } else {
        // The parent's words say how it failed; ours only that the ladder is done.
        let why = format!("No step up is left for {}: {failed}", head.title);
        // Its job's first; one with no job, the model it ran on.
        let flags = match job.clone() {
            Some(j) => vec![j],
            None => same(ran["effort"].as_str().map(String::from)),
        };
        (
            "asked",
            flags,
            format!("Retry {n}, the user's call"),
            Some(why),
        )
    };
    let over = json!({"retry": label, "failed": failed});
    let note = format!(
        "The last try ({id}) failed: {failed}. {}",
        left(data, &l, id)
    );
    // Numbered among all its parent's retries of that title: two chains whose heads share a
    // title never draw the same one.
    let title = format!("{} · retry ", head.title);
    let k = (records.iter())
        .filter(|r| r.title.starts_with(&title))
        .count()
        + 1;
    Ok(Retry {
        brief: format!("{}\n\n{note}", head.brief.trim_end()),
        title: format!("{title}{k}"),
        flags,
        note: json!({"retry_of": id, "chain": chain, "step": step, "note": note}),
        ran: over,
        ask,
    })
}
