//! PR discovery and check aggregation through the unmodified host CLI [D1030, D1187], kept in
//! the session's `prs.json` by every read: the watch's, `info`'s and a merge's [D1009, D1017].
//! `prs.json` (proposed) is `{okAt, error, branch, head, prs}`: when the last whole read answered,
//! why the last one didn't (null when it did), the branch and its local head then, and each PR's row.
//! Its PRs are every one the session touched [D175]: its branches' (kept once read, whichever branch
//! it's on now), and those its own commands opened, merged or changed.

use super::{GH_SECS, Gh, Kind, Pr, Repo, failed, gh, setup};
use crate::{git, worktrees};
use brigadier_frames::log::now_ms;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

/// One read and keep at a time per session (the watch and the app's reads both run in the
/// daemon), so an older read never overwrites a newer one.
static BUSY: Mutex<BTreeMap<PathBuf, Arc<Mutex<()>>>> = Mutex::new(BTreeMap::new());

/// What a read gave: the PRs and, when one PR's checks couldn't be read, why; or why none could be.
type Read = Result<(Vec<Value>, Option<String>), String>;

/// What a PR read asks gh for.
const FIELDS: &str = "--json=number,url,title,state,mergeable,reviewDecision,headRefName,headRefOid,headRepository,baseRefName,mergeCommit,mergedAt,updatedAt,isDraft,statusCheckRollup";

impl Pr {
    /// The session's PRs, read now and kept; None when the host couldn't list them.
    pub(super) fn prs(&self, gh: &Gh) -> Option<Value> {
        let one = self.one();
        let _held = one.lock().unwrap_or_else(|e| e.into_inner());
        let read = self.read(gh);
        let listed = read.is_ok();
        let kept = self.keep(read);
        listed.then(|| kept["prs"].clone())
    }

    /// The watch's read of a published branch [D1009, D1192]: what `prs.json` now holds, or None
    /// when the branch isn't published or its host isn't one Brigadier reads.
    pub fn watch(&self) -> Option<Value> {
        let one = self.one();
        let _held = one.lock().unwrap_or_else(|e| e.into_inner());
        // Only GitHub's PRs are read (through gh) until GitLab's (2.32) [D1030].
        let repo = self.repo.as_ref().filter(|r| r.kind == Kind::GitHub)?;
        let key = format!("branch.{}.remote", self.branch);
        git::read(
            &self.checkout.root,
            &["config", "--get", &key],
            &AtomicBool::new(false),
        )
        .ok()?;
        Some(match gh(repo) {
            Some(gh) => self.keep(self.read(&gh)),
            None => self.keep(Err(super::NO_GH.into())),
        })
    }

    fn one(&self) -> Arc<Mutex<()>> {
        let mut busy = BUSY.lock().unwrap_or_else(|e| e.into_inner());
        busy.entry(self.dir.clone()).or_default().clone()
    }

    /// A PR pushed to mid-read (its head moved between the list and its checks) is read once more,
    /// so a push, or a merge it refused, isn't kept as a read that couldn't check.
    fn read(&self, gh: &Gh) -> Read {
        match self.read_once(gh) {
            Ok((_, Some(_))) => self.read_once(gh),
            read => read,
        }
    }

    fn read_once(&self, gh: &Gh) -> Read {
        let Some(repo) = self.repo.as_ref() else {
            return Err("This remote's host isn't one Brigadier knows.".into());
        };
        let slug = format!("--repo={}/{}", repo.host, repo.path);
        let mut command = gh.command();
        command.args([
            "pr",
            "list",
            &slug,
            &format!("--head={}", self.branch),
            "--state=all",
            "--limit=100",
            FIELDS,
        ]);
        let out = setup::run(&mut command, GH_SECS).map_err(|e| e.to_string())?;
        if !out.status.success() {
            return Err(failed(&out));
        }
        let list: Vec<Value> = serde_json::from_slice(&out.stdout).map_err(|e| e.to_string())?;
        let mine: Vec<&Value> = (list.iter())
            .filter(|p| belongs(p, repo, &self.branch))
            .collect();
        // The open one into the base, else any open one: the card's step reads it [D1287].
        let open = |p: &&&Value| p["state"] == "OPEN";
        let into = (mine.iter().filter(open)).find(|p| p["baseRefName"] == self.base);
        let open = into.or_else(|| mine.iter().find(open));
        super::note_open(
            &self.id,
            &self.branch,
            open.and_then(|p| p["number"].as_u64()),
        );
        let mut error = None;
        for p in (mine.iter()).filter(|p| p["state"] == "MERGED") {
            self.record_merge(p);
        }
        let mut row_of = |p: &Value| {
            let checks = (p["state"] == "OPEN")
                .then(|| {
                    checks(gh, repo, p)
                        .map_err(|e| error.get_or_insert(e).clone())
                        .ok()
                })
                .flatten();
            row(p, checks.as_deref())
        };
        let mut rows: Vec<Value> = mine.iter().map(|p| row_of(p)).collect();
        // The session's other PRs [D175], newest first: those kept from its other branches, read
        // again until merged (then final), and those its own commands touched.
        let old = kept(&self.dir);
        let old: Vec<&Value> = old["prs"].as_array().into_iter().flatten().collect();
        let numbers: BTreeSet<u64> = (old.iter().filter_map(|p| p["number"].as_u64()))
            .chain(touched(&self.dir, repo))
            .filter(|n| mine.iter().all(|p| p["number"] != *n))
            .collect();
        let mut missed = None;
        for n in numbers.into_iter().rev() {
            let was = old.iter().find(|p| p["number"] == n);
            if let Some(was) = was.filter(|p| p["state"] == "merged") {
                rows.push((*was).clone());
                continue;
            }
            let mut command = gh.command();
            command.args(["pr", "view", &n.to_string(), &slug, FIELDS]);
            let read =
                setup::run(&mut command, GH_SECS).and_then(|out| match out.status.success() {
                    true => serde_json::from_slice::<Value>(&out.stdout).map_err(|e| e.to_string()),
                    false => Err(failed(&out)),
                });
            match (read, was) {
                (Ok(p), _) => rows.push(row_of(&p)),
                // One read before keeps its last row with why; one never read (no PR here) waits.
                (Err(e), Some(was)) => {
                    rows.push((*was).clone());
                    missed.get_or_insert(e);
                }
                (Err(_), None) => {}
            }
        }
        let error = error.or(missed);
        Ok((rows, error))
    }

    /// Keeps a read in `prs.json` [D1009]: a PR whose checks couldn't be read keeps its last facts
    /// at the same head, a failed read keeps every PR with why, and `okAt` moves only on a whole
    /// read. Written only when something in it changed.
    fn keep(&self, read: Read) -> Value {
        let path = self.dir.join("prs.json");
        let old = kept(&self.dir);
        // The branch's local head, read even when the host can't be: new commits clear Merged.
        let head = git::read(
            &self.checkout.root,
            &["rev-parse", "HEAD"],
            &AtomicBool::new(false),
        )
        .map(|out| String::from_utf8_lossy(&out).trim().to_string())
        .ok();
        let next = match read {
            Ok((rows, error)) => {
                let last = |row: &Value| {
                    (old["prs"].as_array().into_iter().flatten())
                        .find(|o| o["number"] == row["number"] && o["head"] == row["head"])
                        .filter(|o| !o["failed"].is_null())
                        .cloned()
                };
                let rows: Vec<Value> = (rows.into_iter())
                    .map(
                        |row| match row["state"] == "open" && row["failed"].is_null() {
                            true => last(&row).unwrap_or(row),
                            false => row,
                        },
                    )
                    .collect();
                let ok_at = if error.is_none() {
                    now_ms().into()
                } else {
                    old["okAt"].clone()
                };
                json!({"okAt": ok_at, "error": error, "branch": self.branch, "head": head, "prs": rows})
            }
            // Nothing read before: no PRs yet, but why it couldn't check shows [D30].
            Err(error) if old.is_null() => {
                json!({"okAt": null, "error": error, "branch": self.branch, "head": head, "prs": []})
            }
            Err(error) => {
                let mut next = old.clone();
                (next["error"], next["head"]) = (error.into(), head.into());
                next
            }
        };
        // Its own temp file: a `brigadier host` run from a shell may keep it at the same time.
        let tmp = path.with_extension(format!("{}.tmp", std::process::id()));
        if next != old
            && let Err(e) = fs::write(&tmp, next.to_string()).and_then(|()| fs::rename(&tmp, &path))
        {
            eprintln!("brigadier: keeping {}: {e}", path.display());
        }
        next
    }

    pub fn list(&self) -> Option<Value> {
        self.prs(&self.repo.as_ref().and_then(gh)?)
    }

    fn record_merge(&self, pr: &Value) {
        let (Some(head), Some(commit)) =
            (pr["headRefOid"].as_str(), pr["mergeCommit"]["oid"].as_str())
        else {
            return;
        };
        if pr["baseRefName"] != self.base {
            return;
        }
        let Some(dir) = self.record.as_deref() else {
            return;
        };
        // The session's lock before the checkout's, as a turn start and the one button take them.
        let Ok(_one) = worktrees::lock(dir) else {
            return;
        };
        let never = AtomicBool::new(false);
        let Ok(_held) = git::lock(&self.checkout, true, &never) else {
            return;
        };
        // Failure is uncertain, never permission to discard the branch [D181, D1049].
        let _ = worktrees::external_landing(dir, &self.branch, &self.base_ref, head, commit);
    }
}

/// What a host CLI's `pr` command does that makes its PR one the session touched [D175].
const TOUCH: [&str; 8] = [
    "create", "merge", "edit", "ready", "comment", "review", "close", "reopen",
];

/// The PRs on `repo` the session's own commands opened, merged or changed [D175]: a `pr <verb>`
/// naming one by number or URL, and the URL a `pr create` printed. Read from the session's saved
/// rows, so a command counts once its turn has ended.
// shortcut: gh's command shape only (no glab `mr`, API calls or MCP tools), and a number only as
// its first non-option argument, until a host or agent is seen doing it another way.
fn touched(dir: &Path, repo: &Repo) -> Vec<u64> {
    let Ok(rows) = fs::read(dir.join("thread").join("rows")) else {
        return Vec::new();
    };
    let url = format!("{}/{}/pull/", repo.host, repo.path).to_ascii_lowercase();
    let in_urls = |text: &str| -> Vec<u64> {
        let text = text.to_ascii_lowercase();
        (text.match_indices(&url))
            .filter_map(|(at, _)| {
                let rest = &text[at + url.len()..];
                let end = rest
                    .find(|c: char| !c.is_ascii_digit())
                    .unwrap_or(rest.len());
                rest[..end].parse().ok()
            })
            .collect()
    };
    let ours = |r: &str| {
        let (r, path) = (
            r.trim_matches(['"', '\'']).to_ascii_lowercase(),
            repo.path.to_ascii_lowercase(),
        );
        r == path || r.ends_with(&format!("/{path}"))
    };
    let has = |line: &[u8], what: &[u8]| line.windows(what.len()).any(|w| w == what);
    let mut found = Vec::new();
    for line in rows.split(|b| *b == b'\n') {
        // Most rows aren't a command's, and most commands no PR's: those aren't parsed.
        if !has(line, b"\"step\":\"run\"") || !has(line, b"pr ") {
            continue;
        }
        let Ok(row) = serde_json::from_slice::<Value>(line) else {
            continue;
        };
        let Some(input) = row["input"].as_str() else {
            continue;
        };
        for part in input.split(['\n', ';', '&', '|']) {
            let words: Vec<&str> = part.split_whitespace().collect();
            let Some(at) = (words.windows(2)).position(|w| w[0] == "pr" && TOUCH.contains(&w[1]))
            else {
                continue;
            };
            let (mut rest, mut first, mut elsewhere) = (words[at + 2..].iter(), None, false);
            while let Some(w) = rest.next() {
                match *w {
                    "-R" | "--repo" => elsewhere |= rest.next().is_some_and(|r| !ours(r)),
                    w if w.starts_with("--repo=") => elsewhere |= !ours(&w["--repo=".len()..]),
                    w if w.starts_with('-') => {}
                    w => first = first.or(Some(w.trim_matches(['"', '\'']))),
                }
            }
            if elsewhere {
                continue;
            }
            if let Some(w) = first {
                found.extend(w.trim_start_matches('#').parse::<u64>().ok());
                found.extend(in_urls(w));
            }
            if words[at + 1] == "create" {
                found.extend(in_urls(row["output"].as_str().unwrap_or("")));
            }
        }
    }
    found
}

pub(super) fn belongs(pr: &Value, repo: &Repo, branch: &str) -> bool {
    pr["headRefName"] == branch
        && pr["headRepository"]["nameWithOwner"]
            .as_str()
            .is_some_and(|h| h.eq_ignore_ascii_case(&repo.path))
}

/// gh owns newest-run deduplication by name, workflow and event, including legacy contexts.
pub(super) fn checks(gh: &Gh, repo: &Repo, pr: &Value) -> Result<Vec<Value>, String> {
    // `gh pr checks` fails on a PR with none; the list's rollup, read with its head, says so.
    if pr["statusCheckRollup"]
        .as_array()
        .is_some_and(Vec::is_empty)
    {
        return Ok(Vec::new());
    }
    let number = pr["number"]
        .as_u64()
        .ok_or("gh named no PR number.")?
        .to_string();
    let run = |args: &[&str]| -> Result<Value, String> {
        let mut command = gh.command();
        command.args(args);
        let out = setup::run(&mut command, GH_SECS).map_err(|e| e.to_string())?;
        if !out.status.success() {
            return Err(failed(&out));
        }
        serde_json::from_slice(&out.stdout).map_err(|e| e.to_string())
    };
    let slug = format!("--repo={}/{}", repo.host, repo.path);
    let checks = run(&[
        "pr",
        "checks",
        &number,
        &slug,
        "--json=name,bucket,workflow,event,startedAt,completedAt,link",
    ])?;
    // A new PR head between the list and checks can't borrow the previous head's check state.
    let at = run(&["pr", "view", &number, &slug, "--json=headRefOid"])?;
    if at["headRefOid"] != pr["headRefOid"] {
        return Err(format!("#{number} moved while it was read."));
    }
    serde_json::from_value(checks).map_err(|e| e.to_string())
}

fn row(pr: &Value, checks: Option<&[Value]>) -> Value {
    let count =
        |bucket: &str| checks.map(|checks| checks.iter().filter(|c| c["bucket"] == bucket).count());
    let (failed, running) = (count("fail"), count("pending"));
    let health = if failed.is_some_and(|n| n > 0) {
        "failed"
    } else if pr["mergeable"] == "CONFLICTING" {
        "conflicts"
    } else if pr["reviewDecision"] == "CHANGES_REQUESTED" {
        "changes"
    } else if running.is_some_and(|n| n > 0) {
        "running"
    } else if count("cancel").is_some_and(|n| n > 0) {
        "cancelled"
    } else if checks.is_none() {
        "unknown"
    } else {
        "ready"
    };
    json!({"number": pr["number"], "title": pr["title"], "url": pr["url"],
        "state": pr["state"].as_str().map(str::to_lowercase), "health": health,
        "head": pr["headRefOid"], "branch": pr["headRefName"], "mergeCommit": pr["mergeCommit"]["oid"], "base": pr["baseRefName"],
        "failed": failed, "running": running, "mergedAt": pr["mergedAt"], "draft": pr["isDraft"],
        "updatedAtMs": pr["updatedAt"].as_str().and_then(crate::adapters::iso_ms),
        "failedChecks": checks.map(|c| c.iter().filter(|c| c["bucket"] == "fail").map(|c| c["name"].clone()).collect::<Vec<_>>()), "passed": count("pass"),
        "cancelled": count("cancel"), "skipped": count("skipping"),
        "approved": match pr["reviewDecision"].as_str() {
            Some("APPROVED") => Some(true), Some("REVIEW_REQUIRED" | "CHANGES_REQUESTED") => Some(false), _ => None },
        "mergeable": match pr["mergeable"].as_str() {
            Some("MERGEABLE") => Some(true), Some("CONFLICTING") => Some(false), _ => None }})
}

/// A session's kept PRs (`prs.json`), or null before any read.
pub fn kept(dir: &Path) -> Value {
    (fs::read(dir.join("prs.json")).ok())
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or(Value::Null)
}

/// The session's Merged chip shows but its branch has moved on (a new local commit): its next read
/// is due now, so the chip clears without waiting for the host's pace [D1018].
pub fn moved_on(data: &Path, id: &str) -> bool {
    let dir = crate::session_dir(data, id);
    let kept = kept(&dir);
    if chip(&dir, &kept)["chip"] != "merged" {
        return false;
    }
    let Ok(folder) = git::folder(data, &git::Target::Session(id)) else {
        return false;
    };
    git::read(&folder, &["rev-parse", "HEAD"], &AtomicBool::new(false))
        .is_ok_and(|out| kept["head"] != String::from_utf8_lossy(&out).trim())
}

/// The merged PRs the user has seen (`pr-seen`, numbers): opening the session sees them all.
fn seen_merged(dir: &Path) -> Vec<u64> {
    let text = fs::read_to_string(dir.join("pr-seen")).unwrap_or_default();
    text.split_whitespace()
        .filter_map(|n| n.parse().ok())
        .collect()
}

/// The session was opened: its merged PRs are seen, so their Merged chip clears [D1018].
pub fn opened(dir: &Path) -> io::Result<()> {
    let kept = kept(dir);
    let merged: Vec<u64> = (kept["prs"].as_array().into_iter().flatten())
        .filter(|p| p["state"] == "merged")
        .filter_map(|p| p["number"].as_u64())
        .collect();
    let seen = seen_merged(dir);
    if merged.iter().all(|n| seen.contains(n)) {
        return Ok(());
    }
    let all: Vec<String> = (seen.iter().chain(&merged)).map(u64::to_string).collect();
    crate::write_atomic(&dir.join("pr-seen"), all.join(" ").as_bytes())
}

/// The sidebar's PR chip from every PR the session keeps [D1011, D1018, D1231] (the words are
/// proposed): the one that needs you most, Checks failed over Conflict (with its base, from the
/// host) over Changes asked over Ready; else Merged, while the merge isn't seen and the branch
/// still ends at the merged head. Null when no PR needs a word.
pub fn chip(dir: &Path, kept: &Value) -> Value {
    let rows: Vec<&Value> = kept["prs"].as_array().into_iter().flatten().collect();
    let mark = |p: &Value| match (p["state"].as_str(), p["health"].as_str()) {
        (Some("merged"), _) => "merged",
        (Some("closed"), _) => "closed",
        (_, Some("failed")) => "checks_failed",
        (_, Some("conflicts")) => "conflict",
        (_, Some("changes")) => "changes_asked",
        (_, Some("running")) => "running",
        // Ready to merge: not a draft, not waiting on a review, and the host says it merges [D1018].
        (_, Some("ready")) if p["draft"] == true => "draft",
        (_, Some("ready")) if p["approved"] == false || p["mergeable"] != true => "open",
        (_, Some("ready")) => "ready",
        _ => "open",
    };
    let seen = || seen_merged(dir);
    let unseen = |p: &&Value| {
        mark(p) == "merged"
            && p["head"] == kept["head"]
            && p["number"].as_u64().is_some_and(|n| !seen().contains(&n))
    };
    let chip = (["checks_failed", "conflict", "changes_asked", "ready"].into_iter())
        .find(|chip| rows.iter().any(|p| mark(p) == *chip))
        .or_else(|| rows.iter().any(unseen).then_some("merged"));
    chip.map_or(Value::Null, |chip| {
        // The PR the chip is about goes first: a click opens the first whose mark is the chip's.
        let first = (rows.iter()).position(|p| match chip {
            "merged" => unseen(p),
            _ => mark(p) == chip,
        });
        let mut rows = rows.clone();
        if let Some(i) = first {
            let p = rows.remove(i);
            rows.insert(0, p);
        }
        let prs: Vec<Value> = (rows.iter())
            .map(|p| json!({"number": p["number"], "mark": mark(p)}))
            .collect();
        json!({"chip": chip, "prs": prs})
    })
}
