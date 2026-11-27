//! A refused new chat's own draft, taken into its message's give-back before its session goes,
//! so Home gets the message, then what was typed in the chat, then its own words [C80].

use super::place::{Place, crash_at, hold, mine};
use super::{Words, change, read, shown};
use brigadier_core::{self as core, message};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io;
use std::path::Path;

/// A new chat's own draft as its session went: its words and files, then the chips waiting above
/// its composer and the comment being written on its diff, as words, Home keeping no chips
/// (`said`). Always there on a start's give-back, blank for one never typed in, so the app's own
/// copy, never older, goes in too [C80].
#[derive(Serialize, Deserialize, Clone, Default)]
pub(super) struct Typed {
    session: String,
    #[serde(flatten)]
    pub(super) words: Words,
    #[serde(default)]
    said: String,
}

impl Typed {
    pub(super) fn said(&self) -> Words {
        let parts = (!self.said.is_empty()).then(|| self.said.clone().into());
        Words {
            parts: parts.into_iter().collect(),
            ..Words::default()
        }
    }
}

/// Chips as the agent reads them (the app's `withChips`), then the comment being written, with
/// where each is: a commit's diff, or the lines before the change.
fn said(chips: &[Value], writing: &Value) -> String {
    let s = |v: &Value, k: &str| v[k].as_str().unwrap_or_default().to_string();
    let place = |on: &str, c: &Value| {
        let lines = match (c["start"].as_u64(), c["end"].as_u64()) {
            (Some(a), Some(b)) if a != b => format!("{a}-{b}"),
            (a, _) => a.unwrap_or_default().to_string(),
        };
        let mut at = vec![];
        if on != "review" {
            at.push(format!("in commit {}", on.get(..12).unwrap_or(on)));
        }
        if s(c, "side") == "deletions" {
            at.push("before the change".into());
        }
        let at = (!at.is_empty()).then(|| format!(" ({})", at.join(", ")));
        format!("{}:{lines}{}", s(c, "path"), at.unwrap_or_default())
    };
    let comment = |on: &str, c: &Value| {
        let quote: Vec<String> = (s(c, "excerpt").split('\n'))
            .map(|l| format!("> {l}"))
            .collect();
        format!("{}\n{}\n\n{}", place(on, c), quote.join("\n"), s(c, "text"))
    };
    let mut out: Vec<String> = (chips.iter())
        .map(|c| match c["kind"].as_str() {
            Some("agent") => s(c, "text"),
            _ => comment(&s(c, "on"), &c["comment"]),
        })
        .collect();
    if !s(writing, "text").is_empty() {
        out.push(format!(
            "{}\n\n{}",
            place(&s(writing, "on"), writing),
            s(writing, "text")
        ));
    }
    out.retain(|t| !t.trim().is_empty());
    out.join("\n\n")
}

/// The chat's own draft goes with its message before its session does, read again on every pass,
/// as the chat stays editable while its session can't go: saved in the give-back, so Home's draft
/// names its files, then its files copied whole. Only what's still there is read again: no
/// session folder, nothing was typed there and none is made; a delete cut short may have taken
/// its draft or its chips, and what an earlier pass carried of them stays [C80].
pub(super) fn carry(place: &Place, data: &Path, cid: &str, session: &str) -> io::Result<()> {
    let dir = core::session_dir(data, session);
    // A device's new chat, typed into on that device: its own slot there [D51].
    let own = Place::Session(dir.clone(), place.device().map(String::from));
    let draft = own.file();
    let words = match draft.is_file() {
        true => {
            let _lock = hold(&own.lock())?;
            Some(shown(&read(&draft), true))
        }
        false => None,
    };
    let chips = match dir.join("chips.json").is_file() {
        true => Some(crate::chips::run(data, &["chips".into(), session.into()])?),
        false => None,
    };
    let waiting = |c: &Value| c["chips"].as_array().cloned().unwrap_or_default();
    let said = chips.map(|c| said(&waiting(&c), &c["draft"]));
    change(place, |book| {
        if let Some(g) = mine(book, cid) {
            let t = g.typed.get_or_insert_with(|| Typed {
                session: session.into(),
                ..Typed::default()
            });
            if let Some(w) = &words {
                t.words = w.clone();
            }
            if let Some(s) = &said {
                t.said = s.clone();
            }
        }
        Ok(())
    })?;
    let Some(words) = words else { return Ok(()) };
    let (from, home) = (own.unsent(), place.unsent());
    // Copied again on every pass: a paste edited since an earlier pass keeps its id [C80].
    for id in message::ids(&serde_json::to_value(&words)?) {
        if let Some(file) = message::file_in(&from, &id) {
            crate::attach::copy_whole(&file, &home.join(&id))?;
        }
    }
    crash_at("start:typed");
    Ok(())
}
