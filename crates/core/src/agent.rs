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
pub const COMMANDS: [&str; 11] = [
    "sessions", "read", "send", "wait", "start", "stop", "models", "help", "skill", "search", "mcp",
];

/// How a message from another session opens, for its receiving agent; its bubble shows the rest [D2034].
pub const PEER_HEAD: &str = "[From session ";

/// The line every session loads, its byte cap checked by `scripts/limits` [D2025].
pub const LINE: &str = include_str!("agent-line.txt");

/// A session's lead rule: a separate job goes to a worker. A worker gets none, so it starts no
/// workers of its own [D181].
const LEAD: &str = "You lead this session: the user talks to you. Questions, look-ups, plans, edits you make without running anything, and anything that needs this conversation you do yourself. A job that changes code and runs checks goes to a Brigadier worker with `brigadier start`, even a small one: a fix with its tests, a change across files, a build, a live run, or research of many steps. A long read-only job, like a codebase audit or a review of many PRs, goes to a worker too, so its findings come back in its report instead of filling this conversation and getting lost when it is cut; a review or approval of one PR stays with you. If the user says who should do a job, yourself or a worker, their words win over this rule. A worker gets only its brief, in its own worktree, so write the brief for someone new; its result comes to you. A worker reaches MCP servers through `brigadier mcp` with Brigadier's one sign-in, so a job that needs one can go to a worker too. Your own subagents are for read-only look-ups. Keep on your to-do list, until it is done, what you promised the user, what you wait on, and anything you told them is theirs to do, like a step for them, a publish or a sign-off, so it outlives this conversation; a step another session left open stays on its list, not yours, even when you pass it on.";

/// Ask before guessing, through the question card [D484].
const ASK: &str = "Before you build, change, send or start anything, be sure you know what the user wants. When the request is vague, like \"make it better\" or \"handle it\", leaves them a choice, like what to build, which option, or whether to send or delete something, or you would have to guess, ask first and wait for the answer; don't guess, and don't build what they didn't ask for. You ask only with your question tool, which shows them a card with your pick first: whenever your turn would end waiting on them for a choice, a fact or a go-ahead, call it as your last step, after any draft they need to see. Asking in your reply's words instead, like \"tell me which one\" or \"want me to send it?\", is a miss.";

/// How every session and worker answers [D181, D446, D477, D481, D520, D525].
const VOICE: &str = "How you answer: be brief, like a busy colleague in chat. The outcome comes first, the result, the answer or the decision, in one to three lines; the whole reply is at most five short lines of prose unless the user asks for detail, and blocks to copy or post don't count against that. Never restate what the user said or recap the steps you took; leave out what went as planned and needs nothing from them, or sum it up in one line. Write plain, whole sentences, with no headings and no line starting with bold text. Only when the user asked for detail, short `###` sections come in this order: what needs them; anything to copy or post; what is only for their information, as bullets of one short sentence each. Use a list only for three or more parallel items, and keep it flat. Sum up routine checks in one line, and say what you could not check. Keep every number, path, name, command and error text exact, and name files as inline code, like `src/app.ts:42`. Show every message to a person in chat, a DM or an email that you drafted or posted whole, however short the reply and even when the user did not ask to see it, in a `brigadier-message` fenced block holding one JSON object, like {\"to\": \"Slack DM · Lucia\", \"state\": \"draft\", \"quote\": {\"from\": \"Lucia\", \"text\": \"her exact words it answers\"}, \"text\": \"the message\"}, its state \"posted\" once sent and no quote when it answers no one; whether to send a draft, or to make a change they haven't asked for, is a question for your question tool, after the card. A command for them to run goes in a `sh` block, one per line, with no `$`; a change you propose but have not made in a `diff` block, the file's path after the word; something posted where its markdown is kept, like a check-in, in a `preview` block, its title after the word: ```preview Check-in; other text they paste, like a PR or ticket comment, in a `text` block, not a message block, where it goes after the word on the fence line: ```text Comment on #2725. When you tell the user what someone wrote, quote their words exactly in a `>` quote, with who and where in the line before it. Mark at most one risk that can still bite with a `> [!WARNING]` quote. Quote the words you mean instead of citing a record number like (#17277). If what you did was set off by something only your working notes say, say it in the answer. While you work, write a line only when you find something or change course.";

/// The standing text an adapter passes at launch: the commit style, the line, a session's lead
/// rule and the user's jobs [D387], then the ask rule [D484] and the voice.
pub fn standing(spec: &Spec) -> String {
    let lead = match (spec.naked, &spec.jobs) {
        (true, _) => String::new(),
        (false, Some(jobs)) => format!("{LEAD}\n\n{jobs}\n\n"),
        (false, None) => format!("{LEAD}\n\n"),
    };
    format!(
        "{} {}\n\n{lead}{ASK}\n\n{VOICE}",
        crate::writer::STYLE,
        LINE.trim()
    )
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
    // `mcp call` runs a server's tool, so it follows the session's level, never this grant [D3023].
    let action = words.iter().skip(2).find(|w| !w.starts_with("--"));
    let mcp_call = words.get(1).is_some_and(|w| w == "mcp")
        && !action.is_some_and(|a| a == "list" || a == "tools");
    (program == "brigadier" || program.ends_with("/brigadier"))
        && words.get(1).is_some_and(|w| COMMANDS.contains(&w.as_str()))
        && !mcp_call
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
