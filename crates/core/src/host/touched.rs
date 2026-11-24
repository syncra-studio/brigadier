//! Which PRs the session's own commands looked at, from its saved rows [D175, D213].

use super::Repo;
use super::prs::Key;
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};

/// What a host CLI's `pr` command does that looks at one PR in detail, making it one the session
/// touched [D175, D213]; `list`, `status` and `gh search prs` list many and never add one.
const DETAIL: [&str; 15] = [
    "view",
    "diff",
    "checks",
    "checkout",
    "review",
    "comment",
    "merge",
    "edit",
    "ready",
    "close",
    "reopen",
    "create",
    "update-branch",
    "lock",
    "unlock",
];

/// Where a command says it ran: in the one `cd` it starts with, its path written out in full; None
/// when it says so any other way, or may have moved on.
pub(super) fn ran_in(input: &str) -> Option<PathBuf> {
    let at = input.trim_start().strip_prefix("cd ")?.trim_start();
    let (path, rest) = match at.chars().next()? {
        quote @ ('"' | '\'') => at[1..].split_once(quote)?,
        _ => at.split_at(at.find([' ', '\t', ';', '&', '|', '\n'])?),
    };
    let rest = rest.trim_start_matches([' ', '\t']);
    let then = ["&&", ";", "\n"].iter().any(|s| rest.starts_with(s));
    let moves = (rest.split(|c: char| !c.is_alphanumeric() && !"_-./".contains(c)))
        .any(|w| ["cd", "pushd", "popd", "GH_REPO", "GH_HOST"].contains(&w));
    let path = match path.strip_prefix("~/") {
        Some(rest) => std::env::home_dir()?.join(rest),
        None => PathBuf::from(path),
    };
    (then && !moves && path.is_absolute()).then_some(path)
}

/// The PRs the session's own commands looked at in detail, in any repository on `repo`'s server
/// [D175, D213]: a `pr <verb>` naming one by number or URL (its repository from `--repo`, else the
/// session's, by `own`), an API call on `repos/<owner>/<name>/pulls/<n>`, and the URL a `pr create` printed;
/// each with its `owner/name` when it isn't the session's. Read from the session's saved rows, so
/// a command counts once its turn has ended.
// shortcut: gh's command shape only (no glab `mr` or MCP tools), a number only as its first
// non-option argument, and a single-repository session's bare number read as its repository's even
// after a `cd` elsewhere, until a host or agent is seen doing it another way.
pub(super) fn touched(
    dir: &Path,
    repo: &Repo,
    own: &dyn Fn(&str) -> Option<Option<String>>,
) -> Vec<Key> {
    let Ok(rows) = fs::read(dir.join("thread").join("rows")) else {
        return Vec::new();
    };
    // `owner/name` or `host/owner/name`: None off this server; Some(None) for the session's own.
    let on = |path: &str| -> Option<Option<String>> {
        let path = path.trim_matches(['"', '\'', '/']);
        let path = match path.split('/').collect::<Vec<_>>()[..] {
            [host, _, _] if host.eq_ignore_ascii_case(&repo.host) => path.split_once('/')?.1,
            [_, _] => path,
            _ => return None,
        };
        super::slug(path).then(|| (!path.eq_ignore_ascii_case(&repo.path)).then(|| path.into()))
    };
    let url = |word: &str| -> Option<Key> {
        let word = word.trim_matches(['"', '\'', '(', ')', '<', '>', ',', '.']);
        let rest = word.split_once("://").map_or(word, |(_, rest)| rest);
        let mut parts = rest.split('/');
        let (host, owner, name) = (parts.next()?, parts.next()?, parts.next()?);
        if !host.eq_ignore_ascii_case(&repo.host) || parts.next()? != "pull" {
            return None;
        }
        let n = parts.next()?.split(['#', '?']).next()?.parse().ok()?;
        Some((on(&format!("{owner}/{name}"))?, n))
    };
    // gh fills `{owner}/{repo}` in with the checkout's own.
    let api = |word: &str, input: &str| -> Option<Key> {
        let word = word.trim_matches(['"', '\'']);
        let at = word.find("repos/")?;
        // A whole URL names its server: `api.` before it, or after it `/api/v3`.
        if let Some((_, rest)) = word.split_once("://") {
            let host = rest.split('/').next()?;
            if ![repo.host.clone(), format!("api.{}", repo.host)]
                .iter()
                .any(|h| h.eq_ignore_ascii_case(host))
            {
                return None;
            }
        }
        let mut parts = word[at + "repos/".len()..].split('/');
        let (owner, name) = (parts.next()?, parts.next()?);
        if parts.next()? != "pulls" {
            return None;
        }
        let n = parts.next()?.split(['?', '#']).next()?.parse().ok()?;
        let there = match (owner, name) {
            ("{owner}", "{repo}") => own(input)?,
            _ => on(&format!("{owner}/{name}"))?,
        };
        Some((there, n))
    };
    let has = |line: &[u8], what: &[u8]| line.windows(what.len()).any(|w| w == what);
    let mut found = Vec::new();
    for line in rows.split(|b| *b == b'\n') {
        // Most rows aren't a command's, and most commands no PR's: those aren't parsed.
        if !has(line, b"\"step\":\"run\"") || !(has(line, b"pr ") || has(line, b"/pulls/")) {
            continue;
        }
        let Ok(row) = serde_json::from_slice::<Value>(line) else {
            continue;
        };
        let Some(input) = row["input"].as_str() else {
            continue;
        };
        // A folder chat's own only: a fork's copy of its source's thread isn't.
        if repo.path.is_empty() && row["inherited"] == true {
            continue;
        }
        // gh told to ask another server, for the whole command or just one call.
        let other = |h: &str| !h.trim_matches(['"', '\'']).eq_ignore_ascii_case(&repo.host);
        let mut words = input.split([' ', '\t', '\n', ';', '&', '|']);
        if words.any(|w| w.strip_prefix("GH_HOST=").is_some_and(other)) {
            continue;
        }
        for part in input.split(['\n', ';', '&', '|']) {
            let words: Vec<&str> = part.split_whitespace().collect();
            let hostname = (words.iter().zip(words.iter().skip(1)))
                .find_map(|(w, next)| (*w == "--hostname").then_some(*next))
                .or_else(|| words.iter().find_map(|w| w.strip_prefix("--hostname=")));
            if words.contains(&"api") && !hostname.is_some_and(other) {
                found.extend(words.iter().filter_map(|w| api(w, input)));
            }
            let Some(at) = (words.windows(2)).position(|w| w[0] == "pr" && DETAIL.contains(&w[1]))
            else {
                continue;
            };
            let (mut rest, mut first, mut there) = (words[at + 2..].iter(), None, None);
            while let Some(w) = rest.next() {
                match *w {
                    "-R" | "--repo" => there = Some(rest.next().and_then(|r| on(r))),
                    w if w.starts_with("--repo=") => there = Some(on(&w["--repo=".len()..])),
                    w if w.starts_with('-') => {}
                    w => first = first.or(Some(w)),
                }
            }
            // A repository on another server: not one this read can reach.
            if there == Some(None) {
                continue;
            }
            if let Some(w) = first {
                let w = w.trim_matches(['"', '\'']);
                if let Ok(n) = w.trim_start_matches('#').parse() {
                    let there = there.flatten().or_else(|| own(input));
                    found.extend(there.map(|there| (there, n)));
                }
                found.extend(url(w));
            }
            if words[at + 1] == "create" {
                let printed = row["output"].as_str().unwrap_or("");
                found.extend(printed.split_whitespace().filter_map(url));
            }
        }
    }
    found
}
