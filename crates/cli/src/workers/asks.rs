//! A worker's asks go to its parent agent alone, the old app's way [D119, D126, D131]: its
//! questions, and its approvals but on Ask. Each is written once as a result is, so it reaches the
//! parent the same way: the parent's own `brigadier wait`, or between its turns, waking it. The
//! parent answers with `brigadier send <id> --allow`, `--deny "<reason>"` or its answer as the
//! message; the user sees no card, and the worker's thread shows the ask and the answer.

use super::link;
use super::result::{Res, dir_of, open, path_of};
use super::write_json;
use crate::agent::refuse;
use crate::control;
use brigadier_core::{self as core};
use brigadier_frames::log;
use serde_json::{Value, json};
use std::fs;
use std::io;
use std::path::Path;

/// The worker's request with this id, while it waits on its parent.
pub(super) fn waiting(data: &Path, wid: &str, id: Option<&str>) -> Option<(String, Value)> {
    let f = core::fold(&core::session_dir(data, wid), true).ok()?.fold;
    let t = f.turns.first()?;
    (t.asks.iter())
        .find(|(k, r)| r["to"] == "parent" && id.is_none_or(|id| id == k.as_str()))
        .map(|(k, r)| (k.clone(), r.clone()))
}

pub(super) fn waits(data: &Path, wid: &str, id: &str) -> bool {
    waiting(data, wid, Some(id)).is_some()
        || crate::peers::question(data, wid).is_some_and(|mid| mid == id)
}

/// Writes the first request worker `wid` waits on its parent for, if it has none yet.
pub(crate) fn asked(data: &Path, wid: &str) -> io::Result<()> {
    let Some(l) = link(data, wid) else {
        return Ok(());
    };
    let f = core::fold(&core::session_dir(data, wid), true)?.fold;
    let Some(t) = f.turns.first() else {
        return Ok(());
    };
    // One at a time, the one `answer` settles, so the parent's reply is for the ask it read.
    for (id, r) in t.asks.iter().filter(|(_, r)| r["to"] == "parent").take(1) {
        write(data, &l, wid, id, said(&l.title, wid, r), &t.id)?;
    }
    Ok(())
}

/// Writes worker `wid`'s question `mid` (its `brigadier send` to its parent) for its parent, as its
/// CLI's own questions are [D131].
pub(crate) fn question(data: &Path, wid: &str, mid: &str, text: &str) -> io::Result<()> {
    let Some(l) = link(data, wid).filter(|l| !super::brigade::third(data, wid, l)) else {
        return Ok(());
    };
    let turn = core::fold(&core::session_dir(data, wid), true)?.fold;
    let turn = turn.turns.first().map_or(String::new(), |t| t.id.clone());
    let r = json!({"items": [{"text": text}]});
    write(data, &l, wid, mid, said(&l.title, wid, &r), &turn)
}

/// One ask's record in the parent's results, once.
fn write(
    data: &Path,
    l: &super::Link,
    wid: &str,
    id: &str,
    text: String,
    turn: &str,
) -> io::Result<()> {
    let path = path_of(data, &l.parent, wid, &id.replace(['/', '.'], "_"));
    if path.exists() {
        return Ok(());
    }
    let res = Res {
        id: format!("r{}", core::adapters::uuid()[..13].replace('-', "")),
        wid: wid.into(),
        turn: id.into(),
        how: "asks".into(),
        text,
        at: log::now_ms(),
        state: "written".into(),
        ended: false,
        hop: crate::peers::hop_of(data, wid, turn),
        merge: String::new(),
    };
    fs::create_dir_all(dir_of(data, &l.parent))?;
    write_json(&path, &res)?;
    open(data, &l.parent);
    Ok(())
}

/// What the parent reads: what its worker asks and how to answer it.
fn said(title: &str, wid: &str, r: &Value) -> String {
    let field = |k: &str| r[k].as_str().unwrap_or("").trim().to_string();
    let mut text = match r["items"].as_array() {
        Some(items) => {
            let mut t = format!("Worker {title} ({wid}) asks you:\n");
            for q in items {
                t += &format!("- {}\n", q["text"].as_str().unwrap_or(""));
                for o in q["options"].as_array().into_iter().flatten() {
                    let (label, why) = (
                        o["label"].as_str().unwrap_or(""),
                        o["description"].as_str().unwrap_or(""),
                    );
                    t += &format!(
                        "    · {label}{}\n",
                        if why.is_empty() {
                            String::new()
                        } else {
                            format!(": {why}")
                        }
                    );
                }
            }
            t + &format!(
                "\nAnswer it from its brief, the user's words and the code: `brigadier send {wid} \"<your answer>\"`. Only if just the user can answer, ask them with your tool for asking the user (no reply of yours here is shown), then send their answer the same way."
            )
        }
        None => {
            let mut t = format!(
                "Worker {title} ({wid}) asks for permission ({}):\n  {}\n",
                field("action"),
                subject(r)
            );
            if !field("reason").is_empty() {
                t += &format!("Why: {}\n", field("reason"));
            }
            t + &format!(
                "\nJudge it yourself against its brief and the user's words: `brigadier send {wid} --allow`, or `brigadier send {wid} --deny \"<reason>\"`, which its agent reads."
            )
        }
    };
    text += "\nOnly you see this, never the user, and the worker waits for you. Say nothing of it in your thread: answer, then go on as you were, without a word: wait on it again if you were waiting, else end your turn.";
    text
}

/// What an approval is for: its command, host, paths or input.
fn subject(r: &Value) -> String {
    let field = |k: &str| r[k].as_str().unwrap_or("").trim().to_string();
    let paths = (r["paths"].as_array().into_iter().flatten())
        .filter_map(Value::as_str)
        .collect::<Vec<_>>()
        .join(", ");
    [field("command"), field("host"), paths, field("input")]
        .into_iter()
        .find(|w| !w.is_empty())
        .unwrap_or_default()
}

/// What session `id` waits on its user for, as a `wait` on it says: only the user answers it [D126].
pub fn for_user(data: &Path, id: &str) -> Option<String> {
    let f = core::fold(&core::session_dir(data, id), true).ok()?.fold;
    let (_, r) = (f.turns.first()?.asks.iter()).find(|(_, r)| r["to"] != "parent")?;
    let what = match r["items"].is_array() {
        true => "to answer its question".to_string(),
        false => format!(
            "to approve ({}): {}",
            r["action"].as_str().unwrap_or(""),
            subject(r)
        ),
    };
    Some(format!(
        "{id} waits for the user {what}\nOnly the user can answer it, in Brigadier: `brigadier send {id} --allow` can't. End your turn: its result comes to you when it's done."
    ))
}

/// Whether worker `wid` of `me` waits on `me` for an answer.
pub fn asks_parent(data: &Path, me: &str, wid: &str) -> bool {
    link(data, wid).is_some_and(|l| l.parent == me)
        && (waiting(data, wid, None).is_some() || crate::peers::question(data, wid).is_some())
}

/// `brigadier send <wid> --allow | --deny "<reason>" | "<answer>"` from its parent: answers the
/// request it waits on, through the worker's CLI's own channel, as the parent's [D131].
pub fn answer(
    data: &Path,
    me: &str,
    wid: &str,
    allow: bool,
    deny: Option<&str>,
    text: &str,
) -> Value {
    if link(data, wid).is_none_or(|l| l.parent != me) {
        return refuse("You can answer only your own workers.");
    }
    let Some((id, r)) = waiting(data, wid, None) else {
        return match crate::peers::question(data, wid) {
            Some(mid) if !allow && deny.is_none() && !text.trim().is_empty() => {
                crate::peers::answer(data, me, wid, &mid, text)
            }
            Some(_) => refuse(&format!(
                "{wid} asks a question: answer it with `brigadier send {wid} \"<your answer>\"`."
            )),
            None => refuse(&for_user(data, wid).unwrap_or(format!("{wid} isn't waiting on you."))),
        };
    };
    let question = r["items"].is_array();
    let reply = match (question, allow, deny) {
        (true, false, None) if !text.trim().is_empty() => {
            control::reply(data, wid, text, None, Some("parent"))
        }
        (true, ..) => {
            return refuse(&format!(
                "{wid} asks a question: answer it with `brigadier send {wid} \"<your answer>\"`."
            ));
        }
        (false, true, None) => control::answer_as(data, wid, &id, "allow", None, "parent"),
        (false, false, Some(why)) => {
            control::answer_as(data, wid, &id, "deny", Some(why), "parent")
        }
        (false, ..) => {
            return refuse(&format!(
                "{wid} asks for permission: `brigadier send {wid} --allow`, or `--deny \"<reason>\"`."
            ));
        }
    };
    match reply {
        Ok(Some(r)) if r["result"] != "refused" => {
            json!({"ok": true, "text": format!("Sent to {wid}.")})
        }
        Ok(Some(r)) => refuse(&format!(
            "{wid} couldn't take it: {}.",
            r["error"].as_str().unwrap_or("refused")
        )),
        Ok(None) => refuse(&format!("{wid} isn't waiting on you.")),
        Err(e) => refuse(&e.to_string()),
    }
}
