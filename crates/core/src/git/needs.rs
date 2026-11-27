//! Whether a worker's new commits need an adversarial review, from the commits [beat-competitors
//! D35, D46, D56; review-design rev 2 §3 A]. Docs, lockfiles and generated files leave first, for
//! every trigger alike; what's left is reviewed when it touches risky files, is large, took many
//! commits, or its last check failed; its author may ask, never waive. What none of these decide
//! goes to a quick look by a small model (`Need::Look`): no list of path words [D52, D59].

use super::listed::listed;
use super::risk::{LOCKS, flag, is_test};
use crate::fold::runs::Run;
use serde_json::Value;
use std::collections::HashSet;
use std::process::Command;

/// How its HEAD log names a commit the worktree made itself.
const OWN: &[&str] = &[
    "commit",
    "rebase (pick)",
    "rebase (reword)",
    "rebase (edit)",
    "rebase (squash)",
    "rebase (fixup)",
    "rebase (continue)",
    "cherry-pick",
    "revert",
    "am",
];
const DOCS: &[&str] = &[".md", ".mdx", ".rst", ".txt", ".adoc"];
/// More changed lines than this in counted files outside tests, or files, is large.
const LINES: u64 = 150;
const FILES: usize = 10;
/// This many counted commits or more is many tries.
const COMMITS: usize = 4;

/// One repository's commits `base..head` in `dir`: each file with its status and counts, as
/// Review's list reads them, and each commit's paths; `repo` names it where there are several.
pub struct Span {
    pub repo: String,
    pub files: Vec<Value>,
    pub commits: Vec<Vec<String>>,
    /// Its own commits, oldest first.
    pub own: Vec<String>,
    dir: String,
}

/// What rule A makes of a change: a review and why, a skip and why, or neither, with its size.
pub enum Need {
    Review(String),
    Skip(String),
    Look(String),
}

fn git(dir: &str, args: &[&str], input: Vec<u8>) -> Option<Vec<u8>> {
    use std::io::Write;
    use std::process::Stdio;
    let mut child = (Command::new("git").arg("-C").arg(dir).args(args))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .ok()?;
    // Written beside the read, so a long list never fills both pipes.
    let mut stdin = child.stdin.take()?;
    let writer = std::thread::spawn(move || stdin.write_all(&input));
    let out = child.wait_with_output().ok()?;
    let _ = writer.join();
    out.status.success().then_some(out.stdout)
}

/// Reads a span, NUL-delimited throughout so any file name matches; None where git can't.
pub fn span(repo: &str, dir: &str, base: &str, head: &str) -> Option<Span> {
    let range = format!("{base}..{head}");
    // Its own commits: made in this worktree, as its HEAD log says, never its parent's that a rebase
    // or fast-forward brought in. With no log, every commit of the range.
    let log = git(dir, &["reflog", "--format=%H %gs", "HEAD"], vec![]).unwrap_or_default();
    let log = String::from_utf8_lossy(&log).into_owned();
    let made: HashSet<&str> = (log.lines())
        .filter_map(|l| l.split_once(' '))
        .filter(|(_, how)| OWN.iter().any(|o| how.starts_with(o)))
        .map(|(h, _)| h)
        .collect();
    let all = git(dir, &["rev-list", "--no-merges", &range], vec![])?;
    let all = String::from_utf8_lossy(&all).into_owned();
    let all: Vec<&str> = all.lines().collect();
    let own: Vec<&str> = match made.is_empty() {
        true => all.clone(),
        false => all.iter().copied().filter(|c| made.contains(c)).collect(),
    };
    let mut files: Vec<Value> = if own.len() == all.len() {
        let names = git(dir, &["diff", "-M", "--name-status", "-z", &range], vec![])?;
        let counts = git(dir, &["diff", "-M", "--numstat", "-z", &range], vec![])?;
        listed(&names, &counts, false).into_values().collect()
    } else {
        // Each of its own commits, oldest first, summed by file.
        let mut by: std::collections::BTreeMap<String, Value> = Default::default();
        for c in own.iter().rev() {
            let show = |k: &str| git(dir, &["show", "--format=", "-M", k, "-z", c], vec![]);
            for (path, f) in listed(&show("--name-status")?, &show("--numstat")?, false) {
                let Some(e) = by.get_mut(&path) else {
                    by.insert(path, f);
                    continue;
                };
                for k in ["insertions", "deletions"] {
                    e[k] = (e[k].as_u64().unwrap_or(0) + f[k].as_u64().unwrap_or(0)).into();
                }
                e["status"] = f["status"].clone();
            }
        }
        by.into_values().collect()
    };
    let paths: Vec<u8> = (files.iter())
        .flat_map(|f| [f["path"].as_str().unwrap_or("").as_bytes(), b"\0"].concat())
        .collect();
    // `path\0linguist-generated\0value\0` for each.
    let attrs = git(
        dir,
        &["check-attr", "-z", "linguist-generated", "--stdin"],
        paths,
    )?;
    let attrs = String::from_utf8_lossy(&attrs).into_owned();
    let parts: Vec<&str> = attrs.split('\0').collect();
    let generated: HashSet<&str> = (parts.chunks(3))
        .filter(|t| t.len() == 3 && matches!(t[2], "set" | "true"))
        .map(|t| t[0])
        .collect();
    for f in &mut files {
        f["generated"] = generated.contains(f["path"].as_str().unwrap_or("")).into();
    }
    let log = git(
        dir,
        &[
            "log",
            "-z",
            "--no-merges",
            "--format=%x01%H",
            "--name-only",
            &range,
        ],
        vec![],
    )?;
    let log = String::from_utf8_lossy(&log).into_owned();
    let commits = (log.split('\u{1}').skip(1))
        .filter(|c| own.iter().any(|o| c.starts_with(o)))
        .map(|c| {
            (c.split('\0').skip(1))
                .map(|p| p.trim_start_matches('\n'))
                .filter(|p| !p.is_empty())
                .map(String::from)
                .collect()
        })
        .collect();
    Some(Span {
        repo: repo.into(),
        files,
        commits,
        own: own.iter().rev().map(|c| c.to_string()).collect(),
        dir: dir.into(),
    })
}

/// Left out before any trigger: lockfiles, generated files and docs; a file risk.rs flags as build
/// or a manifest is never a doc, whatever its extension [beat-competitors D46, D48].
fn excluded(f: &Value) -> bool {
    let lower = f["path"].as_str().unwrap_or("").to_lowercase();
    let name = lower.rsplit('/').next().unwrap_or(&lower);
    let kind = flag(f).map(|k| k["kind"].clone());
    let built = kind.is_some_and(|k| k == "build" || k == "manifest");
    let doc = DOCS.iter().any(|e| name.ends_with(e))
        || lower.starts_with("docs/")
        || lower.contains("/docs/");
    LOCKS.contains(&name) || f["generated"] == true || (doc && !built)
}

/// A test by its path alone, whatever its counts.
fn test(path: &str) -> bool {
    let lower = path.to_lowercase();
    is_test(&lower, lower.rsplit('/').next().unwrap_or(&lower))
}

fn lines(f: &Value) -> u64 {
    f["insertions"].as_u64().unwrap_or(0) + f["deletions"].as_u64().unwrap_or(0)
}

fn plural(n: u64, one: &str) -> String {
    format!("{n} {one}{}", if n == 1 { "" } else { "s" })
}

/// Whether it needs a review, and why, in the result's words. `asked`: the author's last message;
/// `run`: the fold's last recognised check.
pub fn needs(spans: &[Span], run: Option<&Run>, asked: Option<&str>) -> Need {
    let shown = |s: &Span, f: &Value| match s.repo.as_str() {
        "" => format!("`{}`", f["path"].as_str().unwrap_or("")),
        r => format!("`{r}/{}`", f["path"].as_str().unwrap_or("")),
    };
    // Its author's ask, the last line of its last message: holds even with nothing counted.
    let last = asked.and_then(|m| m.lines().rev().map(str::trim).find(|l| !l.is_empty()));
    if let Some(why) = last.and_then(|l| l.strip_prefix("Review: wanted")) {
        let why = why.trim_start_matches([' ', '—', '–', '-', ':']).trim();
        return Need::Review(match why {
            "" => "its author asked for one".into(),
            why => format!("its author asked: {why}"),
        });
    }
    if spans.iter().all(|s| s.commits.is_empty()) {
        return Need::Skip("nothing of its own since its last one".into());
    }
    let counted: Vec<(&Span, &Value)> = (spans.iter())
        .flat_map(|s| counted(s).into_iter().map(move |f| (s, f)))
        .collect();
    if counted.is_empty() {
        return Need::Skip("docs, lockfiles or generated files only".into());
    }
    for (s, f) in &counted {
        let ins = f["insertions"].as_u64().unwrap_or(0);
        let del = f["deletions"].as_u64().unwrap_or(0);
        let deleted = f["status"] == "deleted";
        match flag(f).as_ref().and_then(|k| k["kind"].as_str()) {
            Some("build" | "manifest" | "migration") => {
                return Need::Review(format!("it changes {}", shown(s, f)));
            }
            Some("test") if deleted => return Need::Review(format!("it deletes {}", shown(s, f))),
            Some("test") if del > ins => {
                return Need::Review(format!("it shrinks {}", shown(s, f)));
            }
            _ => {}
        }
        // A rename's source counts as its own: a test moved out of the tests, a manifest moved away.
        let Some(from) = f["from"].as_str() else {
            continue;
        };
        let was = serde_json::json!({"path": from, "status": "renamed"});
        if test(from) && !test(f["path"].as_str().unwrap_or("")) {
            return Need::Review(format!("it moves {} out of the tests", shown(s, &was)));
        }
        if flag(&was).is_some_and(|k| k["kind"] != "test" && k["kind"] != "lock") {
            return Need::Review(format!("it changes {}", shown(s, &was)));
        }
    }
    let code: u64 = (counted.iter())
        .filter(|(_, f)| !test(f["path"].as_str().unwrap_or("")))
        .map(|(_, f)| lines(f))
        .sum();
    if code > LINES {
        return Need::Review(format!("it changes {code} lines"));
    }
    if counted.len() > FILES {
        return Need::Review(format!("it changes {} files", counted.len()));
    }
    // Each repository's commits against its own counted files.
    let mine =
        |s: &Span, p: &str| (counted.iter()).any(|(c, f)| std::ptr::eq(*c, s) && f["path"] == p);
    let commits = (spans.iter())
        .flat_map(|s| s.commits.iter().map(move |c| (s, c)))
        .filter(|(s, c)| c.iter().any(|p| mine(s, p)))
        .count();
    let paths: Vec<&str> = (counted.iter())
        .filter_map(|(_, f)| f["path"].as_str())
        .collect();
    if commits >= COMMITS {
        return Need::Review(format!("it took {commits} commits"));
    }
    if let Some(run) = run {
        if run.exit.is_some_and(|e| e != 0) {
            return Need::Review(format!("its last check failed (`{}`)", run.command));
        }
        let later = |a: &String| {
            let a = a.trim_start_matches("./");
            paths
                .iter()
                .any(|p| a == *p || a.ends_with(&format!("/{p}")))
        };
        if run.after.iter().any(later) {
            return Need::Review("it changed files after its last check".into());
        }
    }
    let all: u64 = counted.iter().map(|(_, f)| lines(f)).sum();
    Need::Look(format!(
        "{} in {}",
        plural(all, "line"),
        plural(counted.len() as u64, "file")
    ))
}

/// Its files that count: all but docs, lockfiles and generated files.
pub fn counted(s: &Span) -> Vec<&Value> {
    s.files.iter().filter(|f| !excluded(f)).collect()
}

/// Its own commits' patches to its counted files, oldest first, as a quick look reads them; None
/// where git can't, a file shows no patch of its own (binary, mode only), or it's over `most`
/// bytes: never cut, so a "no" is only ever about the whole change.
pub fn diff(s: &Span, most: usize) -> Option<String> {
    let paths: Vec<&str> = (counted(s).iter())
        .flat_map(|f| [&f["path"], &f["from"]])
        .filter_map(|p| p.as_str())
        .collect();
    if counted(s).iter().any(|f| f["binary"] == true) {
        return None;
    }
    // None of its files count: an empty pathspec would show them all.
    if paths.is_empty() {
        return Some(String::new());
    }
    let mut out = String::new();
    for c in &s.own {
        let mut args = vec!["--literal-pathspecs", "show", "--format=commit %H", "-M"];
        args.extend(["--no-ext-diff", "--no-textconv", "--no-color", c, "--"]);
        args.extend(&paths);
        out += &String::from_utf8(git(&s.dir, &args, vec![])?).ok()?;
        if out.len() > most {
            return None;
        }
    }
    // Every counted file has a hunk of its own, or a rename's header, or it wasn't seen whole.
    let shown = |p: &str| {
        let p = format!(" b/{p}\n");
        out.contains(&format!("+++{p}")) || out.contains(&format!("rename to {}", &p[3..]))
    };
    let whole = counted(s).iter().all(|f| {
        let p = f["path"].as_str().unwrap_or("");
        match f["status"] == "deleted" {
            true => out.contains(&format!("--- a/{p}\n")),
            false => shown(p),
        }
    });
    whole.then_some(out)
}
