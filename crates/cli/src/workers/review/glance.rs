//! The quick look [beat-competitors D56, D66]: a change rule A's signals leave undecided goes to
//! one small model of its reviewer's company, its tools blocked at launch, asked only whether it
//! is sensitive. Its record is `glancing` while it looks, outside the review lock and the daemon's
//! pass; a "no" about exactly the commits it saw is a skip, anything else the full review. One a
//! restart cut short looks again once, then the full review starts.

use super::*;
use brigadier_core::{adapters, git::needs, writer};
use std::collections::BTreeSet;
use std::sync::Mutex;

/// The measured narrow question (beat-competitors msgs/measure-raw/p4/glance/prompt-s.md), plus
/// that comments are no evidence (proposed).
const PROMPT: &str = include_str!("glance.txt");
/// Proposed: four times the slowest measured look (7.1 s), so a hung one holds a result briefly.
const SECS: u64 = 30;
/// Proposed: the most it reads, never cut; the largest measured change was 14.6 KB.
const MOST: usize = 40 << 10;
/// Proposed: the task only frames the change; a "no" rests on the diff, which is never cut.
const BRIEF: usize = 8 << 10;

/// The workers this daemon is looking at now.
static LOOKING: Mutex<BTreeSet<String>> = Mutex::new(BTreeSet::new());

/// What came of a look: sensitive (its model's name and why), not (its name), or no answer.
enum Look {
    Yes(String, String),
    No(String),
    Not(String),
}

/// Each repository's head, as `spans` left it: what the look is of.
fn seen(spans: &[task::Span]) -> Value {
    Value::Object(
        (spans
            .iter()
            .map(|s| (s.repo.clone(), s.head.clone().into())))
        .collect(),
    )
}

/// Under the lock, for `l`'s new `running` record that rule A left undecided at `size`: it looks.
pub(super) fn start(
    data: &Path,
    l: &mut Link,
    wid: &str,
    size: &str,
    spans: &[task::Span],
) -> Option<&'static str> {
    l.review["state"] = "glancing".into();
    (l.review["size"], l.review["seen"]) = (size.into(), seen(spans));
    (l.review["tries"], l.review["pid"]) = (1.into(), std::process::id().into());
    let _ = save(data, wid, l);
    spawn(data, wid, l.review["turn"].as_str().unwrap_or(""));
    None
}

/// `holds` on a `glancing` record: held while its look runs; one a restart cut short looks once more,
/// then the full review starts.
pub(super) fn held(
    data: &Path,
    l: &mut Link,
    wid: &str,
    how: &'static str,
) -> Option<&'static str> {
    let pid = l.review["pid"].as_u64().unwrap_or(0) as u32;
    let me = std::process::id();
    // shortcut: a dead daemon's pid reused by another process reads as live until that one ends.
    let live = match pid == me {
        true => LOOKING.lock().unwrap().contains(wid),
        false => pid > 0 && unsafe { libc::kill(pid as i32, 0) } == 0,
    };
    if live {
        return None;
    }
    if l.review["tries"].as_u64() < Some(2) {
        (l.review["tries"], l.review["pid"]) = (2.into(), me.into());
        let _ = save(data, wid, l);
        spawn(data, wid, l.review["turn"].as_str().unwrap_or(""));
        return None;
    }
    full(
        data,
        l,
        wid,
        "a quick look couldn't clear it (cut short twice by a restart)",
    );
    (l.review["state"] != "running").then_some(how)
}

/// The full review, saying why.
fn full(data: &Path, l: &mut Link, wid: &str, why: &str) {
    (l.review["state"], l.review["why"]) = ("running".into(), why.into());
    match next(data, l, wid) {
        Ok(by) => l.review["by"] = by.into(),
        Err(why) => off(data, l, wid, &why),
    }
    let _ = save(data, wid, l);
}

fn spawn(data: &Path, wid: &str, turn: &str) {
    if !LOOKING.lock().unwrap().insert(wid.into()) {
        return;
    }
    let (data, wid, turn) = (data.to_path_buf(), wid.to_string(), turn.to_string());
    std::thread::spawn(move || {
        // A bug in it is a failed look, never a result held for good.
        let looked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| look(&data, &wid)));
        let (look, at) = match looked.unwrap_or_else(|_| Err("it failed".into())) {
            Ok((look, at)) => (look, at),
            Err(why) => (Look::Not(why), Value::Null),
        };
        apply(&data, &wid, &turn, look, &at);
        LOOKING.lock().unwrap().remove(&wid);
        // The pass looks at a held worker again only when its row changes: its result goes now.
        let _ = result::write_ended(&data, &wid, false);
    });
}

/// Under the lock again: its answer, only for the same turn and exactly the commits it saw.
fn apply(data: &Path, wid: &str, turn: &str, look: Look, at: &Value) {
    let Ok(_one) = lock(data) else { return };
    let Some(mut l) = link(data, wid).filter(|l| l.review["state"] == "glancing") else {
        return;
    };
    if l.review["turn"] != turn {
        return;
    }
    let now = seen(&task::spans(data, wid, &l.review["since"]));
    // A look that failed before it read anything has no heads of its own.
    let same = now == l.review["seen"] && (at.is_null() || now == *at);
    let why = match look {
        _ if !same => "a quick look couldn't clear it (its commits moved)".into(),
        Look::No(name) => {
            let size = l.review["size"].as_str().unwrap_or("").to_string();
            let why = format!("{size}; a quick look by {name} found nothing sensitive");
            return skip(data, &mut l, wid, turn, &why);
        }
        Look::Yes(name, why) => format!("a quick look by {name} found it sensitive ({why})"),
        Look::Not(why) => format!("a quick look couldn't clear it ({why})"),
    };
    full(data, &mut l, wid, &why);
}

/// The look, outside every lock: its answer and the heads it was about.
fn look(data: &Path, wid: &str) -> Result<(Look, Value), String> {
    let l = link(data, wid).ok_or("its worker can't be read")?;
    let spans = task::spans(data, wid, &l.review["since"]);
    let at = seen(&spans);
    if at != l.review["seen"] {
        return Ok((Look::Not("its commits moved".into()), at));
    }
    let read: Option<Vec<_>> = (spans.iter())
        .map(|s| needs::span(&s.repo, &s.at, &s.base, &s.head))
        .collect();
    let read = read.ok_or("its change couldn't be read")?;
    // Its reviewer's pick, nothing reserved, then that agent's small model: of another company.
    let parent = core::load(data, &l.parent).map_err(|e| e.to_string())?;
    let pf = core::fold(&parent.dir, true)
        .map_err(|e| e.to_string())?
        .fold;
    let spec = core::load(data, wid).map_err(|e| e.to_string())?;
    let authors = task::authors(&spec);
    let none = |_: &str| -> Option<String> { None };
    let pick = routing::resolve(data, &l.parent, &parent, &pf, &none, "", Some(&authors))
        .map_err(|e| e["error"].as_str().unwrap_or("no reviewer").to_string())?;
    let a = adapters::get(&pick.agent).ok_or("no reviewer")?;
    let listed = crate::commit::models(data, &pick.agent);
    let other = "no small model of another company that looks without tools";
    let model = a.glance(&listed).ok_or(other)?;
    let maker = |agent: &Value, model: &str| {
        adapters::get(agent.as_str().unwrap_or("")).and_then(|x| x.maker(model))
    };
    // Known, and another than each author's, itself known [beat-competitors D48].
    let mine = maker(&pick.agent.as_str().into(), &model);
    let apart = |x: &Value| {
        maker(&x["agent"], x["model"].as_str().unwrap_or("")).is_some_and(|m| Some(m) != mine)
    };
    if mine.is_none() || !authors.iter().all(apart) {
        return Err(other.into());
    }
    let info = listed.iter().find(|m| m.id == model);
    let name = info.map_or(model.clone(), |m| m.name.clone());
    // What it reads: the task, each counted file's counts, and every patch whole, or none.
    let mut stat = String::new();
    let mut diff = String::new();
    for s in &read {
        for f in needs::counted(s) {
            let path = f["path"].as_str().unwrap_or("");
            let shown = if s.repo.is_empty() {
                path.to_string()
            } else {
                format!("{}/{path}", s.repo)
            };
            stat += &format!(
                "{shown} ({}): +{} -{}\n",
                f["status"].as_str().unwrap_or(""),
                f["insertions"],
                f["deletions"]
            );
        }
        let left = MOST.saturating_sub(diff.len() + stat.len());
        diff += &needs::diff(s, left).ok_or("its change can't be shown whole within 40 KB")?;
    }
    let prompt = (PROMPT.replacen("{{BRIEF}}", &cut(l.brief.clone(), BRIEF), 1))
        .replacen("{{STAT}}", stat.trim_end(), 1)
        .replacen("{{DIFF}}", diff.trim_end(), 1);
    // A one-shot of its own, no tool at all, on the pick's account, at its lowest effort.
    let f = core::fold(&spec.dir, true).map_err(|e| e.to_string())?.fold;
    let mut run = core::as_run(&spec, &f, &pick.agent, pick.account.as_deref());
    (run.model, run.effort) = (Some(model), info.and_then(|m| m.efforts.first().cloned()));
    let mut run = core::Spec {
        rules: Some(routing::launch),
        ..run
    }
    .ruled(&pick.agent)?;
    (run.cid, run.dir, run.naked) = (Some(adapters::uuid()), writer::home(&spec.dir), true);
    run.opts.insert("no_tools".into(), "1".into());
    run.opts.insert("sealed".into(), "1".into());
    (run.level, run.grants) = (a.can().levels.first().map(|l| l.to_string()), vec![]);
    let active = writer::hold(&spec.dir).map_err(|e| e.to_string())?;
    let account = pick.account.unwrap_or_default();
    let said = match writer::write(a, &run, &account, &prompt, &active, SECS) {
        Ok(said) => said,
        Err(e) if e.why.starts_with(&format!("{} didn't answer", a.label())) => {
            return Ok((Look::Not(format!("no answer in {SECS} s")), at));
        }
        Err(e) => {
            let first = e
                .why
                .lines()
                .find(|x| !x.trim().is_empty())
                .unwrap_or("")
                .trim();
            return Ok((
                Look::Not(cut(format!("{} failed: {first}", a.label()), 160)),
                at,
            ));
        }
    };
    Ok((verdict(&said, name), at))
}

/// Its one `Review: yes|no — why` line; none, or more than one, is no clear answer.
fn verdict(said: &str, name: String) -> Look {
    // ASCII only, so its byte offsets are the reply's own.
    let lower = said.to_ascii_lowercase();
    let Some(at) = lower
        .find("review:")
        .filter(|_| lower.matches("review:").count() == 1)
    else {
        return Look::Not("no clear answer".into());
    };
    let rest = said[at + 7..].lines().next().unwrap_or("").trim();
    let (word, why) = rest.split_at(
        rest.find(|c: char| !c.is_ascii_alphabetic())
            .unwrap_or(rest.len()),
    );
    let why = why
        .trim_start_matches([' ', '—', '–', '-', ':', ','])
        .trim()
        .trim_end_matches('.');
    match word.to_lowercase().as_str() {
        "yes" if why.is_empty() => Look::Yes(name, "no reason given".into()),
        "yes" => Look::Yes(name, why.into()),
        "no" => Look::No(name),
        _ => Look::Not("no clear answer".into()),
    }
}
