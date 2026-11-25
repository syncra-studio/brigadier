//! The outcome log read back [D2038]: each worker's own start, end and review notes, and its
//! commits in its parent's branch, computed when read, so a deleted session's outcomes go with
//! its folder and nothing can stay stale [D35]. Archived sessions keep their folders, so count.
//!
//! The review note 4.10 writes into the reviewed worker's own log [D3026]:
//! `{"event": "outcome", "phase": "review", "reviewer": {"agent", "model"}, "findings": n,
//! "fixed": n, "rejected": n, "ran": bool, "why": "…" | null}` (`why`: why it didn't run).

use crate::workers::{self, git};
use brigadier_core as core;
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::Path;

/// One parent branch's history, read once for all its workers: each commit's first parent, the
/// commits git's own revert line names, the repo's branch heads, and each commit a merge brought
/// in, by that merge (so `git revert -m 1 <merge>` reverts it).
#[derive(Default)]
struct Branch {
    heads: HashMap<String, String>,
    first: HashMap<String, String>,
    reverted: HashSet<String>,
    merged_by: HashMap<String, String>,
}

// shortcut: reads the branch's whole history once per call; bound it by date if a huge repo
// makes `routing results` slow.
fn branch(repo: &str, base: &str) -> Branch {
    let mut b = Branch::default();
    let heads = git(
        repo,
        &[
            "for-each-ref",
            "--format=%(refname:short) %(objectname)",
            "refs/heads",
        ],
    );
    for line in heads.unwrap_or_default().lines() {
        if let Some((name, sha)) = line.split_once(' ') {
            b.heads.insert(name.into(), sha.into());
        }
    }
    for line in git(repo, &["rev-list", "--parents", base])
        .unwrap_or_default()
        .lines()
    {
        let mut shas = line.split(' ');
        if let Some(sha) = shas.next() {
            b.first.insert(sha.into(), shas.next().unwrap_or("").into());
            for into in shas {
                b.merged_by.insert(into.into(), sha.into());
            }
        }
    }
    let log = git(
        repo,
        &["log", "--grep=This reverts commit", "--format=%B", base],
    );
    for part in log
        .unwrap_or_default()
        .split("This reverts commit ")
        .skip(1)
    {
        let sha: String = part.chars().take_while(char::is_ascii_hexdigit).collect();
        b.reverted.insert(sha);
    }
    b
}

/// Kept and reverted, by git (proposed): kept while its last commit is in its parent's branch,
/// reverted once a later commit there reverts one of its own. No commits: neither.
fn landed(
    data: &Path,
    wid: &str,
    branches: &mut HashMap<(String, String), Branch>,
) -> (bool, bool) {
    let dir = core::session_dir(data, wid);
    // A folder chat's worker lands in each repository it claimed [D494].
    let claims = core::folder::claims(&dir).into_iter().map(|(_, rec)| rec);
    let each: Vec<(bool, bool)> = std::iter::once(dir)
        .chain(claims)
        .filter_map(|rec| landed_in(&rec, branches))
        .collect();
    (
        !each.is_empty() && each.iter().all(|e| e.0),
        each.iter().any(|e| e.1),
    )
}

/// The same, for one record's worktree; none where it made no commits.
fn landed_in(rec: &Path, branches: &mut HashMap<(String, String), Branch>) -> Option<(bool, bool)> {
    let l = core::worktrees::lands(rec).ok().flatten()?;
    let repo = l.repo.to_string_lossy().to_string();
    let b =
        (branches.entry((repo.clone(), l.base.clone()))).or_insert_with(|| branch(&repo, &l.base));
    let head = l.branch.and_then(|name| b.heads.get(&name).cloned())?;
    if head == l.base_commit {
        return None;
    }
    if !b.first.contains_key(&head) {
        return Some((false, false));
    }
    let mut at = head;
    while at != l.base_commit && !at.is_empty() {
        let merge = b.merged_by.get(&at);
        if b.reverted.contains(&at) || merge.is_some_and(|m| b.reverted.contains(m)) {
            return Some((false, true));
        }
        at = b.first.get(&at).cloned().unwrap_or_default();
    }
    Some((true, false))
}

/// `routing results` [C5, D388 Q13]: by job (`ran.job`; `--model` workers under none, those from
/// before jobs under their row's title), then by model as it ran (after any move in its job): how
/// many it kept, of those counted [D2038]; and the reviews' counts [D3026]. Kept: finished, its
/// last commit in its parent's branch, never retried or reverted. Work not merged yet isn't
/// counted until it is, nor is one its model didn't end: cut off, at a limit, stopped.
pub(crate) fn results(data: &Path) -> Value {
    let mut rows = vec![];
    let mut retried: HashMap<String, u64> = HashMap::new();
    // Each sum is of the reviews that said it: none is guessed [D74].
    let (mut reviews, mut off) = ((0u64, [None::<u64>; 3]), 0u64);
    let mut add = |n: &Value| {
        reviews.0 += 1;
        // "Findings: 0" fixed and rejected none, said or not [D74, D357].
        let none = (n["findings"] == 0).then_some(0);
        for (sum, k) in reviews.1.iter_mut().zip(["findings", "fixed", "rejected"]) {
            let said = n[k].as_u64().or(none);
            *sum = said.map_or(*sum, |n| Some(sum.unwrap_or(0) + n));
        }
    };
    for wid in core::ids(data) {
        let f = core::fold(&core::session_dir(data, &wid), true).map(|f| f.fold);
        let f = f.unwrap_or_default();
        // Plan reviews, in any session's own fold [§6, §8].
        f.plans.done.iter().for_each(&mut add);
        let Some(l) = workers::link(data, &wid).filter(|l| !l.session) else {
            continue;
        };
        let notes = f.outcomes;
        // A retry still going has already said its parent failed a check.
        for n in &notes {
            // A rerun after a temporary end isn't a failed check [D340, D353].
            let start = n["phase"] == "start" && n["step"] != "same";
            if let Some(of) = n["retry_of"].as_str().filter(|_| start) {
                *retried.entry(of.into()).or_default() += 1;
            }
        }
        // One that never ended (held unstarted, or still going) is no result yet [C5].
        if l.last.is_null() {
            continue;
        }
        let end = notes.iter().rev().find(|n| n["phase"] == "end").cloned();
        for n in &notes {
            match n["phase"] == "review" {
                true if n["ran"] == true => add(n),
                true => off += 1,
                false => {}
            }
        }
        let cause = workers::cause(&l, &notes).to_string();
        rows.push((wid, l.ran, end.unwrap_or_default(), cause));
    }
    // An alias its CLI didn't name the real model of groups under the one another worker on it
    // said [D392 P7]. shortcut: any such worker's, not the latest, until an alias moves often.
    let known: HashMap<(String, String), String> = (rows.iter())
        .filter_map(|(_, r, ..)| {
            let key = (r["agent"].as_str()?.into(), r["model"].as_str()?.into());
            Some((key, r["real"].as_str()?.into()))
        })
        .collect();
    let mut branches = HashMap::new();
    // (job, agent, model) → its counts.
    #[derive(Default)]
    struct Tally {
        name: Value,
        kept: u64,
        of: u64,
        finished: u64,
        retried: u64,
        committed: u64,
        cut: u64,
    }
    let mut tally: BTreeMap<(Option<String>, String, String), Tally> = BTreeMap::new();
    for (wid, ran, end, cause) in rows {
        // Its model didn't end it, so it says nothing of its model, retried or not.
        let other = matches!(cause.as_str(), "infrastructure" | "environment" | "quota");
        let commits = end["commits"].as_u64().unwrap_or(0);
        let (landed, reverted) = match commits {
            0 => (false, false),
            _ => landed(data, &wid, &mut branches),
        };
        // Each `--retry` is its parent reporting a failed check on it: the only check report.
        let retries = match other {
            true => 0,
            false => retried.get(&wid).copied().unwrap_or(0),
        };
        let finished = end["how"] == "finished" && cause.is_empty();
        let kept = finished && commits > 0 && landed && retries == 0 && !reverted;
        let failed = cause == "unknown" && end["how"] == "failed";
        let counted = kept || failed || retries > 0 || reverted;
        let job = (ran["job"].as_str().map(String::from))
            .or(ran["row"].as_str().map(crate::routing::capital));
        let agent = ran["agent"].as_str().unwrap_or("").to_string();
        let alias = ran["model"].as_str().unwrap_or("").to_string();
        let model = (ran["real"].as_str().map(String::from))
            .or(known.get(&(agent.clone(), alias.clone())).cloned())
            .unwrap_or(alias);
        let t = tally.entry((job, agent, model)).or_default();
        if t.name.is_null() {
            t.name = ran.get("name").cloned().unwrap_or_default();
        }
        t.kept += kept as u64;
        t.of += counted as u64;
        t.finished += finished as u64;
        t.retried += (retries > 0) as u64;
        t.committed += (finished && commits > 0) as u64;
        t.cut += (cause == "infrastructure") as u64;
    }
    // Jobs in the user's order, then any gone or from before jobs, then named models.
    let order: Vec<Value> =
        (crate::routing::current(data)["jobs"].as_array().cloned()).unwrap_or_default();
    let rank = |j: &Option<String>| match j {
        Some(j) => order
            .iter()
            .position(|o| o["name"] == j.as_str())
            .unwrap_or(order.len()),
        None => order.len() + 1,
    };
    let mut jobs: Vec<(Option<String>, Vec<Value>)> = vec![];
    for ((job, agent, model), t) in tally {
        // Judged by its commits where most of its work makes some, not by one run that did.
        let commits = t.kept > 0 || (t.committed > 0 && t.committed * 2 >= t.finished);
        // Nothing to say yet: only stopped or cut runs, or commits not merged yet.
        if t.of == 0 && (commits || t.finished == 0) {
            continue;
        }
        let m = json!({"agent": agent, "model": model, "name": t.name, "kept": commits.then_some(t.kept),
            "of": t.of, "finished": t.finished, "retried": t.retried, "cut": t.cut});
        match jobs.iter_mut().find(|(j, _)| *j == job) {
            Some((_, l)) => l.push(m),
            None => jobs.push((job, vec![m])),
        }
    }
    jobs.sort_by_key(|(j, _)| rank(j));
    let jobs: Vec<Value> = (jobs.into_iter())
        .map(|(job, models)| json!({"job": job, "models": models}))
        .collect();
    let (count, [findings, fixed, rejected]) = reviews;
    let reviews = (count + off > 0).then(|| {
        json!({"count": count, "off": off, "findings": findings, "fixed": fixed, "rejected": rejected})
    });
    json!({"jobs": jobs, "reviews": reviews, "ok": true})
}
