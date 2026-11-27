//! The allowlist's rows that start or fork an agent, attach files, read a checkout's diffs or set
//! a session's model (remote design §4.1, with msgs/w40-outline.md §R2's `source` rows)
//! [beat-competitors D51]. A start, a side session and a creating fork each need a fresh
//! signature (§4.2); an image outside the project is power (e).

use super::allow::{
    Ctx, Fail, Flags, REFUSED, draft_target, has_files, json_of, number, parts, plain, words,
};
use super::fresh::{self, Need};
use brigadier_core::git::{self, Target};
use std::path::{Component, Path};

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
            f.get("--base").map(reference).transpose()?;
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
                "--latest" if n == 3 => *need = fresh::signed(args),
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
                    f.get("--in").map(super::allow::ids).transpose()?;
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
                    let found = git::checkout(cx.data, &Target::Session(owner))
                        .and_then(|c| git::inside(&c, path.trim_start_matches("./")));
                    if !found.is_ok_and(|at| at.is_file()) {
                        let real = std::fs::canonicalize(path).map_err(|_| REFUSED)?;
                        if real != Path::new(path) {
                            return Err(REFUSED);
                        }
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
