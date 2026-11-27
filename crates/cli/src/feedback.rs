//! `feedback`, the old app's Send feedback [D2100]: the note becomes reports in a writer run on the
//! first ready agent (core's `feedback` has the prompts and the issue text), checked against
//! Brigadier's issues, then filed as the user with their own `gh`: a new issue, or a comment on the
//! issue it repeats. Signed out, `feedback sign-in` signs `gh` in first, in its web flow. No bot and
//! no token of Brigadier's. With no writer to run, the note goes to a prefilled new-issue page.

use crate::{accounts, arg, commit, models};
use brigadier_core::adapters::{self, setup};
use brigadier_core::feedback::{self as fb, Issue, Kind, Report};
use brigadier_core::fold::Fold;
use brigadier_core::{Spec, writer};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::{fs, io};

mod sign_in;

/// How long one read of GitHub may take, and one filing.
const READ_SECS: u64 = 20;
const FILE_SECS: u64 = 60;
/// The most issues listed for the writer; the public API's page size and the most pages read.
const ISSUE_LIMIT: &str = "1000";
const PAGE: usize = 100;
const MAX_PAGES: usize = 10;
/// The old app's: the longest link opened; past it the note is cut, so GitHub takes it.
const MAX_URL: usize = 7500;
/// The old app's: the fallback title is the note's first line, cut at this many characters.
const MAX_TITLE: usize = 72;
/// Why a report wasn't filed when `gh` turned out signed out: Try again signs it in first.
const NOT_SIGNED_IN: &str = "you’re not signed in to GitHub";

/// `feedback account | sign-in [wait|cancel] | write NOTE | file REPORTS`.
pub fn run(data: &Path, args: &[String]) -> io::Result<Value> {
    match args.get(1).map_or("", String::as_str) {
        "account" => Ok(account()),
        "sign-in" => sign_in::run(args.get(2).map_or("", String::as_str)),
        "write" => write(data, arg(args, 2)?),
        "file" => file(data, arg(args, 2)?),
        _ => Err(io::Error::other(
            "usage: brigadier feedback account | sign-in [wait|cancel] | write NOTE | file REPORTS",
        )),
    }
}

/// The user's `gh`. A debug build takes a stand-in from `BRIGADIER_FEEDBACK_GH`, as the old app's
/// did, so the dev app files nothing real while it is tried.
fn gh() -> Option<PathBuf> {
    #[cfg(debug_assertions)]
    if let Some(program) = std::env::var_os("BRIGADIER_FEEDBACK_GH") {
        return Some(program.into());
    }
    setup::find("gh", &[])
}

/// `gh` with `args` on the login shell's PATH, never prompting.
fn gh_run(gh: &Path, args: &[&str], secs: u64) -> Result<Output, String> {
    let mut command = Command::new(gh);
    command
        .args(args)
        .env("PATH", setup::login().path)
        .env("GH_PROMPT_DISABLED", "1");
    setup::run(&mut command, secs)
}

/// The user's `gh` when its active account is signed in to github.com (a stale other one fails a
/// plain status).
fn signed_in() -> Option<PathBuf> {
    let gh = gh()?;
    let args = ["auth", "status", "--active", "--hostname", "github.com"];
    gh_run(&gh, &args, READ_SECS)
        .ok()?
        .status
        .success()
        .then_some(gh)
}

/// Who it posts as: signed in or not, and the GitHub login when `gh` can say it.
fn account() -> Value {
    let Some(gh) = signed_in() else {
        return json!({"ok": true, "signed_in": false, "login": null});
    };
    let login = (gh_run(&gh, &["api", "user", "--jq", ".login"], READ_SECS).ok())
        .filter(|out| out.status.success())
        .map(|out| String::from_utf8_lossy(&out.stdout).trim().to_string())
        .filter(|login| !login.is_empty());
    json!({"ok": true, "signed_in": true, "login": login})
}

/// The note as reports, each checked against the issues. With no writer to run (or a reply that
/// can't be read), the note's prefilled page to open instead, as the old app's fallback.
fn write(data: &Path, note: &str) -> io::Result<Value> {
    let note = note.trim();
    if note.is_empty() {
        return Err(io::Error::other("Write what you spotted first."));
    }
    let gh = signed_in();
    let issues = known_issues(gh.as_deref());
    let prompt = format!(
        "{}\n\n{}",
        fb::write_prompt(),
        fb::write_turn(note, issues.as_deref())
    );
    let reports =
        written(data, &prompt).and_then(|reply| fb::reports_of(&reply, issues.as_deref()));
    let mut reports = match reports {
        Ok(reports) => reports,
        Err(why) => {
            eprintln!("feedback: no write-up, the note opens in the browser: {why}");
            let url = page(data, note);
            return Ok(
                json!({"ok": true, "opened": {"kind": "bug", "title": title(note), "url": url}}),
            );
        }
    };
    let known = issues.unwrap_or_default();
    let mut bodies = vec![];
    let mut wanted: Vec<u64> = reports.iter().flat_map(|(_, c)| c.clone()).collect();
    wanted.sort();
    wanted.dedup();
    for issue in known.iter().filter(|i| wanted.contains(&i.number)) {
        // An issue whose text can't be read is judged by its title alone.
        let body = issue_text(gh.as_deref(), issue.number).unwrap_or_default();
        bodies.push((issue.clone(), body));
    }
    if !bodies.is_empty() {
        let prompt = format!(
            "{}\n\n{}",
            fb::JUDGE_PROMPT,
            fb::judge_turn(&reports, &bodies)
        );
        match written(data, &prompt) {
            Ok(reply) => fb::mark_duplicates(&mut reports, &reply, &bodies),
            Err(why) => eprintln!(
                "feedback: the duplicate check didn't run, filing every report new: {why}"
            ),
        }
    }
    let reports: Vec<Report> = reports.into_iter().map(|(r, _)| r).collect();
    Ok(json!({"ok": true, "reports": reports}))
}

/// One reply to `prompt` from a throwaway writer run, whatever Write with says: the first
/// ready agent that's on, at its cheapest model, on the account new sessions start on; the next
/// agent when it can't. Its runs keep their records in `<data>/feedback/runs/`, and what a run
/// that died left there goes before the next.
fn written(data: &Path, prompt: &str) -> Result<String, String> {
    let dir = data.join("feedback").join("runs");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let base = Spec {
        id: "feedback".into(),
        mode: "pipe".into(),
        cwd: dir.display().to_string(),
        dir: dir.clone(),
        ..Default::default()
    };
    for left in writer::forget(&base, &Fold::default()) {
        eprintln!("feedback: {left}");
    }
    let active = writer::writing(&dir).map_err(|e| e.to_string())?;
    active.lock_shared().map_err(|e| e.to_string())?;
    let groups = models::run(data, &["models".into()]).map_err(|e| e.to_string())?;
    let ready = (groups["groups"].as_array().into_iter().flatten())
        .filter(|g| {
            g["unavailable"].is_null() && g["models"].as_array().is_some_and(|m| !m.is_empty())
        })
        .filter_map(|g| adapters::get(g["provider"].as_str()?));
    let mut why = "no agent can write it now".to_string();
    for a in ready {
        let spec = accounts::starting(
            data,
            Spec {
                backend: a.name().into(),
                ..base.clone()
            },
        );
        let mut f = Fold::default();
        f.accounts
            .extend(spec.starts_on.clone().map(|id| (a.name().to_string(), id)));
        match commit::written_for(data, &spec, &f, &active, None, |_| prompt.to_string()) {
            Ok((reply, _)) => return Ok(reply),
            Err(e) => why = e,
        }
    }
    Err(why)
}

/// Brigadier's issues, open and closed: through `gh` when it is signed in, else the public API;
/// `None` when neither answers.
fn known_issues(gh: Option<&Path>) -> Option<Vec<Issue>> {
    let issue = |v: &Value, url: &str| {
        let title = v["title"].as_str()?;
        let labels =
            (v["labels"].as_array().into_iter().flatten()).filter_map(|l| l["name"].as_str());
        Some(Issue {
            number: v["number"].as_u64()?,
            title: title.to_string(),
            open: v["state"].as_str()?.eq_ignore_ascii_case("open"),
            url: v[url].as_str()?.to_string(),
            kind: fb::kind_of(title, labels),
        })
    };
    if let Some(gh) = gh {
        let fields = "number,title,state,url,labels";
        let args = [
            "issue",
            "list",
            "--repo",
            fb::REPO,
            "--state",
            "all",
            "--limit",
            ISSUE_LIMIT,
            "--json",
            fields,
        ];
        let out = gh_run(gh, &args, READ_SECS).ok()?;
        if !out.status.success() {
            eprintln!(
                "feedback: gh couldn't list the issues: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            );
            return None;
        }
        let listed: Vec<Value> = serde_json::from_slice(&out.stdout).ok()?;
        return Some(listed.iter().filter_map(|v| issue(v, "url")).collect());
    }
    let mut issues = vec![];
    for page in 1..=MAX_PAGES {
        let Value::Array(items) =
            public_api(&format!("issues?state=all&per_page={PAGE}&page={page}"))?
        else {
            return None;
        };
        // The public list has pull requests in it too.
        let found = items.iter().filter(|v| v.get("pull_request").is_none());
        issues.extend(found.filter_map(|v| issue(v, "html_url")));
        if items.len() < PAGE {
            break;
        }
    }
    Some(issues)
}

/// The text of issue `number`, for the duplicate check.
fn issue_text(gh: Option<&Path>, number: u64) -> Option<String> {
    let value = match gh {
        Some(gh) => {
            let number = number.to_string();
            let args = [
                "issue",
                "view",
                &number,
                "--repo",
                fb::REPO,
                "--json",
                "body",
            ];
            let out = gh_run(gh, &args, READ_SECS)
                .ok()
                .filter(|o| o.status.success())?;
            serde_json::from_slice::<Value>(&out.stdout).ok()?
        }
        None => public_api(&format!("issues/{number}"))?,
    };
    Some(value["body"].as_str().unwrap_or_default().to_string())
}

/// GET `path` under the repository on GitHub's public API with `curl`; `None` on any failure
/// (offline, rate limited, a private repository).
fn public_api(path: &str) -> Option<Value> {
    let curl = setup::find("curl", &[])?;
    let url = format!("https://api.github.com/repos/{}/{path}", fb::REPO);
    let mut command = Command::new(curl);
    command.args([
        "-sSfL",
        "--max-time",
        "15",
        "-H",
        "Accept: application/vnd.github+json",
        &url,
    ]);
    let out = setup::run(&mut command, READ_SECS).ok()?;
    if !out.status.success() {
        eprintln!(
            "feedback: GitHub's public API didn't answer {url}: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        );
        return None;
    }
    serde_json::from_slice(&out.stdout).ok()
}

/// `file <reports>`: files each report `write` made as the user, one by one: a comment on the issue
/// it repeats, else a new issue with its form's label, filed again without it only when GitHub
/// refused the label itself. What became of each, in order; signed out, nothing is filed.
fn file(data: &Path, reports: &str) -> io::Result<Value> {
    let reports: Vec<Report> = serde_json::from_str(reports)?;
    let Some(gh) = signed_in() else {
        let results: Vec<Value> = (reports.iter())
            .map(|r| json!({"kind": r.kind, "title": r.title, "outcome": "failed", "reason": NOT_SIGNED_IN}))
            .collect();
        return Ok(json!({"ok": true, "signed_in": false, "results": results}));
    };
    let (version, details) = details(data);
    let results: Vec<Value> = (reports.iter())
        .map(|r| {
            let filed = file_one(&gh, r, &version, &details);
            let mut result = json!({"kind": r.kind, "title": r.title});
            if let (Value::Object(head), Value::Object(rest)) = (&mut result, filed) {
                head.extend(rest);
            }
            result
        })
        .collect();
    Ok(json!({"ok": true, "signed_in": true, "results": results}))
}

fn file_one(gh: &Path, report: &Report, version: &str, details: &[String]) -> Value {
    if let Some(duplicate) = &report.duplicate {
        let number = duplicate.number.to_string();
        let body = fb::repeat_comment(report, details);
        let args = [
            "issue",
            "comment",
            &number,
            "--repo",
            fb::REPO,
            "--body",
            &body,
        ];
        return match gh_run(gh, &args, FILE_SECS) {
            Ok(out) if out.status.success() => {
                let url = last_url(&out.stdout).unwrap_or_else(|| duplicate.url.clone());
                json!({"outcome": "added", "number": duplicate.number, "url": url})
            }
            Ok(out) => refused(&out),
            Err(why) => json!({"outcome": "failed", "reason": format!("gh couldn't run: {why}")}),
        };
    }
    let label = match report.kind {
        Kind::Bug => "bug",
        Kind::Idea => "proposal",
    };
    let (title, body) = (
        fb::issue_title(report),
        fb::issue_body(report, version, details),
    );
    let mut args = vec![
        "issue",
        "create",
        "--repo",
        fb::REPO,
        "--title",
        &title,
        "--body",
        &body,
        "--label",
        label,
    ];
    let mut out = gh_run(gh, &args, FILE_SECS);
    if matches!(&out, Ok(done) if !done.status.success() && label_refused(&done.stderr)) {
        eprintln!("feedback: GitHub refused the label {label}; filing without it");
        args.truncate(args.len() - 2);
        out = gh_run(gh, &args, FILE_SECS);
    }
    match out {
        Ok(out) if out.status.success() => {
            let filed = last_url(&out.stdout)
                .and_then(|url| Some((url.rsplit('/').next()?.parse::<u64>().ok()?, url)));
            match filed {
                Some((number, url)) => json!({"outcome": "filed", "number": number, "url": url}),
                None => json!({"outcome": "failed", "reason": "gh filed it but didn't say where"}),
            }
        }
        Ok(out) => refused(&out),
        Err(why) => json!({"outcome": "failed", "reason": format!("gh couldn't run: {why}")}),
    }
}

/// Whether `gh` failed on the label alone (missing, or the user may not set it).
fn label_refused(stderr: &[u8]) -> bool {
    let stderr = String::from_utf8_lossy(stderr).to_lowercase();
    stderr.contains("label")
        && ["not found", "could not add", "does not have permission"]
            .iter()
            .any(|w| stderr.contains(w))
}

/// The last link `gh` printed: what it filed.
fn last_url(stdout: &[u8]) -> Option<String> {
    (String::from_utf8_lossy(stdout).lines().rev())
        .map(str::trim)
        .find(|line| line.starts_with("https://"))
        .map(str::to_owned)
}

fn refused(out: &Output) -> Value {
    let stderr = String::from_utf8_lossy(&out.stderr);
    let line = (stderr.lines().map(str::trim))
        .find(|l| !l.is_empty())
        .unwrap_or("it failed");
    json!({"outcome": "failed", "reason": format!("GitHub didn't take it: {line}")})
}

/// The prefilled new-issue page for `note`, a bug's, with the versions: the old app's fallback when
/// no writer could run. Past [`MAX_URL`], the most of the note that fits, by whole characters.
fn page(data: &Path, note: &str) -> String {
    let (_, details) = details(data);
    let details = details.join(", ");
    let whole = link(note, &details);
    if whole.len() <= MAX_URL {
        return whole;
    }
    let chars: Vec<char> = note.chars().collect();
    let cut = |n: usize| format!("{}…", chars[..n].iter().collect::<String>().trim_end());
    let (mut fits, mut over) = (0, chars.len());
    while over - fits > 1 {
        let middle = (fits + over) / 2;
        match link(&cut(middle), &details).len() <= MAX_URL {
            true => fits = middle,
            false => over = middle,
        }
    }
    link(&cut(fits), &details)
}

/// The note's first line, its spaces collapsed, cut to a title's length.
fn title(note: &str) -> String {
    let line = note.lines().find(|l| !l.trim().is_empty()).unwrap_or("");
    let line = line.split_whitespace().collect::<Vec<_>>().join(" ");
    let cut: String = line.chars().take(MAX_TITLE - 1).collect();
    match line.chars().count() <= MAX_TITLE {
        true => line,
        false => format!("{}…", cut.trim_end()),
    }
}

fn link(note: &str, details: &str) -> String {
    let title = format!("[Bug]: {}", title(note));
    let body = format!("{note}\n\n{details}");
    let repo = fb::REPO;
    let (title, body) = (encode(&title), encode(&body));
    format!("https://github.com/{repo}/issues/new?title={title}&body={body}")
}

/// This app's version, and what goes with feedback: "Brigadier 0.1.0 (build 2100)", "macOS 27.0
/// (arm64)", then each agent CLI found, by its last check.
fn details(data: &Path) -> (String, Vec<String>) {
    let version = match brigadier_frames::wire::build() {
        0 => env!("CARGO_PKG_VERSION").to_string(),
        b => format!("{} (build {b})", env!("CARGO_PKG_VERSION")),
    };
    let mut out = vec![format!("Brigadier {version}")];
    let chip = match std::env::consts::ARCH {
        "aarch64" => "arm64",
        arch => arch,
    };
    let macos = Command::new("sw_vers").arg("-productVersion").output();
    if let Ok(v) = macos.map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()) {
        out.push(format!("macOS {v} ({chip})"));
    }
    // Windows' `ver` says "Microsoft Windows [Version 10.0.26100.4061]".
    #[cfg(windows)]
    if let Ok(o) = Command::new("cmd").args(["/c", "ver"]).output()
        && let Some(v) = String::from_utf8_lossy(&o.stdout).split("Version ").nth(1)
    {
        out.push(format!("Windows {} ({chip})", v.trim().trim_matches(']')));
    }
    let release = fs::read_to_string("/etc/os-release").unwrap_or_default();
    if let Some(name) = release.lines().find_map(|l| l.strip_prefix("PRETTY_NAME=")) {
        out.push(format!("{} ({chip})", name.trim_matches('"')));
    }
    for a in adapters::all() {
        let checks = fs::read(data.join("agents").join(format!("{}.json", a.name())));
        let checks: Value = serde_json::from_slice(&checks.unwrap_or_default()).unwrap_or_default();
        let version = (checks.as_object().into_iter().flat_map(|m| m.values()))
            .find_map(|c| c["version"].as_str().filter(|v| !v.is_empty()));
        // The number alone: CLIs say "2.1.0 (Claude Code)" or "codex-cli 0.50.0".
        let number = |w: &&str| w.starts_with(|c: char| c.is_ascii_digit());
        let version = version.map(|v| v.split_whitespace().find(number).unwrap_or(v));
        if let Some(v) = version {
            out.push(format!("{} {v}", a.label()));
        }
    }
    (version, out)
}

/// A query value, percent-encoded but for URL-safe characters.
fn encode(text: &str) -> String {
    (text.bytes())
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}
