//! `brigadier terminal …`, the agent's [D317, D318, D320]: its session's terminal tabs and `!`
//! commands listed and read a page at a time as plain text, never streamed to it; and a terminal
//! tab opened for the user, a line typed into it.

use super::shell::{ended, plain};
use super::{live, start, tail, terminals};
use brigadier_core::{self as core, TERM};
use serde_json::{Value, json};
use std::fs;
use std::path::Path;

pub const HELP: &str =
    "brigadier terminal list | read <id> [--lines N] [--from L] | open [--run \"<line>\"] [--json]

Your session's terminals: the user's terminal tabs (t-…) and the `!` commands they ran in your
composer (c-…). `list` names each: what runs or ran, running or how it ended, and its line count.
`read <id>` prints its output as plain text, its last 200 lines by default; --lines N (at most 1000)
and --from L (its first line, from 1) page through all of it. A tab's text is what it printed, not
its screen, so a full-screen program reads poorly. `open` opens a terminal tab for the user in your
session's folder, behind for a worker. --run types \"<line>\" into it, run at once when your session
runs at full permission; else it waits there for the user's Enter. Use it for what the user will
watch or keep (a dev server); run your own commands in your own shell.";

/// What one read prints at most, so its header and hints are never cut.
const PAGE: usize = 12 << 10;
/// A whole output read for paging: plenty for a dev server's session.
// shortcut: reads and plains the whole log on each call; keep an index of line offsets if logs get huge.
const WHOLE: usize = 64 << 20;

/// `words`: the subcommand and its words, past `terminal`.
pub fn run(data: &Path, me: &str, words: &[&str]) -> Value {
    let flag = |name: &str| {
        (words.iter())
            .position(|w| *w == name)
            .and_then(|i| words.get(i + 1))
    };
    let number = |name: &str| flag(name).map(|v| v.parse::<usize>().ok().filter(|n| *n >= 1));
    match words.first().copied() {
        Some("list") => list(data, me),
        Some("read") => match (
            words.get(1).filter(|id| !id.starts_with('-')),
            number("--lines"),
            number("--from"),
        ) {
            (None, ..) => refuse(
                "`brigadier terminal read` needs an id: `brigadier terminal list` lists them.",
            ),
            (_, Some(None), _) | (_, _, Some(None)) => {
                refuse("--lines and --from take a whole number from 1.")
            }
            (Some(id), lines, from) => read(
                data,
                me,
                id,
                lines.flatten().unwrap_or(200).min(1000),
                from.flatten(),
            ),
        },
        Some("open") => open(data, me, flag("--run").copied()),
        _ => refuse(
            "`brigadier terminal` takes list, read <id> or open. `brigadier terminal --help` shows how.",
        ),
    }
}

fn refuse(message: &str) -> Value {
    json!({"ok": false, "error": message})
}

/// The caller's `!` commands whose output is kept, by id, oldest first (by its mark's birth: its
/// end rewrites it). An archive drops their output; their rows keep its tail.
pub(super) fn commands(data: &Path, me: &str) -> Vec<String> {
    let dir = core::session_dir(data, me).join("commands");
    let kept = |id: &str| {
        core::session_dir(data, &format!("{TERM}{id}"))
            .join("log")
            .exists()
    };
    let mut all: Vec<(std::time::SystemTime, String)> =
        (fs::read_dir(dir).into_iter().flatten().flatten())
            .map(|e| {
                let at = e.metadata().and_then(|m| m.created().or(m.modified()));
                (
                    at.unwrap_or(std::time::UNIX_EPOCH),
                    e.file_name().to_string_lossy().to_string(),
                )
            })
            .filter(|(_, id)| kept(id))
            .collect();
    all.sort();
    all.into_iter().map(|(_, id)| id).collect()
}

/// The line a command ran: its spawn's last word.
pub(super) fn line_of(dir: &Path) -> String {
    use brigadier_frames::log::{self, Reader};
    let mut r = Reader::open(&dir.join("log"), 0, 0).ok();
    while let Some(Ok(Some(f))) = r.as_mut().map(|r| r.next_with(|k| k == log::SPAWNED)) {
        if f.kind == log::SPAWNED {
            let v: Value = serde_json::from_slice(&f.data).unwrap_or_default();
            return v["argv"]
                .as_array()
                .and_then(|a| a.last())
                .and_then(Value::as_str)
                .unwrap_or("")
                .into();
        }
    }
    String::new()
}

pub(super) fn text_of(data: &Path, id: &str) -> String {
    plain(&tail(
        &core::session_dir(data, &format!("{TERM}{id}")),
        WHOLE,
    ))
}

fn list(data: &Path, me: &str) -> Value {
    let mut rows = vec![];
    for tab in terminals(data, me) {
        let running = live(data, &format!("{TERM}{tab}"));
        rows.push(json!({"id": tab, "kind": "tab", "running": running, "lines": text_of(data, &tab).lines().count()}));
    }
    for cmd in commands(data, me) {
        let dir = core::session_dir(data, &format!("{TERM}{cmd}"));
        let end = ended(&dir);
        let mut row = json!({"id": cmd, "kind": "command", "command": line_of(&dir), "running": end.is_none() && live(data, &format!("{TERM}{cmd}")), "lines": text_of(data, &cmd).lines().count()});
        if let Some((code, signal, from, to)) = end {
            (row["exitCode"], row["signal"], row["ms"]) =
                (code, signal, to.saturating_sub(from).into());
        }
        rows.push(row);
    }
    let text = match rows.is_empty() {
        true => {
            "No terminals: the user has no terminal tab open here and ran no ! command.".to_string()
        }
        false => (rows.iter())
            .map(|r| {
                let what = match r["kind"] == "tab" {
                    true => "terminal tab".to_string(),
                    false => format!(
                        "! {}",
                        r["command"]
                            .as_str()
                            .unwrap_or("")
                            .chars()
                            .take(120)
                            .collect::<String>()
                    ),
                };
                let state = match (r["running"] == true, &r["exitCode"]) {
                    (true, _) => "running".to_string(),
                    (false, Value::Number(code)) => format!("exit {code}"),
                    (false, _) if r["signal"].is_string() || r["signal"].is_number() => {
                        "stopped".into()
                    }
                    _ => "ended".into(),
                };
                let n = r["lines"].as_u64().unwrap_or(0);
                let id = r["id"].as_str().unwrap_or("");
                format!(
                    "{id}  {what}  {state}  {n} line{}",
                    if n == 1 { "" } else { "s" }
                )
            })
            .collect::<Vec<_>>()
            .join("\n"),
    };
    json!({"ok": true, "terminals": rows, "text": text})
}

fn read(data: &Path, me: &str, id: &str, n: usize, from: Option<usize>) -> Value {
    let id = id.to_string();
    if !terminals(data, me).contains(&id) && !commands(data, me).contains(&id) {
        return refuse(&format!(
            "No terminal {id:?} in your session. `brigadier terminal list` lists them."
        ));
    }
    let text = text_of(data, &id);
    let lines: Vec<&str> = text.lines().collect();
    let total = lines.len();
    let (start, end) = page(&lines, n, from);
    let mut out = format!(
        "{id}: lines {}–{end} of {total}",
        (start + 1).min(end.max(1))
    );
    if start > 0 {
        out += &format!(" · earlier: --from {}", start.saturating_sub(n) + 1);
    }
    if end < total {
        out += &format!(" · later: --from {}", end + 1);
    }
    out += "\n\n";
    // A line longer than a page shows cut, so a read always moves on.
    let shown = lines[start..end].join("\n");
    out += &shown[..shown.floor_char_boundary(PAGE)];
    json!({"ok": true, "id": id, "from": start + 1, "to": end, "total": total, "text": out})
}

/// The lines a read shows, `[start, end)`: `n` from line `from`, else the last `n`, cut to a
/// page from the end it reads away from; always one line at least, when there is one.
fn page(lines: &[&str], n: usize, from: Option<usize>) -> (usize, usize) {
    let total = lines.len();
    let (mut start, mut end) = match from {
        Some(f) => ((f - 1).min(total), (f - 1 + n).min(total)),
        None => (total.saturating_sub(n), total),
    };
    while end - start > 1 && lines[start..end].iter().map(|l| l.len() + 1).sum::<usize>() > PAGE {
        match from {
            Some(_) => end -= 1,
            None => start += 1,
        }
    }
    (start, end)
}

/// A terminal tab on the caller's session, behind for a worker [D519]; `line` typed in, its Enter
/// only at full permission, so it never runs past the session's level [D318].
fn open(data: &Path, me: &str, line: Option<&str>) -> Value {
    let tab = format!("t-{}", crate::control::new_cid());
    let behind = crate::workers::link(data, me).is_some();
    let mut args: Vec<String> = ["tabs", me, "open", &tab, "terminal"]
        .map(String::from)
        .into();
    if behind {
        args.push("--behind".into());
    }
    let full = core::load(data, me).is_ok_and(|s| s.level.as_deref() == Some("full"));
    let keys = line.map(|l| {
        if full {
            format!("{l}\r")
        } else {
            l.to_string()
        }
    });
    let opened = crate::tabs::run(data, &args)
        .and_then(|_| start(data, me, &tab, false, (None, None), keys.as_deref()));
    match opened {
        Err(e) => refuse(&e.to_string()),
        Ok(_) => {
            let ran = match (line, full) {
                (None, _) => String::new(),
                (Some(_), true) => ", running your line".into(),
                (Some(_), false) => ", your line typed in for the user's Enter (your session isn't at full permission)".into(),
            };
            json!({"ok": true, "id": tab, "text": format!("Opened terminal {tab}{ran}. `brigadier terminal read {tab}` reads it.")})
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{PAGE, page};

    #[test]
    fn pages_cover_everything_and_fit() {
        let lines: Vec<String> = (1..=5000).map(|i| i.to_string()).collect();
        let lines: Vec<&str> = lines.iter().map(String::as_str).collect();
        assert_eq!(page(&lines, 200, None), (4800, 5000));
        assert_eq!(page(&lines, 200, Some(1)), (0, 200));
        assert_eq!(page(&lines, 200, Some(4999)), (4998, 5000));
        assert_eq!(page(&lines, 200, Some(9000)), (5000, 5000));
        let wide = "x".repeat(100);
        let wide: Vec<&str> = vec![wide.as_str(); 1000];
        let (start, end) = page(&wide, 1000, None);
        assert!(end == 1000 && (end - start) * 101 <= PAGE);
        let huge = "y".repeat(PAGE * 2);
        assert_eq!(page(&[huge.as_str(), "z"], 10, Some(1)), (0, 1));
    }
}
