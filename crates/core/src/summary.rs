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
/// or a refused resume, nor past a window that refused it, the loop guard's stop or the user's
/// Stop or Pause; those renew with the last summary carried [rev 3 §2.2].
pub fn runs(f: &crate::fold::Fold, last: &serde_json::Value) -> bool {
    let blocked = f.limit.is_some() || f.sign_in.is_some() || f.refused.is_some();
    let window = last["outcome"] == "failed" && last["why"] == "context";
    // A turn the user stopped or paused stays as they left it, a pick waiting or not [D95].
    let left = matches!(last["reason"].as_str(), Some("user" | "pause"));
    !blocked && !window && !left && last["reason"] != "stall"
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
    use crate::handoff::check;
    let Some(turn) = f.renewing.as_ref().and_then(|r| r["turn"].as_str()) else {
        return told(spec, f, call, len);
    };
    let w = walk(&spec.dir, turn, |_, _, _, _| {})?;
    let reply = w.reply.as_str();
    if w.noted || !w.hit {
        return Ok(None);
    }
    let last = f.last.as_ref().filter(|l| l["id"] == turn);
    let has = |h: &str| {
        let h = h.to_lowercase();
        (reply.lines()).any(|l| l.trim().trim_start_matches('#').trim().to_lowercase() == h)
    };
    // A tool first: a stop it caused reads as stopped.
    let failed = (w.tools.then_some("tool"))
        .or(match last {
            None => Some("unfinished"),
            Some(l) if l["outcome"] != "done" => {
                // Its outcome (limited, stopped at its minutes), or a failure's own why.
                let why = ["outcome", "why"].map(|k| l[k].as_str());
                let why = why[0].filter(|o| *o != "failed").or(why[1]);
                Some(why.unwrap_or("failed"))
            }
            _ => None,
        })
        .or(reply.trim().is_empty().then_some("empty"))
        .or((!headings().all(has)).then_some("headings"));
    let data = match failed {
        Some(why) => serde_json::json!({"event": "summary", "turn": turn, "failed": why}),
        None => {
            let was =
                crate::fork::record(&spec.dir).and_then(|r| r["cwd"].as_str().map(String::from));
            let was = was.filter(|w| *w != spec.cwd);
            let text = reply.trim_end();
            // A second walk, each item's words looked through for the quotes and let go.
            let mut found = check::Found::new(text);
            walk(&spec.dir, turn, |at, t, user, tool| {
                found.see(at, t, user, tool)
            })?;
            let mut v = check::check(text, &found, &spec.cwd, was.as_deref());
            let model = match w.model.is_empty() {
                true => crate::rebirth::backend(spec, f).to_string(),
                false => w.model.clone(),
            };
            v["event"] = "summary".into();
            v["turn"] = turn.into();
            v["from"] = w.from.into();
            v["to"] = w.to.into();
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

/// What the archive holds up to `turn`'s summary turn: its reply and model, whether it ran a tool,
/// whether it's noted already, and the range of what a summary may cite.
#[derive(Default)]
struct Walk {
    from: Option<String>,
    to: Option<String>,
    hit: bool,
    noted: bool,
    tools: bool,
    reply: String,
    model: String,
}

/// Walks the archive to `turn`'s summary turn, giving `seen` each item written before it that a
/// summary may cite: its reference, its words, and whether they're the user's own or a tool's.
fn walk(dir: &Path, turn: &str, mut seen: impl FnMut(&str, &str, bool, bool)) -> io::Result<Walk> {
    let mut w = Walk::default();
    let (mut inside, mut past) = (false, false);
    crate::archive::each(dir, |item, at| {
        let s = |k: &str| item[k].as_str().unwrap_or("");
        // No summary cites one: not a note, nor a summary turn, nor a hand-off that carries one.
        if item["kind"] == "note" {
            w.noted |= item["event"] == "summary" && item["turn"] == turn;
            return;
        }
        if item["kind"] == "input" && item["control"].is_null() {
            inside = s("origin") == "summary";
            past |= w.hit;
            w.hit |= s("cid") == turn;
            if s("cid") == turn {
                w.model = item["setup"]["model"].as_str().unwrap_or("").into();
            }
            let fresh = &item["switch"];
            if !w.hit && (fresh["fresh"] == true || fresh["why"] == "picked") {
                w.from = None;
            }
        }
        if w.hit {
            if inside && !past {
                match s("kind") {
                    "tool" => (w.tools, w.reply) = (true, String::new()),
                    // Its text blocks joined, as `Turn::output` joins them.
                    "text" if !w.reply.is_empty() => {
                        w.reply = format!("{}\n\n{}", w.reply, s("text"))
                    }
                    "text" => w.reply = s("text").into(),
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
            // A `!` command's report is its output, not the user's words.
            "input" if origin == "user" => {
                (s("text").into(), !item["parts"]["shell"].is_string(), false)
            }
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
            w.from.get_or_insert(at.clone());
            seen(&at, &text, user, tool);
            w.to = Some(at);
        }
    })?;
    Ok(w)
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
