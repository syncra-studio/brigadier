//! Moving a session that hit its limit to another account or agent [D51]. One transition,
//! serialised by the host like the terminal handoff [D47, D86]: a single spawn that replaces the
//! idle child and logs one input frame carrying the switch. The host refuses it if the log moved
//! since the caller judged the session, and its cid is fixed by the limit, so a repeat, a racing
//! caller or a retry after a crash does it at most once [D54, D82].

use crate::fold::{self, Fold};
use crate::{Call, Spec, adapters, as_run, cli_version};
use serde_json::{Value, json};
use std::fs;
use std::path::PathBuf;

/// The old app's words for a turn its account's limit cut short (D48).
const CARRY_ON: &str = "[Your last turn stopped early: its account hit a usage limit. You now run on another account, in the same session. Carry on from where you stopped. Don't redo anything you already did.]";
/// How much of the last exchange and of the user's messages the hand-off quotes, in characters.
const LAST_EXCHANGE: usize = 40_000;
const MESSAGES: usize = 40_000;

/// Where the session goes: a backend, its account ("" is the computer's login), and its model
/// when it changes; `label` and `from` name both sides in the note.
pub struct Target<'a> {
    pub backend: &'a str,
    pub account: &'a str,
    pub model: Option<&'a str>,
    pub label: &'a str,
    pub from: &'a str,
}

/// Makes the switch, or says why not. `ping` is the host's answer taken before `f` was folded;
/// `still` is asked last, just before the host is, so a setting turned off meanwhile stops an
/// automatic switch.
pub fn switch(
    spec: &Spec,
    f: &Fold,
    ping: &Value,
    call: Call,
    to: &Target,
    auto: bool,
    still: &dyn Fn() -> bool,
) -> Value {
    let caps = ping["caps"].as_array().into_iter().flatten();
    if !caps.into_iter().any(|c| c == "switch") {
        return json!({"ok": false, "error": "old_host", "message": "This session's host is on an older build. It moves to the new one once nothing runs."});
    }
    let Some(why) = fold::switchable(f) else {
        return json!({"ok": false, "error": "not_limited", "message": "This session isn't at a limit."});
    };
    let Some(a) = adapters::get(to.backend) else {
        return json!({"ok": false, "error": format!("unknown backend {}", to.backend)});
    };
    let last = f.last.clone().unwrap_or_default();
    let from = if f.backend.is_empty() {
        spec.backend.as_str()
    } else {
        f.backend.as_str()
    };
    let fresh = to.backend != from || why == "unresumable";
    // The message the CLI refused outright goes again only on proof: its limit, after delivery,
    // before any work. Anything else is told what happened, never sent the user's words twice.
    let proof = last["outcome"] == "limited"
        && last["delivered"] == true
        && last["began"] == false
        && last["origin"] == "user";
    let (origin, text) = if fresh {
        match handoff(spec, why, &last, to.from) {
            Ok(t) => ("system", t),
            Err(e) => return json!({"ok": false, "error": format!("hand-off: {e}")}),
        }
    } else if proof {
        ("user", last["text"].as_str().unwrap_or("").to_string())
    } else {
        ("system", CARRY_ON.to_string())
    };
    let how = if auto {
        "switched automatically to"
    } else {
        "switched to"
    };
    let note = match (why, fresh) {
        ("unresumable", _) => format!(
            "{} couldn't resume this conversation · started a new one with a hand-off",
            to.label
        ),
        (_, true) => format!(
            "Usage limit on {} · {how} {} with a hand-off of this thread",
            to.from, to.label
        ),
        _ => format!("Usage limit on {} · {how} {}", to.from, to.label),
    };
    let switch = json!({"from": {"backend": from, "account": f.accounts.get(from)},
        "to": {"backend": to.backend, "account": to.account, "model": to.model},
        "auto": auto, "fresh": fresh, "why": why, "note": note});
    let mut run = as_run(spec, f, to.backend, Some(to.account));
    if let Some(m) = to.model {
        run.model = Some(m.into());
    }
    let resume = (!fresh)
        .then(|| f.resume.get(to.backend).map(String::as_str))
        .flatten();
    let launch = a.launch(&run, resume, Some(&text));
    let env: serde_json::Map<String, Value> =
        launch.env.into_iter().map(|(k, v)| (k, v.into())).collect();
    let req = json!({"op": "spawn", "cid": format!("sw-{}", last["ts"]), "origin": origin, "text": text,
        "backend": to.backend, "retry_of": last["cid"], "switch": switch, "argv": launch.argv, "env": env,
        "cwd": spec.cwd, "pty": spec.mode == "pty", "keep_stdin": launch.keep_stdin, "input": launch.input,
        "cli_version": cli_version(spec, a), "replace": true, "if_len": ping["len"]});
    if !still() {
        return json!({"ok": false, "error": "off", "message": "Automatic switching was turned off."});
    }
    let mut reply = call(req).unwrap_or_else(|e| json!({"ok": false, "error": e.to_string()}));
    if reply["error"] == "changed" {
        reply["message"] = "The session changed while switching. Try again.".into();
    }
    reply
}

/// The hand-off a new conversation starts from (D90 Q1, as in the old app): every user message,
/// the last exchange verbatim, and the whole thread written to a file in the session folder for
/// anything older [D35].
fn handoff(spec: &Spec, why: &str, last: &Value, from: &str) -> std::io::Result<String> {
    let (mut thread, mut asked, mut since) = (String::new(), vec![], 0);
    let mut said = false;
    crate::read(&spec.dir, |item| {
        let text = item["text"].as_str().unwrap_or("");
        match item["kind"].as_str().unwrap_or("") {
            // A message a switch sent again is the same message: counted once.
            "input" | "prompt" if item["origin"] != "system" && item["switch"].is_null() => {
                since = thread.len();
                asked.push(text.to_string());
                thread += &format!("\n## User\n\n{text}\n");
                said = false;
            }
            "text" => {
                if !said {
                    thread += "\n## Agent\n\n";
                    said = true;
                }
                thread += text;
                thread += "\n";
            }
            "tool" => {
                let input: String = item["input"]
                    .as_str()
                    .unwrap_or("")
                    .chars()
                    .take(300)
                    .collect();
                thread += &format!("- {}: {input}\n", item["name"].as_str().unwrap_or(""));
                said = false;
            }
            _ => {}
        }
    })?;
    let file: PathBuf = spec.dir.join(format!("handoff-{}.md", last["ts"]));
    fs::write(&file, &thread)?;
    let exchange = tail(&thread[since..], LAST_EXCHANGE);
    let mut messages = String::new();
    for (n, m) in asked.iter().enumerate().rev() {
        let line = format!("{}. {m}\n", n + 1);
        if messages.len() + line.len() > MESSAGES {
            messages.insert_str(0, "(older messages are in the file)\n");
            break;
        }
        messages.insert_str(0, &line);
    }
    let reason = if why == "unresumable" {
        "the agent couldn't resume it on this account"
    } else {
        "its usage limit was reached"
    };
    let then = if last["began"] == true {
        "The last turn stopped early. Check the files, carry on from where it stopped, and don't redo anything already done."
    } else {
        "The last message wasn't worked on yet. Do it now."
    };
    Ok(format!(
        "[This conversation moved here from {from} because {reason}. You carry on the same work in the same folder. The whole earlier conversation is in {}; read it when you need more than what follows.]\n\nEvery message the user sent, oldest first:\n{messages}\nThe last exchange, verbatim:\n{exchange}\n\n[{then}]",
        file.display()
    ))
}

/// The last `max` characters of `s`, on a character boundary.
fn tail(s: &str, max: usize) -> &str {
    let mut at = s.len().saturating_sub(max);
    while !s.is_char_boundary(at) {
        at += 1;
    }
    &s[at..]
}
