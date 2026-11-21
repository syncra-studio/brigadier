//! PR discovery and check aggregation through the unmodified host CLI [D1030, D1187], one GraphQL
//! read for all the session's PRs [D207], kept in the session's `prs.json` by every read: the
//! watch's, `info`'s and a merge's [D1009, D1017].
//! `prs.json` (proposed) is `{okAt, error, branch, head, prs}`: when the last whole read answered,
//! why the last one didn't (null when it did), the branch and its local head then, and each PR's row.
//! Its PRs are every one the session touched [D175]: each of its branches' open PR (kept once seen
//! open, `live`, whichever branch it's on now and once closed or merged; never a branch's old closed
//! one) [D256, D426], and those its own commands looked at in detail, in any repository on its
//! server [D213]; open ones first, then by recency.

use super::touched::touched;
use super::{Gh, Kind, Pr, Repo, gh};
use crate::adapters::iso_ms;
use crate::{git, worktrees};
use brigadier_frames::log::now_ms;
use serde_json::{Value, json};
use std::cmp::Reverse;
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

/// One read and keep at a time per session (the watch and the app's reads both run in the
/// daemon), so an older read never overwrites a newer one.
static BUSY: Mutex<BTreeMap<PathBuf, Arc<Mutex<()>>>> = Mutex::new(BTreeMap::new());

/// What a read gave: the PRs and, when one PR's checks couldn't be read, why; or why none could be.
type Read = Result<(Vec<Value>, Option<String>), String>;

/// What every PR read asks the host for: the list's row and the head commit's checks, read in one
/// snapshot, so a PR's head and its checks always agree.
// shortcut: a head's first 100 checks only, until a repository has more.
pub(super) const FIELDS: &str = "number url title state isDraft mergeable reviewDecision createdAt author { login } commented: comments { totalCount } headRefName headRefOid baseRefName mergedAt updatedAt headRepository { nameWithOwner url } mergeCommit { oid } commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes { __typename ... on CheckRun { name status conclusion startedAt completedAt detailsUrl checkSuite { workflowRun { event workflow { name } } } } ... on StatusContext { context state targetUrl createdAt } } } } } } }";

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
        Some(match gh(repo, self.account.as_deref()) {
            Some(gh) => self.keep(self.read(&gh)),
            None => self.keep(Err(super::NO_GH.into())),
        })
    }

    pub(super) fn one(&self) -> Arc<Mutex<()>> {
        let mut busy = BUSY.lock().unwrap_or_else(|e| e.into_inner());
        busy.entry(self.dir.clone()).or_default().clone()
    }

    /// The branch's live PR and every other one the session touched [D175, D256], in any repository on its
    /// server [D213], in one GraphQL read [D207].
    fn read(&self, gh: &Gh) -> Read {
        let Some(repo) = self.repo.as_ref() else {
            return Err("This remote's host isn't one Brigadier knows.".into());
        };
        // The session's other PRs [D175]: those kept from its other branches and repositories, read
        // again until merged (then final), and those its own commands looked at.
        let old = kept(&self.dir);
        let old: Vec<&Value> = old["prs"].as_array().into_iter().flatten().collect();
        let numbers: BTreeSet<Key> = (old.iter())
            .filter(|p| p["live"] == true || p["state"] == "open" || !p["repo"].is_null())
            .map(|p| key(p))
            .chain(
                touched(&self.dir, repo)
                    .into_iter()
                    .map(|(r, n)| (r.map(|r| r.to_ascii_lowercase()), n)),
            )
            .chain(super::create::attached(&self.dir))
            .collect();
        let merged = |k: &Key| (old.iter()).find(|p| key(p) == *k && p["state"] == "merged");
        // Each repository's PRs under its own alias: the session's in its own block.
        let (mut own, mut others) = (String::new(), BTreeMap::<&str, String>::new());
        for (r, n) in numbers.iter().filter(|k| merged(k).is_none()) {
            let ask = format!(" p{n}: pullRequest(number: {n}) {{ ...F }}");
            match r {
                None => own.push_str(&ask),
                Some(r) => others.entry(r).or_default().push_str(&ask),
            }
        }
        let alias: BTreeMap<&str, usize> =
            others.keys().enumerate().map(|(i, r)| (*r, i)).collect();
        // Each `owner/name` is checked to be one (`slug`), so it goes into the query as is.
        let elsewhere: String = (others.iter().enumerate())
            .filter_map(|(i, (r, asks))| {
                let (owner, name) = r.split_once('/')?;
                Some(format!(
                    " r{i}: repository(owner: \"{owner}\", name: \"{name}\") {{{asks} }}"
                ))
            })
            .collect();
        // A branch's 10 latest: each brings its checks, and GitHub refuses a read that big.
        let query = format!(
            "query($owner: String!, $name: String!, $branch: String!) {{ repository(owner: $owner, name: $name) {{ branch: pullRequests(headRefName: $branch, first: 10, states: [OPEN, MERGED, CLOSED], orderBy: {{ field: UPDATED_AT, direction: DESC }}) {{ nodes {{ ...F }} }}{own} }}{elsewhere} }} fragment F on PullRequest {{ {FIELDS} }}"
        );
        let (data, partial) = super::graphql(gh, repo, &query, &[("branch", &self.branch)])?;
        let found = &data["repository"];
        let list = found["branch"]["nodes"].as_array().ok_or_else(|| {
            partial
                .clone()
                .unwrap_or_else(|| "The host didn't list this branch's PRs.".into())
        })?;
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
        for p in (mine.iter()).filter(|p| p["state"] == "MERGED") {
            self.record_merge(p);
        }
        // Of the branch's own, only its open PR; a closed one only once touched [D256, D426].
        let shown: Vec<&&Value> = open.into_iter().collect();
        let mut rows: Vec<Value> = shown.iter().map(|p| row(p)).collect();
        let mut missed = None;
        for k in numbers.iter().rev() {
            let (r, n) = k;
            if r.is_none() && shown.iter().any(|p| p["number"] == *n) {
                continue;
            }
            if let Some(was) = merged(k) {
                rows.push((*was).clone());
                continue;
            }
            let was = old.iter().find(|p| key(p) == *k);
            let got = match r {
                None => &found[format!("p{n}")],
                Some(r) => {
                    &data[format!("r{}", alias.get(r.as_str()).copied().unwrap_or(usize::MAX))]
                        [format!("p{n}")]
                }
            };
            match (got, was) {
                (p, _) if p.is_object() => rows.push(mark(row(p), repo)),
                // One read before keeps its last row with why; one never read (no PR there) waits.
                (_, Some(was)) => {
                    rows.push((*was).clone());
                    missed.get_or_insert(partial.clone().unwrap_or_else(|| {
                        format!("{}#{n} couldn't be read.", r.as_deref().unwrap_or(""))
                    }));
                }
                (_, None) => {}
            }
        }
        // Seen open by this session: its branch's live PR then, so kept once closed or merged [D426].
        for p in &mut rows {
            let was = old.iter().find(|o| key(o) == key(p));
            if p["state"] == "open"
                || was.is_some_and(|o| o["live"] == true || o["state"] == "open")
            {
                p["live"] = true.into();
            }
        }
        // Open first, then the latest [D256]: the card shows the first few, the PR tab them all.
        rows.sort_by_key(|p| (p["state"] != "open", Reverse(p["updatedAtMs"].as_i64())));
        Ok((rows, missed))
    }

    /// One PR's row, from a read of the PR alone (its tab's), kept in `prs.json` beside the others,
    /// so the card and the list never show older facts than its tab. Only the branch's own is added:
    /// another the tab lists opens without joining the card [D283].
    pub(super) fn keep_row(&self, pr: &Value, mine: bool) {
        let one = self.one();
        let _held = one.lock().unwrap_or_else(|e| e.into_inner());
        let mut next = kept(&self.dir);
        let Some(rows) = next["prs"].as_array_mut() else {
            return;
        };
        let mut fresh = row(pr);
        if let Some(repo) = &self.repo {
            fresh = mark(fresh, repo);
        }
        fresh["viewedAtMs"] = now_ms().into();
        match rows.iter_mut().find(|p| key(p) == key(&fresh)) {
            Some(was) => {
                fresh["live"] = was["live"].clone();
                *was = fresh;
            }
            None if mine && fresh["state"] == "open" => rows.push(fresh),
            None => return,
        }
        let path = self.dir.join("prs.json");
        let tmp = path.with_extension(format!("{}.tmp", std::process::id()));
        if let Err(e) = fs::write(&tmp, next.to_string()).and_then(|()| fs::rename(&tmp, &path)) {
            eprintln!("brigadier: keeping {}: {e}", path.display());
        }
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
                        .find(|o| key(o) == key(row) && o["head"] == row["head"])
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
        self.prs(
            &self
                .repo
                .as_ref()
                .and_then(|r| gh(r, self.account.as_deref()))?,
        )
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

/// A kept row's PR: its repository's `owner/name` (lower case) when it isn't the session's own,
/// and its number.
pub(super) type Key = (Option<String>, u64);

fn key(row: &Value) -> Key {
    (
        row["repo"].as_str().map(str::to_ascii_lowercase),
        row["number"].as_u64().unwrap_or(0),
    )
}

/// A row from a repository other than the session's names it, `owner/name` from its URL [D213].
pub(super) fn mark(mut row: Value, repo: &Repo) -> Value {
    let at = (row["url"].as_str())
        .and_then(|u| u.split_once("://"))
        .and_then(|(_, rest)| {
            let mut parts = rest.split('/');
            Some((
                parts.next()?,
                format!("{}/{}", parts.next()?, parts.next()?),
            ))
        });
    if let Some((host, path)) = at {
        if !host.eq_ignore_ascii_case(&repo.host) {
            row["repo"] = format!("{host}/{path}").into();
        } else if !path.eq_ignore_ascii_case(&repo.path) {
            row["repo"] = path.into();
        }
    }
    row
}

pub(super) fn belongs(pr: &Value, repo: &Repo, branch: &str) -> bool {
    pr["headRefName"] == branch
        && pr["headRepository"]["nameWithOwner"]
            .as_str()
            .is_some_and(|h| h.eq_ignore_ascii_case(&repo.path))
}

/// A PR's checks from its head commit's rollup, bucketed and deduplicated as `gh pr checks` does:
/// only the newest run of each name, workflow and event, a status context by its name.
pub(super) fn checks_of(pr: &Value) -> Vec<Value> {
    let nodes = &pr["commits"]["nodes"][0]["commit"]["statusCheckRollup"]["contexts"]["nodes"];
    let mut all: Vec<Value> = (nodes.as_array().into_iter().flatten())
        .map(|c| match c["__typename"].as_str() {
            Some("CheckRun") => {
                let state = match c["status"].as_str() {
                    Some("COMPLETED") => &c["conclusion"],
                    _ => &c["status"],
                };
                let run = &c["checkSuite"]["workflowRun"];
                json!({"name": c["name"], "bucket": bucket(state), "workflow": run["workflow"]["name"],
                    "event": run["event"], "startedAt": c["startedAt"], "completedAt": c["completedAt"],
                    "link": c["detailsUrl"]})
            }
            _ => json!({"name": c["context"], "bucket": bucket(&c["state"]), "workflow": "", "event": "",
                "startedAt": c["createdAt"], "completedAt": c["createdAt"], "link": c["targetUrl"]}),
        })
        .collect();
    all.sort_by(|a, b| b["startedAt"].as_str().cmp(&a["startedAt"].as_str()));
    let mut seen = BTreeSet::new();
    all.retain(|c| seen.insert(format!("{}\0{}\0{}", c["name"], c["workflow"], c["event"])));
    all
}

/// gh's bucket for a check's state or conclusion.
fn bucket(state: &Value) -> &'static str {
    match state.as_str().unwrap_or("") {
        "SUCCESS" => "pass",
        "SKIPPED" | "NEUTRAL" => "skipping",
        "ERROR" | "FAILURE" | "TIMED_OUT" | "ACTION_REQUIRED" | "STARTUP_FAILURE" => "fail",
        "CANCELLED" => "cancel",
        _ => "pending",
    }
}

/// A PR's row as `prs.json` keeps it; an open one's checks counted, a closed one's not asked.
fn row(pr: &Value) -> Value {
    let checks = (pr["state"] == "OPEN").then(|| checks_of(pr));
    let checks = checks.as_deref();
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
        "updatedAtMs": pr["updatedAt"].as_str().and_then(iso_ms),
        "failedChecks": checks.map(|c| c.iter().filter(|c| c["bucket"] == "fail").map(|c| c["name"].clone()).collect::<Vec<_>>()), "passed": count("pass"),
        "cancelled": count("cancel"), "skipped": count("skipping"),
        "author": pr["author"]["login"], "createdAtMs": pr["createdAt"].as_str().and_then(iso_ms),
        "comments": pr["commented"]["totalCount"], "review": pr["reviewDecision"].as_str().map(str::to_lowercase),
        "checks": checks.map(|c| {
            let not = |of: &[&str]| c.iter().filter(|c| of.contains(&c["bucket"].as_str().unwrap_or(""))).count();
            tally(c.len(), c.len() - not(&["pass", "skipping"]), not(&["fail", "cancel"]))
        }),
        "approved": match pr["reviewDecision"].as_str() {
            Some("APPROVED") => Some(true), Some("REVIEW_REQUIRED" | "CHANGES_REQUESTED") => Some(false), _ => None },
        "mergeable": match pr["mergeable"].as_str() {
            Some("MERGEABLE") => Some(true), Some("CONFLICTING") => Some(false), _ => None }})
}

/// A PR's checks as GitHub's list counts them [D258]: done well (passed or skipped) of all, and
/// the mark, failed over pending over passed.
pub(super) fn tally(all: usize, not_ok: usize, failed: usize) -> Value {
    let mark = match (failed, not_ok) {
        (0, 0) => "pass",
        (0, _) => "pending",
        _ => "fail",
    };
    json!({"ok": all - not_ok, "all": all, "mark": mark})
}

/// A session's kept PRs (`prs.json`), or null before any read.
pub fn kept(dir: &Path) -> Value {
    (fs::read(dir.join("prs.json")).ok())
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or(Value::Null)
}
