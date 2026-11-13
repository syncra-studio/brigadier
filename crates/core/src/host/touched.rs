//! Which PRs the session's own commands looked at, from its saved rows [D175, D213].

use super::Repo;
use super::prs::Key;
use serde_json::Value;
use std::fs;
use std::path::Path;

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

/// The PRs the session's own commands looked at in detail, in any repository on `repo`'s server
/// [D175, D213]: a `pr <verb>` naming one by number or URL (its repository from `--repo`, else the
/// session's), an API call on `repos/<owner>/<name>/pulls/<n>`, and the URL a `pr create` printed;
/// each with its `owner/name` when it isn't the session's. Read from the session's saved rows, so
/// a command counts once its turn has ended.
// shortcut: gh's command shape only (no glab `mr` or MCP tools), a number only as its first
// non-option argument, and a bare number read as the session's repository's even after a `cd`
// elsewhere, until a host or agent is seen doing it another way.
pub(super) fn touched(dir: &Path, repo: &Repo) -> Vec<Key> {
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
    let api = |word: &str| -> Option<Key> {
        let word = word.trim_matches(['"', '\'']);
        let at = word.find("repos/")?;
        let mut parts = word[at + "repos/".len()..].split('/');
        let (owner, name) = (parts.next()?, parts.next()?);
        if parts.next()? != "pulls" {
            return None;
        }
        let n = parts.next()?.split(['?', '#']).next()?.parse().ok()?;
        let path = match (owner, name) {
            ("{owner}", "{repo}") => repo.path.clone(),
            _ => format!("{owner}/{name}"),
        };
        Some((on(&path)?, n))
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
        for part in input.split(['\n', ';', '&', '|']) {
            let words: Vec<&str> = part.split_whitespace().collect();
            if words.contains(&"api") {
                found.extend(words.iter().filter_map(|w| api(w)));
            }
            let Some(at) = (words.windows(2)).position(|w| w[0] == "pr" && DETAIL.contains(&w[1]))
            else {
                continue;
            };
            let (mut rest, mut first, mut there) = (words[at + 2..].iter(), None, Some(None));
            while let Some(w) = rest.next() {
                match *w {
                    "-R" | "--repo" => there = rest.next().and_then(|r| on(r)),
                    w if w.starts_with("--repo=") => there = on(&w["--repo=".len()..]),
                    w if w.starts_with('-') => {}
                    w => first = first.or(Some(w)),
                }
            }
            // A repository on another server: not one this read can reach.
            let Some(there) = there else {
                continue;
            };
            if let Some(w) = first {
                let n = w
                    .trim_matches(['"', '\''])
                    .trim_start_matches('#')
                    .parse()
                    .ok();
                found.extend(n.map(|n| (there.clone(), n)));
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
