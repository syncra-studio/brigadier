//! The hand-off a new conversation starts from [D103, D104, D110; repo-merge D86]: built at once
//! from records alone, the whole conversation oldest first, growing with it (b1). A rebirth, a
//! limit switch, a picked agent and a fork all start from it; anything else, the agent reads with
//! `brigadier search` and `brigadier read`, under the references every line here carries.

use crate::archive::{self, Entry};
use crate::{Spec, fold::Fold};
use serde_json::Value;
use std::io;
use std::path::Path;
use std::process::Command;

pub mod estimate;
mod open;
mod pointers;
mod records;

/// Each section's most, in characters (about four to a token), in reading order [w31].
const OPEN: usize = 2_000;
const WORK: usize = 2_000;
const PLAN: usize = 2_000;
const EXCHANGE: usize = 6_000;
const FILES: usize = 3_000;
/// The most of a `!` command's report among the user's words.
const SHELL: usize = 600;

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

/// A numbered list item's line: `1.` or `1)` first.
fn numbered(l: &str) -> bool {
    let l = l.trim_start();
    let n = l.bytes().take_while(u8::is_ascii_digit).count();
    n > 0 && matches!(l.as_bytes().get(n), Some(b'.' | b')'))
}

/// A list item's line, numbered or bulleted.
fn item(l: &str) -> bool {
    numbered(l)
        || ["- ", "* ", "• "]
            .iter()
            .any(|m| l.trim_start().starts_with(m))
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

/// What a session's past holds for its hand-off: its entries, its user's answers, where each of
/// its conversations began, and whether the user stopped a turn since their last message.
struct Past {
    entries: Vec<Entry>,
    /// Where, the text, and who gave it: the user, or Overnight, a reviewer, a parent (O50).
    answers: Vec<(String, String, String)>,
    starts: Vec<(String, String)>,
    turns: Vec<records::Turn>,
    stopped: bool,
}

/// `tails`: a step's output also shows its end, not only its size and reference [D485].
fn past(spec: &Spec, tails: bool) -> io::Result<Past> {
    let dir = spec.dir.as_path();
    let mut p = Past {
        entries: vec![],
        answers: vec![],
        starts: vec![],
        turns: vec![],
        stopped: false,
    };
    // Answers as Brigadier gave them, on every agent (Codex logs no answer of its own), kept once
    // the agent has them: written, or acked without an error. cid → (at, text, by, acked).
    let mut given = std::collections::HashMap::<String, (String, String, String, bool)>::new();
    // The messages the next turn takes, and whether one runs.
    let (mut waiting, mut running) = (vec![], false);
    // Inside a stop (Brigadier's own: a rebirth, a picked model or level, the guard; or the
    // user's): a step it ended may read as refused in its CLI's words; nobody refused it.
    let mut cutting = String::new();
    // A step's entry by its tool id, for its output's pointer once it's done.
    let mut steps = std::collections::HashMap::<String, usize>::new();
    // A fork's inherited copy first, under its `i<line>` references, then its own log.
    archive::each(dir, |item, at| {
        let fresh = &item["switch"];
        if item["kind"] == "input" && (fresh["fresh"] == true || fresh["why"] == "picked") {
            let on = [&item["backend"], &item["setup"]["model"]].map(|v| v.as_str().unwrap_or(""));
            p.starts.push((
                at.clone(),
                format!(
                    "after a {}, on {}",
                    fresh["why"].as_str().unwrap_or("switch"),
                    on.join(" ").trim()
                ),
            ));
        }
        let c = &item["control"];
        if item["kind"] == "input" && (c.is_null() || c["kind"] == "interrupt") {
            cutting = c["by"].as_str().unwrap_or("").into();
            if c.is_null() && item["origin"] == "user" {
                p.stopped = false;
            }
        }
        if item["kind"] == "stopped" && item["by"] == "user" {
            cutting = "user".into();
        }
        p.stopped |= cutting == "user";
        let cid = |k: &str| item[k].as_str().unwrap_or("").to_string();
        match item["kind"].as_str() {
            Some("input") if c["kind"] == "answer" => {
                if let Some(text) = archive::answer(item) {
                    let by = c["by"].as_str().unwrap_or("").to_string();
                    given.insert(cid("cid"), (at.clone(), text, by, item["ack"] == true));
                    took(&mut p.turns, &mut waiting, running, &at);
                }
            }
            Some("delivered") if given.get(&cid("cid")).is_some_and(|g| !g.3) => {
                let (at, text, by, _) = given.remove(&cid("cid")).unwrap_or_default();
                p.answers.push((at, text, by));
            }
            Some("reply") if item["error"].is_null() && given.contains_key(&cid("id")) => {
                let (at, text, by, _) = given.remove(&cid("id")).unwrap_or_default();
                p.answers.push((at, text, by));
            }
            Some("turn_start") => {
                let took = std::mem::take(&mut waiting);
                p.turns.push(records::Turn {
                    took,
                    ..Default::default()
                });
                running = true;
            }
            // A turn a stop cut is the carry-on's to answer; the user's Stop or Pause stopped it.
            Some("turn_end") if running => {
                if let Some(t) = p.turns.last_mut() {
                    t.end = match cutting.as_str() {
                        "user" | "pause" => "stopped",
                        "" if item["ok"] == false => "failed",
                        "" => "done",
                        _ => "cut",
                    };
                }
                running = false;
            }
            // A step's output stays in the log: the hand-off gives its size, end and reference.
            Some("tool_done") if item["ok"] != false => {
                let o = item["output"].as_str().unwrap_or("").trim_end();
                let step = (item["id"].as_str())
                    .and_then(|id| steps.get(id))
                    .and_then(|&i| p.entries.get_mut(i));
                if let Some(e) = step.filter(|e| e.from == "tool" && !o.is_empty()) {
                    let end = tail(o, 300);
                    let whole = end.len() == o.len();
                    let end = end.replace('\n', "\n    ");
                    // An output its end holds whole needs no reference.
                    e.out = match (tails, whole) {
                        (true, true) => format!("  returned:\n    {end}\n"),
                        _ => format!(
                            "  returned {} lines, {} chars; whole output: `brigadier read {}#{at}`\n",
                            o.lines().count(),
                            o.chars().count(),
                            spec.id
                        ),
                    };
                    if tails && !whole {
                        e.out += &format!("  it ends:\n    …{end}\n");
                    }
                }
            }
            _ => {}
        }
        let before = p.entries.len();
        // Answers come only by the delivered path above [D55].
        let entry = archive::entry(item, at.clone()).filter(|e| !e.answer);
        match entry.as_ref().map(|e| e.from) {
            Some("user" | "worker" | "peer") => took(&mut p.turns, &mut waiting, running, &at),
            Some("agent") => p
                .turns
                .last_mut()
                .into_iter()
                .for_each(|t| t.texts.push(at.clone())),
            _ => {}
        }
        p.entries.extend(entry.map(|mut e| {
            if e.from == "error" && item["kind"] == "tool_done" {
                e.from = match cutting.as_str() {
                    "rebirth" | "stall" => "cut",
                    "user" => "stopped",
                    _ => "error",
                };
            }
            e
        }));
        let id = item["id"].as_str().filter(|i| !i.is_empty());
        if let Some(id) = id.filter(|_| item["kind"] == "tool" && p.entries.len() > before) {
            steps.insert(id.to_string(), before);
        }
    })?;
    if let Some(first) = p.entries.first().filter(|e| e.at.starts_with('i')) {
        let start = (first.at.clone(), "before this session was forked".into());
        p.starts.insert(0, start);
    }
    Ok(p)
}

/// A message the running turn takes, steered in, or else the next turn.
fn took(turns: &mut [records::Turn], waiting: &mut Vec<String>, running: bool, at: &str) {
    match turns.last_mut().filter(|_| running) {
        Some(t) => t.took.push(at.into()),
        None => waiting.push(at.into()),
    }
}

/// One entry as the last exchange shows it: messages whole, steps on one short line, then where
/// their output is.
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
        "cut" => "- stopped mid-way by Brigadier, not refused: redo it if still needed\n".into(),
        "stopped" => "- stopped by the user's Stop after any approval it had, not refused: it may have run, so check before redoing it\n".into(),
        "error" => format!(
            "- failed: {}\n",
            head(e.text.lines().next().unwrap_or(""), 200)
        ),
        _ if e.who.is_empty() => format!("- changed {}\n", e.files.join(", ")),
        _ => format!(
            "- {}: {}\n{}",
            e.who,
            head(e.text.lines().next().unwrap_or(""), 200),
            e.out
        ),
    }
}

/// The hand-off for session `spec` with fold `f`. `why`: rebirth (the next message follows), cut
/// (its last turn was stopped mid-way for a fresh context, or its window filled), limited,
/// unresumable, picked, switched (picked mid-turn, which it carries on) or forked; `from` names where it came from; `last` is its last turn.
pub fn build(spec: &Spec, f: &Fold, why: &str, last: &Value, from: &str) -> io::Result<String> {
    let id = spec.id.as_str();
    // An output's end goes only to the same agent's fresh conversation [D485].
    let p = past(spec, matches!(why, "rebirth" | "cut"))?;
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

    let newest = p.entries.iter().rev().find(|e| said(e));
    // A fork in a folder of its own: the record's paths are the source's (O50).
    let was = crate::fork::record(&spec.dir).and_then(|r| r["cwd"].as_str().map(String::from));
    let was = was.filter(|w| *w != spec.cwd);
    if let Some(w) = &was {
        out += &format!(
            "\nThe session worked in {w}; you're in {}: paths under the first are now under this one.\n",
            spec.cwd
        );
    }

    // The skills the user's messages invoked: a fresh agent gets their `/name` as plain text.
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
        out += &format!("\n## The session's skills\n{skills}");
    }

    // The agent's own kept lines, whole: `brigadier keep` caps them [D87].
    let kept = crate::keeps::shown(&spec.dir);
    if !kept.is_empty() {
        out +=
            &format!("\n## Kept by you, as you wrote them (`brigadier keep` changes them)\n{kept}");
    }

    out += &records::conversation(id, &p);

    // What came with the messages, the newest first.
    let sent = (p.entries.iter().rev())
        .flat_map(|e| (e.sent.iter()).map(move |file| format!("- {id}#{}: {file}\n", e.at)));
    let sent = fill(sent, FILES, "they're in that folder");
    if !sent.is_empty() {
        let folder = crate::message::sent(&spec.dir);
        out += &format!(
            "\n## Files sent with the messages, in {}\n{sent}",
            folder.display()
        );
    }

    let open = open::items(spec, &p.entries);
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
            let base = [Some(spec.cwd.as_str()), was.as_deref()];
            let rel = base
                .into_iter()
                .flatten()
                .find_map(|b| file.strip_prefix(b)?.strip_prefix('/'));
            let file = rel.unwrap_or(file);
            if touched.len() < 15 && !touched.contains(&file) {
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
        .written
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

    // The last exchange, after the last message (the conversation has it), cut from its start.
    let at = p
        .entries
        .iter()
        .rposition(|e| said(&e))
        .map_or(0, |i| i + 1);
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
            let at = tool.map_or(String::new(), |t| format!(", its last step {} ({id}#{})", t.who, t.at));
            let asked = newest.map_or(String::new(), |n| format!(" of the newest message ({id}#{})", n.at));
            // Only a git checkout has a status to check.
            let check = if branch.is_empty() { "Carry on" } else { "Check `git status` first, then carry on" };
            // One sentence for each cause (O50, NF-2).
            let cause = match why {
                "switched" => format!("The user picked another agent or model while your last turn ran, so Brigadier stopped it mid-way{at}"),
                _ if last["outcome"] == "failed" && last["why"] == "context" => format!("The model's window refused your last turn{at}: the old conversation was too full to go on"),
                _ => format!("Brigadier stopped your last turn mid-way{at} to renew its full context"),
            };
            // Only a step its completion record says Brigadier cut is called stopped (O50, A7).
            let cut = p.entries.iter().rev().take_while(|e| !said(e)).any(|e| e.from == "cut");
            let cut = if cut { " A step it stopped while starting is listed as stopped: redo it if still needed." } else { "" };
            format!("{cause}; nobody refused anything.{cut} Any other that failed is listed as failed, the rest went through. {check} with the next step{asked}; don't redo what's done, nor what an older message asked. A step above that returned output gives its size and reference: take what you need from it, or for a file read only the lines you need, rather than running it again.")
        }
        "rebirth" | "picked" | "forked" => "The new message follows: take it from here.".into(),
        _ if last["began"] == true => "The last turn stopped early. Check the files, carry on from where it stopped, and don't redo anything already done.".into(),
        _ => "The last message wasn't worked on yet. Do it now.".into(),
    };
    // A step the user's Stop cut reads as refused in its CLI's words; it wasn't [D170].
    if p.stopped {
        out += "\n## Stopped\nThe user pressed Stop on a turn since their last message. A Stop isn't a refusal: a step it cut may read as refused or failed above, but it was stopped while it ran, after any approval it had, and may have run in part or in full.\n";
    }
    out += &pointers::section(id, &p);
    out += &format!("\n## Next\n{step}\n");
    Ok(out)
}
