//! What a worker is told after its brief: how its work lands and the fixed line [D3000, D3023].

use brigadier_core as core;
use std::path::Path;

/// How a worker lands its work: reviewed first [D385], merged into `base` in `to` with plain git
/// [D97], changed in `folder` directly with no project (proposed, C70), or kept on its branch; a
/// commit and merge only if it changed files [D311]. Committed work may ask for its review [D46].
pub(crate) fn land_line(
    merge: Option<(&str, &str, &str)>,
    review: bool,
    folder: Option<(&str, &str)>,
) -> String {
    match (merge, folder) {
        _ if review => super::review::FINDINGS.into(),
        (None, Some((dir, of))) => {
            format!(
                "Your work goes to {}, the folder of {of}; nothing in your own folder reaches it. If your task changes files, change them there directly, and never commit, branch or switch anything there.",
                sh(dir)
            )
        }
        (Some((to, branch, base)), _) => {
            let (dir, b) = (sh(to), sh(branch));
            format!(
                "If you changed files, commit them on your branch when your work is done and right, then merge it into {base}: `git -C {dir} merge --no-edit {b}`. If that conflicts, run `git -C {dir} merge --abort` at once, rebase your branch onto {base}, resolve there, then merge again; never leave {to} mid-merge, and never touch its uncommitted changes. If it can't merge, say why. If you committed nothing, don't merge. {ASK}"
            )
        }
        (None, None) => {
            format!("If you changed files, commit them on your branch and don't merge it. {ASK}")
        }
    }
}

/// The author's ask: it may add a review, never waive one [beat-competitors D46].
const ASK: &str = "If your work needs a review its files may not show, end your last message with the line `Review: wanted — <why>`.";

/// `s` as one shell word: as is when plain, else single-quoted ("Application Support") [D309].
pub(super) fn sh(s: &str) -> String {
    let plain = |c: char| c.is_ascii_alphanumeric() || "_./:@%+=,-".contains(c);
    match !s.is_empty() && s.chars().all(plain) {
        true => s.into(),
        false => format!("'{}'", s.replace('\'', "'\\''")),
    }
}

/// Proposed: the line every worker gets after its brief [D3000, D3023]; `land`, how its work
/// lands (`land_line`). `root`: the family's first session, where the user's own words are,
/// however deep it is.
pub(super) fn fixed_line(parent: &str, pid: &str, root: &str, land: &str) -> String {
    format!(
        "You're a worker for {parent} ({pid}). When you end your turn, your last message goes back to it by itself, so end with what you did and found. To ask it something, `brigadier send {pid} \"<question>\"` and wait for its answer there; don't end your turn on a question. {land} `brigadier read {root} --user` has the user's own words. What you leave running ends when you finish. Your CLI loads no skills of its own, and no MCP servers but any only it can sign in to: `brigadier skill`, `brigadier mcp` and `brigadier search` (past sessions) bring what you need."
    )
}

/// A no-project family's folder for edits and its name: its first session's, however deep the
/// worker is, since a worker's project is its parent's (proposed, C70).
pub(crate) fn edits(data: &Path, root: &str) -> Option<(String, String)> {
    core::load(data, root)
        .ok()
        .map(|s| (s.cwd.clone(), core::share::title(&s)))
}
