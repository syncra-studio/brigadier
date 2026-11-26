//! `brigadier keep` [D87; rev 2 §4.3]: the agent's own kept lines, on its own session only, each op a
//! `kept` NOTE written only where the log still stands as the list was judged (`if_len`).

use crate::owner;
use brigadier_core::{self as core, keeps};
use serde_json::{Value, json};
use std::path::Path;

pub(super) const HELP: &str = "brigadier keep [\"<line>\"] [--replace K \"<line>\"] [--drop K] [--json]

Keeps a line for good: a change to the goal, or a decision and why. Every fresh conversation of this
session starts with your kept lines whole, as you wrote them. With no line, lists them, numbered;
--replace K puts a new line in place of line K, --drop K drops it. At most 20 lines, 100 tokens a line
and 650 in all: past that, drop or shorten one first. Keep only what must never be lost.";

fn text(list: &[keeps::Line]) -> String {
    match list.is_empty() {
        true => "Nothing kept yet.\n".into(),
        false => (list.iter().enumerate())
            .map(|(k, l)| format!("{}. {}\n", k + 1, l.text))
            .collect(),
    }
}

pub(super) fn run(
    data: &Path,
    me: &str,
    line: Option<&str>,
    value: &dyn Fn(&str) -> Option<String>,
) -> Value {
    let refuse = |e: String| json!({"ok": false, "error": e});
    let Ok(spec) = core::load(data, me) else {
        return refuse("`brigadier keep` runs only inside a session.".into());
    };
    let (replace, drop) = (value("--replace"), value("--drop"));
    if line.is_none() && replace.is_none() && drop.is_none() {
        let list = keeps::list(&spec.dir);
        return json!({"ok": true, "kept": list.iter().map(|l| &l.text).collect::<Vec<_>>(), "text": text(&list)});
    }
    if owner::ensure(data, &spec).is_err() {
        return refuse("This session's host isn't running.".into());
    }
    // The line's id, named once: a retry after another keep moved the list keeps aiming at it.
    let first = keeps::list(&spec.dir);
    let target = match replace.as_ref().or(drop.as_ref()) {
        None => None,
        Some(k) => match k
            .parse::<usize>()
            .ok()
            .and_then(|n| first.get(n.wrapping_sub(1)))
        {
            Some(l) => Some(l.id.clone()),
            None => return refuse(format!("No kept line {k}: `brigadier keep` lists them.")),
        },
    };
    // Judged and written at one log length, so two keeps at once can't both pass the size check.
    for _ in 0..40 {
        let Ok(ping) = owner::call(data, me, json!({"op": "ping"})) else {
            return refuse("This session's host isn't answering.".into());
        };
        let list = keeps::list(&spec.dir);
        if let Some(t) = &target
            && !list.iter().any(|l| &l.id == t)
        {
            let k = replace
                .as_ref()
                .or(drop.as_ref())
                .map_or("", |k| k.as_str());
            return refuse(format!(
                "Line {k} changed meanwhile: `brigadier keep` lists them."
            ));
        }
        let (op, id, words) = match (&replace, &drop, line, &target) {
            (Some(_), None, Some(l), Some(id)) => ("replace", id.clone(), l),
            (None, Some(_), None, Some(id)) => ("drop", id.clone(), ""),
            (None, None, Some(l), None) => {
                ("add", format!("{me}.{}", &core::adapters::uuid()[..8]), l)
            }
            _ => return refuse("Give a line, --replace K with a line, or --drop K.".into()),
        };
        let replacing = (op == "replace").then_some(id.as_str());
        if let Some(why) = (op != "drop")
            .then(|| keeps::refused(&list, replacing, words))
            .flatten()
        {
            return refuse(why);
        }
        let note = json!({"event": "kept", "op": op, "id": id, "text": words});
        let reply = owner::call(
            data,
            me,
            json!({"op": "note", "data": note, "if_len": ping["len"]}),
        );
        match reply {
            Ok(r) if r["ok"] == true => {
                let list = keeps::list(&spec.dir);
                let done = match op {
                    "drop" => "Dropped",
                    "replace" => "Replaced",
                    _ => "Kept",
                };
                return json!({"ok": true, "text": format!("{done}. Your list now:\n{}", text(&list))});
            }
            Ok(r) if r["error"] == "changed" => {
                std::thread::sleep(std::time::Duration::from_millis(50))
            }
            Ok(r) => return refuse(r["error"].as_str().unwrap_or("refused").into()),
            Err(e) => return refuse(e.to_string()),
        }
    }
    refuse("The session kept changing; try again.".into())
}
