//! Session grants and saved rules, matched as OpenCode matches them: a grant answers the asks it
//! covers for this session only, and a rule the user saved in OpenCode never lets an Ask turn skip
//! an ask [D166, D193, D266].

use super::http::Server;
use super::server::Shared;
use serde_json::{Value, json};
use std::collections::{HashSet, VecDeque};
use std::path::{Component, Path, PathBuf};

/// A new session grant `{action, save}`. It also answers the asks already waiting that it covers,
/// as OpenCode's own lasting answer would, but only for this session [D193].
pub(super) fn grant(server: &Server, state: &Shared, g: Value) {
    let mut st = state.lock().unwrap();
    st.grants.push(g);
    let covered: Vec<Value> = (st.asked.values())
        .filter(|a| granted(&st.grants, a))
        .cloned()
        .collect();
    drop(st);
    covered.iter().for_each(|a| allow(server, a));
}

/// Why a turn can't run: the rules the user saved in OpenCode for this project ("always") that
/// would let it skip an ask the session's rules make, since OpenCode checks them after the
/// session's own [D166, D266]. Named, never changed. None when nothing would skip an ask.
pub(super) fn skipping(server: &Server, state: &Shared) -> Option<String> {
    let (session, rules) = {
        let st = state.lock().unwrap();
        (
            st.session.clone(),
            st.rules.as_array().cloned().unwrap_or_default(),
        )
    };
    if !rules.iter().any(|r| r["effect"] == "ask") {
        return None;
    }
    let get = |path: &str| -> Result<Value, String> {
        match server.request("GET", path, &Value::Null) {
            Ok((code, body)) if code < 300 => {
                serde_json::from_str(&body).map_err(|e| e.to_string())
            }
            other => Err(format!("{other:?}")),
        }
    };
    let saved = get(&format!("/api/session/{session}")).and_then(|info| {
        let project = info["data"]["projectID"].as_str().unwrap_or("").to_string();
        get(&format!("/api/permission/saved?projectID={project}"))
    });
    let saved = match saved {
        Ok(v) => v["data"].as_array().cloned().unwrap_or_default(),
        Err(e) => {
            return Some(format!(
                "Brigadier couldn't check the rules OpenCode saved for this project, so this turn doesn't start under Ask: {e}"
            ));
        }
    };
    let text = |v: &Value, k: &str| v[k].as_str().unwrap_or("").to_string();
    let named: Vec<String> = (saved.iter())
        .filter(|r| skips(&rules, &text(r, "action"), &text(r, "resource")))
        .map(|r| {
            format!(
                "{} {:?} (id {})",
                text(r, "action"),
                text(r, "resource"),
                text(r, "id")
            )
        })
        .collect();
    (!named.is_empty()).then(|| format!(
        "OpenCode has rules saved for this project that let it act without asking: {}. This session runs under Ask, so Brigadier doesn't start a turn while they're there. Remove them in OpenCode (opencode api permission.saved.remove --param id=<id>) to go on.",
        named.join(", ")
    ))
}

/// Whether any resource covered by this saved pattern would ask. Walk the wildcard states
/// together, including later allow exceptions: sampling a pattern misses `?` and secret paths.
fn skips(rules: &[Value], action: &str, resource: &str) -> bool {
    let rules: Vec<&Value> = rules
        .iter()
        .filter(|r| matches(r["action"].as_str().unwrap_or(""), action))
        .collect();
    let patterns: Vec<Vec<char>> = std::iter::once(resource)
        .chain(rules.iter().map(|r| r["resource"].as_str().unwrap_or("")))
        .map(|p| p.chars().collect())
        .collect();
    let step = |p: &[char], at: &[usize], c: Option<char>| {
        let mut next: Vec<usize> = match c {
            None => vec![0],
            Some(c) => at
                .iter()
                .filter_map(|&i| match p.get(i) {
                    Some('*') => Some(i),
                    Some('?') => Some(i + 1),
                    Some(&ch) if ch == c => Some(i + 1),
                    _ => None,
                })
                .collect(),
        };
        let mut i = 0;
        while i < next.len() {
            let n = next[i];
            if p.get(n) == Some(&'*') && !next.contains(&(n + 1)) {
                next.push(n + 1);
            }
            i += 1;
        }
        next.sort_unstable();
        next.dedup();
        next
    };
    let mut letters: HashSet<char> = patterns
        .iter()
        .flatten()
        .copied()
        .filter(|c| !matches!(c, '*' | '?'))
        .collect();
    // All other characters make the same transitions as one another.
    if let Some(c) = (0..=0x10ffff)
        .filter_map(char::from_u32)
        .find(|c| !letters.contains(c))
    {
        letters.insert(c);
    }
    let start: Vec<Vec<usize>> = patterns.iter().map(|p| step(p, &[], None)).collect();
    let mut seen = HashSet::from([start.clone()]);
    let mut queue = VecDeque::from([start]);
    while let Some(at) = queue.pop_front() {
        let accepts = |i: usize| at[i].contains(&patterns[i].len());
        if accepts(0)
            && rules
                .iter()
                .enumerate()
                .rev()
                .find(|(i, _)| accepts(i + 1))
                .is_none_or(|(_, r)| r["effect"] == "ask")
        {
            return true;
        }
        for &c in &letters {
            let next: Vec<Vec<usize>> = patterns
                .iter()
                .zip(&at)
                .map(|(p, at)| step(p, at, Some(c)))
                .collect();
            if !next[0].is_empty() && seen.insert(next.clone()) {
                queue.push_back(next);
            }
        }
    }
    false
}

/// Answers an ask `once` for a grant that covers it.
pub(super) fn allow(server: &Server, ask: &Value) {
    let (session, id) = (
        ask["sessionID"].as_str().unwrap_or(""),
        ask["id"].as_str().unwrap_or(""),
    );
    let path = format!("/api/session/{session}/permission/{id}/reply");
    if let Err(e) = server.request("POST", &path, &json!({"decision": "once"})) {
        eprintln!("OpenCode {path}: {e}");
    }
}

/// Whether a grant covers every resource of an ask, by OpenCode's own matching rules.
pub(super) fn granted(grants: &[Value], ask: &Value) -> bool {
    let resources = ask["resources"].as_array().cloned().unwrap_or_default();
    // One `brigadier` agent command's grant covers them all [D2026].
    // and a `brigadier …` pattern covers nothing else (`helper`, later `mcp call`).
    let agent = |v: &Value| crate::agent::call(v.as_str().unwrap_or(""));
    let ours = |v: &Value| {
        let program = v.as_str().unwrap_or("").split_whitespace().next();
        program.is_some_and(|w| w == "brigadier" || w.ends_with("/brigadier"))
    };
    grants.iter().any(|g| {
        let save = g["save"].as_array().cloned().unwrap_or_default();
        g["action"] == ask["action"]
            && resources.iter().all(|r| {
                let mine = agent(r);
                save.iter().any(|p| {
                    (mine && (agent(p) || ours(p)))
                        || !(ours(p) && ours(r))
                            && matches(p.as_str().unwrap_or(""), r.as_str().unwrap_or(""))
                })
            })
    })
}

/// Whether a shell ask only the Auto path rules made names nothing outside the project and the
/// folders it may write: each path, resolved against the project, stays inside one [D130, D152,
/// C82]. A risky command's own later rule still asks.
pub(super) fn inside(rules: &Value, dir: &str, writes: &[String], ask: &Value) -> bool {
    let rules = rules.as_array().map_or(&[][..], Vec::as_slice);
    let text = |v: &Value, k: &str| v[k].as_str().unwrap_or("").to_string();
    let last = |r: &str| {
        (rules.iter().rev())
            .find(|x| matches(&text(x, "action"), "shell") && matches(&text(x, "resource"), r))
    };
    let resources = ask["resources"].as_array().map_or(&[][..], Vec::as_slice);
    // The project first: a relative word is joined to it alone; each folder as named and as real.
    let roots: Vec<PathBuf> = (std::iter::once(dir).chain(writes.iter().map(String::as_str)))
        .flat_map(|d| {
            [
                PathBuf::from(d),
                std::fs::canonicalize(d).unwrap_or_default(),
            ]
        })
        .collect();
    ask["action"] == "shell"
        && !dir.is_empty()
        && !resources.is_empty()
        && resources.iter().all(|r| {
            let r = r.as_str().unwrap_or("");
            // A part of the command the rules already allow (`; lsof …`) doesn't hold it back.
            last(r).is_some_and(|x| {
                text(x, "effect") == "allow"
                    || super::control::PATHS.contains(&text(x, "resource").as_str())
                        && words(r).iter().all(|w| named_inside(&roots, w))
            })
        })
}

/// The words of a command the path rules judge. The brief or message of a plain `brigadier start` or
/// `send` (no `cd`, no shell around it) is prose, not a path: its words as the shell passes them,
/// a positional one with spaces left out unless it starts as a path does; an option's value stays.
fn words(r: &str) -> Vec<String> {
    let agent = crate::agent::call(r)
        .then(|| crate::agent::plain_words(r))
        .flatten();
    let ours = |w: &[String]| {
        w.first()
            .is_some_and(|p| p.rsplit('/').next() == Some("brigadier"))
            && matches!(w.get(1).map(String::as_str), Some("start" | "send"))
    };
    match agent {
        Some(w) if ours(&w) => (0..w.len())
            .filter(|&i| {
                let prose = i > 1
                    && !w[i - 1].starts_with('-')
                    && w[i].contains(char::is_whitespace)
                    && !w[i].starts_with(['/', '~', '.', '-']);
                !prose
            })
            .map(|i| w[i].clone())
            .collect(),
        _ => r.split_whitespace().map(String::from).collect(),
    }
}

/// A command's word, if it names a path, resolved against the project: `~` is home; a redirect's
/// file (2>/dev/null) and an option's value (--out=/x) count; a word with a variable never is inside.
fn named_inside(roots: &[PathBuf], word: &str) -> bool {
    let w = word.trim_matches(['\'', '"']);
    let w = w
        .rfind(['<', '>'])
        .map_or(w, |i| w[i + 1..].trim_start_matches('&'));
    let w = w.rsplit_once('=').map_or(w, |(_, v)| v);
    // `$HOME` names a path with no slash in it, so an expansion asks before anything else.
    if w.contains(['$', '`']) {
        return false;
    }
    if !(w.contains('/') || w.starts_with('~') || w.starts_with("..")) {
        return true;
    }
    let path = match w.strip_prefix('~') {
        Some(rest) if rest.is_empty() || rest.starts_with('/') => {
            format!("{}{rest}", std::env::var("HOME").unwrap_or_default())
        }
        Some(_) => return false,
        None => w.into(),
    };
    let mut out = PathBuf::new();
    for c in roots[0].join(path).components() {
        match c {
            Component::ParentDir => drop(out.pop()),
            Component::CurDir => {}
            c => out.push(c),
        }
    }
    // As the shell sees it (macOS's /tmp is /private/tmp), a new file by its folder.
    let real = |p: &Path| std::fs::canonicalize(p).ok();
    let out = real(&out)
        .or_else(|| Some(real(out.parent()?)?.join(out.file_name()?)))
        .unwrap_or(out);
    out == Path::new("/dev/null")
        || roots
            .iter()
            .any(|r| !r.as_os_str().is_empty() && out.starts_with(r))
}

/// OpenCode's whole-value wildcard: `*` any run, `?` one character; `cmd *` also matches `cmd`.
fn matches(pattern: &str, value: &str) -> bool {
    fn go(p: &[char], v: &[char]) -> bool {
        match (p.first(), v.first()) {
            (None, None) => true,
            (Some('*'), _) => go(&p[1..], v) || (!v.is_empty() && go(p, &v[1..])),
            (Some('?'), Some(_)) => go(&p[1..], &v[1..]),
            (Some(a), Some(b)) => a == b && go(&p[1..], &v[1..]),
            _ => false,
        }
    }
    let (p, v): (Vec<char>, Vec<char>) = (pattern.chars().collect(), value.chars().collect());
    go(&p, &v) || pattern.strip_suffix(" *").is_some_and(|bare| bare == value)
}

