//! The summary turn [repo-merge D85, D92, D93; design rev 3 §2.2]: before a renewal, the old
//! conversation writes what the fresh one should know, as one more turn of Brigadier's own origin
//! `"summary"`, with no tools. Off unless `BRIGADIER_SUMMARY=1`, until the bench shows it adds no
//! made-up facts and loses no recall (D93).

use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// A summary turn's most: past it, it's stopped and counts as failed (§4).
pub const LIMIT: Duration = Duration::from_secs(180);

/// Whether renewals write a summary first.
pub fn on() -> bool {
    std::env::var_os("BRIGADIER_SUMMARY").is_some_and(|v| v == "1")
}

/// The flag a summary turn holds while it runs: every tool call is refused under it.
pub fn flag(dir: &Path) -> PathBuf {
    dir.join("summarizing")
}

/// Whether a summary turn holds the session's tools now: its flag is there and the log has no
/// end for it, however long it ran with the daemon away. One its end left behind holds nothing;
/// a host that died in it is ended by the next. A log that can't be read holds them.
pub fn running(dir: &Path) -> bool {
    let open = |f: crate::Folded| f.fold.turns.first().is_some_and(|t| t.origin == "summary");
    flag(dir).exists() && crate::fold(dir, true).map_or(true, open)
}

/// The tool hook's answer [D92]: refused, with the reason, while the summary turn runs.
pub fn tool_hook(dir: Option<&Path>) -> Option<&'static str> {
    dir.filter(|d| running(d)).map(|_| {
        "Brigadier: this turn writes the conversation's summary, with no tools. Answer in text only."
    })
}

/// The summary input's words [rev 3 §2.3]: ours, modelled on Claude Code's and Codex's.
// No word of it is one of the fake's directives, so the drills' summary turn runs no step.
pub const PROMPT: &str = include_str!("handoff/summary.txt");

/// The headings a summary must hold, as the prompt names them; one without them failed [§4].
pub fn headings() -> impl Iterator<Item = &'static str> {
    PROMPT.lines().filter_map(|l| l.strip_prefix("## "))
}

/// Whether `backend`'s CLI is proved to refuse every tool call before it runs, under the flag
/// [D92]: Claude from the version its proof held on, and the fake. Codex and OpenCode failed the
/// proof, so they renew without a summary. shortcut: a match while one real agent passes; an
/// adapter method once a second does.
pub fn vetoes(spec: &crate::Spec, backend: &str) -> bool {
    match backend {
        // The drills' stand-in for an agent that failed the proof.
        "fake" => std::env::var_os("BRIGADIER_FAKE_NO_VETO").is_none(),
        "claude" => crate::adapters::claude::veto::vetoes(spec),
        _ => false,
    }
}

/// Whether this session's renewals write a summary first: its agent vetoes, and a child running
/// now was launched with the veto, not one from before an upgrade gave it [D92].
pub fn applies(spec: &crate::Spec, f: &crate::fold::Fold) -> bool {
    let live = f.child.as_ref().is_some_and(|c| !c.exited);
    let given = f.given.as_ref().is_some_and(|g| g["veto"] == true);
    on() && vetoes(spec, crate::rebirth::backend(spec, f)) && (!live || given)
}

/// Marks a launch's setup as carrying the veto, launch-only: a child without it is started again
/// for a turn that has it, so the setup it's known by never claims a hook it lacks.
pub fn stamp(run: &crate::Spec, backend: &str, setup: &mut serde_json::Value) {
    if on() && vetoes(run, backend) {
        setup["veto"] = true.into();
    }
}

/// Whether the old conversation can still write one after `last`: not at a usage limit, a sign-in
/// or a refused resume, nor past a window that refused it or the loop guard's stop; those renew
/// with the last summary carried [rev 3 §2.2].
pub fn runs(f: &crate::fold::Fold, last: &serde_json::Value) -> bool {
    let blocked = f.limit.is_some() || f.sign_in.is_some() || f.refused.is_some();
    let window = last["outcome"] == "failed" && last["why"] == "context";
    !blocked && !window && last["reason"] != "stall"
}

/// The turn the held renewal serves, as the fold had it when the summary input came: its cause,
/// its guard count. None with no renewal held.
pub fn served(f: &crate::fold::Fold) -> Option<serde_json::Value> {
    let r = f.renewing.as_ref()?;
    Some(r["last"].clone()).filter(|l| !l.is_null())
}

/// Writes the held renewal's summary note, once: its summary turn's last reply, checked, or why
/// it failed [rev 3 §2.2, §2.4, §4]. With no renewal held, or its note there, nothing. Only if the
/// log is still `len` long, when given; the log's new length when written.
pub fn settle(
    spec: &crate::Spec,
    f: &crate::fold::Fold,
    call: crate::send::Call,
    len: Option<u64>,
) -> io::Result<Option<u64>> {
    use crate::handoff::check::{self, Source};
    let Some(turn) = f.renewing.as_ref().and_then(|r| r["turn"].as_str()) else {
        return told(spec, f, call, len);
    };
    let (mut sources, mut from) = (Vec::<Source>::new(), None);
    let (mut inside, mut hit, mut past, mut noted, mut tools) = (false, false, false, false, false);
    let (mut reply, mut model) = (String::new(), String::new());
    crate::archive::each(&spec.dir, |item, at| {
        let s = |k: &str| item[k].as_str().unwrap_or("");
        // No summary cites one: not a note, nor a summary turn, nor a hand-off that carries one.
        if item["kind"] == "note" {
            noted |= item["event"] == "summary" && item["turn"] == turn;
            return;
        }
        if item["kind"] == "input" && item["control"].is_null() {
            inside = s("origin") == "summary";
            past |= hit;
            hit |= s("cid") == turn;
            if s("cid") == turn {
                model = item["setup"]["model"].as_str().unwrap_or("").into();
            }
            let fresh = &item["switch"];
            if !hit && (fresh["fresh"] == true || fresh["why"] == "picked") {
                from = None;
            }
        }
        if hit {
            if inside && !past {
                match s("kind") {
                    "tool" => (tools, reply) = (true, String::new()),
                    "text" => reply = s("text").into(),
                    _ => {}
                }
            }
            return;
        }
        if inside {
            return;
        }
        let origin = s("origin");
        let (text, user, tool) = match s("kind") {
            "input" if item["control"].is_object() => {
                let mine = item["control"]["by"].is_null();
                (
                    crate::archive::answer(item)
                        .filter(|_| mine)
                        .unwrap_or_default(),
                    true,
                    false,
                )
            }
            "input" if origin == "user" => (s("text").into(), true, false),
            "input" if origin.starts_with("result:") || origin.starts_with("peer:") => {
                (s("text").into(), false, false)
            }
            "text" => (s("text").into(), false, false),
            "tool" => match item["input"].as_str() {
                Some(i) => (i.into(), false, true),
                None => (item["input"].to_string(), false, true),
            },
            "tool_done" => (s("output").into(), false, true),
            _ => return,
        };
        if !text.trim().is_empty() {
            from.get_or_insert(at.clone());
            sources.push(Source {
                at,
                text: check::fold(&text),
                user,
                tool,
            });
        }
    })?;
    if noted || !hit {
        return Ok(None);
    }
    let last = f.last.as_ref().filter(|l| l["id"] == turn);
    let has = |h: &str| {
        let h = h.to_lowercase();
        (reply.lines()).any(|l| l.trim().trim_start_matches('#').trim().to_lowercase() == h)
    };
    let failed = match last {
        None => Some("unfinished"),
        Some(l) if l["outcome"] != "done" => {
            // Its outcome (limited, stopped at its minutes), or a failure's own why.
            let why = ["outcome", "why"].map(|k| l[k].as_str());
            let why = why[0].filter(|o| *o != "failed").or(why[1]);
            Some(why.unwrap_or("failed"))
        }
        _ => None,
    }
    .or(tools.then_some("tool"))
    .or(reply.trim().is_empty().then_some("empty"))
    .or((!headings().all(has)).then_some("headings"));
    let data = match failed {
        Some(why) => serde_json::json!({"event": "summary", "turn": turn, "failed": why}),
        None => {
            let was =
                crate::fork::record(&spec.dir).and_then(|r| r["cwd"].as_str().map(String::from));
            let was = was.filter(|w| *w != spec.cwd);
            let text = reply.trim_end();
            let mut v = check::check(text, &sources, &spec.cwd, was.as_deref());
            let model = if model.is_empty() {
                crate::rebirth::backend(spec, f).to_string()
            } else {
                model
            };
            v["event"] = "summary".into();
            v["turn"] = turn.into();
            v["from"] = from.into();
            v["to"] = sources.last().map(|s| s.at.clone()).into();
            v["model"] = model.into();
            v["text"] = text.into();
            v
        }
    };
    let reply = call(serde_json::json!({"op": "note", "data": data, "if_len": len}))?;
    match reply["ok"] == true {
        true => Ok(reply["len"].as_u64()),
        false => Err(io::Error::other(format!(
            "the summary's note: {}",
            reply["error"]
        ))),
    }
}

/// With summaries on, an agent that can't be held to no tools renews without one: the session
/// says so once, as the design wants the owner told [D92]. The log's new length when written.
fn told(
    spec: &crate::Spec,
    f: &crate::fold::Fold,
    call: crate::send::Call,
    len: Option<u64>,
) -> io::Result<Option<u64>> {
    let b = crate::rebirth::backend(spec, f);
    if !on() || vetoes(spec, b) {
        return Ok(None);
    }
    let mut said = false;
    crate::archive::each(&spec.dir, |item, _| {
        said |= item["event"] == "unsummarized" && item["backend"] == b;
    })?;
    if said {
        return Ok(None);
    }
    let label = crate::adapters::get(b).map_or(b, |a| a.label());
    let text = format!(
        "{label} renews this chat without a written summary: it can't be held to no tools while it writes one. Each fresh conversation starts from the records and the last summary, if any."
    );
    let data = serde_json::json!({"event": "unsummarized", "backend": b, "id": format!("unsummarized:{b}"), "text": text});
    let reply = call(serde_json::json!({"op": "note", "data": data, "if_len": len}))?;
    Ok(reply["len"].as_u64().filter(|_| reply["ok"] == true))
}
