//! Land [D1015, D1028, D1049]: the action button's next step, worked out from git, and landing a
//! session's branch into its base as a merge commit or a squash. Rust sends structure; the UI
//! writes the words [D65].
//!
//! The pre-check is `git merge-tree`, which leaves the index and files alone but writes objects,
//! so its result is kept by the commits and tree it merged and runs again only when one changes.
//! Those objects are left to git's own gc as unreferenced loose objects (proposed) [D35, D1049].

use super::{Checkout, Status, Target, checkout, err, lock, push, read, status};
use crate::adapters::setup;
use crate::worktrees::{self, Landing, Lands};
use crate::{host, load, projects, session_dir};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// Proposed: a landing's git gives up after this.
const LAND_SECS: u64 = 120;
/// Proposed: the branch's PRs are read again after this, or at once when asked, until 2.27's watch.
const PR_AGE: Duration = Duration::from_secs(120);
/// How many pre-check results are kept.
const KEPT: usize = 64;

#[derive(Clone)]
enum Merge {
    /// The merged tree.
    Clean(String),
    Conflicts(Vec<String>),
}

/// Pre-check results by base commit, merge base and tree.
static MERGES: Mutex<Vec<([String; 3], Merge)>> = Mutex::new(Vec::new());
/// Each session's PRs as last read: when, for which HEAD and push count, the host's name and the rows.
type Read = (Instant, (String, u64), Option<String>, Option<Vec<Value>>);
static PRS: Mutex<BTreeMap<String, Read>> = Mutex::new(BTreeMap::new());
static TEMP: AtomicU64 = AtomicU64::new(0);

fn git(dir: &Path, args: &[&str], stop: &AtomicBool) -> io::Result<String> {
    Ok(String::from_utf8_lossy(&read(dir, args, stop)?)
        .trim()
        .to_string())
}

/// A git that writes: hooks off unless `hooks`, git's own words on a failure.
fn write(dir: &Path, hooks: bool, args: &[&str], stop: &AtomicBool) -> io::Result<String> {
    let mut command = match hooks {
        true => worktrees::with_hooks(dir),
        false => worktrees::command(dir),
    };
    command.env("PATH", setup::login().path).args(args);
    finish(&mut command, stop)
}

fn finish(command: &mut Command, stop: &AtomicBool) -> io::Result<String> {
    let out = setup::run_until(command, LAND_SECS, stop).map_err(io::Error::other)?;
    if !out.status.success() {
        return err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn count(dir: &Path, range: &str, stop: &AtomicBool) -> io::Result<u64> {
    git(dir, &["rev-list", "--count", range, "--"], stop)?
        .parse()
        .map_err(io::Error::other)
}

/// Merging `tree` into `base` from `merge_base`, as `git merge-tree` says.
fn merge(
    dir: &Path,
    base: &str,
    merge_base: &str,
    tree: &str,
    stop: &AtomicBool,
) -> io::Result<Merge> {
    let key = [base.to_string(), merge_base.to_string(), tree.to_string()];
    if let Some((_, merged)) = MERGES.lock().unwrap().iter().find(|(k, _)| *k == key) {
        return Ok(merged.clone());
    }
    let mut command = worktrees::command(dir);
    command.args([
        "merge-tree",
        "--write-tree",
        "--name-only",
        "-z",
        "--no-messages",
        &format!("--merge-base={merge_base}"),
        base,
        tree,
    ]);
    let out = setup::run_until(&mut command, LAND_SECS, stop).map_err(io::Error::other)?;
    let text = String::from_utf8_lossy(&out.stdout);
    let mut parts = text.split('\0').filter(|p| !p.is_empty());
    let merged = match (out.status.code(), parts.next()) {
        (Some(0), Some(tree)) => Merge::Clean(tree.to_string()),
        (Some(1), Some(_)) => Merge::Conflicts(parts.map(String::from).collect()),
        _ => {
            let why = String::from_utf8_lossy(&out.stderr).trim().to_string();
            return err(format!("git merge-tree: {why}"));
        }
    };
    let mut kept = MERGES.lock().unwrap();
    if kept.len() >= KEPT {
        kept.remove(0);
    }
    kept.push((key, merged.clone()));
    Ok(merged)
}

/// Removes a scratch file when dropped.
struct Scratch(PathBuf);

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

/// The tree the next commit would hold: the staged files, or everything when nothing is, as
/// Commit stages it then. Made in a copy of the index in the session's folder [D35], so the real
/// index and the files are never touched.
fn next_tree(checkout: &Checkout, dir: &Path, all: bool, stop: &AtomicBool) -> io::Result<String> {
    let n = TEMP.fetch_add(1, Ordering::SeqCst);
    let index = Scratch(dir.join(format!("precheck-{}-{n}.index", std::process::id())));
    match fs::copy(checkout.git_dir.join("index"), &index.0) {
        Err(e) if e.kind() != io::ErrorKind::NotFound => return Err(e),
        _ => {}
    }
    let run = |args: &[&str]| {
        let mut command = worktrees::command(&checkout.root);
        command.env("GIT_INDEX_FILE", &index.0).args(args);
        finish(&mut command, stop)
    };
    if all {
        run(&["add", "-A"])?;
    }
    run(&["write-tree"])
}

/// Whether a merge or rebase stopped midway in the checkout whose git folder is `git_dir`.
fn midway(git_dir: &Path) -> bool {
    ["MERGE_HEAD", "rebase-merge", "rebase-apply"]
        .iter()
        .any(|f| git_dir.join(f).exists())
}

/// The checkouts of the repository: each one's folder and the branch it has, or the branch it's
/// rebasing.
fn checkouts(dir: &Path, stop: &AtomicBool) -> io::Result<Vec<(PathBuf, Option<String>)>> {
    let out = read(dir, &["worktree", "list", "--porcelain", "-z"], stop)?;
    let text = String::from_utf8_lossy(&out);
    let mut found = vec![];
    for record in text.split("\0\0").filter(|r| !r.is_empty()) {
        let fields: Vec<&str> = record.split('\0').collect();
        let Some(path) = fields.iter().find_map(|f| f.strip_prefix("worktree ")) else {
            continue;
        };
        let path = PathBuf::from(path);
        if fields.contains(&"bare") || !path.is_dir() {
            continue;
        }
        let branch = fields
            .iter()
            .find_map(|f| f.strip_prefix("branch "))
            .map(String::from)
            .or_else(|| rebasing(&path, stop));
        found.push((path, branch));
    }
    Ok(found)
}

/// The branch a detached checkout is rebasing: it gets that branch back when the rebase ends.
fn rebasing(path: &Path, stop: &AtomicBool) -> Option<String> {
    let git_dir = PathBuf::from(git(path, &["rev-parse", "--absolute-git-dir"], stop).ok()?);
    ["rebase-merge/head-name", "rebase-apply/head-name"]
        .iter()
        .find_map(|f| fs::read_to_string(git_dir.join(f)).ok())
        .map(|name| name.trim().to_string())
}

/// The checkout that has `full` (a `refs/heads/` name), if any.
fn holder(dir: &Path, full: &str, stop: &AtomicBool) -> io::Result<Option<Checkout>> {
    let Some((path, _)) = (checkouts(dir, stop)?)
        .into_iter()
        .find(|(_, branch)| branch.as_deref() == Some(full))
    else {
        return Ok(None);
    };
    let git_dir = git(&path, &["rev-parse", "--absolute-git-dir"], stop)?;
    Ok(Some(Checkout {
        root: fs::canonicalize(&path)?,
        git_dir: fs::canonicalize(git_dir)?,
        // Used for its folder and lock only, which don't read this.
        worktree: false,
    }))
}

/// The files in `holder` a landing that changes `changed` would run into: edits, untracked and
/// ignored files at those paths or around them.
fn collisions(holder: &Checkout, changed: &[String], stop: &AtomicBool) -> io::Result<Vec<String>> {
    let args = [
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
        "--ignored=matching",
    ];
    let out = read(&holder.root, &args, stop)?;
    let text = String::from_utf8_lossy(&out);
    let mut records = text.split('\0').filter(|r| r.len() > 3);
    let mut there = vec![];
    while let Some(record) = records.next() {
        there.push(record[3..].trim_end_matches('/').to_string());
        // A rename's old path follows it.
        if matches!(record.as_bytes()[0], b'R' | b'C') {
            records.next();
        }
    }
    let near = |a: &str, b: &str| {
        a == b || a.starts_with(&format!("{b}/")) || b.starts_with(&format!("{a}/"))
    };
    let mut hit: Vec<String> = there
        .into_iter()
        .filter(|path| changed.iter().any(|c| near(c, path)))
        .collect();
    hit.sort();
    hit.dedup();
    Ok(hit)
}

/// The paths a landing from `from` to `to` changes.
fn changed(dir: &Path, from: &str, to: &str, stop: &AtomicBool) -> io::Result<Vec<String>> {
    let out = read(
        dir,
        &["diff", "--name-only", "--no-renames", "-z", from, to],
        stop,
    )?;
    Ok(String::from_utf8_lossy(&out)
        .split('\0')
        .filter(|p| !p.is_empty())
        .map(String::from)
        .collect())
}

/// The base's full ref name: landing goes only into a local branch.
fn full_name(dir: &Path, base: &str, stop: &AtomicBool) -> String {
    git(dir, &["rev-parse", "--symbolic-full-name", base], stop).unwrap_or_default()
}

/// Why the base can't take a landing now, or null [D1047, D1161].
fn blocked(dir: &Path, base: &str, from: &str, tree: &str, stop: &AtomicBool) -> io::Result<Value> {
    let full = full_name(dir, base, stop);
    if full.starts_with("refs/remotes/") {
        return Ok(json!({"why": "remote"}));
    }
    if !full.starts_with("refs/heads/") {
        return Ok(json!({"why": "commit"}));
    }
    let Some(holder) = holder(dir, &full, stop)? else {
        return Ok(Value::Null);
    };
    if midway(&holder.git_dir) {
        return Ok(json!({"why": "midway", "folder": holder.root}));
    }
    let files = collisions(&holder, &changed(dir, from, tree, stop)?, stop)?;
    Ok(match files.is_empty() {
        true => Value::Null,
        false => json!({"why": "busy", "folder": holder.root, "files": files}),
    })
}

/// What `head` merges into `base` from: git's merge base, or after a squash still in the base,
/// the HEAD it squashed, so only the work since then merges, not the squashed commits again.
fn merge_base(
    dir: &Path,
    lands: &Lands,
    base: &str,
    head: &str,
    stop: &AtomicBool,
) -> io::Result<String> {
    let ancestor =
        |a: &str, b: &str| read(dir, &["merge-base", "--is-ancestor", a, b], stop).is_ok();
    match &lands.landing {
        Some(l) if l.style == "squash" && ancestor(&l.commit, base) && ancestor(&l.head, head) => {
            Ok(l.head.clone())
        }
        _ => git(dir, &["merge-base", base, head], stop),
    }
}

/// The session that keeps landing while it shares this one's folder [D1082].
// shortcut: no session shares a folder until 2.35 (stream O); then this reads O's `share::lands`.
fn shared_with(_data: &Path, _id: &str) -> Option<String> {
    None
}

fn ms_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
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
    let lands = match id {
        Some(_) if worktrees::made(&dir) => worktrees::lands(&dir)?,
        _ => None,
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
        _ => (folder(&checkout, &now), Value::Null, Value::Null),
    };
    let hint = hint(&step, now.files.len());
    Ok(json!({"step": step, "hint": hint, "at": at, "style": style}))
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
    if !now.files.is_empty() {
        return commit;
    }
    let Ok(remote) = push::remote(checkout, branch) else {
        return commit;
    };
    if head["upstream"].is_null() {
        return json!({"kind": "publish", "branch": branch, "remote": remote});
    }
    match ahead.unwrap_or(0) + behind.unwrap_or(0) {
        0 => commit,
        _ => json!({"kind": "sync", "branch": branch, "remote": remote,
            "ahead": ahead.unwrap_or(0), "behind": behind.unwrap_or(0)}),
    }
}

/// A session's own worktree: Commit, then Merge into its base or Catch up, then landed; with an
/// open PR, the PR's step [D1015, D1016, D1019, D1093, D1102].
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
    if !now.files.is_empty() {
        let staged = now.files.values().any(|f| !f["staged"].is_null());
        let tree = next_tree(checkout, dir, !staged, stop)?;
        let clean = matches!(
            merge(root, &base_at, &merge_base, &tree, stop)?,
            Merge::Clean(_)
        );
        let waiting = count(root, &format!("{merge_base}..{head}"), stop)?;
        let step = json!({"kind": "commit", "base": base, "waiting": waiting, "clean": clean});
        return Ok((step, at));
    }
    if let Some(landing) =
        (lands.landing.as_ref()).filter(|l| worktrees::landed(&lands.repo, &base_at, head, l))
    {
        return Ok((
            json!({"kind": "landed", "base": base, "atMs": landing.at_ms}),
            at,
        ));
    }
    if let Some(step) = pr(data, id, now, base, fresh) {
        return Ok((step, at));
    }
    let ahead = count(root, &format!("{merge_base}..{head}"), stop)?;
    if ahead == 0 {
        // Nothing of its own yet, or all of it already in the base.
        let step = match head == lands.base_commit {
            true => json!({"kind": "commit", "base": base, "waiting": 0, "clean": true}),
            false => json!({"kind": "landed", "base": base, "atMs": null}),
        };
        return Ok((step, at));
    }
    let tree = git(root, &["rev-parse", &format!("{head}^{{tree}}")], stop)?;
    let step = match merge(root, &base_at, &merge_base, &tree, stop)? {
        Merge::Conflicts(conflicts) => {
            json!({"kind": "catchUp", "base": base, "conflicts": conflicts})
        }
        Merge::Clean(merged) => {
            let moved = count(root, &format!("{head}..{base_at}"), stop)?;
            let blocked = match shared_with(data, id) {
                Some(with) => json!({"why": "shared", "with": with}),
                None => blocked(root, base, &base_at, &merged, stop)?,
            };
            json!({"kind": "merge", "base": base, "ready": ahead, "moved": moved, "blocked": blocked})
        }
    };
    Ok((step, at))
}

/// With an open PR the button follows it [D1016, D1019]: Push to #N while commits aren't on the
/// host, Fix with agent on failed checks, conflicts or changes asked, else Merge #N. None when the
/// branch isn't published, has no open PR, or gh can't say: then the local steps stand.
fn pr(data: &Path, id: &str, now: &Status, base: &str, fresh: bool) -> Option<Value> {
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
    let open = rows?.into_iter().find(|p| p["state"] == "open")?;
    let number = open["number"].clone();
    if ahead > 0 {
        return Some(
            json!({"kind": "pushPr", "base": base, "pr": number, "ahead": ahead,
            "host": host_name}),
        );
    }
    let why = match open["health"].as_str() {
        Some("failed") => "checks",
        Some("conflicts") => "conflicts",
        Some("changes") => "changes",
        _ => {
            let checks = json!({"passed": open["passed"], "failed": open["failed"],
                "running": open["running"], "approved": open["approved"]});
            return Some(
                json!({"kind": "mergePr", "base": base, "pr": number, "checks": checks,
                "mergeable": open["mergeable"]}),
            );
        }
    };
    Some(json!({"kind": "fixPr", "base": base, "pr": number, "why": why, "failed": open["failed"]}))
}

/// The toolbar dot's state, the most urgent first: a failed PR, a conflict, changes, ready [D1025].
fn hint(step: &Value, changes: usize) -> Value {
    let base = &step["base"];
    match step["kind"].as_str() {
        Some("fixPr") if step["why"] != "conflicts" => {
            return json!({"tone": "failed", "pr": step["pr"], "why": step["why"]});
        }
        Some("fixPr" | "catchUp" | "continue") => return json!({"tone": "conflict", "base": base}),
        Some("commit") if step["clean"] == false => {
            return json!({"tone": "conflict", "base": base});
        }
        _ => {}
    }
    if changes > 0 {
        return json!({"tone": "changes", "count": changes});
    }
    let ready = match step["kind"].as_str() {
        Some("merge") => step["blocked"].is_null(),
        Some("mergePr") => {
            step["mergeable"] == true
                && step["checks"]["failed"] == 0
                && step["checks"]["running"] == 0
        }
        _ => false,
    };
    match ready {
        true => json!({"tone": "ready", "base": base}),
        false => Value::Null,
    }
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

/// A squash's first message: the branch's commits, as `gh pr create --fill` writes them.
// shortcut (proposed): until 2.19's writer writes squash messages [D1029]; then the UI asks it.
pub fn squash_message(data: &Path, id: &str) -> io::Result<String> {
    let dir = session_dir(data, id);
    let Some(lands) = worktrees::lands(&dir)? else {
        return err("This session has no base.");
    };
    let checkout = checkout(data, &Target::Session(id))?;
    let range = format!("{}..HEAD", lands.base);
    let never = AtomicBool::new(false);
    let out = read(
        &checkout.root,
        &["log", "--reverse", "--format=%s%x00%b%x00", &range, "--"],
        &never,
    )?;
    let text = String::from_utf8_lossy(&out);
    let parts: Vec<&str> = text.split('\0').map(str::trim).collect();
    let commits: Vec<(&str, &str)> = (parts.chunks(2))
        .filter(|c| c.len() == 2 && !c[0].is_empty())
        .map(|c| (c[0], c[1]))
        .collect();
    Ok(match &commits[..] {
        [] => String::new(),
        [(subject, "")] => subject.to_string(),
        [(subject, body)] => format!("{subject}\n\n{body}"),
        [(first, _), ..] => {
            let list: Vec<String> = commits.iter().map(|(s, _)| format!("- {s}")).collect();
            format!("{first}\n\n{}", list.join("\n"))
        }
    })
}

/// Lands the session's branch into its base [D1015, D1028, D1047, D1049], pinned to the commits
/// its step was worked out on (`head`, `base`): a merge commit, or one squashed commit with
/// `message`. The landing commit is made without touching any checkout, then the base moves to
/// it: a fast-forward in the checkout that has it, refused if that would run into its files, or a
/// compare-and-swap of the ref when none has it. Then the landing is recorded, so delete knows a
/// squashed branch landed [D181].
pub fn land(
    data: &Path,
    id: &str,
    style: &str,
    message: Option<&str>,
    (head, base): (&str, &str),
    stop: &AtomicBool,
) -> io::Result<Value> {
    let squash = match style {
        "merge" => false,
        "squash" => true,
        _ => return err(format!("not a merge style: {style:?}")),
    };
    let dir = session_dir(data, id);
    let Some(lands) = worktrees::lands(&dir)? else {
        return err("This session has no base to land into.");
    };
    if let Some(with) = shared_with(data, id) {
        return err(format!("Landing stays with {with}."));
    }
    let session = checkout(data, &Target::Session(id))?;
    let root = &session.root;
    let _mine = lock(&session, true, stop)?;
    // The checkout's lock is held, so this reads git as it is, not through `status`.
    let dirty = read(
        root,
        &["status", "--porcelain", "-z", "--untracked-files=all"],
        stop,
    )?;
    if !dirty.is_empty() || midway(&session.git_dir) {
        return err("This session has changes that aren't committed. Commit them first.");
    }
    let full = full_name(root, &lands.base, stop);
    if !full.starts_with("refs/heads/") {
        return err(format!(
            "{} isn't a local branch, so open a PR instead.",
            lands.base
        ));
    }
    let now = git(root, &["rev-parse", "--verify", "HEAD^{commit}"], stop)?;
    let tip = git(
        root,
        &["rev-parse", "--verify", &format!("{full}^{{commit}}")],
        stop,
    )?;
    if now != head || tip != base {
        return err("Something changed since it was checked. Look again, then merge.");
    }
    if count(root, &format!("{tip}..{now}"), stop)? == 0 {
        return err(format!("Everything here is already in {}.", lands.base));
    }
    let merge_base = merge_base(root, &lands, &tip, &now, stop)?;
    let tree = git(root, &["rev-parse", &format!("{now}^{{tree}}")], stop)?;
    let Merge::Clean(merged) = merge(root, &tip, &merge_base, &tree, stop)? else {
        return err(format!(
            "It would conflict with {}. Catch up first.",
            lands.base
        ));
    };
    let message = match (squash, message.map(str::trim)) {
        (true, Some(m)) if !m.is_empty() => m.to_string(),
        (true, _) => return err("A squash needs a message."),
        (false, _) => format!(
            "Merge branch '{}'",
            lands.branch.as_deref().unwrap_or("HEAD")
        ),
    };
    // One landing at a time per repository: the main checkout's own lock.
    let common = git(
        root,
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
        stop,
    )?;
    let common = Checkout {
        root: lands.repo.clone(),
        git_dir: fs::canonicalize(common)?,
        worktree: false,
    };
    let _repo = lock(&common, true, stop)?;
    let mut args = vec!["commit-tree", merged.as_str(), "-p", tip.as_str()];
    if !squash {
        args.extend(["-p", now.as_str()]);
    }
    args.extend(["-m", message.as_str()]);
    let commit = write(root, false, &args, stop)?;
    let trusted = (load(data, id)?.project)
        .is_some_and(|p| projects::get(data, &p).is_ok_and(|p| p.trusted == Some(true)));
    move_base(
        root,
        &lands.base,
        &full,
        (&tip, &commit),
        &common,
        trusted,
        stop,
    )?;
    let at_ms = ms_now();
    let landing = Landing {
        head: now,
        commit: commit.clone(),
        style: style.into(),
        at_ms,
    };
    worktrees::set_landing(&dir, landing)?;
    // The style it landed with is the project's pick from now on [D1028].
    let _ = set_style(data, &Target::Session(id), style);
    Ok(json!({"commit": commit, "atMs": at_ms}))
}

/// Moves `full` from `old` to `new`, a fast-forward, as the old app's `land` did: in the checkout
/// that has it, with no autostash and no ignored file overwritten, after checking it hasn't
/// switched or moved; with no checkout, a compare-and-swap of the ref. Checked again after.
fn move_base(
    dir: &Path,
    base: &str,
    full: &str,
    (old, new): (&str, &str),
    common: &Checkout,
    hooks: bool,
    stop: &AtomicBool,
) -> io::Result<()> {
    let tip = || {
        git(
            dir,
            &["rev-parse", "--verify", &format!("{full}^{{commit}}")],
            stop,
        )
    };
    let moved = || {
        err(format!(
            "{base} moved while merging. Look again, then merge."
        ))
    };
    let Some(holder) = holder(dir, full, stop)? else {
        let args = ["update-ref", "-m", "Brigadier: merge", full, new, old];
        if write(dir, false, &args, stop).is_err() {
            return match tip()? == old {
                true => err(format!("Couldn't move {base}.")),
                false => moved(),
            };
        }
        return Ok(());
    };
    let folder = holder.root.display();
    if git(&holder.root, &["symbolic-ref", "--quiet", "HEAD"], stop)
        .ok()
        .as_deref()
        != Some(full)
    {
        return err(format!(
            "{base} is being rebased in {folder}. Finish that first."
        ));
    }
    let _theirs = match holder.git_dir == common.git_dir {
        true => None,
        false => Some(lock(&holder, true, stop)?),
    };
    if midway(&holder.git_dir) {
        return err(format!(
            "{folder} is in the middle of a merge or rebase. Finish that first."
        ));
    }
    let files = collisions(&holder, &changed(dir, old, new, stop)?, stop)?;
    if !files.is_empty() {
        let list = files.join(", ");
        return err(format!(
            "{base} is checked out in {folder} with changes to {list}. Commit or stash them there first."
        ));
    }
    if tip()? != old {
        return moved();
    }
    let args = [
        "-c",
        "merge.autoStash=false",
        "merge",
        "--ff-only",
        "--no-autostash",
        "--no-overwrite-ignore",
        "--no-edit",
        "--quiet",
        new,
    ];
    let ran = write(&holder.root, hooks, &args, stop);
    // A post-merge hook can fail after the merge went through: what the ref says counts.
    match (tip()?, ran) {
        (now, _) if now == new => Ok(()),
        (now, _) if now != old => moved(),
        (_, Err(e)) => err(format!("Couldn't merge into {base}: {e}")),
        (_, Ok(_)) => err(format!("Couldn't move {base}.")),
    }
}
