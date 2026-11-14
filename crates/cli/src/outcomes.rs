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
    let Some(l) = core::worktrees::lands(&core::session_dir(data, wid))
        .ok()
        .flatten()
    else {
        return (false, false);
    };
    let repo = l.repo.to_string_lossy().to_string();
    let b =
        (branches.entry((repo.clone(), l.base.clone()))).or_insert_with(|| branch(&repo, &l.base));
    let Some(head) = l.branch.and_then(|name| b.heads.get(&name).cloned()) else {
        return (false, false);
    };
    if head == l.base_commit || !b.first.contains_key(&head) {
        return (false, false);
    }
    let mut at = head;
    while at != l.base_commit && !at.is_empty() {
        let merge = b.merged_by.get(&at);
        if b.reverted.contains(&at) || merge.is_some_and(|m| b.reverted.contains(m)) {
            return (false, true);
        }
        at = b.first.get(&at).cloned().unwrap_or_default();
    }
    (true, false)
}

/// `routing results`: each worker's outcome, then success per model as it ran (after any move
/// in its row) [D2038], and the reviews' counts [D3026]; the rules below are proposed.
pub(crate) fn results(data: &Path) -> Value {
    let mut rows = vec![];
    let mut retried: HashMap<String, u64> = HashMap::new();
    // A sum any review left unknown is unknown, never 0 [D74].
    let mut reviews = (0u64, [Some(0u64); 3]);
    for wid in core::ids(data) {
        let Some(l) = workers::link(data, &wid).filter(|l| !l.session) else {
            continue;
        };
        let notes = workers::outcomes(data, &wid);
        let end = notes.iter().rev().find(|n| n["phase"] == "end").cloned();
        for n in &notes {
            // A rerun after a temporary end isn't a failed check [D340, D353].
            let start = n["phase"] == "start" && n["step"] != "same";
            if let Some(of) = n["retry_of"].as_str().filter(|_| start) {
                *retried.entry(of.into()).or_default() += 1;
            }
            if n["phase"] == "review" && n["ran"] == true {
                reviews.0 += 1;
                for (sum, k) in reviews.1.iter_mut().zip(["findings", "fixed", "rejected"]) {
                    *sum = sum.zip(n[k].as_u64()).map(|(a, b)| a + b);
                }
            }
        }
        rows.push((wid, l.ran, end.unwrap_or_default()));
    }
    let mut branches = HashMap::new();
    let mut models: BTreeMap<(String, String), (u64, u64)> = BTreeMap::new();
    let workers: Vec<Value> = (rows.into_iter())
        .map(|(wid, ran, end)| {
            let commits = end["commits"].as_u64().unwrap_or(0);
            let (kept, reverted) = match commits {
                0 => (false, false),
                _ => landed(data, &wid, &mut branches),
            };
            // Each `--retry` is its parent reporting a failed check on it: the only check report.
            let retries = retried.get(&wid).copied().unwrap_or(0);
            let how = end["how"].as_str().unwrap_or("");
            // A worker that changed nothing never succeeds; stopped, temporary and nothing
            // changed aren't counted unless it was retried or reverted.
            let succeeded = how == "finished" && commits > 0 && retries == 0 && !reverted;
            let failed = how == "failed" && end["temporary"] != true;
            let counted = succeeded || failed || retries > 0 || reverted;
            let (agent, model) = (ran["agent"].as_str().unwrap_or(""), ran["model"].as_str().unwrap_or(""));
            if counted {
                let m = models.entry((agent.into(), model.into())).or_default();
                (m.0, m.1) = (m.0 + succeeded as u64, m.1 + 1);
            }
            json!({"id": wid, "agent": agent, "model": model, "how": end["how"], "temporary": end["temporary"],
                "commits": commits, "retries": retries, "checks": retries, "kept": kept, "reverted": reverted,
                "succeeded": succeeded, "counted": counted})
        })
        .collect();
    let models: Vec<Value> = (models.into_iter())
        .map(|((agent, model), (succeeded, of))| json!({"agent": agent, "model": model, "succeeded": succeeded, "of": of}))
        .collect();
    let (count, [findings, fixed, rejected]) = reviews;
    let reviews = (count > 0).then(
        || json!({"count": count, "findings": findings, "fixed": fixed, "rejected": rejected}),
    );
    json!({"models": models, "reviews": reviews, "workers": workers, "ok": true})
}
