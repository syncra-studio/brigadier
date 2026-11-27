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

/// Chips as the agent reads them (the app's `withChips`), then the comment being written.
fn said(chips: &[Value], writing: &Value) -> String {
    let s = |v: &Value, k: &str| v[k].as_str().unwrap_or_default().to_string();
    let lines = |c: &Value| match (c["start"].as_u64(), c["end"].as_u64()) {
        (Some(a), Some(b)) if a != b => format!("{a}-{b}"),
        (a, _) => a.unwrap_or_default().to_string(),
    };
    let comment = |on: &str, c: &Value| {
        let mut at = vec![];
        if on != "review" {
            at.push(format!("in commit {}", on.get(..12).unwrap_or(on)));
        }
        if s(c, "side") == "deletions" {
            at.push("before the change".into());
        }
        let at = (!at.is_empty()).then(|| format!(" ({})", at.join(", ")));
        let quote: Vec<String> = s(c, "excerpt")
            .split('\n')
            .map(|l| format!("> {l}"))
            .collect();
        let (path, text) = (s(c, "path"), s(c, "text"));
        format!(
            "{path}:{}{}\n{}\n\n{text}",
            lines(c),
            at.unwrap_or_default(),
            quote.join("\n")
        )
    };
    let mut out: Vec<String> = (chips.iter())
        .map(|c| match c["kind"].as_str() {
            Some("agent") => s(c, "text"),
            _ => comment(&s(c, "on"), &c["comment"]),
        })
        .collect();
    if !s(writing, "text").is_empty() {
        out.push(format!(
            "{}:{}\n\n{}",
            s(writing, "path"),
            lines(writing),
            s(writing, "text")
        ));
    }
    out.retain(|t| !t.trim().is_empty());
    out.join("\n\n")
}

/// The chat's own draft goes with its message before its session does, read again on every pass,
/// as the chat stays editable while its session can't go: saved in the give-back, so Home's draft
/// names its files, then its files copied whole. No session folder: nothing was typed there, none
/// is made, and what an earlier pass carried stays [C80].
pub(super) fn carry(place: &Place, data: &Path, cid: &str, session: &str) -> io::Result<()> {
    let dir = core::session_dir(data, session);
    let typed = if dir.is_dir() {
        Some(typed(data, &dir, session)?)
    } else {
        None
    };
    change(place, |book| {
        if let Some(g) = mine(book, cid) {
            let blank = || Typed {
                session: session.into(),
                ..Typed::default()
            };
            g.typed = typed.clone().or(g.typed.take()).or_else(|| Some(blank()));
        }
        Ok(())
    })?;
    let Some(t) = typed else { return Ok(()) };
    let (from, home) = (message::draft(&dir), message::home(data));
    for id in message::ids(&serde_json::to_value(&t.words)?) {
        if let (Some(file), None) = (message::file_in(&from, &id), message::file_in(&home, &id)) {
            crate::attach::copy_whole(&file, &home.join(&id))?;
        }
    }
    crash_at("start:typed");
    Ok(())
}

/// Session `dir`'s draft as its composer shows it, under its lock, and what waits above it.
fn typed(data: &Path, dir: &Path, session: &str) -> io::Result<Typed> {
    let words = {
        let _lock = hold(&Place::Session(dir.to_path_buf()).lock())?;
        shown(&read(&dir.join("draft")), true)
    };
    let chips = crate::chips::run(data, &["chips".into(), session.into()])?;
    let waiting = chips["chips"].as_array().cloned().unwrap_or_default();
    Ok(Typed {
        session: session.into(),
        words,
        said: said(&waiting, &chips["draft"]),
    })
}
