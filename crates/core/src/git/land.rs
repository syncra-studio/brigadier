//! Land [D1015, D1028, D1049]: a session's branch into its base, as a merge commit or a squash.

use super::precheck::{
    Merge, changed, collisions, count, full_name, git, holder, merge, merge_base, midway,
    shared_with, write,
};
use super::step::set_style;
use super::{Checkout, Target, checkout, err, lock, read};
use crate::worktrees::{self, Landing};
use crate::{load, projects, session_dir};
use serde_json::{Value, json};
use std::fs;
use std::io;
use std::path::Path;
use std::sync::atomic::AtomicBool;
use std::time::{SystemTime, UNIX_EPOCH};

fn ms_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

/// What a squash of the pair `(head, base)` takes in: the commits it squashes, oldest first, and a
/// first message from them, as `gh pr create --fill` writes it. Pinned like the landing, so its
/// confirm lists exactly what it lands.
// shortcut (proposed): the message until 2.19's writer writes squash messages [D1029].
pub fn squash(data: &Path, id: &str, (head, base): (&str, &str)) -> io::Result<Value> {
    let Some(lands) = worktrees::lands(&session_dir(data, id))? else {
        return err("This session has no base.");
    };
    let checkout = checkout(data, &Target::Session(id))?;
    let never = AtomicBool::new(false);
    let from = merge_base(&checkout.root, &lands, base, head, &never)?;
    let range = format!("{from}..{head}");
    let format = "--format=%h%x00%s%x00%b%x00";
    let out = read(
        &checkout.root,
        &["log", "--reverse", format, &range, "--"],
        &never,
    )?;
    let text = String::from_utf8_lossy(&out);
    let parts: Vec<&str> = text.split('\0').map(str::trim).collect();
    let commits: Vec<(&str, &str, &str)> = (parts.chunks(3))
        .filter(|c| c.len() == 3 && !c[0].is_empty())
        .map(|c| (c[0], c[1], c[2]))
        .collect();
    let message = match &commits[..] {
        [] => String::new(),
        [(_, subject, "")] => subject.to_string(),
        [(_, subject, body)] => format!("{subject}\n\n{body}"),
        [(_, first, _), ..] => {
            let list: Vec<String> = commits.iter().map(|(_, s, _)| format!("- {s}")).collect();
            format!("{first}\n\n{}", list.join("\n"))
        }
    };
    let commits: Vec<Value> = (commits.iter())
        .map(|(sha, subject, _)| json!({"sha": sha, "subject": subject}))
        .collect();
    Ok(json!({"message": crate::writer::without_attribution(&message), "commits": commits}))
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
    pinned: (&str, &str),
    stop: &AtomicBool,
) -> io::Result<Value> {
    landing(data, id, style, message, pinned, false, stop)
}

/// `land` for a caller that holds the session's `worktrees::lock` across it [D1208].
pub fn land_held(
    data: &Path,
    id: &str,
    style: &str,
    message: Option<&str>,
    pinned: (&str, &str),
    stop: &AtomicBool,
) -> io::Result<Value> {
    landing(data, id, style, message, pinned, true, stop)
}

fn landing(
    data: &Path,
    id: &str,
    style: &str,
    message: Option<&str>,
    (head, base): (&str, &str),
    held: bool,
    stop: &AtomicBool,
) -> io::Result<Value> {
    let set_landing = match held {
        true => worktrees::set_landing_held,
        false => worktrees::set_landing,
    };
    let squash = match style {
        "merge" => false,
        "squash" => true,
        _ => return err(format!("not a merge style: {style:?}")),
    };
    if let Some(with) = shared_with(data, id) {
        return err(format!("Landing stays with {with}."));
    }
    let dir = session_dir(data, id);
    let Some(lands) = worktrees::lands(&dir)? else {
        return err("This session has no base to land into.");
    };
    let session = checkout(data, &Target::Session(id))?;
    let root = &session.root;
    // One landing at a time per repository: the main checkout's own lock, always taken first, then
    // the session's checkout, then the base's, so two landings never wait on each other.
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
        (true, Some(m)) if !crate::writer::without_attribution(m).is_empty() => {
            crate::writer::without_attribution(m)
        }
        (true, _) => return err("A squash needs a message."),
        (false, _) => format!(
            "Merge branch '{}'",
            lands.branch.as_deref().unwrap_or("HEAD")
        ),
    };
    let mut args = vec!["commit-tree", merged.as_str(), "-p", tip.as_str()];
    if !squash {
        args.extend(["-p", now.as_str()]);
    }
    args.extend(["-m", message.as_str()]);
    let commit = write(root, false, &args, stop)?;
    let trusted = (load(data, id)?.project)
        .is_some_and(|p| projects::get(data, &p).is_ok_and(|p| p.trusted == Some(true)));
    // Recorded before the base moves, so a crash between can't lose a squash; it counts only once
    // its commit is in the base, so one that never got there reads as not landed [D35, D1049].
    let at_ms = ms_now();
    let landing = Landing {
        head: now,
        commit: commit.clone(),
        style: style.into(),
        at_ms,
    };
    set_landing(&dir, Some(landing))?;
    let moved = move_base(
        root,
        &lands.base,
        &full,
        (&tip, &commit),
        &common,
        trusted,
        stop,
    );
    if let Err(e) = moved {
        let _ = set_landing(&dir, lands.landing);
        return Err(e);
    }
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
    let _theirs = match holder.git_dir == common.git_dir {
        true => None,
        false => Some(lock(&holder, true, stop)?),
    };
    // Checked under its lock and again just before the merge, which goes to whatever it has out.
    let on_base = || match git(&holder.root, &["symbolic-ref", "--quiet", "HEAD"], stop) {
        Ok(now) if now == full => Ok(()),
        Ok(_) => err(format!(
            "{folder} switched to another branch. Look again, then merge."
        )),
        Err(_) => err(format!(
            "{base} is being rebased in {folder}. Finish that first."
        )),
    };
    on_base()?;
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
    on_base()?;
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
