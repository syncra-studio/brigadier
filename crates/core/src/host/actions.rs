//! The Actions tab [D264]: the session repository's workflow runs as GitHub's "All workflows" page
//! and one run's page, through the user's own gh's REST reads. Each read sends the ETag it was last
//! kept with, so a check that finds nothing new is a 304, free of the rate limit [D207]. All kept
//! in `actions/` in the session's folder, so the tab paints the last read at once.

use super::view::{keep, read_kept};
use super::{GH_SECS, Gh, Kind, NO_GH, Pr, Repo, err, failed, gh, graphql, setup};
use crate::adapters::iso_ms;
use brigadier_frames::log::now_ms;
use serde_json::{Value, json};
use std::io;
use std::path::{Path, PathBuf};

/// A view's page is GitHub's 25.
const PAGE: u32 = 25;
/// Proposed: the last reads of this many queries are kept, the side list's among them.
const KEPT: usize = 40;
/// Proposed: this many reads go out at once.
const AT_ONCE: usize = 8;
/// Proposed: a job's log keeps its last lines, and gets this long to come.
// shortcut: a longer log shows only its tail; page it when someone needs the start of a huge one.
const LOG_LINES: usize = 5000;
const LOG_SECS: u64 = 60;
const ANNOTATIONS: &str = "query($id: ID!) { node(id: $id) { ... on CheckSuite { checkRuns(first: 100) { nodes { databaseId annotations(first: 50) { nodes { annotationLevel title message path location { start { line } } } } } } } } }";

fn kept_at(dir: &Path, name: &str) -> PathBuf {
    dir.join("actions").join(name)
}

/// The side list and each query's last read, or null before any [D207].
pub fn kept_runs(dir: &Path, queries: &[&str]) -> Value {
    let was = read_kept(kept_at(dir, "runs.json"));
    let found: Vec<Value> = queries.iter().map(|q| kept_query(&was, q)).collect();
    json!({"workflows": was["workflows"], "found": found})
}

fn kept_query(was: &Value, query: &str) -> Value {
    (was["queries"].as_array().into_iter().flatten())
        .find(|q| q["query"] == query)
        .cloned()
        .unwrap_or(Value::Null)
}

/// Run `id`'s page as last read, or null before any.
pub fn kept_run(dir: &Path, id: u64) -> Value {
    read_kept(kept_at(dir, &format!("{id}.json")))
}

/// What one REST read found: its body and ETag, None when nothing changed since the ETag sent, or
/// why it couldn't be read.
type Read = Result<Option<(Value, Option<String>)>, String>;

/// `path` read through gh, sent with the ETag it was last kept with.
fn rest(gh: &Gh, repo: &Repo, path: &str, etag: Option<&str>) -> Read {
    let mut command = gh.command();
    command.args(["api", "-i", "--hostname", &repo.host, path]);
    if let Some(etag) = etag {
        command.args(["-H", &format!("If-None-Match: {etag}")]);
    }
    let out = setup::run(&mut command, GH_SECS)?;
    // gh prints the status line and headers, a blank line, then the body; a 304 exits non-zero.
    let text = String::from_utf8_lossy(&out.stdout);
    let (mut status, mut tag, mut at) = (0, None, 0);
    for line in text.split_inclusive('\n') {
        at += line.len();
        let line = line.trim_end();
        if line.is_empty() {
            break;
        }
        if status == 0 {
            status = line
                .split(' ')
                .nth(1)
                .and_then(|s| s.parse().ok())
                .unwrap_or(0);
        } else if let Some((key, value)) = line.split_once(':')
            && key.eq_ignore_ascii_case("etag")
        {
            tag = Some(value.trim().to_string());
        }
    }
    let body: Value = serde_json::from_str(text.get(at..).unwrap_or("")).unwrap_or_default();
    match status {
        304 => Ok(None),
        200..=299 => Ok(Some((body, tag))),
        _ => {
            super::forget(repo);
            Err(body["message"]
                .as_str()
                .map_or_else(|| failed(&out), String::from))
        }
    }
}

/// Each of `paths` read with its ETag, a few at once.
fn rest_all(gh: &Gh, repo: &Repo, paths: &[(String, Option<String>)]) -> Vec<Read> {
    paths
        .chunks(AT_ONCE)
        .flat_map(|chunk| {
            std::thread::scope(|s| {
                let reads: Vec<_> = (chunk.iter())
                    .map(|(path, etag)| s.spawn(|| rest(gh, repo, path, etag.as_deref())))
                    .collect();
                let joined = reads.into_iter().map(|r| r.join());
                joined
                    .map(|r| r.unwrap_or_else(|_| Err("The read stopped.".into())))
                    .collect::<Vec<_>>()
            })
        })
        .collect()
}

/// GitHub's search words, a quoted one ("Nightly build") kept whole.
fn words(query: &str) -> Vec<String> {
    let (mut out, mut word, mut quoted) = (Vec::new(), String::new(), false);
    for c in query.chars() {
        match c {
            '"' => quoted = !quoted,
            c if c.is_whitespace() && !quoted => {
                out.extend((!word.is_empty()).then(|| std::mem::take(&mut word)))
            }
            c => word.push(c),
        }
    }
    out.extend((!word.is_empty()).then_some(word));
    out
}

fn encode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// The REST path a query reads, as GitHub's runs search takes it: `workflow:` (its name, file or
/// id), `event:`, `is:` or `status:`, `branch:` and `actor:`; and its other words, which a run's
/// title must hold.
fn runs_path(repo: &str, query: &str, workflows: &Value) -> (String, Vec<String>) {
    let (mut base, mut params, mut rest) = (
        format!("repos/{repo}/actions/runs"),
        vec![format!("per_page={PAGE}")],
        Vec::new(),
    );
    for word in words(query) {
        match word.split_once(':') {
            Some(("workflow", w)) => {
                let named = (workflows.as_array().into_iter().flatten()).find(|f| {
                    f["name"]
                        .as_str()
                        .is_some_and(|n| n.eq_ignore_ascii_case(w))
                });
                let id = named.map_or_else(|| w.to_string(), |f| f["id"].to_string());
                base = format!("repos/{repo}/actions/workflows/{}/runs", encode(&id));
            }
            Some((key @ ("event" | "branch" | "actor"), v)) => {
                params.push(format!("{key}={}", encode(v)))
            }
            Some(("is" | "status", v)) => params.push(format!("status={}", encode(v))),
            _ => rest.push(word.to_lowercase()),
        }
    }
    (format!("{base}?{}", params.join("&")), rest)
}

/// A run, job or step's one state: queued, running, or how it ended.
fn state(status: &Value, conclusion: &Value) -> &'static str {
    match (status.as_str(), conclusion.as_str()) {
        (Some("completed"), Some(c)) => match c {
            "success" => "success",
            "failure" | "timed_out" | "startup_failure" => "failure",
            "cancelled" => "cancelled",
            "skipped" => "skipped",
            "action_required" => "action_required",
            _ => "neutral",
        },
        (Some("in_progress"), _) => "running",
        _ => "queued",
    }
}

fn ms(v: &Value, key: &str) -> Option<u64> {
    v[key].as_str().and_then(iso_ms)
}

/// A run as its row and its page's summary say it.
fn run_row(r: &Value) -> Value {
    let started = ms(r, "run_started_at").or(ms(r, "created_at"));
    let done = r["status"] == "completed";
    // Its own repository's PR only: a fork's PRs from the same branch come along too.
    let pr = (r["pull_requests"].as_array().into_iter().flatten())
        .find(|p| p["base"]["repo"]["id"] == r["repository"]["id"])
        .map(|p| p["number"].clone());
    let commit = r["head_commit"]["message"]
        .as_str()
        .and_then(|m| m.lines().next());
    json!({"id": r["id"], "title": r["display_title"], "workflow": r["name"], "workflowId": r["workflow_id"],
        "number": r["run_number"], "attempt": r["run_attempt"], "event": r["event"], "actor": r["actor"]["login"],
        "branch": r["head_branch"], "sha": r["head_sha"], "commit": commit, "pr": pr,
        "state": state(&r["status"], &r["conclusion"]), "createdAtMs": ms(r, "created_at"), "startedAtMs": started,
        "durationMs": done.then(|| ms(r, "updated_at").zip(started).map(|(end, start)| end.saturating_sub(start))).flatten(),
        "url": r["html_url"], "suite": r["check_suite_node_id"]})
}

fn job_row(j: &Value) -> Value {
    let steps: Vec<Value> = (j["steps"].as_array().into_iter().flatten())
        .map(|s| json!({"number": s["number"], "name": s["name"], "state": state(&s["status"], &s["conclusion"]),
            "startedAtMs": ms(s, "started_at"), "completedAtMs": ms(s, "completed_at")}))
        .collect();
    json!({"id": j["id"], "name": j["name"], "state": state(&j["status"], &j["conclusion"]), "url": j["html_url"],
        "startedAtMs": ms(j, "started_at"), "completedAtMs": ms(j, "completed_at"), "steps": steps})
}

impl Pr {
    fn actions(&self) -> io::Result<(&Repo, Gh)> {
        let Some(repo) = self.repo.as_ref().filter(|r| r.kind == Kind::GitHub) else {
            return err("Only GitHub's Actions can be read here.");
        };
        match gh(repo) {
            Some(gh) => Ok((repo, gh)),
            None => err(NO_GH),
        }
    }

    /// The side list's workflows and each query's first page of runs, newest first, with how many
    /// there are, all read at once; each kept, with why when its read failed.
    pub fn runs(&self, queries: &[&str]) -> io::Result<Value> {
        let (repo, gh) = self.actions()?;
        let path = kept_at(&self.dir, "runs.json");
        let was = read_kept(path.clone());
        let flows = &was["workflows"];
        let asks: Vec<(String, Vec<String>)> = queries
            .iter()
            .map(|q| runs_path(&repo.path, q, &flows["list"]))
            .collect();
        let mut paths = vec![(
            format!("repos/{}/actions/workflows?per_page=100", repo.path),
            flows["etag"].as_str().map(String::from),
        )];
        paths.extend((asks.iter().zip(queries)).map(|((p, _), q)| {
            (
                p.clone(),
                kept_query(&was, q)["etag"].as_str().map(String::from),
            )
        }));
        let mut reads = rest_all(&gh, repo, &paths).into_iter();
        let workflows = match reads.next() {
            Some(Ok(Some((body, etag)))) => {
                let mut list: Vec<Value> = (body["workflows"].as_array().into_iter().flatten())
                    .filter(|w| w["state"] == "active")
                    .map(|w| json!({"id": w["id"], "name": w["name"], "path": w["path"]}))
                    .collect();
                list.sort_by_key(|w| w["name"].as_str().unwrap_or("").to_lowercase());
                json!({"okAt": now_ms(), "etag": etag, "list": list})
            }
            Some(Err(why)) if flows.is_null() => json!({"okAt": null, "error": why, "list": []}),
            _ => flows.clone(),
        };
        let found: Vec<Value> = (queries.iter().zip(asks).zip(reads))
            .map(|((query, (_, title)), read)| {
                let last = kept_query(&was, query);
                match read {
                    Ok(Some((body, etag))) => {
                        let runs: Vec<Value> = (body["workflow_runs"].as_array().into_iter().flatten())
                            .map(run_row)
                            .filter(|r| {
                                let t = r["title"].as_str().unwrap_or("").to_lowercase();
                                title.iter().all(|w| t.contains(w.as_str()))
                            })
                            .collect();
                        // Words beyond GitHub's own filter the page read, so it counts what it shows.
                        let total = if title.is_empty() { body["total_count"].clone() } else { runs.len().into() };
                        json!({"query": query, "okAt": now_ms(), "error": null, "etag": etag, "total": total, "runs": runs})
                    }
                    Ok(None) => {
                        let mut next = last;
                        next["okAt"] = now_ms().into();
                        next["error"] = Value::Null;
                        next
                    }
                    // Why a read failed, kept beside the last good one.
                    Err(why) if last.is_null() => json!({"query": query, "okAt": null, "error": why, "runs": [], "total": null}),
                    Err(why) => {
                        let mut next = last;
                        next["error"] = why.into();
                        next
                    }
                }
            })
            .collect();
        let one = self.one();
        let _held = one.lock().unwrap_or_else(|e| e.into_inner());
        let now = read_kept(path.clone());
        let older = (now["queries"].as_array().into_iter().flatten())
            .filter(|q| !queries.iter().any(|n| q["query"] == *n))
            .cloned();
        let kept: Vec<Value> = found.iter().cloned().chain(older).take(KEPT).collect();
        keep(&path, &json!({"workflows": workflows, "queries": kept}));
        Ok(json!({"workflows": workflows, "found": found}))
    }

    /// Run `id`'s page: the run, its latest attempt's jobs and steps, and their annotations, each
    /// read against its ETag; kept, with why when a part couldn't be read.
    pub fn run(&self, id: u64) -> io::Result<Value> {
        let (repo, gh) = self.actions()?;
        let path = kept_at(&self.dir, &format!("{id}.json"));
        let was = read_kept(path.clone());
        let at = format!("repos/{}/actions/runs/{id}", repo.path);
        let tag = |key: &str| was[key].as_str().map(String::from);
        let mut reads = rest_all(
            &gh,
            repo,
            &[
                (at.clone(), tag("etag")),
                (format!("{at}/jobs?per_page=100"), tag("jobsEtag")),
            ],
        )
        .into_iter();
        let mut next = match was.is_object() {
            true => was.clone(),
            false => json!({"run": null, "jobs": [], "annotations": []}),
        };
        let mut why = None;
        match reads.next() {
            Some(Ok(Some((body, etag)))) => {
                next["run"] = run_row(&body);
                next["etag"] = etag.into();
            }
            Some(Err(e)) => why = Some(e),
            _ => {}
        }
        let mut changed = false;
        match reads.next() {
            Some(Ok(Some((body, etag)))) => {
                next["jobs"] = (body["jobs"].as_array().into_iter().flatten())
                    .map(job_row)
                    .collect();
                next["jobsEtag"] = etag.into();
                changed = true;
            }
            Some(Err(e)) => why = why.or(Some(e)),
            _ => {}
        }
        if next["run"].is_null() {
            return err(why.unwrap_or_else(|| format!("Run {id} couldn't be read.")));
        }
        // Annotations hang on the run's check suite, read again only when its jobs changed.
        if changed && let Some(suite) = next["run"]["suite"].as_str() {
            match graphql(&gh, repo, ANNOTATIONS, &[("id", suite)]) {
                Ok((data, _)) => next["annotations"] = annotations(&data, &next["jobs"]),
                Err(e) => why = why.or(Some(e)),
            }
        }
        if why.is_none() {
            next["okAt"] = now_ms().into();
        }
        next["error"] = why.into();
        keep(&path, &next);
        Ok(next)
    }

    /// A finished job's log, its `##[group]` lines folded; kept for good once read, as it never
    /// changes. A running job's has no public live read, so the tab asks only once it's done.
    pub fn job_log(&self, job: u64) -> io::Result<Value> {
        let path = kept_at(&self.dir, &format!("log/{job}.json"));
        let was = read_kept(path.clone());
        if was["lines"].is_array() {
            return Ok(was);
        }
        let (repo, gh) = self.actions()?;
        let mut command = gh.command();
        // A log holds its tools' colours; gh refuses to print them unless told to, and `fold` drops them.
        command.args([
            "api",
            "--allow-escape-sequences",
            "--hostname",
            &repo.host,
            &format!("repos/{}/actions/jobs/{job}/logs", repo.path),
        ]);
        let out = setup::run(&mut command, LOG_SECS).map_err(io::Error::other)?;
        if !out.status.success() {
            return err(failed(&out));
        }
        let log = fold(&String::from_utf8_lossy(&out.stdout));
        keep(&path, &log);
        Ok(log)
    }

    /// Runs run `id` again, all its jobs or only the failed ones (and what they need).
    pub fn rerun(&self, id: u64, failed_only: bool) -> io::Result<()> {
        let (repo, gh) = self.actions()?;
        let what = if failed_only {
            "rerun-failed-jobs"
        } else {
            "rerun"
        };
        let mut command = gh.command();
        command.args([
            "api",
            "-X",
            "POST",
            "--silent",
            "--hostname",
            &repo.host,
            &format!("repos/{}/actions/runs/{id}/{what}", repo.path),
        ]);
        let out = setup::run(&mut command, GH_SECS).map_err(io::Error::other)?;
        match out.status.success() {
            true => Ok(()),
            false => err(failed(&out)),
        }
    }
}

/// The annotations of the jobs shown, by job: an older attempt's check runs share the suite.
fn annotations(data: &Value, jobs: &Value) -> Value {
    let jobs = jobs.as_array().cloned().unwrap_or_default();
    let runs = data["node"]["checkRuns"]["nodes"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let found: Vec<Value> = (runs.iter())
        .filter_map(|run| Some((jobs.iter().find(|j| j["id"] == run["databaseId"])?, run)))
        .flat_map(|(job, run)| {
            let list = run["annotations"]["nodes"].as_array().cloned().unwrap_or_default();
            list.into_iter().map(move |a| {
                json!({"job": job["name"], "level": a["annotationLevel"].as_str().map(str::to_lowercase),
                    "title": a["title"], "message": a["message"], "path": a["path"], "line": a["location"]["start"]["line"]})
            })
        })
        .collect();
    found.into()
}

/// A job's log as the tab draws it: each line without its time, a `##[group]` holding the lines
/// to its `##[endgroup]`, and an error, warning, notice or command line marked.
fn fold(text: &str) -> Value {
    let text = plain(text);
    let all: Vec<&str> = text.trim_start_matches('\u{feff}').lines().collect();
    let cut = all.len().saturating_sub(LOG_LINES);
    let (mut lines, mut group): (Vec<Value>, Option<(String, Vec<Value>)>) = (Vec::new(), None);
    for raw in &all[cut..] {
        let line = match raw.split_once(' ') {
            Some((at, rest)) if at.ends_with('Z') && at.contains('T') => rest,
            _ => raw,
        };
        if let Some(title) = line.strip_prefix("##[group]") {
            lines.extend(
                group
                    .take()
                    .map(|(t, inner)| json!({"text": t, "group": inner})),
            );
            group = Some((title.to_string(), Vec::new()));
            continue;
        }
        if line.starts_with("##[endgroup]") {
            lines.extend(
                group
                    .take()
                    .map(|(t, inner)| json!({"text": t, "group": inner})),
            );
            continue;
        }
        let marked = ["error", "warning", "notice", "command", "debug"]
            .into_iter()
            .find_map(|k| line.strip_prefix(&format!("##[{k}]")).map(|rest| (k, rest)));
        let one = match marked {
            Some((kind, rest)) => json!({"text": rest, "kind": kind}),
            None => json!({"text": line}),
        };
        match &mut group {
            Some((_, inner)) => inner.push(one),
            None => lines.push(one),
        }
    }
    lines.extend(group.map(|(t, inner)| json!({"text": t, "group": inner})));
    json!({"lines": lines, "cut": cut})
}

/// `text` without its terminal escapes (`ESC [ … letter`, the colours a tool prints).
fn plain(text: &str) -> String {
    let (mut out, mut chars) = (String::with_capacity(text.len()), text.chars().peekable());
    while let Some(c) = chars.next() {
        if c != '\u{1b}' {
            out.push(c);
        } else if chars.next_if_eq(&'[').is_some() {
            while chars.next().is_some_and(|c| !c.is_ascii_alphabetic()) {}
        }
    }
    out
}
