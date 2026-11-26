//! The text one result writes [D3006]: how it ended, its branch and commits, the diff stat,
//! uncommitted files, the receipt and the `read` pointer [D3029].

use super::review::{self, last_by};
use super::{Res, dir_of, open, path_of, take};
use crate::owner;
use crate::workers::{Link, git, read_json, write_json};
use brigadier_core::{self as core};
use brigadier_frames::log;
use serde_json::{Value, json};
use std::collections::HashSet;
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

/// The commits a worktree's own HEAD made since `start`, oldest last, by its reflog: what it merged,
/// rebased onto or checked out of others' isn't its work. None where its reflog doesn't go back to
/// `start`: none, or a worktree made again, whose log starts after commits it had made.
pub(in crate::workers) fn own(dir: &str, start: &str) -> Option<Vec<String>> {
    let log = git(dir, &["log", "-g", "--format=%H %gs", "HEAD"])?;
    let first = log.lines().last()?.split(' ').next()?;
    if first != start {
        return None;
    }
    let made = |why: &str| {
        let picked = |w: &str| why.starts_with(w) && why.contains("(pick)");
        (why.starts_with("commit") || why.starts_with("cherry-pick") || why.starts_with("revert"))
            || picked("rebase")
            || picked("pull")
            || ["(reword)", "(squash)", "(fixup)", "(continue)"]
                .iter()
                .any(|x| why.starts_with("rebase") && why.contains(x))
    };
    let mine: HashSet<&str> = (log.lines().filter_map(|l| l.split_once(' ')))
        .filter(|(_, why)| made(why))
        .map(|(sha, _)| sha)
        .collect();
    let range = git(dir, &["rev-list", &format!("{start}..HEAD")])?;
    let kept = range.lines().filter(|sha| mine.contains(sha));
    Some(kept.map(String::from).collect())
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
    write_as(data, l, wid, turn, how, error, Of::default())
}

/// What one result reports: a turn the user started in it (`direct`), when it ended (`Res::end`),
/// a wake that ended after that turn's own result was written (`late`).
#[derive(Default)]
pub(in crate::workers) struct Of {
    pub direct: bool,
    pub end: u64,
    pub late: bool,
    /// The turn or wake whose last message it carries, and up to when (ms): none finds it.
    pub said: Option<(String, u64)>,
    /// Who stopped it (`End::by`).
    pub by: Option<String>,
}

/// The turn's time and computer calls as Brigadier measured them, not as the worker tells them,
/// with each turn it carried on: a rebirth's `rb-<turn>`, a switch's or reconnect's [D51, D339].
/// shortcut: an earlier turn's wait on an answer counts as work, as `End` keeps no wait; add one
/// if it matters. The calls log is the worker's own folder's, so a worker could write lines in it:
/// log in the daemon if one does.
fn measured(dir: &Path, f: &core::fold::Fold, turn: &str, ended: Option<&Value>) -> String {
    let Some(e) = ended else {
        return String::new();
    };
    let (from, to) = (
        e["began_at"].as_u64().unwrap_or(0),
        e["ts"].as_u64().unwrap_or(0),
    );
    if from == 0 || to < from {
        return String::new();
    }
    let mut spans = vec![(from, to)];
    let (mut t, mut seen) = (turn.to_string(), HashSet::new());
    // The recorded link first: a reborn turn's reconnect is `rb-<turn>.n1` [D339].
    let of = |t: &str| {
        (f.carried.iter())
            .find_map(|(of, to)| (to == t).then(|| of.clone()))
            .or_else(|| t.strip_prefix("rb-").map(String::from))
    };
    while let Some(was) = of(&t).filter(|was| seen.insert(was.clone())) {
        let own = (f.ends.get(&was).into_iter().flatten()).filter(|e| e.id == was);
        spans.extend(
            own.filter(|e| e.began > 0 && e.at >= e.began)
                .map(|e| (e.began, e.at)),
        );
        t = was;
    }
    let calls = fs::read_to_string(dir.join("computer").join("calls")).unwrap_or_default();
    let verbs: Vec<&str> = (calls.lines())
        .filter_map(|l| l.split_once(' '))
        .filter(|(at, _)| {
            at.parse::<u64>()
                .is_ok_and(|at| spans.iter().any(|s| (s.0..=s.1).contains(&at)))
        })
        .map(|(_, verb)| verb)
        .filter(|v| crate::computer::VERBS.contains(v))
        .collect();
    // Its time working: what it waited on an answer is left out.
    let waited = e["waited"].as_u64().unwrap_or(0).min(to - from);
    let work: u64 = spans.iter().map(|(a, b)| b - a).sum::<u64>() - waited;
    let mins = work as f64 / 60_000.0;
    let mut said =
        format!("Measured by Brigadier: {mins:.1} min of work from its input to its end");
    if waited >= 6_000 {
        said += &format!(
            ", and {:.1} min more waiting on an answer",
            waited as f64 / 60_000.0
        );
    }
    if !verbs.is_empty() {
        let looks = (verbs.iter())
            .filter(|v| ["apps", "read", "screenshot"].contains(v))
            .count();
        said += &format!(
            ", {} computer calls ({} actions, {looks} reads or screenshots)",
            verbs.len(),
            verbs.len() - looks
        );
    }
    said + ".\n"
}

/// The most a turn the user started in a worker tells its parent, all of it [D303].
const DIRECT: usize = 1 << 10;

/// `direct`: a turn the user started in it, whose result is at most 1 KB, how it ended, its merge
/// and the `read` pointer first, and waits quietly for the parent's next input [D303].
pub(in crate::workers) fn write_as(
    data: &Path,
    l: &Link,
    wid: &str,
    turn: &str,
    how: &str,
    error: Option<&str>,
    of: Of,
) -> io::Result<()> {
    let direct = of.direct;
    let dir = core::session_dir(data, wid);
    let spec = core::load(data, wid).ok();
    let cwd = spec.as_ref().map_or(String::new(), |s| s.cwd.clone());
    let branch = core::worktrees::branch(&dir).ok().flatten();
    let base = core::worktrees::base(&dir);
    let word = match how {
        "finished" => "finished",
        "stopped" if l.last["by"] == "user" => "was ended by the user",
        // A parent's Stop reaches the turn as "user" too: only its link tells them apart.
        "stopped" if l.last["by"] != "agent" && of.by.as_deref() == Some("user") => {
            "was stopped by the user"
        }
        "stopped" => "was stopped",
        "limit" => "stopped at a usage limit",
        "context" if of.by.as_deref() == Some("stall") => {
            "stopped: its context kept filling with no progress"
        }
        "context" => "stopped: its context is full",
        "refused" => "was refused by its provider",
        _ => "failed",
    };
    let mut text = format!("Worker {} ({wid}) {word}.\n", l.title);
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
        let range = || git(&cwd, &["rev-list", "--count", &format!("{c}..HEAD")]);
        (own(&cwd, c).map(|l| l.len()))
            .or_else(|| range()?.parse().ok())
            .unwrap_or(0)
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
        commits = if merged { made } else { ahead.min(made) };
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
        let from = fork(&at, &base);
        let start = (core::worktrees::lands(&rec).ok().flatten()).map(|l| l.base_commit);
        let made = git(&at, &["rev-list", "--count", &format!("{from}..HEAD")]);
        let made: usize = made.map_or(0, |n| n.parse().unwrap_or(0));
        let made = (start.and_then(|s| own(&at, &s))).map_or(made, |l| l.len().min(made));
        text += &format!("In {name}, its branch {branch}, from {base}: {made} commits\n");
        for line in git_lines(&at, &["log", "--oneline", &format!("{from}..HEAD")], 20) {
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
        let num = git(&at, &["diff", "--numstat", &format!("{from}...HEAD")]).unwrap_or_default();
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
    // A start that failed never ran, and may have no log to read [NH-A11].
    if error.is_none() {
        text += &format!("Ran on {}.\n", ran.join(" · "));
    }
    text += &review::said(data, l, wid, turn);
    // That turn's own last message, not a later turn's the user started in the worker [D3006].
    let f = core::fold(&dir, true).map(|f| f.fold).unwrap_or_default();
    let (said, until) = of.said.unwrap_or_else(|| {
        let end = f.end(turn);
        (end.map_or(turn, |e| &e.id).into(), u64::MAX)
    });
    let last = last_by(data, wid, &said, until).or_else(|| last_by(data, wid, turn, until));
    // Its host died in it: the log says so, or left the turn open.
    let logged = match of.end {
        0 => f.end(turn),
        at => (f.ends.get(turn).into_iter().flatten()).find(|e| e.at == at),
    };
    let unended = of.end == u64::MAX || (of.end == 0 && f.turns.iter().any(|t| t.id == turn));
    // Brigadier stopped it, overnight or the like: cut off, as by a host's end.
    let cut = unended || logged.is_some_and(|e| e.how == "interrupted") || of.by.is_some();
    // Past a summary turn it wrote since, the turn that summary served [D92].
    let summary = (f.last.as_ref()).is_some_and(|l| l["origin"] == "summary");
    let ended = &(core::summary::served(&f).filter(|_| summary)).or(f.last.clone());
    text += &measured(&dir, &f, turn, (ended.as_ref()).filter(|e| e["id"] == turn));
    // A failure that passes by itself: the parent may try it again [D340].
    let why = (ended.as_ref()).filter(|e| how == "failed" && e["id"] == turn);
    let why = why.and_then(|e| e["why"].as_str().filter(|w| core::adapters::temporary(w)));
    text += &why.map_or(String::new(), |w| take::retry(wid, w));
    // What it ended for, where that wasn't its model's work [D2038].
    let cause = match how {
        "finished" => Value::Null,
        "stopped" => "user".into(),
        "limit" => "quota".into(),
        "refused" => "refused".into(),
        "failed" if cut || error.is_some() || why.is_some() => "infrastructure".into(),
        "failed" if (ended.as_ref()).is_some_and(|e| e["outcome"] == "sign_in") => {
            "environment".into()
        }
        _ => "unknown".into(),
    };
    // No conversation announced: nothing to carry on, and the message may never have arrived [D66].
    if cut && how == "failed" && f.resume.is_empty() {
        text += "Its first message was cut before its agent started, so it may not have arrived. Send it again if it's still needed.\n";
    } else if cut && how == "failed" {
        text += &format!(
            "Its process was cut off; nothing says its work was wrong. `brigadier send {wid} \"<go on>\"` carries it on where it stopped.\n"
        );
    }
    if how == "refused" {
        text += "Its provider's safety checks stopped it and it isn't coming back; sent again, it's likely refused again. Ask the user, or give the work to another agent: `brigadier start --job \"<job>\" --agent <another> \"<brief>\"`.\n";
    }
    if direct {
        text = compact(
            wid,
            &format!(
                "Worker {} ({wid}): the turn the user started in it {word}.\n",
                l.title
            ),
            &merge,
            commits,
            last,
        );
    } else if let Some(mut last) = last {
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
    if !direct && error.is_none() {
        text += &format!("\n`brigadier read {wid}` for more.");
    }
    // A lead that waited on this result often went on without ticking its list [D441].
    if core::rebirth::todo() && !direct {
        text.truncate(text.trim_end().len());
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
            _ if direct => "quiet",
            _ if l.review["switch"] == true || l.review["plan"].is_string() => "review",
            "stopped" => "held",
            _ => "written",
        }
        .into(),
        // One its parent ended is news the parent has: it too waits for the next input [D303, D328].
        ended: how == "stopped" && matches!(l.last["by"].as_str(), Some("user" | "agent")),
        hop: crate::peers::hop_of(data, wid, turn),
        merge,
        going: String::new(),
        refused: String::new(),
        end: of.end,
    };
    fs::create_dir_all(dir_of(data, &l.parent))?;
    let key = match of.late {
        true => format!("{turn}.{}", of.end),
        false => turn.into(),
    };
    let path = path_of(data, &l.parent, wid, &key);
    {
        // The daemon and the parent's own `wait` may both write it: the first one's stands.
        let _one = review::lock_at(&core::session_dir(data, &l.parent).join("results.lock"))?;
        if path.exists() {
            return Ok(());
        }
        write_json(&path, &res)?;
    }
    // A review's result goes to the work it reviewed, never its parent: its end row all the same [D115, D456].
    // A stopped one's waits for the parent's next turn, so its log says it holds no block open [D314].
    let note = match res.state.as_str() {
        "review" => {
            json!({"event": "worker", "phase": "result", "result": take::said(data, &l.parent, &res)})
        }
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
            "commits": commits, "added": added, "removed": removed, "cause": cause});
        crate::routing::real(&dir, &mut l.ran);
        write_json(&link_path, &l)?;
        // Its outcomes are its parent's asks; a turn the user started isn't one [D2038].
        if spec.is_some() && !direct {
            let end = json!({"event": "outcome", "phase": "end", "how": how, "commits": commits, "at": res.at, "temporary": why.is_some(), "reason": why, "cause": cause});
            let _ = owner::call(data, wid, json!({"op": "note", "data": end}));
        }
    }
    Ok(())
}

/// A turn the user started, told in at most 1 KB: how it ended, its merge, its last message cut
/// to what's left, and the `read` pointer [D303].
fn compact(wid: &str, head: &str, merge: &str, commits: usize, last: Option<String>) -> String {
    let merge = match merge.split_once('=') {
        Some(("merged", base)) => format!("It merged into {base}: {commits} commits.\n"),
        Some((_, base)) => format!("Not merged into {base}: {commits} commits it doesn't have.\n"),
        None => String::new(),
    };
    let tail = format!("`brigadier read {wid}` for more.");
    let mut text = format!("{head}{merge}");
    if let Some(last) = last.map(|l| l.trim().to_string()).filter(|l| !l.is_empty()) {
        let lead = "Its last message:\n";
        let room = DIRECT.saturating_sub(text.len() + lead.len() + tail.len() + 6);
        let mut at = room.min(last.len());
        while !last.is_char_boundary(at) {
            at -= 1;
        }
        let cut = if at < last.len() { "…" } else { "" };
        text += &format!("{lead}{}{cut}\n", &last[..at]);
    }
    text + &tail
}
