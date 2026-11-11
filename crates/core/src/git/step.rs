//! The action button's next step [D1015, D1045, D1152], worked out from git all the time: Rust
//! sends structure and the UI writes the words [D65].

use super::precheck::{
    Merge, blocked, count, git, merge, merge_base, midway, next_tree, shared_with,
};
use super::{Checkout, Status, Target, checkout, err, push, status};
use crate::worktrees::{self, Lands};
use crate::{host, load, projects, session_dir};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::time::{Duration, Instant};

/// Proposed: the branch's PRs are read again after this, or at once when asked, until 2.27's watch.
const PR_AGE: Duration = Duration::from_secs(120);
/// Each session's PRs as last read: when, for which HEAD and push count, the host's name and the rows.
type Read = (Instant, (String, u64), Option<String>, Option<Vec<Value>>);
static PRS: Mutex<BTreeMap<String, Read>> = Mutex::new(BTreeMap::new());

/// Focus and each new host read bypass the 120 s cache, even a cached empty PR list [D1187].
pub fn invalidate_prs() {
    PRS.lock().unwrap().clear();
}

/// The action button's next step for a session or project [D1015, D1045], what the toolbar's dot
/// says [D1025], how it lands [D1028], and the commits it was worked out on, which a landing
/// pins. `fresh`: the PRs are read again now, as after an action.
pub fn step(data: &Path, target: &Target, fresh: bool, stop: &AtomicBool) -> io::Result<Value> {
    let checkout = checkout(data, target)?;
    let now = status(&checkout, stop)?;
    let (id, dir) = match target {
        Target::Session(id) => (Some(*id), session_dir(data, id)),
        Target::Project(_) => (None, PathBuf::new()),
    };
    // A "here" fork in another session's worktree reads that session's record [D1082].
    let holder = id.and_then(|id| crate::share::holder(data, &load(data, id).ok()?));
    let lands = match holder.as_ref() {
        Some(holder) => worktrees::lands(&holder.dir)?,
        None => None,
    };
    let (step, at, style) = match (id, lands) {
        (Some(id), Some(lands)) => {
            let (step, at) = session(data, id, &dir, &checkout, &now, &lands, fresh, stop)?;
            (
                step,
                at,
                style(data, target, &checkout.root, &lands.base, stop)?,
            )
        }
        // A folder's HEAD pins its commit-first Sync or Publish [D1049].
        _ => (
            folder(&checkout, &now),
            json!({"head": now.head["head"], "base": null}),
            Value::Null,
        ),
    };
    let freshness = holder
        .and_then(|h| worktrees::base(&h.dir))
        .map(|base| super::truth::base(&checkout, &base, stop))
        .transpose()?;
    Ok(json!({"step": step, "at": at, "merge": style, "freshness": freshness}))
}

/// The user's own folder: VS Code's Commit, Publish Branch and Sync Changes [D1045].
fn folder(checkout: &Checkout, now: &Status) -> Value {
    let head = &now.head;
    let Some(branch) = head["branch"].as_str() else {
        return Value::Null;
    };
    let (ahead, behind) = (head["ahead"].as_u64(), head["behind"].as_u64());
    let commit = json!({"kind": "folderCommit", "branch": branch,
        "ahead": ahead.unwrap_or(0), "behind": behind.unwrap_or(0)});
    // Nowhere to publish, or no first commit yet: only a commit is left to do.
    let Ok(remote) = push::remote(checkout, branch) else {
        return commit;
    };
    if head["head"].is_null() {
        return commit;
    }
    // Sync or Publish commits what's uncommitted first [D1203, D1207].
    let first = now.files.len();
    if head["upstream"].is_null() {
        return json!({"kind": "publish", "branch": branch, "remote": remote, "commit": first});
    }
    match ahead.unwrap_or(0) + behind.unwrap_or(0) + first as u64 {
        0 => commit,
        _ => json!({"kind": "sync", "branch": branch, "remote": remote,
            "ahead": ahead.unwrap_or(0), "behind": behind.unwrap_or(0), "commit": first}),
    }
}

/// A session's own worktree: Merge into its base, committing what isn't first, or Catch up, then
/// landed; with an open PR, the PR's step [D1015, D1016, D1019, D1093, D1102, D1203, D1207].
#[allow(clippy::too_many_arguments)]
fn session(
    data: &Path,
    id: &str,
    dir: &Path,
    checkout: &Checkout,
    now: &Status,
    lands: &Lands,
    fresh: bool,
    stop: &AtomicBool,
) -> io::Result<(Value, Value)> {
    let root = &checkout.root;
    let base = lands.base.as_str();
    let Some(head) = now.head["head"].as_str() else {
        return Ok((Value::Null, Value::Null));
    };
    let base_at = git(
        root,
        &["rev-parse", "--verify", &format!("{base}^{{commit}}")],
        stop,
    )
    .or_else(|_| err(format!("{base} isn't in this project any more.")))?;
    let at = json!({"head": head, "base": base_at});
    let files = now.files.values();
    if midway(&checkout.git_dir) {
        let left = files.filter(|f| f["changes"] == "conflicted").count();
        return Ok((json!({"kind": "continue", "base": base, "left": left}), at));
    }
    let merge_base = merge_base(root, lands, &base_at, head, stop)?;
    // The landing step commits every change first, so it's worked out on what that commit would
    // hold [D1203, D1207].
    let first = now.files.len();
    if first == 0
        && let Some(landing) =
            (lands.landing.as_ref()).filter(|l| worktrees::landed(&lands.repo, &base_at, head, l))
    {
        return Ok((
            json!({"kind": "landed", "base": base, "atMs": landing.at_ms}),
            at,
        ));
    }
    // The remote has commits this branch doesn't, as after a push turned away: Sync is the fix
    // [D1206].
    let behind = now.head["behind"].as_u64().unwrap_or(0);
    if behind > 0
        && let Some(branch) = now.head["branch"].as_str()
        && let Ok(remote) = push::remote(checkout, branch)
    {
        let ahead = now.head["ahead"].as_u64().unwrap_or(0);
        let step = json!({"kind": "sync", "branch": branch, "remote": remote,
            "behind": behind, "ahead": ahead, "commit": first});
        return Ok((step, at));
    }
    if let Some(step) = pr(data, id, now, base, first, fresh) {
        return Ok((step, at));
    }
    let ahead = count(root, &format!("{merge_base}..{head}"), stop)?;
    if ahead == 0 && first == 0 {
        // Nothing of its own yet, or all of it already in the base.
        let step = match head == lands.base_commit {
            true => json!({"kind": "commit", "base": base, "waiting": 0, "clean": true}),
            false => json!({"kind": "landed", "base": base, "atMs": null}),
        };
        return Ok((step, at));
    }
    let tree = match first {
        0 => git(root, &["rev-parse", &format!("{head}^{{tree}}")], stop)?,
        _ => next_tree(checkout, dir, true, stop)?,
    };
    let step = match merge(root, &base_at, &merge_base, &tree, stop)? {
        Merge::Conflicts(conflicts) => {
            json!({"kind": "catchUp", "base": base, "conflicts": conflicts, "commit": first})
        }
        Merge::Clean(merged) => {
            // After a squash still in the base, the base moved only past that squash: its own
            // commit isn't counted [D1229].
            let since = match &lands.landing {
                Some(l) if l.style == "squash" && l.head == merge_base => l.commit.as_str(),
                _ => head,
            };
            let moved = count(root, &format!("{since}..{base_at}"), stop)?;
            let blocked = match shared_with(data, id) {
                Some(with) => json!({"why": "shared", "with": with}),
                None => blocked(root, base, &base_at, &merged, stop)?,
            };
            json!({"kind": "merge", "base": base, "ready": ahead, "moved": moved,
                "blocked": blocked, "commit": first})
        }
    };
    Ok((step, at))
}

/// With an open PR the button follows it [D1016, D1019]: Push to #N while commits aren't on the
/// host or changes aren't committed, Fix with agent on failed checks, conflicts or changes asked, else Merge #N. None when the
/// branch isn't published, has no open PR, or gh can't say: then the local steps stand.
fn pr(data: &Path, id: &str, now: &Status, base: &str, first: usize, fresh: bool) -> Option<Value> {
    now.head["upstream"].as_str()?;
    let ahead = now.head["ahead"].as_u64().unwrap_or(0);
    let key = (now.head["head"].as_str().unwrap_or("").to_string(), ahead);
    let cached = (PRS.lock().unwrap().get(id).cloned())
        .filter(|(at, was, ..)| !fresh && *was == key && at.elapsed() < PR_AGE);
    let (_, _, host_name, rows) = match cached {
        Some(read) => read,
        None => {
            let pr = host::pr(data, id).ok()?;
            let host_name = pr.repo.as_ref().map(|r| r.name().to_string());
            let rows = pr.list().and_then(|v| v.as_array().cloned());
            let read = (Instant::now(), key, host_name, rows);
            PRS.lock().unwrap().insert(id.to_string(), read.clone());
            read
        }
    };
    let rows = rows?;
    if let Some(landed) = super::truth::landing(data, id, now) {
        return Some(landed);
    }
    let open = rows.into_iter().find(|p| p["state"] == "open")?;
    let number = open["number"].clone();
    // Uncommitted changes are committed, then pushed to the PR [D1203].
    if ahead > 0 || first > 0 {
        return Some(
            json!({"kind": "pushPr", "base": base, "pr": number, "ahead": ahead,
            "host": host_name, "commit": first}),
        );
    }
    let why = match open["health"].as_str() {
        Some("failed") => "checks",
        Some("conflicts") => "conflicts",
        Some("changes") => "changes",
        _ => {
            let checks = json!({"passed": open["passed"], "failed": open["failed"],
                "running": open["running"], "approved": open["approved"],
                "cancelled": open["cancelled"], "skipped": open["skipped"],
                "blocked": matches!(open["health"].as_str(), Some("unknown" | "cancelled"))});
            return Some(
                json!({"kind": "mergePr", "base": base, "pr": number, "checks": checks,
                "mergeable": open["mergeable"]}),
            );
        }
    };
    Some(json!({"kind": "fixPr", "base": base, "pr": number, "why": why, "failed": open["failed"]}))
}

/// The project a target lands in, if any.
fn project_of(data: &Path, target: &Target) -> io::Result<Option<String>> {
    Ok(match target {
        Target::Session(id) => load(data, id)?.project,
        Target::Project(id) => Some(id.to_string()),
    })
}

/// How the project's sessions land: the pick remembered for it, else a guess from the base's own
/// history, a merge commit if it has any, else squash [D1028].
fn style(
    data: &Path,
    target: &Target,
    dir: &Path,
    base: &str,
    stop: &AtomicBool,
) -> io::Result<Value> {
    let project = project_of(data, target)?;
    if let Some(picked) = project.and_then(|p| projects::get(data, &p).ok()?.merge) {
        return Ok(picked.into());
    }
    let parents = git(
        dir,
        &[
            "log",
            "--first-parent",
            "--max-count=50",
            "--format=%P",
            base,
            "--",
        ],
        stop,
    )?;
    Ok(match parents.lines().any(|p| p.contains(' ')) {
        true => "merge".into(),
        false => "squash".into(),
    })
}

/// Remembers the merge style picked for the target's project [D1028].
pub fn set_style(data: &Path, target: &Target, style: &str) -> io::Result<()> {
    if !matches!(style, "merge" | "squash") {
        return err(format!("not a merge style: {style:?}"));
    }
    match project_of(data, target)? {
        Some(project) => projects::set_merge(data, &project, style),
        None => err("This chat has no project."),
    }
}
