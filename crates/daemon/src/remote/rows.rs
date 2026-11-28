//! The allowlist's rows that start or fork an agent, attach files, read a checkout's diffs or a
//! project's branches, set a session's model, or archive, restore, pin, rename or delete a
//! session, as the desktop's sidebar sends them (remote design §4.1, with msgs/w40-outline.md
//! §R2's `source` rows) [beat-competitors D51]. A start, a side session, a creating fork and a
//! delete (it removes a worktree) each need a fresh signature (§4.2); an image outside the project
//! is power (e).

use super::allow::{
    Ctx, Fail, Flags, REFUSED, draft_target, has_files, ids, json_of, number, parts, plain, words,
};
use super::fresh::{self, Need};
use super::{devices, powers};
use brigadier_core::git::{self, Target};
use brigadier_core::{projects, worktrees};
use std::path::{Component, Path, PathBuf};

/// Power (e)'s image named other than as its resolved path; the answer carries that path.
pub(super) const NOT_CANONICAL: &str = "not_canonical";

/// `MAX_BYTES` (`crates/core/src/message.rs`): the most one file may be, as base64.
const MAX_B64: usize = (10 << 20) / 3 * 4 + 4;

/// A branch or ref name: what git allows, never a flag or a way up.
fn reference(r: &str) -> Result<(), Fail> {
    let ok = |c: char| c.is_ascii_alphanumeric() || "._/-".contains(c);
    (!r.is_empty() && !r.starts_with('-') && !r.contains("..") && r.chars().all(ok))
        .then_some(())
        .ok_or(REFUSED)
}

/// A path inside a checkout, as its repository names it: relative, never going up.
fn inside(path: &str) -> Result<(), Fail> {
    let p = Path::new(path);
    let down = p
        .components()
        .all(|c| matches!(c, Component::Normal(_) | Component::CurDir));
    (!path.is_empty() && !path.starts_with('~') && !path.starts_with("--") && down)
        .then_some(())
        .ok_or(REFUSED)
}

/// Power (e)'s image: an absolute path, as the CLI takes it (`attach::named`), its switch on, and
/// never in the data folder but for the session's own checkout: the Mac's drafts, the devices'
/// records and its pairing keys are there. One that isn't its own resolved form is answered with
/// that form, which the phone can't work out, to show and sign; the answer grants nothing.
fn outside(cx: &Ctx, path: &str, own: Option<PathBuf>) -> Result<(), Fail> {
    if !path.starts_with('/') {
        return Err(REFUSED);
    }
    let device = devices::find(cx.data, cx.device).ok_or(REFUSED)?;
    if !powers::on(&device, "paths") {
        return Err(fresh::OFF);
    }
    let real = std::fs::canonicalize(path).map_err(|_| REFUSED)?;
    let data = std::fs::canonicalize(cx.data).map_err(|_| REFUSED)?;
    if real.starts_with(&data) && !own.is_some_and(|c| real.starts_with(c)) {
        return Err(REFUSED);
    }
    if real != Path::new(path) {
        cx.resolved.set(Some(real.to_str().ok_or(REFUSED)?.into()));
        return Err(NOT_CANONICAL);
    }
    Ok(())
}

/// A known project's local branches, read as `projects branches` reads them.
fn branches(cx: &Ctx, p: &str) -> Result<serde_json::Value, Fail> {
    cx.project(p)?;
    let folder = projects::get(cx.data, p).map_err(|_| REFUSED)?.folder;
    worktrees::branches(cx.data, Path::new(&folder)).map_err(|_| REFUSED)
}

/// A kept start as Home's book holds it (`--home <draft>`, its draft not): as the phone sends one,
/// the adopt's `--draft` its own, for the start row to check.
pub(super) fn booked(
    mut op: Vec<String>,
    home: &str,
    draft: Option<&str>,
) -> Result<Vec<String>, Fail> {
    let at = (op.iter().skip(2).position(|x| x == "--home")).ok_or(REFUSED)? + 2;
    if op.get(at + 1).map(String::as_str) != Some(home) {
        return Err(REFUSED);
    }
    op.drain(at..at + 2);
    op.extend(["--draft".into(), draft.ok_or(REFUSED)?.into()]);
    Ok(op)
}

pub(super) fn row(
    cx: &Ctx,
    args: &[String],
    need: &mut Option<Need>,
    slot: &mut bool,
) -> Result<(), Fail> {
    let a = |i: usize| args.get(i).map(String::as_str).ok_or(REFUSED);
    let n = args.len();
    let rest = |from: usize| args.get(from..).unwrap_or(&[]);
    match a(0)? {
        // Start in a project: the daemon picks the worktree and the project's level; the phone's
        // draft is its own Home book (`--slot`, lane D), which needs `--draft` and `--cid`.
        "start" => {
            plain(a(1)?)?;
            let f = Flags::parse(rest(2), &START)?;
            cx.project(f.get("--project").ok_or(REFUSED)?)?;
            plain(f.get("--cid").ok_or(REFUSED)?)?;
            json_of(f.get("--draft").ok_or(REFUSED)?)?;
            f.get("--draft-rev").map(number).transpose()?;
            words(f.get("--text").unwrap_or(""))?;
            f.get("--backend").map(plain).transpose()?;
            f.get("--model").map(reference).transpose()?;
            f.get("--effort").map(plain).transpose()?;
            // A plain ref (never an option, whatever git lets a branch be called) that the
            // project's own branch list holds, as the desktop's pick offers.
            if let Some(b) = f.get("--base") {
                reference(b)?;
                let repo = branches(cx, f.get("--project").ok_or(REFUSED)?)?;
                if !repo["branches"]
                    .as_array()
                    .is_some_and(|l| l.iter().any(|x| x == b))
                {
                    return Err(REFUSED);
                }
            }
            f.get("--parts").map(|p| parts(cx, None, p)).transpose()?;
            (*need, *slot) = (fresh::signed(args), true);
        }
        // Send as a new session; the replay form only on the user's tap. No slot: no files.
        "side" => {
            cx.visible(a(1)?)?;
            plain(a(2)?)?;
            if n > 3 {
                let f = Flags::parse(rest(3), &SIDE)?;
                words(f.get("--text").ok_or(REFUSED)?)?;
                plain(f.get("--cid").ok_or(REFUSED)?)?;
                f.get("--qid").map(plain).transpose()?;
                if let Some(p) = f.get("--parts") {
                    parts(cx, Some(a(1)?), p)?;
                    if has_files(p)? {
                        return Err(REFUSED);
                    }
                }
            }
            *need = fresh::signed(args);
        }
        "fork" => {
            cx.visible(a(1)?)?;
            match a(2)? {
                "--check" if n == 4 => plain(a(3)?)?,
                // `--check` on the latest answer, a read too [beat-competitors D87].
                "--latest" if n == 3 => {}
                new => {
                    plain(new)?;
                    let f = Flags::parse(rest(3), &FORK)?;
                    plain(f.get("--at").ok_or(REFUSED)?)?;
                    let place = f.get("--where").unwrap_or("worktree");
                    if !matches!(place, "worktree" | "chat") {
                        return Err(REFUSED);
                    }
                    f.get("--fingerprint").map(plain).transpose()?;
                    match (f.get("--to"), f.get("--model")) {
                        (Some(b), Some(m)) => {
                            plain(b)?;
                            reference(m)?;
                        }
                        (None, None) if !f.has("--effort") && !f.has("--fast") => {}
                        _ => return Err(REFUSED),
                    }
                    f.get("--effort").map(plain).transpose()?;
                    *need = fresh::signed(args);
                }
            }
        }
        "attach" => {
            // Home's files are the device's for every project: the CLI takes only bare `@home`.
            let owner = a(1)?;
            if owner.starts_with("@home:") {
                return Err(REFUSED);
            }
            draft_target(cx, owner)?;
            match (a(2)?, n) {
                ("add", _) => {
                    plain(a(3)?)?;
                    let name = a(4)?;
                    if name.contains('/') || name.starts_with('.') {
                        return Err(REFUSED);
                    }
                    words(name)?;
                    let f = Flags::parse(
                        rest(5),
                        &[("--backend", true), ("--in", true), ("--data", true)],
                    )?;
                    f.get("--backend").map(plain).transpose()?;
                    f.get("--in").map(ids).transpose()?;
                    let data = f.get("--data").ok_or(REFUSED)?;
                    if data.len() > MAX_B64 || data.starts_with("--") {
                        return Err(REFUSED);
                    }
                    *slot = true;
                }
                ("remove", 4) => {
                    plain(a(3)?)?;
                    *slot = true;
                }
                ("list", 3) => *slot = true,
                // An image in a reply: a file inside the checkout, links followed, as the CLI
                // finds it first; anything else only as its own canonical path, signed once
                // (power (e), step 1), so the CLI's search by name never reaches past it.
                ("view", 4) if !owner.starts_with('@') => {
                    let path = a(3)?;
                    let checkout = git::checkout(cx.data, &Target::Session(owner)).ok();
                    let found = (checkout.as_ref())
                        .and_then(|c| git::inside(c, path.trim_start_matches("./")).ok());
                    // The CLI reads `~/…` as the home folder before the checkout (`attach::named`).
                    if path.starts_with("~/") || !found.is_some_and(|at| at.is_file()) {
                        outside(cx, path, checkout.map(|c| c.root))?;
                        *need = fresh::power("paths", args);
                    }
                }
                _ => return Err(REFUSED),
            }
        }
        // Diffs, read only: a visible session or one of its repositories, never `--project`.
        "source" => {
            let target = a(1)?;
            // `<id>@<repo>`, as the CLI's `Target::session` splits it.
            let (session, repo) = target.split_once('@').unwrap_or((target, "x"));
            plain(repo)?;
            cx.visible(session)?;
            match (a(2)?, n) {
                ("status" | "truth" | "since", 3) => {}
                ("review", 4) => reference(a(3)?)?,
                ("review-file", 5 | 6) if a(3)? != "last" => {
                    reference(a(3)?)?;
                    inside(a(4)?)?;
                    args.get(5).map(|r| reference(r)).transpose()?;
                }
                ("review-file", 7 | 8) if a(3)? == "last" => {
                    reference(a(4)?)?;
                    reference(a(5)?)?;
                    inside(a(6)?)?;
                    args.get(7).map(|r| reference(r)).transpose()?;
                }
                _ => return Err(REFUSED),
            }
        }
        // A session's own agent; the CLI checks the model and effort against the agent's list.
        "set" => {
            let row = cx.visible(a(1)?)?;
            let f = Flags::parse(rest(2), &SET)?;
            plain(f.get("--op").ok_or(REFUSED)?)?;
            if f.has("--now") {
                if f.found_len() != 2 {
                    return Err(REFUSED);
                }
            } else {
                let agent = f.get("--agent").ok_or(REFUSED)?;
                if row["backend"] != agent {
                    return Err(REFUSED);
                }
                reference(f.get("--model").ok_or(REFUSED)?)?;
                f.get("--effort").map(plain).transpose()?;
            }
        }
        // The new chat's branch pick, read only, as the desktop's `projects branches` answers.
        "projects" if n == 3 && a(1)? == "branches" => cx.project(a(2)?)?,
        // The sidebar's own marks on one visible session (`sidebar/actions.ts`); archive's
        // `--named` workers only narrow which of its finished workers lose their ignored files.
        "pin" if n == 2 || n == 3 && a(2)? == "--off" => drop(cx.visible(a(1)?)?),
        "restore" if n == 2 => drop(cx.visible(a(1)?)?),
        "archive" if n == 3 => {
            cx.visible(a(1)?)?;
            match a(2)?.strip_prefix("--named=") {
                Some("") => {}
                Some(named) => ids(named)?,
                None if a(2)? == "--check" => {}
                None => return Err(REFUSED),
            }
        }
        // Rust picks the branch's new name itself; `--branch` only pins the preview's (`-`: none).
        "rename" if n <= 5 => {
            cx.visible(a(1)?)?;
            words(a(2)?)?;
            match (args.get(3).map(String::as_str), args.get(4)) {
                (None, None) | (Some("--preview"), None) => {}
                (Some("--branch"), Some(b)) if b == "-" => {}
                (Some("--branch"), Some(b)) => reference(b)?,
                _ => return Err(REFUSED),
            }
        }
        // Delete's confirm reads whose workers it stops; the delete itself keeps the branch, as
        // the desktop's, and is signed afresh.
        "delete" if n == 3 && a(2)? == "--check" => drop(cx.visible(a(1)?)?),
        "delete" if n == 4 && a(2)? == "--branch" && a(3)? == "keep" => {
            cx.visible(a(1)?)?;
            *need = fresh::signed(args);
        }
        // An instant command the agent lists: the CLI refuses any other name.
        "command" if n == 3 => {
            cx.visible(a(1)?)?;
            plain(a(2)?)?;
        }
        _ => return Err(REFUSED),
    }
    Ok(())
}

const START: [(&str, bool); 11] = [
    ("--project", true),
    ("--text", true),
    ("--cid", true),
    ("--backend", true),
    ("--model", true),
    ("--effort", true),
    ("--parts", true),
    ("--fast", false),
    ("--base", true),
    ("--draft", true),
    ("--draft-rev", true),
];
const SIDE: [(&str, bool); 4] = [
    ("--text", true),
    ("--cid", true),
    ("--qid", true),
    ("--parts", true),
];
const FORK: [(&str, bool); 7] = [
    ("--at", true),
    ("--where", true),
    ("--fingerprint", true),
    ("--to", true),
    ("--model", true),
    ("--effort", true),
    ("--fast", false),
];
const SET: [(&str, bool); 6] = [
    ("--agent", true),
    ("--model", true),
    ("--effort", true),
    ("--fast", false),
    ("--op", true),
    ("--now", false),
];
