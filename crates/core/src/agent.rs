//! What every session's agent is given for the `brigadier` command [D2025, D2026, D3030]: the
//! line it always has, the grant its calls carry, and which calls are Brigadier's own agent
//! commands, so one approval covers them all.

use crate::Spec;
use std::fs::OpenOptions;
use std::io::{Read, Seek, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;

/// The session folder and the grant, in the agent's environment.
pub const SESSION: &str = "BRIGADIER_SESSION";
pub const GRANT: &str = "BRIGADIER_GRANT";

/// The commands an agent may run [D2026]; the daemon refuses every other.
pub const COMMANDS: [&str; 10] = [
    "sessions", "read", "send", "wait", "start", "stop", "models", "help", "skill", "search",
];

/// How a message from another session opens, for its receiving agent; its bubble shows the rest [D2034].
pub const PEER_HEAD: &str = "[From session ";

/// The line every session loads, its byte cap checked by `scripts/limits` [D2025].
pub const LINE: &str = include_str!("agent-line.txt");

/// The standing text an adapter passes at launch: the commit style, then the line.
pub fn standing() -> String {
    format!("{} {}", crate::writer::STYLE, LINE.trim())
}

/// The grant for this launch (proposed lifecycle): one token per owner generation, the host that
/// holds the session. The first launch under a new host replaces the token of the host before it,
/// so a launch never revokes a live holder's (the old app's #555), a stale holder loses it, and
/// the session's delete takes it with its folder. None when it can't be written.
pub fn grant(spec: &Spec) -> Option<String> {
    let owner: serde_json::Value =
        serde_json::from_slice(&std::fs::read(spec.dir.join("owner.json")).unwrap_or_default())
            .unwrap_or_default();
    let generation = format!("{}.{}", owner["pid"], owner["start_us"]);
    let mut file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .open(spec.dir.join("grant"))
        .ok()?;
    file.lock().ok()?;
    let mut held = String::new();
    file.read_to_string(&mut held).ok()?;
    if let Some((g, token)) = held.split_once(' ')
        && g == generation
    {
        return Some(token.to_string());
    }
    let token = crate::adapters::uuid();
    file.set_len(0).ok()?;
    file.rewind().ok()?;
    write!(file, "{generation} {token}").ok()?;
    Some(token)
}

/// Whether `token` is the session's grant now.
pub fn granted(dir: &Path, token: &str) -> bool {
    let held = std::fs::read_to_string(dir.join("grant")).unwrap_or_default();
    !token.is_empty() && held.split_once(' ').is_some_and(|(_, t)| t == token)
}

/// Whether a shell command (or an approval's pattern for one) is one plain `brigadier` agent
/// command: no other program, no shell syntax, so a grant for one can safely cover them all.
/// Quotes are words, so a brief can be passed: inside single quotes everything is literal, inside
/// double quotes nothing that expands. `helper` and the app's commands aren't agent commands, so
/// no approval ever covers them.
pub fn call(command: &str) -> bool {
    let c = command.trim().trim_end_matches(":*").trim_end_matches(" *");
    let Some(mut words) = past_cd(c).and_then(plain_words) else {
        return false;
    };
    // `zsh -lc '<it>'` with nothing after it: its script is checked the same way.
    if words.len() == 3
        && matches!(words[0].rsplit('/').next(), Some("sh" | "bash" | "zsh"))
        && matches!(words[1].as_str(), "-c" | "-lc")
    {
        let Some(inner) = past_cd(&words[2]).and_then(plain_words) else {
            return false;
        };
        words = inner;
    }
    let program = words.first().map_or("", String::as_str);
    (program == "brigadier" || program.ends_with("/brigadier"))
        && words.get(1).is_some_and(|w| COMMANDS.contains(&w.as_str()))
}

/// The command after any `cd <folder> &&`, each folder plain words only; None when one isn't.
fn past_cd(mut c: &str) -> Option<&str> {
    while c.starts_with("cd ") {
        let (head, rest) = c.split_once("&&")?;
        if plain_words(head)?.len() != 2 {
            return None;
        }
        c = rest.trim_start();
    }
    Some(c)
}

/// A command's words when it has no shell syntax but quotes; None when it has any.
fn plain_words(c: &str) -> Option<Vec<String>> {
    let (mut words, mut word, mut quote, mut open) = (vec![], String::new(), None, false);
    for ch in c.chars() {
        match (quote, ch) {
            (_, '\n') => return None,
            (Some('\''), '\'') | (Some('"'), '"') => quote = None,
            (Some('"'), '$' | '`' | '\\' | '!') => return None,
            (Some(_), ch) => word.push(ch),
            (None, '\'' | '"') => (quote, open) = (Some(ch), true),
            (None, ch) if ch.is_whitespace() => {
                if open || !word.is_empty() {
                    words.push(std::mem::take(&mut word));
                }
                open = false;
            }
            (None, ch) if ";&|<>$`()\\*?{}[]~#!".contains(ch) => return None,
            (None, ch) => {
                word.push(ch);
                open = true;
            }
        }
    }
    if quote.is_some() {
        return None;
    }
    if open || !word.is_empty() {
        words.push(word);
    }
    Some(words)
}

/// A session's agent gets `brigadier`'s folder first on its PATH, its grant and its data folder
/// [D2026]; probes and sign-ins don't.
pub(crate) fn env(spec: &Spec) -> Option<(String, Vec<(String, String)>)> {
    spec.dir.parent()?.ends_with("sessions").then_some(())?;
    let token = grant(spec)?;
    let me = std::env::current_exe().ok()?;
    let data = crate::data_of(spec).display().to_string();
    let vars = vec![
        (SESSION.into(), spec.dir.display().to_string()),
        (GRANT.into(), token),
        ("BRIGADIER_DATA".into(), data),
    ];
    Some((me.parent()?.display().to_string(), vars))
}
