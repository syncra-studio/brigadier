//! Which of a session's mockups a command means: the one `--of` names, else the only one it can be.

use super::{state, tab};
use crate::workers;
use brigadier_core as core;
use serde_json::{Value, json};
use std::collections::HashSet;
use std::path::Path;

/// The mockup of session `id` a command means: worker `of`'s, else its only one; to pick from, also
/// one it reuses, and else its only one waiting for a pick. Never a guess between several: they're
/// listed instead.
pub(super) fn one(
    data: &Path,
    id: &str,
    of: Option<String>,
    to_pick: bool,
) -> Result<String, String> {
    core::check_id(id).map_err(|e| e.to_string())?;
    let mut wids: Vec<String> = (workers::records(data, id).into_iter())
        .map(|r| r.wid)
        .collect();
    if to_pick && let Ok(f) = core::fold(&core::session_dir(data, id), true) {
        wids.extend(f.fold.mockups.opened);
        let mut seen = HashSet::new();
        wids.retain(|w| seen.insert(w.clone()));
    }
    let all: Vec<(String, Value)> = (wids.into_iter())
        .filter_map(|w| state(data, &w).map(|m| (w, m)))
        .collect();
    let listed = |of: &[(String, Value)]| {
        (of.iter())
            .map(|(w, m)| format!("{w} \"{}\"", m["title"].as_str().unwrap_or("")))
            .collect::<Vec<_>>()
            .join(", ")
    };
    if let Some(of) = of {
        return match all.iter().find(|(w, _)| *w == of.trim()) {
            Some((w, _)) => Ok(w.clone()),
            None if all.is_empty() => Err(format!("{of} is no mockup worker of {id}.")),
            None => Err(format!(
                "{of} is no mockup worker of {id}. Its mockups: {}.",
                listed(&all)
            )),
        };
    }
    let open: Vec<_> = (all.iter().filter(|(_, m)| to_pick && m["picked"].is_null()))
        .cloned()
        .collect();
    match if open.is_empty() { &all } else { &open }.as_slice() {
        [] => Err(format!("Session {id} has no mockup.")),
        [(w, _)] => Ok(w.clone()),
        several => Err(format!(
            "More than one mockup: name it with --of <worker>: {}.",
            listed(several)
        )),
    }
}

/// `--use A [--of <worker>]`: the user named their pick in the lead's chat; it goes as the tab's
/// Use, so the tab follows.
pub(super) fn use_(
    data: &Path,
    me: &str,
    letter: &str,
    value: &dyn Fn(&str) -> Option<String>,
) -> Result<Value, String> {
    let wid = one(data, me, value("--of"), true)?;
    let notes = json!({"all": value("--note").unwrap_or_default()});
    let r = tab::pick(data, &wid, letter, &notes).map_err(|e| e.to_string())?;
    let title = state(data, &wid).unwrap_or_default()["title"].clone();
    let name = format!("{} ({wid})", title.as_str().unwrap_or("The mockup"));
    let said = r["message"].as_str().unwrap_or("");
    if r["ok"] != true {
        return Err(format!("{name}: {said}"));
    }
    // A reused mockup's worker builds for, and reports to, the session that drew it.
    let other = (workers::link(data, &wid).map(|l| l.parent)).filter(|p| p != me);
    let text = match (said, other) {
        ("", Some(s)) => format!(
            "{letter} went to mockup worker {name} to build into session {s}'s branch; its tab shows it, and its result goes to that session."
        ),
        ("", None) => format!(
            "{letter} went to mockup worker {name} to build; its tab shows it, and its result comes to you once it's built."
        ),
        (_, Some(s)) => {
            format!("{name}: {letter} went to session {s} to build, as its worker was stopped.")
        }
        (_, None) => format!("{name}: {said}"),
    };
    Ok(json!({"ok": true, "text": text}))
}
