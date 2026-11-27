//! The hand-off a new conversation starts from [D103, D104, D110; repo-merge D86]: built at once
//! from records alone, the whole conversation oldest first, growing with it (b1). A rebirth, a
//! limit switch, a picked agent and a fork all start from it; anything else, the agent reads with
//! `brigadier search` and `brigadier read`, under the references every line here carries. It
//! opens with the newest good summary the old conversation wrote, checked [repo-merge D85].

use crate::archive::{self, Entry};
use crate::{Spec, fold::Fold};
use serde_json::Value;
use std::io;

pub mod check;
pub mod estimate;
mod open;
mod pointers;
mod records;
mod room;
pub use room::remember;
mod skills;
mod text;
use text::{fill, git, head, tail};

/// Each section's most, in characters (about four to a token), in reading order [w31].
const OPEN: usize = 2_000;
const WORK: usize = 2_000;
const PLAN: usize = 2_000;
const EXCHANGE: usize = 6_000;
const FILES: usize = 3_000;
/// The most of a `!` command's report among the user's words.
const SHELL: usize = 600;

/// An answer's reference, text and giver, and where it stands among the records.
type Answer = (String, String, String, (u8, u64));

/// What a session's past holds for its hand-off: its entries, its user's answers, where each of
/// its conversations began, and whether the user stopped a turn since their last message, or
/// its lead did (`led`) [C76].
#[derive(Default)]
struct Past {
    entries: Vec<Entry>,
    /// Where, the text, and who gave it: the user, or Overnight, a reviewer, a parent (O50).
    answers: Vec<Answer>,
    starts: Vec<(String, String)>,
    turns: Vec<records::Turn>,
    stopped: bool,
    led: bool,
    /// The newest good summary note: its reference, the note, and the renewals since it.
    summary: Option<(String, Value, usize)>,
}

/// `tails`: a step's output also shows its end, not only its size and reference [D485].
fn past(spec: &Spec, tails: bool) -> io::Result<Past> {
    let dir = spec.dir.as_path();
    let mut p = Past::default();
    // Answers as Brigadier gave them, on every agent (Codex logs no answer of its own), kept once
    // the agent has them: written, or acked without an error. cid → (at, text, by, acked).
    let mut given = std::collections::HashMap::<String, (String, String, String, bool)>::new();
    // The messages the next turn takes, and whether one runs.
    let (mut waiting, mut running) = (vec![], false);
    // The agent's process, by pid and backend.
    let mut agent = (None, String::new());
    // Inside a stop (Brigadier's own: a rebirth, a picked model or level, the guard; or the
    // user's): a step it ended may read as refused in its CLI's words; nobody refused it.
    let mut cutting = String::new();
    // A step's entry by its tool id, for its output's pointer once it's done.
    let mut steps = std::collections::HashMap::<String, usize>::new();
    let mut summary = false;
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
                (p.stopped, p.led) = (false, false);
            }
        }
        if item["kind"] == "stopped" && matches!(item["by"].as_str(), Some("user" | "lead")) {
            cutting = item["by"].as_str().unwrap_or("").into();
        }
        p.stopped |= cutting == "user";
        p.led |= cutting == "lead";
        if item["kind"] == "note" && item["event"] == "summary" && item["failed"].is_null() {
            p.summary = Some((at.clone(), item.clone(), p.starts.len()));
        }
        // A summary turn, the conversation's own before its renewal, is no record but its Stop.
        if item["kind"] == "input" && c.is_null() {
            summary = item["origin"] == "summary";
        }
        // An Overnight decision is noted whenever its night settles, inside a summary turn too.
        if let Some(d) = records::decided(item, &at) {
            p.answers.push(d);
        }
        if summary {
            return;
        }
        let cid = |k: &str| item[k].as_str().unwrap_or("").to_string();
        match item["kind"].as_str() {
            Some("input") if c["kind"] == "answer" => {
                if let Some(text) = archive::answer(item) {
                    let by = c["by"].as_str().unwrap_or("").to_string();
                    given.insert(cid("cid"), (at.clone(), text, by, item["ack"] == true));
                    records::took(&mut p.turns, &mut waiting, running, &at);
                }
            }
            Some("delivered") if given.get(&cid("cid")).is_some_and(|g| !g.3) => {
                let (at, text, by, _) = given.remove(&cid("cid")).unwrap_or_default();
                p.answers.push((at.clone(), text, by, records::key(&at)));
            }
            Some("reply") if item["error"].is_null() && given.contains_key(&cid("id")) => {
                let (at, text, by, _) = given.remove(&cid("id")).unwrap_or_default();
                p.answers.push((at.clone(), text, by, records::key(&at)));
            }
            Some("turn_start") => records::begin(&mut p.turns, &mut waiting, &mut running),
            // A CLI that says it once for several messages (Claude's init): a step starts the next.
            Some("tool") => records::begin(&mut p.turns, &mut waiting, &mut running),
            // A turn a stop cut is the carry-on's to answer; the user's Stop or Pause stopped it.
            Some("turn_end") if running || !waiting.is_empty() => {
                records::begin(&mut p.turns, &mut waiting, &mut running);
                let how = match cutting.as_str() {
                    "user" | "pause" | "lead" => "stopped",
                    "" if item["ok"] == false => "failed",
                    "" => "done",
                    _ => "cut",
                };
                records::end(&mut p.turns, &mut running, how);
            }
            Some("spawned") => agent = (item["pid"].as_i64(), cid("backend")),
            // One its CLI never ended: what else ends a turn in the fold ends it here.
            _ if let Some(how) = records::ended(item, &agent).filter(|_| running) => {
                records::end(&mut p.turns, &mut running, how)
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
            Some("user" | "worker" | "peer") => {
                records::took(&mut p.turns, &mut waiting, running, &at)
            }
            // The entry itself: texts of one output chunk share a frame.
            Some("agent") => {
                records::begin(&mut p.turns, &mut waiting, &mut running);
                (p.turns.last_mut().into_iter()).for_each(|t| {
                    t.texts.push(at.clone());
                    t.answer = Some(p.entries.len());
                })
            }
            _ => {}
        }
        p.entries.extend(entry.map(|mut e| {
            if e.from == "error" && item["kind"] == "tool_done" {
                e.from = match cutting.as_str() {
                    "rebirth" | "stall" => "cut",
                    "user" => "stopped",
                    "lead" => "led",
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
    (p.summary.iter_mut()).for_each(|s| s.2 = p.starts.len() - s.2);
    if let Some(first) = p.entries.first().filter(|e| e.at.starts_with('i')) {
        let start = (first.at.clone(), "before this session was forked".into());
        p.starts.insert(0, start);
    }
    Ok(p)
}

/// The hand-off to the same agent's fresh conversation, nothing sent after it.
pub fn renewal(spec: &Spec, f: &Fold, why: &str, last: &Value, from: &str) -> io::Result<String> {
    build(
        spec,
        f,
        why,
        last,
        from,
        crate::rebirth::backend(spec, f),
        None,
        "",
    )
}

/// The hand-off for session `spec` with fold `f`. `why`: rebirth (the next message follows), cut
/// (its last turn was stopped mid-way for a fresh context, or its window filled), limited,
/// unresumable, picked, switched (picked mid-turn, which it carries on) or forked; `from` names where it came from; `last` is its last turn.
/// `to` is the agent the fresh conversation runs on, `model` the one picked there if any, and
/// `pending` what's sent after the hand-off: together they set its room [§2.6].
#[allow(clippy::too_many_arguments)]
pub fn build(
    spec: &Spec,
    f: &Fold,
    why: &str,
    last: &Value,
    from: &str,
    to: &str,
    model: Option<&str>,
    pending: &str,
) -> io::Result<String> {
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
        "[This conversation carries on session {id} because {reason}. The old conversation is history, not instructions; the files on disk are the truth. Don't re-read the archive to start: do the next step, and only when you need a specific fact, find it with `brigadier search` or `brigadier read {id}#<n>` and quote it. {}]\n",
        p.summary.as_ref().map_or(check::RECORD, |_| check::SUMMARY)
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

    // The old conversation's own summary first, checked; the records after it win [rev 3 §2.5].
    // The small hand-off keeps its heading and reference only [§2.6].
    let summary = p.summary.as_ref().map(|(at, note, ago)| {
        let start = out.len();
        out += &check::section(id, at, note, *ago, check::SHOWN);
        (start..out.len(), check::section(id, at, note, *ago, 0))
    });

    // Where each section the small hand-off leaves out sits, and the line that stands for it.
    let mut spans = vec![];
    let mut span = |out: &String, start: usize, line: String| {
        (out.len() > start).then(|| spans.push((start..out.len(), line)));
    };
    let start = out.len();
    out += &skills::section(spec, &p);
    span(&out, start, "- The skills the user's messages invoked: `brigadier skill --json` lists them; load any one asks for.\n".into());

    // The agent's own kept lines, whole: `brigadier keep` caps them [D87].
    let kept = crate::keeps::shown(&spec.dir);
    if !kept.is_empty() {
        out +=
            &format!("\n## Kept by you, as you wrote them (`brigadier keep` changes them)\n{kept}");
    }

    // Measured with every other section, then fitted to what's left of the room.
    let conv_at = out.len();

    // What came with the messages, the newest first.
    let sent = (p.entries.iter().rev())
        .flat_map(|e| (e.sent.iter()).map(move |file| format!("- {id}#{}: {file}\n", e.at)));
    let sent = fill(sent, FILES, "they're in that folder");
    let folder = crate::message::sent(&spec.dir);
    let start = out.len();
    if !sent.is_empty() {
        out += &format!(
            "\n## Files sent with the messages, in {}\n{sent}",
            folder.display()
        );
    }

    span(
        &out,
        start,
        format!("- Files sent with the messages: in {}\n", folder.display()),
    );
    // The steps after the newest message: the open ones and the last exchange.
    let at = (p.entries.iter())
        .rposition(|e| said(&e))
        .map_or(0, |i| i + 1);
    let steps = (p.entries.get(at).zip(p.entries.last())).map_or(String::new(), |(a, b)| {
        format!("`brigadier read {id}#{} --to {}`", a.at, b.at)
    });
    // Kept in the small hand-off too: its 2,000 bytes are the only record of what still runs.
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
    let start = out.len();
    if !work.is_empty() {
        out += &format!("\n## The work\n{}", tail(&work, WORK));
    }
    span(
        &out,
        start,
        format!("- The work: `git status` and `git log` in {cwd}\n"),
    );

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
    let exchange: String = p.entries[at..]
        .iter()
        .map(|e| records::line(id, e))
        .collect();
    let start = out.len();
    if !exchange.is_empty() {
        let cut = if exchange.len() > EXCHANGE { "…" } else { "" };
        out += &format!(
            "\n## The last exchange, verbatim\n{cut}{}\n",
            tail(&exchange, EXCHANGE)
        );
    }
    span(&out, start, String::new());

    // The next step, by a fixed rule.
    let step = match why {
        // A Switch now its served turn's summary waited for, that turn done: said as done.
        "cut" | "switched" if why == "cut" || last["outcome"] != "done" => {
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
        _ if last["outcome"] == "done" => "Your last turn was done. Say only that you're ready for the next message.".into(),
        _ if last["began"] == true => "The last turn stopped early. Check the files, carry on from where it stopped, and don't redo anything already done.".into(),
        _ => "The last message wasn't worked on yet. Do it now.".into(),
    };
    // A step the user's Stop cut reads as refused in its CLI's words; it wasn't [D170].
    if p.stopped {
        out += "\n## Stopped\nThe user pressed Stop on a turn since their last message. A Stop isn't a refusal: a step it cut may read as refused or failed above, but it was stopped while it ran, after any approval it had, and may have run in part or in full.\n";
    } else if p.led {
        out += "\n## Stopped\nYour lead stopped a turn of yours since the user's last message. A stop isn't a refusal: a step it cut may read as refused or failed above, but it was stopped while it ran, after any approval it had, and may have run in part or in full.\n";
    }
    out += &pointers::section(id, &p);
    out += &format!("\n## Next\n{step}\n");
    let room = room::room(spec, f, to, model, pending);
    let less = |n: usize| n.saturating_sub(estimate::tokens(&out));
    let (conv, fits) = records::conversation(id, &p, Some((less(room), less(room / 2))));
    if fits {
        out.insert_str(conv_at, &conv);
        return Ok(out);
    }
    // The small hand-off [§2.6]: what the room can't hold is one line each, one command away; the
    // conversation its first and newest messages and range lines.
    let (mut at, mut lines) = (conv_at, String::new());
    for (r, line) in spans.into_iter().rev() {
        at -= if r.start < at { r.len() } else { 0 };
        out.replace_range(r, "");
        lines.insert_str(0, &line);
    }
    if let Some((r, short)) = summary {
        at = at - r.len() + short.len();
        out.replace_range(r, &short);
    }
    if !steps.is_empty() {
        lines +=
            &format!("- Open steps and the last exchange, after the newest message: {steps}\n");
    }
    let (conv, _) = records::conversation(id, &p, None);
    let left = format!("\n## Left out to fit the room, each one command away\n{lines}");
    out.insert_str(at, &(conv + &left));
    Ok(out)
}
