//! Session grants and saved rules, matched as OpenCode matches them: a grant answers the asks it
//! covers for this session only, and a rule the user saved in OpenCode never lets an Ask turn skip
//! an ask [D166, D193, D266].

use super::http::Server;
use super::server::Shared;
use serde_json::{Value, json};
use std::collections::{HashSet, VecDeque};

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
    grants.iter().any(|g| {
        let save = g["save"].as_array().cloned().unwrap_or_default();
        g["action"] == ask["action"]
            && resources.iter().all(|r| {
                save.iter()
                    .any(|p| matches(p.as_str().unwrap_or(""), r.as_str().unwrap_or("")))
            })
    })
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
