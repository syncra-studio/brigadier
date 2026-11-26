//! The skills the user's messages invoked: a fresh agent gets their `/name` as plain text, so the
//! hand-off says to load each, within rev 2 §4.2's bounds.

use super::{Past, records};
use crate::{Spec, archive::Entry};
use std::path::Path;

/// The section, or nothing when no message invoked one.
pub(super) fn section(spec: &Spec, p: &Past) -> String {
    let id = spec.id.as_str();
    let hidden = crate::library::hidden(&crate::data_of(spec), spec.project.as_deref());
    let mut names: Vec<String> = (crate::adapters::all().iter())
        .flat_map(|a| a.fixed_commands(Some(Path::new(&spec.cwd)), None))
        .filter(|k| k["kind"] == "skill" && !hidden.has(k))
        .filter_map(|k| k["name"].as_str().map(String::from))
        .collect();
    names.sort();
    names.dedup();
    // Newest invoked first, 20 at most, a name at most 60 estimated tokens (rev 2 §4.2).
    let mut invoked: Vec<(&Entry, &String)> = (names.iter())
        .filter_map(|name| {
            let mut user = p
                .entries
                .iter()
                .filter(|e| e.from == "user" && e.who.is_empty());
            Some((
                user.rfind(|e| {
                    e.text
                        .split_whitespace()
                        .any(|w| w.strip_prefix('/') == Some(name))
                })?,
                name,
            ))
        })
        .collect();
    invoked.sort_by_key(|(e, _)| std::cmp::Reverse(records::key(&e.at)));
    let more = invoked.len().saturating_sub(20);
    let mut skills: String = (invoked.iter().take(20)).map(|(e, name)| {
        let shown = records::upto(name, 60).map_or(name.to_string(), |s| format!("{s}… (cut: `brigadier skill --json` lists them whole)"));
        format!("- /{shown}, from {id}#{}: load it before you go on, with your own skill tool or `brigadier skill {name}`\n", e.at)
    }).collect();
    if more > 0 {
        skills += &format!("- {more} more: `brigadier skill --json`\n");
    }
    if !skills.is_empty() {
        return format!("\n## The session's skills\n{skills}");
    }
    String::new()
}
