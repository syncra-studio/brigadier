//! What the agent is told of its user's terminals [D316, D317, D320]: each `!` command that ended,
//! as the user's own message (its line, how it ended, its newest output); with its next input or
//! its own `wait`, never waking it, each that still runs and one line per terminal tab that printed
//! more. Never the whole stream: `brigadier terminal read` has the rest.

use super::agent::text_of;
use super::terminals;
use brigadier_core::{self as core, TERM};
use serde_json::{Value, json};
use std::fs;
use std::path::Path;

/// A report's newest output: lines, then bytes.
const LINES: usize = 40;
const BYTES: usize = 2 << 10;
/// A command's line as told, in characters.
const COMMAND: usize = 300;
/// The most running commands told at a time, the newest.
const MOST: usize = 5;

/// A command that ended, as its user's message to the agent: `note` is its end's.
pub fn report(data: &Path, cmd: &str, line: &str, note: &Value) -> String {
    let ms = || took(note["ms"].as_u64().unwrap_or(0));
    let how = match note["progress"].as_str() {
        Some("done") => format!("It exited {} after {}", note["exitCode"], ms()),
        Some("cancelled") => format!("It was stopped after {}", ms()),
        _ => format!(
            "It failed: {}",
            note["error"].as_str().unwrap_or("it didn't run to an end")
        ),
    };
    let text = text_of(data, cmd);
    let lines: Vec<&str> = text.lines().collect();
    let newest = lines[lines.len().saturating_sub(LINES)..].join("\n");
    let cut = newest.ceil_char_boundary(newest.len().saturating_sub(BYTES));
    let shown = &newest[cut..];
    let out = match (text.trim().is_empty(), shown.len() < text.trim_end().len()) {
        (true, _) => ", with no output.".to_string(),
        (_, false) => format!(", with this output:\n```\n{shown}\n```"),
        _ => format!(
            ", with {} of output, the newest:\n```\n{shown}\n```\nAll of it: `brigadier terminal read {cmd}`",
            count(lines.len(), "line")
        ),
    };
    let line: String = line.chars().take(COMMAND).collect();
    format!("I ran `{line}` in the session's folder with `!`. {how}{out}")
}

/// The words for those of `cmds` (oldest first) that still run.
pub fn running(data: &Path, sid: &str, cmds: &[String]) -> String {
    let mark = |cmd: &str| core::session_dir(data, sid).join("commands").join(cmd);
    let mut out = String::new();
    for cmd in cmds.iter().skip(cmds.len().saturating_sub(MOST)) {
        let Some(line) = (fs::read_to_string(mark(cmd)).ok())
            .and_then(|m| m.strip_prefix('!').map(String::from))
        else {
            continue;
        };
        let line: String = line.chars().take(COMMAND).collect();
        out += &format!("\n- `{line}`; its output so far: `brigadier terminal read {cmd}`");
    }
    match out.is_empty() {
        true => out,
        false => format!(
            "\n\nThe user runs these in the session's folder with `!`; you'll hear when each ends:{out}"
        ),
    }
}

/// `n` and its noun, plural when it isn't 1.
fn count(n: usize, noun: &str) -> String {
    format!("{n} {noun}{}", if n == 1 { "" } else { "s" })
}

fn took(ms: u64) -> String {
    match ms / 1000 {
        _ if ms < 1000 => format!("{ms} ms"),
        s if s < 60 => format!("{:.1}s", ms as f64 / 1000.0),
        s if s < 3600 => format!("{}m {}s", s / 60, s % 60),
        s => format!("{}h {}m", s / 3600, s / 60 % 60),
    }
}

/// One line per terminal tab of `sid` that printed more since the lead was last told; a new
/// shell's prompt alone isn't news. Remembered once composed.
// shortcut: a told count is kept as composed, not as delivered; an input that then fails to send loses one notice line.
pub fn tabs(data: &Path, sid: &str) -> String {
    let path = core::session_dir(data, sid).join("terminals-told.json");
    let was: Value =
        serde_json::from_slice(&fs::read(&path).unwrap_or_default()).unwrap_or_default();
    let (mut now, mut out) = (json!({}), String::new());
    for tab in terminals(data, sid) {
        let dir = core::session_dir(data, &format!("{TERM}{tab}"));
        let size = fs::metadata(dir.join("log")).map_or(0, |m| m.len());
        let (seen, told) = (was[&tab][0].as_u64(), was[&tab][1].as_u64().unwrap_or(0));
        if seen == Some(size) {
            now[&tab] = was[&tab].clone();
            continue;
        }
        let lines = text_of(data, &tab).lines().count() as u64;
        if lines <= told + 1 {
            now[&tab] = json!([size, told]);
            continue;
        }
        now[&tab] = json!([size, lines]);
        out += &format!(
            "\n- {tab}: {} new; `brigadier terminal read {tab} --from {}`",
            count((lines - told) as usize, "line"),
            told + 1
        );
    }
    let _ = fs::write(&path, now.to_string());
    match out.is_empty() {
        true => out,
        false => format!(
            "\n\nThe user's terminal tabs printed more (read one only if it bears on your work):{out}"
        ),
    }
}
