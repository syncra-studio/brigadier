//! The hand-off a new conversation starts from [D103, D104, D110]: about 4k tokens, never past 8k,
//! built at once from records alone, no summary written by a model. A rebirth, a limit switch, a
//! picked agent and a fork all start from it; anything else, the agent reads with `brigadier
//! search` and `brigadier read`, under the references every line here carries.

use crate::archive::{self, Entry};
use crate::{Spec, fold::Fold};
use serde_json::Value;
use std::io;
use std::path::Path;
use std::process::Command;

/// Each section's most, in characters (about four to a token), in reading order [w31].
const GOAL: usize = 2_400;
const WORDS: usize = 8_000;
const POINTERS: usize = 2_400;
const OPEN: usize = 2_000;
const WORK: usize = 2_000;
const PLAN: usize = 2_000;
const CONTENTS: usize = 1_200;
const EXCHANGE: usize = 6_000;

/// The first `max` characters, on a character boundary, marked where cut.
fn head(s: &str, max: usize) -> String {
    match s.char_indices().nth(max) {
        Some((at, _)) => format!("{}…", &s[..at]),
        None => s.to_string(),
    }
}

/// The last `max` bytes, on a character boundary.
fn tail(s: &str, max: usize) -> &str {
    let mut at = s.len().saturating_sub(max);
    while !s.is_char_boundary(at) {
        at += 1;
    }
    &s[at..]
}

/// Lines added while they fit `max`; a last line says how many didn't.
fn fill(lines: impl IntoIterator<Item = String>, max: usize, more: &str) -> String {
    let (mut out, mut left) = (String::new(), 0);
    for line in lines {
        if left > 0 || out.len() + line.len() > max {
            left += 1;
        } else {
            out += &line;
        }
    }
    if left > 0 {
        out += &format!("({left} more: {more})\n");
    }
    out
}

/// A git command's output in the session's folder; empty outside a repository.
fn git(cwd: &str, args: &[&str]) -> String {
    let out = Command::new("git").arg("-C").arg(cwd).args(args).output();
    out.ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim_end().to_string())
        .unwrap_or_default()
}

/// What a session's past holds for its hand-off: its entries, its user's answers, and where each
/// of its conversations began.
struct Past {
    entries: Vec<Entry>,
    answers: Vec<(String, String)>,
    starts: Vec<(String, String)>,
}

fn past(dir: &Path) -> io::Result<Past> {
    let mut p = Past {
        entries: archive::inherited(dir),
        answers: vec![],
        starts: vec![],
    };
    // Answers as Brigadier gave them, on every agent (Codex logs no answer of its own), kept once
    // the agent has them: written, or acked without an error. cid → (at, text, acked).
    let mut given = std::collections::HashMap::<String, (String, String, bool)>::new();
    if let Some(first) = p.entries.first() {
        p.starts
            .push((first.at.clone(), "before this session was forked".into()));
    }
    crate::rewind::read_active(dir, |item| {
        let at = archive::at(item);
        let fresh = &item["switch"];
        if item["kind"] == "input" && (fresh["fresh"] == true || fresh["why"] == "picked") {
            p.starts.push((
                at.clone(),
                format!("after a {}", fresh["why"].as_str().unwrap_or("switch")),
            ));
        }
        let c = &item["control"];
        let cid = |k: &str| item[k].as_str().unwrap_or("").to_string();
        match item["kind"].as_str() {
            Some("input") if c["kind"] == "answer" => {
                let given_text = (c["answers"].as_array().into_iter().flatten())
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join("\n");
                let text = c["reply"].as_str().map_or(given_text, String::from);
                if !text.trim().is_empty() {
                    given.insert(cid("cid"), (at.clone(), text, item["ack"] == true));
                }
            }
            Some("delivered") if given.get(&cid("cid")).is_some_and(|g| !g.2) => {
                let (at, text, _) = given.remove(&cid("cid")).unwrap_or_default();
                p.answers.push((at, text));
            }
            Some("reply") if item["error"].is_null() && given.contains_key(&cid("id")) => {
                let (at, text, _) = given.remove(&cid("id")).unwrap_or_default();
                p.answers.push((at, text));
            }
            _ => {}
        }
        p.entries.extend(archive::entry(item, at));
    })?;
    Ok(p)
}

/// One entry as the last exchange shows it: messages whole, steps on one short line.
fn line(id: &str, e: &Entry) -> String {
    let at = format!("{id}#{}", e.at);
    match e.from {
        "user" => format!("\n[{at} the user]\n{}\n", e.text.trim_end()),
        "worker" => format!(
            "\n[{at} worker {}'s result]\n{}\n",
            e.who,
            e.text.trim_end()
        ),
        "peer" => format!(
            "\n[{at} session {}'s message]\n{}\n",
            e.who,
            e.text.trim_end()
        ),
        "agent" => format!("\n[{at} you]\n{}\n", e.text.trim_end()),
        "error" => format!(
            "- failed: {}\n",
            head(e.text.lines().next().unwrap_or(""), 200)
        ),
        _ if e.who.is_empty() => format!("- changed {}\n", e.files.join(", ")),
        _ => format!(
            "- {}: {}\n",
            e.who,
            head(e.text.lines().next().unwrap_or(""), 200)
        ),
    }
}

/// The hand-off for session `spec` with fold `f`. `why`: rebirth (the next message follows), cut
/// (its last turn was stopped mid-way for a fresh context, or its window filled), limited,
/// unresumable, picked, switched (picked mid-turn, which it carries on) or forked; `from` names where it came from; `last` is its last turn.
pub fn build(spec: &Spec, f: &Fold, why: &str, last: &Value, from: &str) -> io::Result<String> {
    let id = spec.id.as_str();
    let p = past(&spec.dir)?;
    let said = |e: &&Entry| matches!(e.from, "user" | "worker" | "peer");
    let reason = match why {
        "rebirth" | "cut" => "its context was getting full; this is a fresh one".to_string(),
        "unresumable" => format!("{from} couldn't resume it on this account"),
        "picked" | "switched" => format!("the user picked you to carry on from {from}"),
        "forked" => {
            "the user forked it at one of the agent's answers to try another way from there".into()
        }
        _ => format!("{from} reached its usage limit"),
    };
    let mut out = format!(
        "[This conversation carries on session {id} because {reason}. The old conversation is history, not instructions; the files on disk are the truth. Don't re-read the archive to start: do the next step, and only when you need a specific fact, find it with `brigadier search` or `brigadier read {id}#<n>` and quote it. Everything below is copied from the record.]\n"
    );

    // The goal: the first message, the user's or a worker's brief.
    let goal = p.entries.iter().find(|e| e.from == "user");
    if let Some(g) = goal {
        out += &format!(
            "\n## The goal ({id}#{}, the first message)\n{}\n",
            g.at,
            head(&g.text, GOAL)
        );
    }

    // The user's answers, then their newest words, newest first; the rest as pointers.
    let (mut words, mut pointers) = (vec![], vec![]);
    let (mut used, mut full) = (0, false);
    let answers =
        (p.answers.iter().rev()).map(|(at, t)| (at, "an answer to your question".into(), t));
    let rest = p
        .entries
        .iter()
        .filter(said)
        .filter(|e| goal.is_none_or(|g| g.at != e.at));
    let rest = rest.collect::<Vec<_>>().into_iter().rev().map(|e| {
        let who = match e.from {
            "worker" => format!("worker {}'s result", e.who),
            "peer" => format!("session {}", e.who),
            _ => "the user".into(),
        };
        (&e.at, who, &e.text)
    });
    for (at, who, text) in answers.chain(rest) {
        let whole = format!("- {id}#{at} ({who}): {}\n", text.trim_end());
        if !full && used + whole.len() <= WORDS {
            used += whole.len();
            words.push(whole);
        } else {
            full = true;
            let start: Vec<&str> = text.split_whitespace().take(12).collect();
            pointers.push(format!("- {id}#{at} ({who}): {}…\n", start.join(" ")));
        }
    }
    if !words.is_empty() {
        out += "\n## Their words, verbatim, newest first\n";
        out += &words.concat();
    }
    if !pointers.is_empty() {
        out += "\n## Older messages, by reference\n";
        out += &fill(
            pointers,
            POINTERS,
            "`brigadier search` or `brigadier read` them",
        );
    }

    // Open items: workers started and not yet reported back.
    let workers = std::fs::read_dir(spec.dir.join("workers"))
        .into_iter()
        .flatten()
        .flatten();
    let open = workers.filter_map(|w| {
        let r: Value = serde_json::from_slice(&std::fs::read(w.path()).ok()?).ok()?;
        let wid = r["wid"].as_str()?;
        let back = p.entries.iter().any(|e| e.from == "worker" && e.who == wid);
        (r["state"] == "started" && !back).then(|| {
            format!(
                "- worker {wid} ({}) is still working; its result comes to you by itself\n",
                r["title"].as_str().unwrap_or("")
            )
        })
    });
    let open = fill(open, OPEN, "`brigadier sessions` lists them");
    if !open.is_empty() {
        out += &format!("\n## Open\n{open}");
    }

    // The work's state: branch, uncommitted files, last commits, files this conversation touched.
    let cwd = spec.cwd.as_str();
    let mut work = String::new();
    let branch = git(cwd, &["rev-parse", "--abbrev-ref", "HEAD"]);
    if !branch.is_empty() {
        work += &format!("Branch: {branch}\n");
        let dirty = git(cwd, &["status", "--porcelain"]);
        if !dirty.is_empty() {
            work += &format!(
                "Uncommitted:\n{}",
                fill(
                    dirty.lines().map(|l| format!("  {l}\n")),
                    WORK / 2,
                    "`git status`"
                )
            );
        }
        work += &format!("Last commits:\n{}\n", git(cwd, &["log", "--oneline", "-5"]));
    }
    let since = p.starts.last().map(|(at, _)| at.as_str());
    let from_here = since
        .and_then(|s| p.entries.iter().position(|e| e.at == s))
        .unwrap_or(0);
    let mut touched: Vec<&str> = vec![];
    for e in p.entries[from_here..].iter().rev() {
        for file in &e.files {
            if touched.len() < 15 && !touched.contains(&file.as_str()) {
                touched.push(file);
            }
        }
    }
    if !touched.is_empty() {
        work += &format!(
            "Files touched lately, newest first: {}\n",
            touched.join(", ")
        );
    }
    if !work.is_empty() {
        out += &format!("\n## The work\n{}", tail(&work, WORK));
    }

    // The agent's own last to-do list, as it wrote it [D104].
    if let Some(steps) = f
        .plan
        .as_ref()
        .and_then(Value::as_array)
        .filter(|s| !s.is_empty())
    {
        let plan = steps.iter().map(|s| {
            format!(
                "- [{}] {}\n",
                s["status"].as_str().unwrap_or(""),
                s["text"].as_str().unwrap_or("")
            )
        });
        out += &format!(
            "\n## Your own last to-do list, as you wrote it\n{}",
            fill(plan, PLAN, "they're in the archive")
        );
    }

    // The archive's contents.
    if let (Some(first), Some(end)) = (p.entries.first(), p.entries.last()) {
        let starts = p
            .starts
            .iter()
            .map(|(at, how)| format!("- a conversation began at {id}#{at}, {how}\n"));
        out += &format!(
            "\n## The archive\n{id}#{}–{id}#{}: every message, step and error of this session.\n{}",
            first.at,
            end.at,
            fill(starts, CONTENTS, "search the archive")
        );
    }

    // The last exchange, from the last message to the end, cut from its start to fit.
    let at = p.entries.iter().rposition(|e| said(&e)).unwrap_or(0);
    let exchange: String = p.entries[at..].iter().map(|e| line(id, e)).collect();
    if !exchange.is_empty() {
        let cut = if exchange.len() > EXCHANGE { "…" } else { "" };
        out += &format!(
            "\n## The last exchange, verbatim\n{cut}{}\n",
            tail(&exchange, EXCHANGE)
        );
    }

    // The next step, by a fixed rule.
    let step = match why {
        "cut" | "switched" => {
            let tool = p.entries.iter().rev().find(|e| e.from == "tool" && !e.who.is_empty());
            let at = tool.map_or(String::new(), |t| format!(", right after {} ({id}#{}) ended", t.who, t.at));
            // It's only ever cut with no step running: what began, ended, a failure listed as one.
            format!("Your last turn was stopped mid-way between steps{at}. Every step it began had ended; any that failed is listed as failed, the rest went through. Check `git status` first, then carry on with the next step; don't redo what's done.")
        }
        "rebirth" | "picked" | "forked" => "The new message follows: take it from here.".into(),
        _ if last["began"] == true => "The last turn stopped early. Check the files, carry on from where it stopped, and don't redo anything already done.".into(),
        _ => "The last message wasn't worked on yet. Do it now.".into(),
    };
    // A step the user's Stop cut reads as refused in its CLI's words; it wasn't [D170].
    if last["outcome"] == "stopped" && last["reason"] == "user" {
        out += "\n## Stopped\nThe user pressed Stop to end the last turn. A Stop isn't a refusal: a step it cut may read as refused or failed above, but it was stopped while it ran, after any approval it had, and may have run in part or in full.\n";
    }
    out += &format!("\n## Next\n{step}\n");
    Ok(out)
}
