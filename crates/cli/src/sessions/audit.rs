//! `brigadier audit <id>` [D221]: a read-only report of one session from its log: its
//! conversations, their cost and context, each fresh start and what it carried, every turn, the
//! processes that ended, and the user's corrections. `--recall` prints the standard recall prompt
//! and a checklist from the record to grade the answer against. Nothing is written.

use crate::{has, heard};
use brigadier_core::{self as core, Spec, archive};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::io::{self, Write};

const RECALL: &str = "Quick recall check, answer from memory only — don't run any command, read any file or open any link.

1. Open asks and promises: everything I asked you to do, or you offered to do, that isn't finished yet. For each: what it is, when it came up, and what it's waiting on.
2. PRs and tickets: every PR and Jira ticket we've touched in this session, with its repo, its current state as you last knew it, and what you did on it.
3. Decisions: what I decided or approved, and what you decided yourself.
4. Files and branches you changed or created, and where they are now.
5. What you're unsure of or may have forgotten — say so plainly rather than guess.

Keep it to plain lists, one line per item.";

/// Words in the user's message, lowercased without apostrophes, that usually mean a correction.
const CORRECTIONS: &str = "didnt|did not|dont understand|did you even|i said|not what i|wrong|why did you|you forgot|thats not";

type Sections = Vec<(String, Vec<String>)>;

#[derive(Default)]
struct Conv {
    name: String,
    from: u64,
    to: u64,
    build: Option<u64>,
    voice: Option<bool>,
    turns: u32,
    cost: f64,
    last_cost: f64,
    tokens: BTreeMap<String, u64>,
    ctx: Vec<u64>,
}

#[derive(Default)]
struct Turn {
    at: u64,
    f: u64,
    why: String,
    idle: u64,
    /// Approvals, steers and API retries.
    n: [u32; 3],
    stopped: Option<String>,
}

/// A fresh conversation: what it said when it began, and its archive reads in the next 10 min.
#[derive(Default)]
struct Start {
    line: String,
    at: u64,
    reads: Vec<String>,
    failed: u32,
    ctx: Option<u64>,
}

pub fn run(spec: &Spec, args: &[String]) -> io::Result<Value> {
    let sections = if has(args, "--recall") {
        checklist(spec)?
    } else {
        audit(spec)?
    };
    if has(args, "--json") {
        let s: Vec<Value> = sections
            .iter()
            .map(|(t, l)| json!({"title": t, "lines": l}))
            .collect();
        return Ok(json!({"ok": true, "sections": s}));
    }
    let mut text = String::new();
    for (title, lines) in sections {
        text += &format!("{title}\n");
        (lines.iter()).for_each(|l| text += &format!("  {}\n", l.replace('\n', "\n  ")));
        text += "\n";
    }
    heard(io::stdout().write_all(text.as_bytes()))?;
    Ok(Value::Null)
}

fn audit(spec: &Spec) -> io::Result<Sections> {
    // This build's voice text opens the standing text's last paragraph.
    let standing = core::agent::standing(spec);
    let voice = standing
        .rsplit("\n\n")
        .next()
        .and_then(|v| v.split('.').next())
        .unwrap_or("");
    let (mut convs, mut cur, mut starts) = (Vec::<Conv>::new(), 0, Vec::<Start>::new());
    let (mut turns, mut idle, mut ends, mut fixes, mut words) =
        (vec![], vec![], vec![], vec![], vec![]);
    let (mut turn, mut cause, mut last_end) = (None::<Turn>, String::new(), 0);
    let (mut spawn, mut stop, mut used, mut cost) =
        (Value::Null, None::<String>, Value::Null, None);
    let (mut prev, mut ctx, mut host) = ((0, 0), 0, None);
    core::read(&spec.dir, |item| {
        let (ts, f) = (
            item["ts"].as_u64().unwrap_or(0),
            item["f"].as_u64().unwrap_or(0),
        );
        let s = |k: &str| item[k].as_str().unwrap_or("");
        convs.get_mut(cur).into_iter().for_each(|c| c.to = ts);
        match s("kind") {
            "spawned" => (spawn, stop) = (item.clone(), None),
            "resume_id" => {
                let name = format!("{} {}", s("backend"), s("id")); // whole: Codex's and OpenCode's share their start
                cur = convs
                    .iter()
                    .position(|c| c.name == name)
                    .unwrap_or(convs.len());
                if cur == convs.len() {
                    convs.push(Conv {
                        name,
                        from: ts,
                        to: ts,
                        ..Conv::default()
                    });
                }
                let c = &mut convs[cur];
                // The host's build spawned it: its notes stay in a rows-only copy [D220].
                c.build = c.build.or(host);
                if c.voice.is_none() && spawn.is_object() {
                    let argv = spawn["argv"].as_array().into_iter().flatten();
                    c.voice = Some(argv.filter_map(Value::as_str).any(|a| a.contains(voice)));
                }
            }
            "context" => {
                ctx = item["used"].as_u64().unwrap_or(0);
                convs.get_mut(cur).into_iter().for_each(|c| c.ctx.push(ctx));
                starts
                    .last_mut()
                    .filter(|st| st.ctx.is_none())
                    .into_iter()
                    .for_each(|st| st.ctx = Some(ctx));
            }
            "usage" => {
                used = item["usage"].clone();
                let Some(c) = convs.get_mut(cur) else { return };
                for (k, v) in used.as_object().into_iter().flatten() {
                    *c.tokens.entry(k.clone()).or_default() += v.as_u64().unwrap_or(0);
                }
                // A CLI's cost is its process's running total, which a resumed process may carry on.
                cost = used["cost_usd"].as_f64().map(|t| {
                    let d = if t >= c.last_cost { t - c.last_cost } else { t };
                    (c.cost, c.last_cost) = (c.cost + d, t);
                    d
                });
            }
            "input" if item["switch"]["fresh"] == true || item["switch"]["why"] == "picked" => {
                let why = item["switch"]["why"].as_str().unwrap_or("switch");
                // The first message is the goal, carried apart from the user's other words.
                let said = words
                    .iter()
                    .skip(1)
                    .map(|w: &String| w.split_whitespace().count());
                let line = format!(
                    "{} #{f} {why}: a fresh {} conversation, with {} in context at most before it; the user's words before it: {}, {} of three words or fewer",
                    clock(ts),
                    s("backend"),
                    k((convs.get(cur).and_then(|c| c.ctx.iter().max().copied())).unwrap_or(ctx)), // its conversation's peak
                    said.clone().count(),
                    said.filter(|&n| n <= 3).count()
                );
                starts.push(Start {
                    line,
                    at: ts,
                    ..Start::default()
                });
                cause = match s("text").trim() {
                    "" => format!("(the hand-off: {why})"),
                    text => short(text, 60),
                };
            }
            "input" if item["control"]["kind"] == "interrupt" => {
                let by = item["control"]["by"].as_str().unwrap_or("user");
                turn.iter_mut().for_each(|t| t.stopped = Some(by.into()));
            }
            "input" if item["steer"] == true => turn.iter_mut().for_each(|t| t.n[1] += 1),
            "input" if item["control"].is_null() => cause = short(s("text").trim(), 60),
            "approval" => turn.iter_mut().for_each(|t| t.n[0] += 1),
            "retrying" => turn.iter_mut().for_each(|t| t.n[2] += 1),
            "turn_start" => {
                let why = match std::mem::take(&mut cause) {
                    c if c.is_empty() => "(started by itself)".into(),
                    c => c,
                };
                let idle = if last_end > 0 {
                    ts.saturating_sub(last_end)
                } else {
                    0
                };
                turn = Some(Turn {
                    at: ts,
                    f,
                    why,
                    idle,
                    ..Turn::default()
                });
                convs.get_mut(cur).into_iter().for_each(|c| c.turns += 1);
                (used, cost) = (Value::Null, None);
            }
            "turn_end" => {
                last_end = ts;
                let Some(t) = turn.take() else { return };
                let how = match (&t.stopped, item["ok"] == true) {
                    (_, true) => "ok".into(),
                    (Some(by), _) => format!("stopped by the {by}"),
                    _ => "failed".into(),
                };
                let counts: String = ["approvals", "steers", "API retries"]
                    .iter()
                    .zip(t.n)
                    .filter(|(_, n)| *n > 0)
                    .map(|(w, n)| format!(", {w} {n}"))
                    .collect();
                let cost = cost.map_or(String::new(), |c| format!(", ${c:.2}"));
                turns.push(format!(
                    "{} #{} {} {how}{cost}{counts}: {}",
                    clock(t.at),
                    t.f,
                    dur(ts - t.at),
                    t.why
                ));
                if t.idle > 3_600_000 {
                    idle.push(format!(
                        "{} #{} after {} idle: {}{cost}",
                        clock(t.at),
                        t.f,
                        dur(t.idle),
                        tokens(&used)
                    ));
                }
            }
            "stopped" => stop = Some(s("by").into()),
            "exited" => {
                let how = match (item["signal"].as_i64(), item["code"].as_i64()) {
                    (Some(sig), _) => format!("killed by signal {sig}"),
                    (_, c) => format!("code {}", c.unwrap_or(-1)),
                };
                let when = if turn.is_some() {
                    "mid-turn"
                } else {
                    "between turns"
                };
                // A stop explains only the exit that follows it.
                let after = stop.take().map_or(", no stop asked".into(), |b| {
                    format!(", after a stop by {b}")
                });
                ends.push(format!(
                    "{} #{f} the agent's process ended: {how}, {when}{after}",
                    clock(ts)
                ));
            }
            "note" if item["event"] == "owner_started" => {
                host = item["build"].as_u64();
                let build = host.unwrap_or(0);
                ends.extend((f > 0).then(|| match turn.take() {
                    Some(_) => format!("{} #{f} the session's host started again, on build {build}, with a turn running: its last record was {} #{}, and no exit was logged", clock(ts), clock(prev.0), prev.1),
                    None => format!("{} #{f} the session's host moved to build {build}", clock(ts)),
                }));
            }
            "tool"
                if s("input").contains("brigadier read")
                    || s("input").contains("brigadier search") =>
            {
                let st = starts.last_mut().filter(|st| ts - st.at <= 600_000);
                st.into_iter().for_each(|st| st.reads.push(s("id").into()));
            }
            "tool_done" if item["ok"] == false => {
                starts
                    .last_mut()
                    .filter(|st| st.reads.iter().any(|r| r == s("id")))
                    .into_iter()
                    .for_each(|st| st.failed += 1);
            }
            _ => {}
        }
        if let Some(e) = archive::entry(item, archive::at(item)).filter(|e| e.from == "user") {
            let plain = e.text.to_lowercase().replace(['\'', '’'], "");
            if CORRECTIONS.split('|').any(|c| plain.contains(c)) {
                fixes.push(format!("{} #{} {}", clock(e.ts), e.at, short(&e.text, 120)));
            }
            words.push(e.text);
        }
        prev = (ts, f);
    })?;
    let mut conv_lines: Vec<String> = convs.iter().map(|c| {
        let cost = if c.cost > 0.0 { format!("${:.2}", c.cost) } else { "no cost reported".into() };
        let voice = c.voice.map_or("?", |v| if v { "yes" } else { "no" });
        let peak = c.ctx.iter().max().copied().unwrap_or(0);
        format!("{}  {}-{}  build {}  voice text {voice}  {} turns  {cost}  context {} → peak {}\n  tokens: {}",
            c.name, clock(c.from), clock(c.to), c.build.map_or("?".into(), |b| b.to_string()), c.turns,
            k(c.ctx.first().copied().unwrap_or(0)), k(peak), tokens(&json!(c.tokens)))
    }).collect();
    conv_lines.push(format!(
        "Total cost the CLIs reported: ${:.2}",
        convs.iter().map(|c| c.cost).sum::<f64>()
    ));
    let start_lines = starts.iter().map(|st| format!("{}; the next context starts at {}; archive reads in the next 10 min: {}, {} failed",
        st.line, st.ctx.map_or("?".into(), k), st.reads.len(), st.failed)).collect();
    Ok(vec![
        (
            format!("Session {} ({} conversations)", spec.id, convs.len()),
            conv_lines,
        ),
        (
            "Turns after more than 1 h idle (the whole context is written to the cache again)"
                .into(),
            idle,
        ),
        (
            "Fresh conversations: rebirths and switches".into(),
            start_lines,
        ),
        ("Processes that ended".into(), ends),
        ("The user's corrections".into(), fixes),
        ("Turns".into(), turns),
    ])
}

/// Each ref the record names (`#2712`, `repo#n`, a PR link, a ticket key): its mentions, and
/// whether a step acted on it.
type Refs = BTreeMap<String, (Vec<String>, bool)>;

/// A Jira-style ticket key: FREELOGO-1680.
fn ticket(word: &str) -> bool {
    word.split_once('-').is_some_and(|(key, n)| {
        key.len() >= 2
            && key.starts_with(|c: char| c.is_ascii_uppercase())
            && (key.bytes()).all(|b| b.is_ascii_uppercase() || b.is_ascii_digit())
            && n.bytes().all(|b| b.is_ascii_digit())
            && !n.is_empty()
            && !["UTF", "SHA", "ISO"].contains(&key)
    })
}

/// The recall prompt, then what the record before the latest one (or all of it) says the answer
/// should cover: the PRs and tickets it names, and the agent's own promises and waits.
fn checklist(spec: &Spec) -> io::Result<Sections> {
    // One style: the session's own repo's PRs bare (#2712), another repo's with its name.
    let origin = crate::workers::git(&spec.cwd, &["remote", "get-url", "origin"]);
    let origin = origin.unwrap_or_default();
    let here = (origin.trim_end_matches(".git").rsplit(['/', ':']).next()).unwrap_or("");
    let pr = |repo: &str, n: &str| match repo.rsplit('/').next().unwrap_or("") {
        r if r == here => format!("#{n}"),
        r => format!("{r}#{n}"),
    };
    let (mut prs, mut tickets, mut promised) = (Refs::new(), Refs::new(), Vec::<String>::new());
    let mut kept = None;
    let number = |n: &str| n.len() >= 2 && n.bytes().all(|b| b.is_ascii_digit());
    core::read(&spec.dir, |item| {
        let s = |k: &str| item[k].as_str().unwrap_or("");
        let words = |t: &str| -> Vec<String> {
            t.split(|c: char| c.is_whitespace() || "()[]<>,;:`*\"'".contains(c))
                .map(|w| w.trim_end_matches(['.', '?', '!']).to_string())
                .collect()
        };
        // Acted on: a `gh pr` verb on a PR, a ticket's transition or comment.
        if item["kind"] == "tool" {
            let name = s("name").to_lowercase();
            if name.contains("transition") || name.contains("comment") {
                for t in words(s("input")).into_iter().filter(|w| ticket(w)) {
                    tickets.entry(t).or_default().1 = true;
                }
            }
            for cmd in s("input").split("gh pr ").skip(1) {
                let mut args = cmd.split_whitespace();
                let (verb, n) = (args.next().unwrap_or(""), args.next().unwrap_or(""));
                let acts = "merge review ready comment edit close reopen";
                if acts.split(' ').any(|a| a == verb) && number(n) {
                    let mut args = cmd.split_whitespace();
                    let repo = args.find(|a| matches!(*a, "-R" | "--repo"));
                    let repo = repo.and(args.next()).unwrap_or(here);
                    prs.entry(pr(repo, n)).or_default().1 = true;
                }
            }
            return;
        }
        let entry = archive::entry(item, archive::at(item));
        let Some(e) = entry.filter(|e| matches!(e.from, "user" | "agent")) else {
            return;
        };
        if e.from == "user" && e.text.starts_with(&RECALL[..40]) {
            kept = Some((prs.clone(), tickets.clone(), promised.clone()));
            return;
        }
        let at = format!("#{}", e.at);
        for word in words(&e.text) {
            let (repo, n) = match word.split_once("/pull/") {
                Some((repo, n)) => (repo, n.split('/').next().unwrap_or("")),
                None => word.split_once('#').unwrap_or(("", "")),
            };
            if repo != spec.id && number(n) {
                prs.entry(pr(repo, n)).or_default().0.push(at.clone());
            }
            if ticket(&word) {
                tickets.entry(word).or_default().0.push(at.clone());
            }
        }
        let sentences = e.text.split_inclusive(['.', '?', '!', '\n']).map(str::trim);
        for sentence in sentences.filter(|_| e.from == "agent") {
            let plain = sentence.to_lowercase().replace('’', "'");
            let says = (["i'll ", "i will ", "waiting on you"].iter()).any(|w| plain.contains(w));
            if says && !promised.iter().any(|p| p.ends_with(sentence)) {
                promised.push(format!("{} {at} {sentence}", clock(e.ts)));
            }
        }
    })?;
    let (mut prs, tickets, promised) = kept.unwrap_or((prs, tickets, promised));
    // A bare #n also named with just one other repo is that repo's PR.
    let bare: Vec<String> = prs.keys().filter(|k| k.starts_with('#')).cloned().collect();
    for k in bare {
        let mut others = prs.keys().filter(|o| o.len() > k.len() && o.ends_with(&k));
        if let (Some(o), None) = (others.next().cloned(), others.next()) {
            let (at, acted) = prs.remove(&k).unwrap_or_default();
            let into = prs.entry(o).or_default();
            into.0.extend(at);
            into.0.sort_by_key(|a| a[1..].parse::<u64>().unwrap_or(0));
            into.1 |= acted;
        }
    }
    // Named twice or more, or acted on, first; the rest folded on one line.
    let refs = |m: Refs| -> Vec<String> {
        let (top, once): (Vec<_>, Vec<_>) =
            (m.into_iter()).partition(|(_, (at, acted))| *acted || at.len() > 1);
        let mut lines: Vec<String> = (top.into_iter())
            .map(|(k, (at, acted))| {
                let span = (at.first().zip(at.last()))
                    .map_or(String::new(), |(a, b)| format!(", first {a}, last {b}"));
                let acted = if acted { ", acted on" } else { "" };
                format!("{k}: {} mentions{span}{acted}", at.len())
            })
            .collect();
        let once: Vec<String> = (once.iter())
            .map(|(k, (at, _))| format!("{k} {}", at[0]))
            .collect();
        if !once.is_empty() {
            lines.push(format!("mentioned once: {}", once.join(", ")));
        }
        lines
    };
    Ok(vec![
        ("The recall prompt".into(), vec![RECALL.into()]),
        ("PRs the record names before it".into(), refs(prs)),
        ("Tickets the record names before it".into(), refs(tickets)),
        (
            "The agent's promises and waits (\"I'll\", \"waiting on you\")".into(),
            promised,
        ),
    ])
}

/// Local time with seconds.
fn clock(ms: u64) -> String {
    format!("{}:{:02}", crate::workers::row::clock(ms), ms / 1000 % 60)
}

fn dur(ms: u64) -> String {
    match ms / 1000 {
        s if s < 120 => format!("{s} s"),
        s if s < 7200 => format!("{} min", s / 60),
        s => format!("{} h {} min", s / 3600, s / 60 % 60),
    }
}

fn k(n: u64) -> String {
    match n {
        n if n >= 1_000_000 => format!("{:.1}M", n as f64 / 1e6),
        n if n >= 1_000 => format!("{:.1}k", n as f64 / 1e3),
        n => n.to_string(),
    }
}

/// A message's first line, quoted, cut at `max` characters.
fn short(s: &str, max: usize) -> String {
    let line = s.lines().next().unwrap_or("");
    match line.char_indices().nth(max) {
        Some((at, _)) => format!("\"{}…\"", &line[..at]),
        None if line.len() < s.trim_end().len() => format!("\"{line}…\""),
        None => format!("\"{line}\""),
    }
}

/// The token counts a CLI reported, under its own names.
fn tokens(u: &Value) -> String {
    let counts = u
        .as_object()
        .into_iter()
        .flatten()
        .filter_map(|(name, n)| Some((name, n.as_u64()?)));
    counts
        .filter(|(_, n)| *n > 0)
        .map(|(name, n)| format!("{name} {}", k(n)))
        .collect::<Vec<_>>()
        .join(", ")
}
