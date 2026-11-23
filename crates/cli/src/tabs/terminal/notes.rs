//! What the lead is told of its user's terminals [D316, D317, D320], with its next input or its
//! own `wait`, never waking it: each `!` command as it is then (its line, how it ended or that it
//! still runs, its newest output), and one line per terminal tab that printed more. Never the
//! whole stream: `brigadier terminal read` has the rest.

use super::agent::text_of;
use super::shell::ended;
use super::terminals;
use brigadier_core::{self as core, TERM};
use serde_json::{Value, json};
use std::fs;
use std::path::Path;

/// The newest commands told in full; older ones get a line of synopsis.
const FULL: usize = 3;
/// A full one's newest output: lines, then bytes.
const LINES: usize = 40;
const BYTES: usize = 2 << 10;
/// A command's line as told, in characters.
const COMMAND: usize = 300;
/// All of one input's commands; past it the oldest lose their output.
const TOTAL: usize = 7 << 10;

/// The words for `cmds` (oldest first) in session `sid`, and whether each had ended, so its end
/// isn't told again.
pub fn shell(data: &Path, sid: &str, cmds: &[String]) -> (String, Vec<bool>) {
    let mut done = vec![];
    let mut parts: Vec<(String, String)> = vec![];
    for (i, cmd) in cmds.iter().enumerate() {
        let dir = core::session_dir(data, &format!("{TERM}{cmd}"));
        let mark = core::session_dir(data, sid).join("commands").join(cmd);
        let over = fs::read_to_string(&mark).is_ok_and(|m| m == "ended");
        let end = ended(&dir);
        let how = match &end {
            Some((code, signal, from, to)) if signal.is_null() => {
                format!("exited {code} after {}", took(to.saturating_sub(*from)))
            }
            Some((_, _, from, to)) => {
                format!("was stopped after {}", took(to.saturating_sub(*from)))
            }
            None if over => "didn't run to an end (it failed to start, or its host ended)".into(),
            None => {
                let born = fs::metadata(&mark).and_then(|m| m.created()).ok();
                let ran = born
                    .and_then(|b| b.elapsed().ok())
                    .map_or(0, |d| d.as_millis() as u64);
                format!(
                    "is still running ({} so far; you'll hear when it ends)",
                    took(ran)
                )
            }
        };
        done.push(end.is_some() || over);
        let line: String = super::agent::line_of(&dir).chars().take(COMMAND).collect();
        let text = text_of(data, cmd);
        let lines: Vec<&str> = text.lines().collect();
        let read = format!("all of it: `brigadier terminal read {cmd}`");
        let head = format!("- `{line}` {how}; {} of output", count(lines.len(), "line"));
        let last = lines.iter().rev().find(|l| !l.trim().is_empty());
        let short = match last {
            Some(l) => format!(
                "{head}, ending \"{}\"; {read}",
                l.trim().chars().take(160).collect::<String>()
            ),
            None => format!("{head}; {read}"),
        };
        let full = match i + FULL >= cmds.len() && !lines.is_empty() {
            true => {
                let newest = lines[lines.len().saturating_sub(LINES)..].join("\n");
                let cut = newest.len().saturating_sub(BYTES);
                let newest = &newest[newest.ceil_char_boundary(cut)..];
                format!("{head}, the newest:\n```\n{newest}\n```\n  {read}")
            }
            false => short.clone(),
        };
        parts.push((full, short));
    }
    if parts.is_empty() {
        return (String::new(), done);
    }
    let sizes: Vec<(usize, usize)> = parts.iter().map(|(a, b)| (a.len(), b.len())).collect();
    let mut out = "\n\nThe user ran these in your session's folder with `!`, for your context, not as a request: act on one only if it bears on your work.".to_string();
    let kept = fit(&sizes, TOTAL);
    let left = kept.iter().filter(|k| **k == 0).count();
    if left > 0 {
        out += &format!("\n- …and {left} older: `brigadier terminal list`");
    }
    for ((full, short), k) in parts.iter().zip(&kept) {
        match k {
            2 => out += &format!("\n{full}"),
            1 => out += &format!("\n{short}"),
            _ => {}
        }
    }
    (out, done)
}

/// How each part goes in `total` bytes, given its (full, short) sizes: 2 full, 1 short, 0 left
/// out. The oldest give up their output first, then their line.
fn fit(sizes: &[(usize, usize)], total: usize) -> Vec<u8> {
    let mut kept = vec![2u8; sizes.len()];
    let size = |k: &[u8]| {
        (sizes.iter().zip(k))
            .map(|((a, b), k)| [0, *b, *a][*k as usize])
            .sum::<usize>()
    };
    for step in [1, 0] {
        for i in 0..sizes.len() {
            if size(&kept) <= total {
                return kept;
            }
            kept[i] = step;
        }
    }
    kept
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
