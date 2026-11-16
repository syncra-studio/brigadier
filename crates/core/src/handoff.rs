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
    answers: Vec<(String, String)>,
    starts: Vec<(String, String)>,
    stopped: bool,
}

/// `tails`: a step's output also shows its end, not only its size and reference [D485].
fn past(spec: &Spec, tails: bool) -> io::Result<Past> {
    let dir = spec.dir.as_path();
    let mut p = Past {
        entries: archive::inherited(dir),
        answers: vec![],
        starts: vec![],
        stopped: false,
    };
    // Answers as Brigadier gave them, on every agent (Codex logs no answer of its own), kept once
    // the agent has them: written, or acked without an error. cid → (at, text, acked).
    let mut given = std::collections::HashMap::<String, (String, String, bool)>::new();
    if let Some(first) = p.entries.first() {
        p.starts
            .push((first.at.clone(), "before this session was forked".into()));
    }
    // Inside a stop (Brigadier's own: a rebirth, a picked model or level, the guard; or the
    // user's): a step it ended may read as refused in its CLI's words; nobody refused it.
    let mut cutting = String::new();
    // A step's entry by its tool id, for its output's pointer once it's done.
    let mut steps = std::collections::HashMap::<String, usize>::new();
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
        p.entries.extend(archive::entry(item, at).map(|mut e| {
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
    Ok(p)
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

    // The goal: the first message, the user's or a worker's brief. With newer words, they come
    // first and it follows them as history: it may be done already, so it isn't redone [D108].
    let goal = p.entries.iter().find(|e| e.from == "user");
    let newest = p.entries.iter().rev().find(|e| said(e));
    let later = newest.filter(|n| goal.is_some_and(|g| n.at != g.at));
    let first = goal.map_or(String::new(), |g| match later {
        Some(n) => format!(
            "\n## The first message ({id}#{}), history: the newest words, {id}#{}, are what's asked now\n{}\n",
            g.at, n.at, head(&g.text, GOAL)
        ),
        None => format!("\n## The goal ({id}#{}, the first message)\n{}\n", g.at, head(&g.text, GOAL)),
    });
    if later.is_none() {
        out += &first;
    }

    // The skills the user's messages invoked: a fresh agent gets their `/name` as plain text.
    let mut names: Vec<String> = (crate::adapters::all().iter())
        .flat_map(|a| a.fixed_commands(Some(Path::new(&spec.cwd)), None))
        .filter(|k| k["kind"] == "skill")
        .filter_map(|k| k["name"].as_str().map(String::from))
        .collect();
    names.sort();
    names.dedup();
    let skills: String = (names.iter()).filter_map(|name| {
        let mut user = p.entries.iter().filter(|e| e.from == "user");
        let e = user.find(|e| e.text.split_whitespace().any(|w| w.strip_prefix('/') == Some(name)))?;
        Some(format!("- /{name}, from {id}#{}: load it before you go on, with your own skill tool or `brigadier skill {name}`\n", e.at))
    }).collect();
    if !skills.is_empty() {
        out += &format!("\n## The session's skills\n{skills}");
    }

    // The user's answers, then their newest words, newest first; the rest as pointers.
    let (mut words, mut pointers) = (vec![], vec![]);
    let (mut used, mut full) = (0, false);
    let answers = (p.answers.iter().rev())
        .map(|(at, t)| (at, "an answer to your question".into(), String::new(), t));
    let rest = (p.entries.iter().enumerate())
        .filter(|(_, e)| said(e) && goal.is_none_or(|g| g.at != e.at));
    let rest = rest.collect::<Vec<_>>().into_iter().rev().map(|(i, e)| {
        let who = match e.from {
            "worker" => format!("worker {}'s result", e.who),
            "peer" => format!("session {}", e.who),
            _ => "the user".into(),
        };
        // A short answer reads with what it answered: your message just before it, its numbered
        // items for a numbered answer, the list it ends with, or else its end.
        let asked = (p.entries[..i].iter().rev())
            .find(|q| q.from == "agent")
            .filter(|_| e.from == "user" && e.text.split_whitespace().count() <= 5)
            .map_or(String::new(), |q| {
                let text = q.text.trim_end();
                let items: Vec<&str> = if e.text.lines().any(numbered) {
                    text.lines()
                        .filter(|l| numbered(l) && !l.starts_with(char::is_whitespace))
                        .collect()
                } else {
                    let run = text
                        .lines()
                        .rev()
                        .take_while(|l| l.trim().is_empty() || item(l));
                    let mut run: Vec<&str> = run.filter(|l| item(l)).collect();
                    run.reverse();
                    run
                };
                let items: Vec<String> = items.iter().map(|l| head(l.trim(), 300)).collect();
                let end = match items.is_empty() {
                    true => format!("…{}", tail(text, 300).replace('\n', " ")),
                    false => head(&items.join(" "), 600),
                };
                format!(", answering your {id}#{}: {end}", q.at)
            });
        (&e.at, who, asked, &e.text)
    });
    for (at, who, asked, text) in answers.chain(rest) {
        let whole = format!("- {id}#{at} ({who}{asked}): {}\n", text.trim_end());
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
    if later.is_some() {
        out += &first;
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
            let at = tool.map_or(String::new(), |t| format!(", its last step {} ({id}#{})", t.who, t.at));
            let asked = newest.map_or(String::new(), |n| format!(" of the newest message ({id}#{})", n.at));
            // Only a git checkout has a status to check.
            let check = if branch.is_empty() { "Carry on" } else { "Check `git status` first, then carry on" };
            format!("Brigadier stopped your last turn mid-way{at}; nobody refused anything. A step it stopped while starting is listed as stopped: redo it if still needed. Any other that failed is listed as failed, the rest went through. {check} with the next step{asked}; don't redo what's done, nor what an older message asked. A step above that returned output gives its size and reference: take what you need from it, or for a file read only the lines you need, rather than running it again.")
        }
        "rebirth" | "picked" | "forked" => "The new message follows: take it from here.".into(),
        _ if last["began"] == true => "The last turn stopped early. Check the files, carry on from where it stopped, and don't redo anything already done.".into(),
        _ => "The last message wasn't worked on yet. Do it now.".into(),
    };
    // A step the user's Stop cut reads as refused in its CLI's words; it wasn't [D170].
    if p.stopped {
        out += "\n## Stopped\nThe user pressed Stop on a turn since their last message. A Stop isn't a refusal: a step it cut may read as refused or failed above, but it was stopped while it ran, after any approval it had, and may have run in part or in full.\n";
    }
    out += &format!("\n## Next\n{step}\n");
    Ok(out)
}
