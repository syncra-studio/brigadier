//! What every session's agent is given for the `brigadier` command [D2025, D2026, D3030]: the
//! line it always has, the grant its calls carry, and which calls are Brigadier's own agent
//! commands, so one approval covers them all.

use crate::Spec;
use serde_json::Value;
use std::fs::OpenOptions;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::io::{Read, Seek, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;

/// The session folder and the grant, in the agent's environment.
pub const SESSION: &str = "BRIGADIER_SESSION";
pub const GRANT: &str = "BRIGADIER_GRANT";

/// The commands an agent may run [D2026]; the daemon refuses every other.
pub const COMMANDS: [&str; 21] = [
    "sessions",
    "read",
    "send",
    "wait",
    "start",
    "stop",
    "models",
    "help",
    "skill",
    "notes",
    "search",
    "mcp",
    "browser",
    "show",
    "repo",
    "mockup",
    "computer",
    "terminal",
    "new",
    "overnight",
    "keep",
];

/// How a message from another session opens, for its receiving agent; its bubble shows the rest [D2034].
pub const PEER_HEAD: &str = "[From session ";

/// The line every session loads, its byte cap checked by `scripts/limits` [D2025].
pub const LINE: &str = include_str!("agent-line.txt");

/// The standing text's parts, each one where its rule can't live in a tool, a check or the
/// renderer, their bytes held by `scripts/limits` [D527, D529]: the commit style [D1029], a
/// session's lead rule, which a worker doesn't get [D181, D387], asking [D484, D526] and the voice.
const COMMITS: &str = include_str!("standing/commits.txt");
const LEAD: &str = include_str!("standing/lead.txt");
const ASK: &str = include_str!("standing/ask.txt");
const VOICE: &str = include_str!("standing/voice.txt");

/// The standing text an adapter passes at launch: the commit style, the line, a session's lead
/// rule and the user's jobs [D387], a folder chat's repos [D494], then the ask rule [D484] and
/// the voice.
pub fn standing(spec: &Spec) -> String {
    // A run with no tools (the message writer, the queue's judge) gets the commit style alone: the
    // rest is about tools it hasn't, and would only end it (proposed) [D771].
    if spec.opts.contains_key("no_tools") {
        return COMMITS.trim().to_string();
    }
    let repos = crate::folder::standing(spec).map_or(String::new(), |r| format!("{r}\n\n"));
    let lead = match (spec.naked, &spec.jobs) {
        (true, _) => String::new(),
        (false, Some(jobs)) => format!("{LEAD}\n\n{jobs}\n\n"),
        (false, None) => format!("{LEAD}\n\n"),
    };
    format!(
        "{} {}\n\n{lead}{repos}{ASK}\n\n{VOICE}",
        COMMITS,
        LINE.trim()
    )
}

/// A turn's setup with the lead's job list as told, by its fingerprint: a running lead's launch
/// text keeps the list it started with [D932].
pub fn with_jobs(spec: &Spec, mut setup: Value) -> Value {
    if let Some(jobs) = &spec.jobs {
        let mut hash = DefaultHasher::new();
        jobs.hash(&mut hash);
        setup["jobs"] = format!("{:016x}", hash.finish()).into();
    }
    setup
}

/// A message to a running lead, after the user's jobs as they are now where they changed since
/// it was last told, so a renamed or edited job is right on its next turn [D932].
pub fn retold(spec: &Spec, f: &crate::fold::Fold, setup: &Value, text: &str) -> String {
    match &spec.jobs {
        Some(jobs) if f.given.as_ref().is_some_and(|g| g["jobs"] != setup["jobs"]) => {
            format!("{jobs}\n\n{text}")
        }
        _ => text.into(),
    }
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
    // `mcp call` runs a server's tool and `mcp tools` starts the server, so they follow the
    // session's level, never this grant [D3023].
    let action = words.iter().skip(2).find(|w| !w.starts_with("--"));
    let mcp_call = words.get(1).is_some_and(|w| w == "mcp") && !action.is_some_and(|a| a == "list");
    (program == "brigadier" || program.ends_with("/brigadier"))
        && words.get(1).is_some_and(|w| COMMANDS.contains(&w.as_str()))
        && !mcp_call
}

/// Whether a shell command is one `brigadier computer …` call and nothing else, its text perhaps
/// from `echo` or `printf` with literal words: the daemon asks for each app itself [D31], so its
/// CLI's prompt is answered for it. Stricter than `call`, as nobody reads it: the bare name, which
/// our folder comes first for on its PATH, and a CLI's own shell around it by the system's path.
pub fn computer(command: &str) -> bool {
    // A space is the one blank its shell and this both read as one.
    if (command.chars()).any(|c| c != ' ' && (c.is_whitespace() || c.is_control())) {
        return false;
    }
    let shell = plain_words(command).and_then(|w| match w.as_slice() {
        [sh, flag, script]
            if matches!(sh.as_str(), "/bin/sh" | "/bin/bash" | "/bin/zsh")
                && matches!(flag.as_str(), "-c" | "-lc") =>
        {
            Some(script.clone())
        }
        _ => None,
    });
    let line = shell.as_deref().unwrap_or(command);
    let words = |c: &str| plain_words(c).unwrap_or_default();
    let is = |w: &[String], first: &[&str]| {
        w.len() >= first.len() && w.iter().zip(first).all(|(a, b)| a == b)
    };
    // The one pipe outside quotes: what's before it is plain words only if that's it.
    let piped = (line.match_indices('|')).find_map(|(at, _)| {
        let (text, call) = (words(&line[..at]), words(&line[at + 1..]));
        (!text.is_empty() && !call.is_empty()).then_some((text, call))
    });
    match piped {
        Some((text, call)) => {
            (is(&text, &["echo"]) || is(&text, &["printf"]))
                && is(&call, &["brigadier", "computer"])
        }
        None => is(&words(line), &["brigadier", "computer"]),
    }
}

/// What a session allow of one plain `brigadier mcp tools <server>` or `mcp call <server> <tool>`
/// covers: that server's list, or that tool with any arguments, as an MCP tool's own allow does;
/// never another server's or tool's, as a CLI's suggested `brigadier mcp *` would [D3023].
pub fn mcp_prefix(command: &str) -> Option<String> {
    let words = past_cd(command.trim()).and_then(plain_words)?;
    let words: Vec<&str> = words.iter().map(String::as_str).collect();
    let covers = match words.as_slice() {
        ["brigadier", "mcp", "tools", _, ..] => &words[..4],
        ["brigadier", "mcp", "call", _, _, ..] => &words[..5],
        _ => return None,
    };
    let name = |w: &&str| {
        w.chars()
            .all(|c| c.is_ascii_alphanumeric() || "_-:.".contains(c))
    };
    (covers[3..]
        .iter()
        .all(|w| !w.is_empty() && !w.starts_with('-') && name(w)))
    .then(|| covers.join(" "))
}

/// Whether `url`'s host is one a local development server answers on: localhost, *.localhost,
/// 127.x, 0.0.0.0 and [::1] [D507].
pub fn local_address(url: &str) -> bool {
    let Some((_, rest)) = url.trim().split_once("://") else {
        return false;
    };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    let host = authority
        .rsplit('@')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    if let Some(after) = host.strip_prefix("[::1]") {
        return after.is_empty() || after.starts_with(':');
    }
    let host = host.split(':').next().unwrap_or_default();
    let loopback = host.strip_prefix("127.").is_some_and(|rest| {
        let parts: Vec<&str> = rest.split('.').collect();
        parts.len() == 3
            && (parts.iter()).all(|p| (1..=3).contains(&p.len()) && p.parse::<u8>().is_ok())
    });
    host == "localhost" || host.ends_with(".localhost") || host == "0.0.0.0" || loopback
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

/// A command's words when it has no shell syntax but quotes; None when it has any. Inside double
/// quotes `\$`, `` \` ``, `\"` and `\\` are the literal character, as the shell passes them.
pub(crate) fn plain_words(c: &str) -> Option<Vec<String>> {
    let (mut words, mut word, mut quote, mut open) = (vec![], String::new(), None, false);
    let mut escaped = false;
    for ch in c.chars() {
        if std::mem::take(&mut escaped) {
            match ch {
                '$' | '`' | '"' | '\\' => word.push(ch),
                '\n' | '!' => return None,
                ch => word.extend(['\\', ch]),
            }
            continue;
        }
        match (quote, ch) {
            (_, '\n') => return None,
            (Some('\''), '\'') | (Some('"'), '"') => quote = None,
            (Some('"'), '\\') => escaped = true,
            (Some('"'), '$' | '`' | '!') => return None,
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
    let mut vars = vec![
        (SESSION.into(), spec.dir.display().to_string()),
        (GRANT.into(), token),
        ("BRIGADIER_DATA".into(), data),
        // The standing line's folder; without it an agent makes its own.
        (
            "TMPDIR".into(),
            crate::background::temp(&spec.dir).display().to_string(),
        ),
    ];
    vars.extend(browser_shim().map(|shim| ("BROWSER".into(), shim)));
    Some((me.parent()?.display().to_string(), vars))
}

/// `BROWSER` in an agent's shell, for `vite --open`, `"$BROWSER" <url>` and the like, the same for
/// every adapter: a local page opens in a tab of Brigadier's browser with the session's grant;
/// the daemon refuses when the user's local links open elsewhere, and any refusal or failure
/// goes to the default browser. Ported from the old app's AGENT_BROWSER_SHIM [D507, D516].
const BROWSER_SHIM: &str = r#"#!/bin/sh
case "$1" in
  http://localhost*|https://localhost*|http://127.*|https://127.*|http://0.0.0.0*|https://0.0.0.0*|http://\[::1\]*|https://\[::1\]*|http://*.localhost*|https://*.localhost*)
    if brigadier browser open "$1" --keep --dev-url >/dev/null 2>&1; then exit 0; fi ;;
esac
if command -v open >/dev/null 2>&1; then exec open "$1"; fi
exec xdg-open "$1"
"#;

/// The shim's path, the same for every launch and written only when it differs; in the temp
/// folder, since a path with a space breaks some openers. A shell without it still works, so a
/// failure isn't reported.
fn browser_shim() -> Option<String> {
    let folder = std::env::temp_dir().join("brigadier-open");
    let shim = folder.join("agent-browser");
    if std::fs::read_to_string(&shim).ok().as_deref() != Some(BROWSER_SHIM) {
        std::fs::create_dir_all(&folder).ok()?;
        std::fs::write(&shim, BROWSER_SHIM).ok()?;
        let mode = std::os::unix::fs::PermissionsExt::from_mode(0o700);
        std::fs::set_permissions(&shim, mode).ok()?;
    }
    Some(shim.display().to_string())
}
