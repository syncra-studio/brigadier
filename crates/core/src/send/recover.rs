//! The one recovery of a session's last turn: an unproven delivery, a lost one, a cut-off run,
//! and the user's own Stop with Resume.

use super::{Call, Running, send};
use crate::fold::{self, Fold, Live};
use crate::message::Message;
use crate::{Spec, adapters, as_run, sweep};
use brigadier_frames::{log, procs};
use serde_json::{Value, json};

/// What Resume says after the user's Stop, the old app's line [D2022].
pub(crate) const RESUME: &str = "[The user stopped you, then asked you to resume. Continue their request from where you left off.]";

/// What carries on a turn the network cut, once it is back [D339].
pub(crate) const RECONNECT: &str = "[Your last turn was cut off: the connection to your API dropped. It's back now. Continue from where you left off.]";

/// Carries on a last turn a passing failure ended, in the same conversation, under the command id
/// `fold::reconnect` gives that try, so it goes once [D339, D54]. `now`: the user's Try again.
pub fn reconnect(spec: &Spec, f: &Fold, child: Running, call: Call, now: bool) -> Value {
    let Some(due) = fold::reconnect(f, now) else {
        return json!({"ok": false, "error": "not_due"});
    };
    let (cid, of) = (due["cid"].as_str().unwrap_or(""), due["of"].as_str());
    if f.cids.contains_key(cid) {
        return json!({"ok": false, "error": "not_due"});
    }
    let backend = due["backend"].as_str().filter(|b| !b.is_empty());
    let mut reply = send(
        spec,
        f,
        child,
        call,
        cid,
        "system",
        &Message::plain(RECONNECT),
        backend,
        of,
    );
    reply["recovered"] = "reconnected".into();
    reply
}

/// The one recovery. An unproven delivery is re-sent only when a person asks (never by itself), and
/// to an agent that acks only when the log proves no child read it [D54, D82, D222]; an interrupted
/// turn continues through the backend's resume id. `more`: what goes with the user's Resume [D329].
pub fn recover(
    spec: &Spec,
    f: &Fold,
    live: &Live,
    child: Running,
    call: Call,
    more: &str,
) -> Value {
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
            let resume = f.resume.get(&turn.backend);
            // Its own record proves it never took it: it goes again, once [D66].
            if !resume.is_some_and(|id| a.accepted(&run, id, cid))
                && resume.is_some_and(|id| a.missed(&run, id, cid))
            {
                return resend(spec, f, child, call, turn, now);
            }
            if !resume.is_some_and(|id| a.accepted(&run, id, cid)) {
                let e = format!(
                    "{} didn't confirm this message, and there's no proof it wasn't received, so it wasn't sent again. If it's missing from the conversation, send it again.",
                    a.label()
                );
                return json!({"ok": false, "recovered": "uncertain", "error": e});
            }
            taken(spec, child, call, more, cid)
        }
        "undelivered" => {
            let Some(turn) = f.turns.iter().find(|t| t.delivered.is_none()) else {
                return json!({"ok": false});
            };
            // The agent is asked first: one its record shows it took never goes twice [D66].
            let cid = turn.cid.as_deref().unwrap_or("");
            let run = as_run(spec, f, &turn.backend, None);
            let a = adapters::get(&turn.backend);
            if a.is_some_and(|a| {
                (f.resume.get(&turn.backend)).is_some_and(|id| a.accepted(&run, id, cid))
            }) {
                return taken(spec, child, call, more, cid);
            }
            resend(spec, f, child, call, turn, now)
        }
        "interrupted" => {
            let swept = sweep(f, &spec.dir);
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
            let cid = format!("rc{now}");
            let mut reply = with_back(
                spec,
                f,
                None,
                call,
                &cid,
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
            // Stopped before the agent said or did anything for it, and with no ack proving it
            // took it, the user's message may never have reached it (a stop drops what it hadn't
            // read): it goes with the Resume, so nothing they sent is lost [D82, D154].
            let acked = last["delivered"] == true
                && adapters::get(backend.unwrap_or(&f.backend)).is_some_and(|a| a.acks());
            let carried = !resend && last["origin"] == "user" && last["said"] == false && !acked;
            let (cid, origin, said) = match resend {
                true => (format!("{old}.r{now}"), "user", "resent"),
                false => (format!("rs{now}"), "system", "continued"),
            };
            // Another agent picked since takes it on, from the hand-off [D90].
            let picked = f.picked.is_some();
            // With no agent alive and no conversation to resume, the line would start a new one without the request.
            if !resend
                && !carried
                && !picked
                && child.is_none()
                && !f.resume.contains_key(backend.unwrap_or(&f.backend))
            {
                return json!({"ok": false, "error": "The agent stopped before its conversation began, so there's nothing to carry on. Send your message again."});
            }
            let mut msg = if resend {
                again(spec, last["text"].as_str().unwrap_or(""), &last["parts"])
            } else {
                Message::plain(RESUME)
            };
            if carried {
                let m = again(spec, last["text"].as_str().unwrap_or(""), &last["parts"]);
                msg.agent = format!("{RESUME}\n\n{}", m.agent);
                msg.images = m.images;
                if m.parts["back"].is_array() {
                    msg.parts = json!({"back": m.parts["back"]});
                }
            }
            msg.agent += more;
            let mut reply = with_back(
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
        // Steers its turn ended before confirming, with no turn left to recover [D66].
        _ if f.turns.is_empty() && f.acking.values().any(|i| gone(f, child, i)) => {
            left(spec, f, child, call)
        }
        _ => json!({"ok": false, "error": format!("nothing to recover: {state}")}),
    }
}

/// `msg` sent as `cid` after the words of the steers a gone child never confirmed and its agent's
/// record proves it never took, each settled by this one's reply: a Recover's, a Resume's, or what
/// carries on a turn a switch cut [D66].
#[allow(clippy::too_many_arguments)]
pub fn with_back(
    spec: &Spec,
    f: &Fold,
    child: Running,
    call: Call,
    cid: &str,
    origin: &str,
    msg: &Message,
    backend: Option<&str>,
    retry_of: Option<&str>,
) -> Value {
    let back = match unconfirmed(spec, f, child, call) {
        Ok(back) => back,
        Err(reply) => return reply,
    };
    let mut msg = msg.clone();
    carry(&mut msg, &back);
    let mut reply = send(spec, f, child, call, cid, origin, &msg, backend, retry_of);
    back.settle(call, cid, &mut reply);
    reply["cid"] = cid.into();
    reply
}

/// Steers a gone child never confirmed, outside any turn: each settled by its agent's record, and
/// those it never took sent again, once, as an input of their own [D66].
fn left(spec: &Spec, f: &Fold, child: Running, call: Call) -> Value {
    let back = match unconfirmed(spec, f, child, call) {
        Ok(back) => back,
        Err(reply) => return reply,
    };
    let cid = format!("rb{}", log::now_ms());
    let mut reply = json!({"ok": true, "recovered": "checked"});
    if !back.ids.is_empty() {
        let mut msg = Message::plain("");
        carry(&mut msg, &back);
        reply = send(spec, f, child, call, &cid, "system", &msg, None, None);
        (reply["recovered"], reply["cid"]) = ("resent".into(), cid.as_str().into());
    }
    back.settle(call, &cid, &mut reply);
    reply
}

/// Its agent's record shows it took `cid` before it was cut off: noted as such, and its turn goes
/// on in the same Recover, never sending it twice [D66].
fn taken(spec: &Spec, child: Running, call: Call, more: &str, cid: &str) -> Value {
    let took = json!({"event": "confirmed", "cid": cid, "how": "accepted"});
    let cut = json!({"event": "interrupted", "reason": {"accepted": cid}});
    for note in [took, cut] {
        if let Err(e) = call(json!({"op": "note", "data": note})) {
            return json!({"ok": false, "error": e.to_string()});
        }
    }
    let f = match crate::fold(&spec.dir, true) {
        Ok(f) => f.fold,
        Err(e) => return json!({"ok": false, "error": e.to_string()}),
    };
    let live = fold::live(&f, fold::Owner::Alive, &spec.dir, &procs::all());
    let mut reply = recover(spec, &f, &live, child, call, more);
    reply["accepted"] = cid.into();
    reply
}

/// The turn's own message again, under a new id that names it [D54].
fn resend(spec: &Spec, f: &Fold, child: Running, call: Call, turn: &fold::Turn, now: u64) -> Value {
    let old = turn.cid.clone().unwrap_or_default();
    if let Err(e) = call(
        json!({"op": "note", "data": {"event": "interrupted", "reason": {"undelivered": old}}}),
    ) {
        return json!({"ok": false, "error": e.to_string()});
    }
    let cid = format!("{old}.r{now}");
    let mut msg = again(spec, &turn.text, &turn.parts);
    carry(&mut msg, &Back::default());
    let carried = turn.parts["back"].clone();
    let mut reply = send(
        spec,
        f,
        child,
        call,
        &cid,
        &turn.origin,
        &msg,
        Some(&turn.backend),
        Some(&old),
    );
    (reply["recovered"], reply["cid"]) = ("resent".into(), cid.as_str().into());
    // One its agent never confirmed is settled by the new one's reply, as a steer given back is.
    if f.acking.contains_key(&old) {
        Back {
            ids: vec![old],
            ..Default::default()
        }
        .settle(call, &cid, &mut reply);
        // Those it carried follow it there: their records wait on the new one.
        let ids = carried
            .as_array()
            .into_iter()
            .flatten()
            .map(|c| c["cid"].clone());
        if let Some(resent) = reply["resent"].as_array_mut() {
            resent.extend(ids);
        }
    }
    reply
}

/// Steers a child that's gone never confirmed [D66], each settled by its agent's own record: taken,
/// proven never taken (its words go with the recovery, once), or not known either way.
#[derive(Default)]
struct Back {
    words: Vec<String>,
    ids: Vec<String>,
    taken: Vec<String>,
    unknown: Vec<String>,
}

impl Back {
    /// Once the recovery went, those it carries are settled as gone with it.
    fn settle(&self, call: Call, cid: &str, reply: &mut Value) {
        let went = matches!(
            reply["result"].as_str(),
            Some("delivered" | "logged" | "sent")
        );
        for id in self.ids.iter().filter(|_| went) {
            let note = json!({"event": "confirmed", "cid": id, "how": "resent", "as": cid, "error": "unconfirmed"});
            if let Err(e) = call(json!({"op": "note", "data": note})) {
                reply["error"] = e.to_string().into();
            }
        }
        // Logged, its input settles them whatever its send says: their records wait on it.
        if !self.ids.is_empty() {
            reply["resent"] = json!(self.ids);
        }
        if !self.taken.is_empty() {
            reply["taken"] = json!(self.taken);
        }
        if !self.unknown.is_empty() {
            reply["unconfirmed"] = json!(self.unknown);
            reply["message"] = "Some messages went into its last turn and its agent never confirmed them, and nothing proves it didn't get them, so they weren't sent again. They're in the conversation above: send any it's missing again.".into();
        }
    }
}

/// Whether steer `input` went to a child that's gone: a live child may take its own yet, but
/// never one written to the child before it [D66].
fn gone(f: &Fold, child: Running, input: &Value) -> bool {
    let live = f.child.as_ref().filter(|c| child.is_some() && !c.exited);
    input["steer"] == true
        && live.is_none_or(|c| !input["child"].is_null() && input["child"] != c.start_us)
}

fn unconfirmed(spec: &Spec, f: &Fold, child: Running, call: Call) -> Result<Back, Value> {
    let mut back = Back::default();
    // In the order they came, so one sender's go again in its order [D67].
    let mut steers: Vec<_> = (f.acking.iter())
        .filter(|(_, i)| gone(f, child, i))
        .collect();
    steers.sort_by_key(|(_, i)| i["n"].as_u64());
    for (cid, input) in steers {
        let backend = input["backend"].as_str().unwrap_or(&f.backend);
        let Some(a) = adapters::get(backend) else {
            continue;
        };
        let run = as_run(spec, f, backend, None);
        let resume = f.resume.get(backend);
        let took = resume.is_some_and(|id| a.accepted(&run, id, cid));
        // shortcut: a steer's images don't go with it again; carry its parts if that shows.
        if !took && resume.is_some_and(|id| a.missed(&run, id, cid)) {
            back.words.push(input["text"].as_str().unwrap_or("").into());
            back.ids.push(cid.clone());
            continue;
        }
        let how = if took { "accepted" } else { "unknown" };
        let note = json!({"event": "confirmed", "cid": cid, "how": how, "error": (!took).then_some("unconfirmed")});
        call(json!({"op": "note", "data": note}))
            .map_err(|e| json!({"ok": false, "error": e.to_string()}))?;
        match took {
            true => back.taken.push(cid.clone()),
            false => back.unknown.push(cid.clone()),
        }
    }
    Ok(back)
}

/// A message sent again as it was first sent, its files already in the session's folder, still
/// naming the steers a Recover gave back with it [D66].
fn again(spec: &Spec, text: &str, parts: &Value) -> Message {
    let mut own = parts.clone();
    if let Some(p) = own.as_object_mut() {
        p.remove("back");
        if p.is_empty() {
            own = Value::Null;
        }
    }
    let mut msg =
        crate::message::compose(spec, text, own, None).unwrap_or_else(|_| Message::plain(text));
    if parts["back"].is_array() {
        if !msg.parts.is_object() {
            msg.parts = json!({});
        }
        msg.parts["back"] = parts["back"].clone();
    }
    msg
}

/// `msg` with the steers it carries already and those `back` gives back now, in the order they
/// came, ahead of its own words; its input keeps them all, so a resend of it carries them again.
fn carry(msg: &mut Message, back: &Back) {
    let had = msg.parts["back"].as_array().cloned().unwrap_or_default();
    let now = (back.ids.iter().zip(&back.words)).map(|(c, t)| json!({"cid": c, "text": t}));
    let all: Vec<Value> = had.into_iter().chain(now).collect();
    if all.is_empty() {
        return;
    }
    let words = all.iter().filter_map(|c| c["text"].as_str());
    let own = [msg.agent.as_str()].into_iter().filter(|t| !t.is_empty());
    msg.agent = words.chain(own).collect::<Vec<_>>().join("\n\n");
    if !msg.parts.is_object() {
        msg.parts = json!({});
    }
    msg.parts["back"] = all.into();
}
