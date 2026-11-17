//! The text one result writes [D3006]: how it ended, its branch and commits, the diff stat,
//! uncommitted files, the receipt and the `read` pointer [D3029].

use super::review::{self, last_of_turn};
use super::{Res, dir_of, open, path_of, take};
use crate::owner;
use crate::workers::{Link, git, read_json, write_json};
use brigadier_core::{self as core};
use brigadier_frames::log;
use serde_json::{Value, json};
use std::fs;
use std::io;
use std::path::Path;

fn git_lines(dir: &str, args: &[&str], most: usize) -> Vec<String> {
    let out = git(dir, args).unwrap_or_default();
    let lines: Vec<String> = out.lines().map(String::from).collect();
    let more = lines.len().saturating_sub(most);
    let mut shown: Vec<String> = lines.into_iter().take(most).collect();
    if more > 0 {
        shown.push(format!("… {more} more"));
    }
    shown
}

/// Where HEAD forked from `base` or from its upstream, whichever is nearer: a stale local base
/// doesn't count others' merged work as the worker's.
fn fork(dir: &str, base: &str) -> String {
    let ahead = |c: &String| git(dir, &["rev-list", "--count", &format!("{c}..HEAD")]);
    [base.to_string(), format!("{base}@{{u}}")]
        .iter()
        .filter_map(|b| git(dir, &["merge-base", "HEAD", b]))
        .min_by_key(|c| {
            ahead(c)
                .and_then(|n| n.parse::<u64>().ok())
                .unwrap_or(u64::MAX)
        })
        .unwrap_or_else(|| base.into())
}

/// Writes one result: the sender's record, first, in the parent's folder [D54]. Then the worker's
/// row shows how it ended. `error`: a start that failed, whose worker never ran.
pub(in crate::workers) fn write(
    data: &Path,
    l: &Link,
    wid: &str,
    turn: &str,
    how: &str,
    error: Option<&str>,
) -> io::Result<()> {
    let dir = core::session_dir(data, wid);
    let spec = core::load(data, wid).ok();
    let cwd = spec.as_ref().map_or(String::new(), |s| s.cwd.clone());
    let branch = core::worktrees::branch(&dir).ok().flatten();
    let base = core::worktrees::base(&dir);
    let word = match how {
        "finished" => "finished",
        "stopped" if l.last["by"] == "user" => "was ended by the user",
        "stopped" => "was stopped",
        "limit" => "stopped at a usage limit",
        "context" => "stopped: its context is full",
        _ => "failed",
    };
    let what = if l.session { "Session" } else { "Worker" };
    let mut text = format!("{what} {} ({wid}) {word}.\n", l.title);
    if let Some(e) = error {
        text += &format!("It didn't start: {e}\n");
    }
    // Proposed: the extras past how it ended, its last message, branch and commits: the diff
    // stat, uncommitted files, the receipt and the `read` pointer [D3029].
    let (mut added, mut removed, mut commits) = (0u64, 0u64, 0usize);
    let landed = core::worktrees::merged(&dir).unwrap_or(true);
    // Its own commits since it began; merged once they're all in the parent's branch [D97].
    let start = (core::worktrees::lands(&dir).ok().flatten()).map(|l| l.base_commit);
    let made = start.as_ref().map_or(0, |c| {
        let range = format!("{c}..HEAD");
        git(&cwd, &["rev-list", "--count", &range]).map_or(0, |n| n.parse().unwrap_or(0))
    });
    let merged = landed && made > 0;
    let mut merge = String::new();
    if let (Some(branch), Some(base)) = (&branch, &base) {
        // Merged, its own commits are what it did; `base..HEAD` would be none.
        let from = start.as_deref().filter(|_| merged).unwrap_or(base);
        let range = format!("{from}..HEAD");
        let log = git_lines(&cwd, &["log", "--oneline", &range], 20);
        let ahead = git(&cwd, &["rev-list", "--count", &format!("{base}..HEAD")]);
        let ahead: usize = ahead.map_or(0, |n| n.parse().unwrap_or(0));
        commits = if merged { made } else { ahead };
        text += &match merged {
            true => format!("Its branch {branch}, from {base}: {made} commits\n"),
            false => format!("Its branch {branch}, from {base}: {ahead} commits not in {base}\n"),
        };
        for line in &log {
            text += &format!("  {line}\n");
        }
        // Its own changes: from where it forked, the base's upstream when it rebased onto that [D456].
        let own = if merged {
            from.to_string()
        } else {
            fork(&cwd, base)
        };
        let stat =
            git(&cwd, &["diff", "--shortstat", &format!("{own}...HEAD")]).unwrap_or_default();
        if !stat.trim().is_empty() {
            text += &format!("{}\n", stat.trim());
        }
        let num = git(&cwd, &["diff", "--numstat", &format!("{own}...HEAD")]).unwrap_or_default();
        for line in num.lines() {
            let mut n = line
                .split_whitespace()
                .map(|x| x.parse::<u64>().unwrap_or(0));
            added += n.next().unwrap_or(0);
            removed += n.next().unwrap_or(0);
        }
        let dirty = git_lines(&cwd, &["status", "--porcelain"], 20);
        if !dirty.is_empty() {
            text += "Uncommitted:\n";
            for line in &dirty {
                text += &format!("  {line}\n");
            }
        }
        if merged {
            text += &format!("It merged into {base}.\n");
            merge = format!("merged={base}");
        } else if made > 0 {
            let to = core::load(data, &l.parent)
                .map(|p| p.cwd)
                .unwrap_or_default();
            let why = if git(&to, &["rev-parse", "-q", "--verify", "MERGE_HEAD"]).is_some() {
                format!("{to} is mid-merge")
            } else {
                format!("{ahead} commits {base} doesn't have")
            };
            text += &format!("Not merged into {base}: {why}.\n");
            merge = format!("unmerged={base}");
        }
    }
    // A folder chat's worker: each repo it claimed, its branch and commits there [D494, D3006].
    for (name, rec) in core::folder::claims(&dir) {
        let (Some(branch), Some(base), Some(at)) = (
            core::worktrees::branch(&rec).ok().flatten(),
            core::worktrees::base(&rec),
            core::worktrees::folder(&rec).map(|f| f.display().to_string()),
        ) else {
            continue;
        };
        let own = fork(&at, &base);
        let made = git(&at, &["rev-list", "--count", &format!("{own}..HEAD")]);
        let made: usize = made.map_or(0, |n| n.parse().unwrap_or(0));
        text += &format!("In {name}, its branch {branch}, from {base}: {made} commits\n");
        for line in git_lines(&at, &["log", "--oneline", &format!("{own}..HEAD")], 20) {
            text += &format!("  {line}\n");
        }
        let dirty = git_lines(&at, &["status", "--porcelain"], 20);
        if !dirty.is_empty() {
            text += &format!("Uncommitted in {name}:\n  {}\n", dirty.join("\n  "));
        }
        if made > 0 && !core::worktrees::merged(&rec).unwrap_or(false) {
            text += &format!("Not merged into {base} in {name}.\n");
            merge = format!("unmerged={base}");
        }
        let num = git(&at, &["diff", "--numstat", &format!("{own}...HEAD")]).unwrap_or_default();
        for mut n in num
            .lines()
            .map(|l| l.split_whitespace().map(|x| x.parse::<u64>().unwrap_or(0)))
        {
            added += n.next().unwrap_or(0);
            removed += n.next().unwrap_or(0);
        }
        commits += made;
    }
    let ran = &l.ran;
    let ran: Vec<&str> = [&ran["agent"], &ran["model"], &ran["effort"]]
        .iter()
        .filter_map(|v| v.as_str())
        .collect();
    text += &format!("Ran on {}.\n", ran.join(" · "));
    text += &review::said(data, l, wid, turn);
    // That turn's own last message, not a later turn's the user started in the worker [D3006].
    // A sub-session's last word is its last turn's, after its workers' results woke it [D189].
    let ended = (core::fold(&dir, true).ok()).and_then(|f| f.fold.last);
    let said = (ended.as_ref().filter(|_| l.session)).and_then(|l| l["id"].as_str());
    // A failure that passes by itself: the parent may try it again [D340].
    let why = (ended.as_ref()).filter(|e| how == "failed" && e["id"] == turn);
    let why = why.and_then(|e| e["why"].as_str().filter(|w| core::adapters::temporary(w)));
    text += &why.map_or(String::new(), |w| take::retry(wid, w));
    if let Some(mut last) = last_of_turn(data, wid, said.unwrap_or(turn)) {
        if last.len() > super::LAST {
            let mut at = super::LAST;
            while !last.is_char_boundary(at) {
                at -= 1;
            }
            last.truncate(at);
            last += "\n[cut at 16 KB]";
        }
        text += &format!("Its last message:\n{}\n", last.trim_end());
    }
    text += &format!("\n`brigadier read {wid}` for more.");
    // A lead that waited on this result often went on without ticking its list [D441].
    if core::rebirth::todo() {
        text += "\n\nTick off on your to-do list what this settles.";
    }
    let res = Res {
        id: format!("r{}", core::adapters::uuid()[..13].replace('-', "")),
        wid: wid.into(),
        turn: turn.into(),
        how: how.into(),
        text,
        at: log::now_ms(),
        // A stopped task's result never wakes the parent: it goes with its next turn [D314].
        state: match how {
            _ if l.review["switch"] == true || l.review["plan"].is_string() => "review",
            "stopped" => "held",
            _ => "written",
        }
        .into(),
        ended: how == "stopped" && l.last["by"] == "user",
        hop: crate::peers::hop_of(data, wid, turn),
        merge,
    };
    fs::create_dir_all(dir_of(data, &l.parent))?;
    write_json(&path_of(data, &l.parent, wid, turn), &res)?;
    // A review's result goes to the work it reviewed, never its parent: its end row all the same [D115, D456].
    // A stopped one's waits for the parent's next turn, so its log says it holds no block open [D314].
    let note = match res.state.as_str() {
        "review" => json!({"event": "worker", "phase": "result", "result": take::said(&res)}),
        "held" => json!({"event": "worker", "phase": "held", "ids": [wid]}),
        _ => Value::Null,
    };
    if !note.is_null() {
        let _ = owner::call(data, &l.parent, json!({"op": "note", "data": note}));
    }
    open(data, &l.parent);
    let link_path = dir.join("worker.json");
    if let Some(mut l) = read_json::<Link>(&link_path) {
        l.last = json!({"how": how, "at": res.at, "landed": landed, "merged": merged,
            "commits": commits, "added": added, "removed": removed});
        crate::routing::real(&dir, &mut l.ran);
        write_json(&link_path, &l)?;
        if spec.is_some() {
            let end = json!({"event": "outcome", "phase": "end", "how": how, "commits": commits, "at": res.at, "temporary": why.is_some(), "reason": why});
            let _ = owner::call(data, wid, json!({"op": "note", "data": end}));
        }
    }
    Ok(())
}
