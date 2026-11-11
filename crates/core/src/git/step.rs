//! The card's control (2.48) [D1278, D1285, D1286, D1287]: its next step, one thing per click, and
//! why each of its menu's rows can't run, worked out from git each read: Rust sends structure and
//! the UI writes the words [D65]. Nothing here runs anything [D1203, D1286].

use super::precheck::{
    Merge, blocked, count, git, merge, merge_base, midway, rebasing_in, shared_with,
};
use super::{Checkout, Status, Target, push, read, status};
use crate::worktrees::landing::Landing;
use crate::worktrees::{self, Lands};
use crate::{host, load};
use serde_json::{Map, Value, json};
use std::io;
use std::path::Path;
use std::sync::atomic::AtomicBool;

/// The control's step for a session or project, the commits it was worked out on (which Merge
/// into main and Catch up are pinned to), and the base's freshness [D1049, D1193]. `checkout`:
/// `target`'s, as `super::checkout` finds it.
pub fn step(
    data: &Path,
    target: &Target,
    checkout: &Checkout,
    stop: &AtomicBool,
) -> io::Result<Value> {
    let now = status(checkout, stop)?;
    let id = match target {
        Target::Session(id) => Some(*id),
        Target::Project(_) => None,
    };
    // A "here" fork in another session's worktree reads that session's record [D1082].
    let holder = id.and_then(|id| crate::share::holder(data, &load(data, id).ok()?));
    let lands = match holder.as_ref() {
        Some(holder) => worktrees::lands(&holder.dir)?,
        None => None,
    };
    // A rebase stopped midway detaches HEAD: its branch is the one it rebases.
    let rebasing = rebasing_in(&checkout.git_dir);
    let branch =
        (now.head["branch"].as_str()).or_else(|| rebasing.as_deref()?.strip_prefix("refs/heads/"));
    let (step, at) = match branch {
        // Detached: the card's branch row says so, and there's no step [D1187].
        None => (Value::Null, json!({"head": now.head["head"], "base": null})),
        Some(branch) => control(data, id, checkout, &now, branch, lands.as_ref(), stop)?,
    };
    let freshness = holder
        .and_then(|h| worktrees::base(&h.dir))
        .map(|base| super::truth::base(checkout, &base, stop))
        .transpose()?;
    Ok(json!({"step": step, "at": at, "freshness": freshness}))
}

/// Commit, then Push, then Create PR; Sync when the branch's own remote has commits it doesn't;
/// Catch up when the base moved; Resolve with agent when either would conflict [D1280, D1285,
/// D1286, D1290]. With nothing to do: none, a grey Commit [D1287]. In your own folder there's no
/// base to land into, so Create PR, Catch up and Merge into main stay off [D1045].
fn control(
    data: &Path,
    id: Option<&str>,
    checkout: &Checkout,
    now: &Status,
    branch: &str,
    lands: Option<&Lands>,
    stop: &AtomicBool,
) -> io::Result<(Value, Value)> {
    let root = &checkout.root;
    let head = now.head["head"].as_str();
    let files = now.files.len();
    let (ahead, behind) = (u(&now.head["ahead"]), u(&now.head["behind"]));
    let upstream = now.head["upstream"].as_str();
    let remote = push::remote(checkout, branch).ok();
    // The first reason a row gets is the one it shows.
    let mut off = Map::new();
    let mut why = |row: &str, reason: &str| {
        off.entry(row).or_insert(reason.into());
    };
    let (mut next, mut resolve) = (None, Value::Null);
    let mut facts =
        json!({"base": null, "moved": 0, "pr": null, "landedAtMs": null, "sharedWith": null});

    if files == 0 {
        why("commit", "clean");
    }
    // A checkout already mid-merge or mid-rebase reads as Resolve with agent [D1290].
    if midway(&checkout.git_dir) {
        let conflicted = (now.files.iter())
            .filter(|(_, f)| f["changes"] == "conflicted")
            .map(|(path, _)| path.as_str())
            .collect::<Vec<_>>();
        let (op, onto) = under_way(checkout, branch, lands.map(|l| l.base.as_str()), stop);
        resolve = json!({"op": op, "ref": onto, "files": conflicted});
        next = Some("resolve");
        for row in ["commit", "push", "createPr", "sync", "catchUp", "merge"] {
            why(row, "conflicts");
        }
    }
    // The branch's own remote: Sync pulls, then pushes [D1286]; a pull that would conflict is the
    // agent's, with the upstream as its ref [D1290].
    match (upstream, behind) {
        (None, _) => why("sync", "unpublished"),
        (Some(_), 0) => why("sync", "synced"),
        (Some(_), _) if files > 0 => why("sync", "commitFirst"),
        (Some(up), _) => match head.map(|h| conflicts(root, h, "@{upstream}", stop)) {
            Some(Ok(Some(files))) => {
                why("sync", "conflicts");
                if next.is_none() {
                    resolve = json!({"op": "pull", "ref": up, "files": files});
                    next = Some("resolve");
                }
            }
            _ if next.is_none() => next = Some("sync"),
            _ => {}
        },
    }
    if behind > 0 {
        why("push", "behind");
    }
    match (&remote, upstream) {
        (None, _) => why("push", "noRemote"),
        (Some(_), Some(_)) if ahead == 0 => why("push", "pushed"),
        _ => {}
    }
    if head.is_none() {
        why("push", "commitFirst");
    }

    let landing = match (id, lands, head) {
        (Some(id), Some(lands), Some(head)) => Some(session(
            data,
            id,
            checkout,
            now,
            lands,
            head,
            remote.as_deref(),
            stop,
        )?),
        _ => None,
    };
    let pr = id.and_then(|id| host::open_pr(id, branch));
    let at = json!({"head": head, "base": landing.as_ref().map(|s| s.base_at.clone())});
    match landing {
        None => {
            for row in ["createPr", "catchUp", "merge"] {
                why(row, "noBase");
            }
        }
        Some(s) => {
            facts["base"] = s.base.as_str().into();
            facts["moved"] = s.moved.into();
            facts["pr"] = pr.into();
            facts["landedAtMs"] = s.landed_at.into();
            if s.own == 0 && upstream.is_none() {
                why(
                    "push",
                    if files > 0 {
                        "commitFirst"
                    } else {
                        "noCommits"
                    },
                );
            }
            if s.landed_at.is_some() {
                for row in ["createPr", "merge"] {
                    why(row, "landed");
                }
            }
            if let Some(with) = &s.shared {
                facts["sharedWith"] = with.as_str().into();
                for row in ["createPr", "catchUp", "merge"] {
                    why(row, "shared");
                }
            }
            // Its PR into this base merged on the host with nothing new since: there's no PR to make
            // [D1018]. A remote-tracking base lands into its name on the host, as `host::pr` reads it;
            // the remotes are asked only when such a PR is kept.
            let kept = id.map_or(Value::Null, |id| host::kept(&crate::session_dir(data, id)));
            let merged: Vec<&Value> = (kept["prs"].as_array().into_iter().flatten())
                .filter(|p| p["state"] == "merged" && p["head"].as_str() == head)
                .collect();
            if kept["branch"] == branch && !merged.is_empty() {
                let remotes = git(root, &["remote"], stop).unwrap_or_default();
                let on_host = (remotes.lines())
                    .find_map(|r| s.base.strip_prefix(&format!("{r}/")))
                    .unwrap_or(&s.base);
                if merged.iter().any(|p| p["base"] == on_host) {
                    why("createPr", "prMerged");
                }
            }
            if pr.is_some() {
                why("createPr", "prOpen");
                why("merge", "inPrTab");
            }
            if s.own == 0 {
                for row in ["createPr", "merge"] {
                    why(
                        row,
                        if files > 0 {
                            "commitFirst"
                        } else {
                            "noCommits"
                        },
                    );
                }
            }
            if files > 0 {
                why("catchUp", "commitFirst");
                why("merge", "commitFirst");
            }
            // Catching up is this session's own when it lands, not a shared folder's [D1082].
            let mine = s.landed_at.is_none() && s.shared.is_none();
            // Sync pushes too, so with main moved it waits for Catch up [D1282].
            let held = s.moved > 0 && s.landed_at.is_none() && ahead > 0;
            if held && next == Some("sync") {
                next = None;
            }
            match (s.moved, &s.conflicts) {
                (0, _) => why("catchUp", "upToDate"),
                (_, Some(files)) => {
                    why("catchUp", "conflicts");
                    if next.is_none() && mine {
                        resolve = json!({"op": "merge", "ref": s.base, "files": files});
                        next = Some("resolve");
                    }
                }
                _ if next.is_none() && files == 0 && mine => next = Some("catchUp"),
                _ => {}
            }
            // Main moved: nothing goes out until it's caught up [D1282].
            if s.moved > 0 && s.landed_at.is_none() {
                for row in ["push", "createPr", "merge"] {
                    why(row, "moved");
                }
            }
            if held {
                why("sync", "moved");
            }
            if upstream.is_none() || ahead > 0 {
                why("createPr", "pushFirst");
            }
            if s.no_host {
                why("createPr", "noHost");
            }
            if let Some(blocked) = s.blocked {
                why("merge", blocked);
            }
        }
    }
    if files > 0 && next.is_none() {
        next = Some("commit");
    }
    for row in ["push", "createPr"] {
        if next.is_none() && !off.contains_key(row) {
            next = Some(row);
        }
    }
    facts["next"] = next.into();
    facts["off"] = off.into();
    facts["branch"] = branch.into();
    facts["ahead"] = ahead.into();
    facts["behind"] = behind.into();
    facts["files"] = files.into();
    facts["resolve"] = resolve;
    Ok((facts, at))
}

/// What a session's worktree adds: its base, how far it moved, its own commits, a landing that
/// holds, and why Merge into main can't run.
struct Session {
    base: String,
    base_at: String,
    own: u64,
    moved: u64,
    /// Catching up would conflict in these files.
    conflicts: Option<Vec<String>>,
    /// Merged into the base on this machine, nothing since [D1229].
    landed_at: Option<u64>,
    shared: Option<String>,
    no_host: bool,
    blocked: Option<&'static str>,
}

#[allow(clippy::too_many_arguments)]
fn session(
    data: &Path,
    id: &str,
    checkout: &Checkout,
    now: &Status,
    lands: &Lands,
    head: &str,
    remote: Option<&str>,
    stop: &AtomicBool,
) -> io::Result<Session> {
    let root = &checkout.root;
    let base = lands.base.as_str();
    let base_at = git(
        root,
        &["rev-parse", "--verify", &format!("{base}^{{commit}}")],
        stop,
    )
    .or_else(|_| super::err(format!("{base} isn't in this project any more.")))?;
    let merge_base = merge_base(root, &base_at, head, stop)?;
    let own = count(root, &format!("{merge_base}..{head}"), stop)?;
    let (moved, landing) = moved(root, lands, &base_at, head, stop)?;
    let landed_at = landing
        .filter(|l| now.files.is_empty() && l.head == head)
        .map(|l| l.at_ms);
    // One merge of the base into the branch answers both Catch up's conflicts and Merge into
    // main's pre-check: the same commits, merge base and tree.
    let merged = match (moved, own) {
        (0, 0) => None,
        _ => {
            let tree = git(root, &["rev-parse", &format!("{head}^{{tree}}")], stop)?;
            Some(merge(root, &base_at, &merge_base, &tree, stop)?)
        }
    };
    let conflicts = match (moved, &merged) {
        (0, _) => None,
        (_, Some(Merge::Conflicts(files))) => Some(files.clone()),
        _ => None,
    };
    let no_host = (remote.and_then(|r| push::url(checkout, r).ok()))
        .is_none_or(|url| host::repo(&url).is_none());
    // Merge into main's own pre-check: the base a remote branch, or its folder busy [D1161, D1228].
    let blocked = match (own, &conflicts, &merged) {
        (0, _, _) | (_, Some(_), _) | (_, _, None) => None,
        (_, _, Some(Merge::Conflicts(_))) => Some("moved"),
        (_, _, Some(Merge::Clean(merged))) => {
            match blocked(root, base, &base_at, merged, stop)?["why"].as_str() {
                Some("remote") => Some("remoteBase"),
                Some(_) => Some("baseBusy"),
                None => None,
            }
        }
    };
    Ok(Session {
        base: base.into(),
        base_at,
        own,
        moved,
        conflicts,
        landed_at,
        shared: shared_with(data, id),
        no_host,
        blocked,
    })
}

/// The base's own commits since this branch last met it, and the session's own landing while it
/// holds, which never counts, whatever its kind [D1229]. Main moved: nothing goes out until it's
/// caught up [D1282].
pub(super) fn moved<'a>(
    root: &Path,
    lands: &'a Lands,
    base_at: &str,
    head: &str,
    stop: &AtomicBool,
) -> io::Result<(u64, Option<&'a Landing>)> {
    let ancestor =
        |a: &str, b: &str| read(root, &["merge-base", "--is-ancestor", a, b], stop).is_ok();
    let landing = (lands.landing.as_ref())
        .filter(|l| ancestor(&l.commit, base_at) && ancestor(&l.head, head));
    let moved = match landing {
        Some(l) => {
            let (not_head, not_landing) = (format!("^{head}"), format!("^{}", l.commit));
            let args = [
                "rev-list",
                "--count",
                base_at,
                &not_head,
                &not_landing,
                "--",
            ];
            git(root, &args, stop)?.parse().map_err(io::Error::other)?
        }
        None => count(root, &format!("{head}..{base_at}"), stop)?,
    };
    Ok((moved, landing))
}

/// What a merge or rebase stopped midway brings in: the branch's own upstream (a pull) or the base
/// (a merge) when it's one of them, else its commit [D1290].
fn under_way(
    checkout: &Checkout,
    branch: &str,
    base: Option<&str>,
    stop: &AtomicBool,
) -> (&'static str, String) {
    let dir = &checkout.git_dir;
    let incoming = ["MERGE_HEAD", "rebase-merge/onto", "rebase-apply/onto"]
        .iter()
        .find_map(|f| std::fs::read_to_string(dir.join(f)).ok())
        .and_then(|text| text.lines().next().map(str::to_string))
        .unwrap_or_default();
    let root = &checkout.root;
    let upstream = git(
        root,
        &[
            "rev-parse",
            "--abbrev-ref",
            &format!("{branch}@{{upstream}}"),
        ],
        stop,
    );
    let at = |name: &str| {
        git(
            root,
            &["rev-parse", "--verify", &format!("{name}^{{commit}}")],
            stop,
        )
    };
    for (op, name) in [("pull", upstream.ok()), ("merge", base.map(String::from))] {
        if let Some(name) = name.filter(|n| at(n).is_ok_and(|c| c == incoming)) {
            return (op, name);
        }
    }
    ("merge", incoming.chars().take(7).collect())
}

/// The files merging `theirs` into `head` would conflict in, as `git merge-tree` says; none when
/// it merges cleanly. Nothing is written but git's own objects [D1166].
fn conflicts(
    root: &Path,
    head: &str,
    theirs: &str,
    stop: &AtomicBool,
) -> io::Result<Option<Vec<String>>> {
    let theirs = git(
        root,
        &["rev-parse", "--verify", &format!("{theirs}^{{commit}}")],
        stop,
    )?;
    let base = git(root, &["merge-base", head, &theirs], stop)?;
    let tree = git(root, &["rev-parse", &format!("{head}^{{tree}}")], stop)?;
    Ok(match merge(root, &theirs, &base, &tree, stop)? {
        Merge::Conflicts(files) => Some(files),
        Merge::Clean(_) => None,
    })
}

fn u(value: &Value) -> u64 {
    value.as_u64().unwrap_or(0)
}
