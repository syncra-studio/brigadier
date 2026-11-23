//! `run` (proposed): a few actions in one call, one round trip. It stops at the first that fails
//! and answers each step's line, then one diff for the whole run.

use super::window::{Seen, baseline, changes, shows};
use super::{SESSIONS, Words, lock, refuse, verb, words};
use serde_json::Value;
use std::path::Path;

const STEPS: [&str; 6] = ["click", "type", "key", "scroll", "menu", "drag"];

pub(super) fn run(
    data: &Path,
    me: &str,
    w: &Words,
    rows: &dyn Fn() -> Vec<Value>,
    here: &dyn Fn() -> bool,
) -> Result<String, Value> {
    let steps: Vec<Vec<String>> = w.rest.iter().map(|s| split(s)).collect();
    let verbs: Vec<&str> = steps
        .iter()
        .map(|s| s.first().map_or("", String::as_str))
        .collect();
    if steps.is_empty() || verbs.iter().any(|v| !STEPS.contains(v)) {
        return Err(refuse(
            "Give the steps, each in quotes: brigadier computer run 'click 4' 'menu \"Edit > Paste\"' 'key return'. A step is click, type, key, scroll, menu or drag.",
        ));
    }
    if verbs.iter().filter(|v| **v == "type").count() > 1
        || (steps.iter().flatten()).any(|a| a == "--submit" || a == "--stdin")
    {
        return Err(refuse(
            "A run has one type step, its text on stdin, and no --submit: add 'key return' as a step.",
        ));
    }
    let mut s = lock(&SESSIONS).get(me).cloned().unwrap_or_default();
    if s.window != 0 && !s.snapshot.is_empty() {
        baseline(data, &mut s, here);
        lock(&SESSIONS).insert(me.to_string(), s);
    }
    batch(me, true);
    let (mut lines, mut typed) = (vec![], None);
    for (i, step) in steps.iter().enumerate() {
        let mut args = vec!["computer".to_string()];
        args.extend(step.iter().cloned());
        if let (Some(text), "type") = (w.values.get("--stdin"), verbs[i]) {
            args.extend(["--stdin".into(), text.to_string()]);
            typed = step
                .get(1)
                .and_then(|n| n.trim_matches(['[', ']']).parse::<u64>().ok())
                .zip(Some(*text));
        }
        let done = words(&args).and_then(|sw| verb(data, me, &sw, rows, here));
        match done {
            Ok(text) => lines.push(text.lines().next().unwrap_or("").to_string()),
            Err(e) => {
                let why = e["error"].as_str().unwrap_or("it failed");
                lines.push(format!("Step {} stopped the run: {why}", i + 1));
                break;
            }
        }
    }
    batch(me, false);
    let mut s = lock(&SESSIONS).get(me).cloned().unwrap_or_default();
    if s.window == 0 || s.snapshot.is_empty() {
        return Ok(lines.join("\n"));
    }
    let (seen, diff) = changes(data, me, &mut s, here);
    let verdict = match typed {
        Some((n, text)) if shows(&s, n, text) => format!("Done: [{n}] reads the text back."),
        _ if seen == Seen::No => "No change seen. Read again, or try another way.".into(),
        _ if seen == Seen::Unsure => "Sent; I can't tell what it changed.".into(),
        _ => "Change observed.".into(),
    };
    lock(&SESSIONS).insert(me.to_string(), s);
    Ok(format!("{}\n{verdict}\n{diff}", lines.join("\n")))
}

/// Marks `me`'s actions as steps of a run: each is sent, and the run reads once at its end.
fn batch(me: &str, on: bool) {
    lock(&SESSIONS).entry(me.to_string()).or_default().batch = on;
}

/// A step's words, split on spaces outside quotes: menu "File > Save As…".
fn split(step: &str) -> Vec<String> {
    let (mut out, mut word, mut quote) = (vec![], String::new(), None);
    for c in step.chars() {
        match (c, quote) {
            ('"' | '\'', None) => quote = Some(c),
            (c, Some(q)) if c == q => quote = None,
            (' ', None) => out.extend((!word.is_empty()).then(|| std::mem::take(&mut word))),
            _ => word.push(c),
        }
    }
    out.extend((!word.is_empty()).then_some(word));
    out
}
