//! The one recovery of a session's last turn: an unproven delivery, a lost one, a cut-off run,
//! and the user's own Stop with Resume.

use super::{Call, Running, send};
use crate::fold::{self, Fold, Live};
use crate::message::Message;
use crate::{Spec, adapters, as_run, sweep};
use brigadier_frames::log;
use serde_json::{Value, json};

/// What Resume says after the user's Stop, the old app's line [D2022].
pub(crate) const RESUME: &str = "[The user stopped you, then asked you to resume. Continue their request from where you left off.]";

/// The one recovery. An unproven delivery is re-sent only when a person asks (never by itself), and
/// to an agent that acks only when the log proves no child read it [D54, D82, D222]; an interrupted
/// turn continues through the backend's resume id.
pub fn recover(spec: &Spec, f: &Fold, live: &Live, child: Running, call: Call) -> Value {
    let status = fold::status(f, live);
    let state = status["state"].as_str().unwrap_or("");
    let now = log::now_ms();
    let note = |data: Value| call(json!({"op": "note", "data": data}));
    match state {
        "uncertain" => {
            let (Some(turn), true) = (f.turns.first(), child.is_none()) else {
                return json!({"ok": false, "recovered": "uncertain", "error": "The agent is still running and hasn't confirmed this message. Stop it to move on."});
            };
            let Some(a) = adapters::get(&turn.backend) else {
                return json!({"ok": false, "error": format!("unknown backend {}", turn.backend)});
            };
            let cid = turn.cid.as_deref().unwrap_or("");
            let run = as_run(spec, f, &turn.backend, None);
            if !(f.resume.get(&turn.backend)).is_some_and(|id| a.accepted(&run, id, cid)) {
                let e = format!(
                    "{} didn't confirm this message, and there's no proof it wasn't received, so it wasn't sent again. If it's missing from the conversation, send it again.",
                    a.label()
                );
                return json!({"ok": false, "recovered": "uncertain", "error": e});
            }
            if let Err(e) = note(json!({"event": "interrupted", "reason": {"accepted": cid}})) {
                return json!({"ok": false, "error": e.to_string()});
            }
            let said = format!(
                "{} took this message before it was cut off. Recover again to continue it.",
                a.label()
            );
            json!({"ok": true, "recovered": "accepted", "message": said})
        }
        "undelivered" => {
            let Some(turn) = f.turns.iter().find(|t| t.delivered.is_none()) else {
                return json!({"ok": false});
            };
            let old = turn.cid.clone().unwrap_or_default();
            if let Err(e) = note(json!({"event": "interrupted", "reason": {"undelivered": old}})) {
                return json!({"ok": false, "error": e.to_string()});
            }
            let cid = format!("{old}.r{now}");
            let mut reply = send(
                spec,
                f,
                child,
                call,
                &cid,
                &turn.origin,
                &again(spec, &turn.text, &turn.parts),
                Some(&turn.backend),
                Some(&old),
            );
            reply["recovered"] = "resent".into();
            reply
        }
        "interrupted" => {
            let swept = sweep(f);
            let last = f
                .turns
                .first()
                .map(|t| (t.cid.clone(), t.retry_of.clone(), t.backend.clone()));
            let last = last.or_else(|| {
                f.last.as_ref().map(|l| {
                    (
                        l["cid"].as_str().map(String::from),
                        l["retry_of"].as_str().map(String::from),
                        l["backend"].as_str().unwrap_or("").to_string(),
                    )
                })
            });
            let (cid, retry_of, backend) = last.unwrap_or_default();
            let root = retry_of.or(cid).unwrap_or_default();
            if let Err(e) = note(json!({"event": "interrupted", "reason": status["reason"]})) {
                return json!({"ok": false, "error": e.to_string()});
            }
            if !f.resume.contains_key(&backend) {
                return json!({"ok": false, "swept": swept, "error": "no resume id was announced, so there is nothing to continue; send a new message"});
            }
            let text = "Continue where you left off; your previous run was cut off.";
            let mut reply = send(
                spec,
                f,
                None,
                call,
                &format!("rc{now}"),
                "system",
                &Message::plain(text),
                Some(&backend),
                Some(&root),
            );
            reply["recovered"] = "continued".into();
            reply["swept"] = swept.into();
            reply
        }
        // The user's Stop, then Resume: their message again only on the log's proof that no child
        // read it, by its command id; else the old app's neutral line carries the request on [D300, D373, D2022].
        _ if fold::resumable(f, state) => {
            let last = f.last.clone().unwrap_or_default();
            let backend = last["backend"].as_str().filter(|b| !b.is_empty());
            let old = last["cid"].as_str().unwrap_or("");
            let resend = last["never_ran"] == true && last["origin"] == "user";
            let (cid, origin, said) = match resend {
                true => (format!("{old}.r{now}"), "user", "resent"),
                false => (format!("rs{now}"), "system", "continued"),
            };
            // Another agent picked since takes it on, from the hand-off [D90].
            let picked = f.picked.is_some();
            // With no agent alive and no conversation to resume, the line would start a new one without the request.
            if !resend
                && !picked
                && child.is_none()
                && !f.resume.contains_key(backend.unwrap_or(&f.backend))
            {
                return json!({"ok": false, "error": "The agent stopped before its conversation began, so there's nothing to carry on. Send your message again."});
            }
            let msg = if resend {
                again(spec, last["text"].as_str().unwrap_or(""), &last["parts"])
            } else {
                Message::plain(RESUME)
            };
            let mut reply = send(
                spec,
                f,
                child,
                call,
                &cid,
                origin,
                &msg,
                // Past its threshold, the Resume is the next input that goes on in a fresh conversation [D108].
                backend.filter(|_| !picked && !crate::rebirth::full(spec, f)),
                resend.then_some(old),
            );
            reply["recovered"] = said.into();
            reply
        }
        _ => json!({"ok": false, "error": format!("nothing to recover: {state}")}),
    }
}

/// A message sent again as it was first sent, its files already in the session's folder.
fn again(spec: &Spec, text: &str, parts: &Value) -> Message {
    crate::message::compose(spec, text, parts.clone()).unwrap_or_else(|_| Message::plain(text))
}
