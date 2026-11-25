//! A Brigade [D185, D189]: a session whose boss agent leads sub-sessions, each a full lead with
//! workers of its own, made as workers are (`make`) but not naked. Its asks go to the boss, which
//! answers from the user's words or passes them to the user (`to_user`); its result goes back
//! once its own workers are done. Starts are capped between the user's messages, so a loop comes
//! back to the user [D144]. A session is a Brigade from its first message, `start --brigade`, or
//! never: nothing turns a started one on or off [D209].

use super::{Link, busy, busy::owes, link, records, refuse, result};
use crate::{control, owner, peers};
use brigadier_core::message::answers::Answers;
use brigadier_core::{self as core};
use serde_json::{Value, json};
use std::io;
use std::path::Path;

/// Sub-sessions a Brigade runs at once, and starts between two of its user's messages.
const AT_ONCE: usize = 3;
const SESSIONS: usize = 6;
/// Worker starts a Brigade's boss or sub-session makes between two of its user's messages.
const WORKERS: usize = 12;
/// A sub-session's question to its boss that goes to the user instead.
const THIRD: usize = 3;
pub(crate) const ASK_USER: &str = "Ask the user before starting more";

/// A row's Brigade facts: a Brigade, or the Brigade a sub-session works in, its row under it.
pub fn brigade_row(row: &mut Value, spec: Option<&core::Spec>) {
    row["brigade"] = spec.is_some_and(|s| s.brigade).into();
    row["boss"] = json!(spec.and_then(|s| s.boss.as_ref()));
}

/// Why session `me` may not start another (`session`: a sub-session), past a Brigade's caps.
pub(super) fn capped(data: &Path, me: &str, spec: &core::Spec, session: bool) -> Option<Value> {
    if session && !spec.brigade {
        return Some(refuse(
            "Only a Brigade uses `start --session`. If the user asked for a new session, use `brigadier new`.",
        ));
    }
    let boss = if spec.brigade {
        me
    } else {
        spec.boss.as_deref()?
    };
    let since = core::fold(&core::session_dir(data, boss), true).map_or(0, |f| f.fold.sent);
    let mine = records(data, me);
    let (kind, most) = if session {
        ("sessions", SESSIONS)
    } else {
        ("workers", WORKERS)
    };
    let started = (mine.iter())
        .filter(|r| r.session == session && r.at > since)
        .count();
    // A night has caps of its own, and no user to ask.
    if started >= most && crate::overnight::of(data, me).is_none() {
        return Some(refuse(&format!(
            "{ASK_USER}: you started {started} {kind} since their last message, the most allowed. Tell them where the job stands and end your turn."
        )));
    }
    let running = (mine.iter())
        .filter(|r| r.session && (r.state == "starting" || busy(data, &r.wid)))
        .count();
    (session && running >= AT_ONCE).then(|| refuse(&format!("{running} sessions run now, the most at once. Wait for one's result, then start this one.")))
}

/// What a sub-session gets after its brief, in place of a worker's line [D189].
pub(super) fn line(boss: &str, bid: &str, land: &str) -> String {
    format!(
        "You're a session in the Brigade {boss} ({bid}): you lead this part of its job, with workers of your own, and own only the files your brief gives you. Your boss holds the decisions. Send it only a decision you propose or a question, with `brigadier send {bid} \"…\"`, and wait there; never send it progress or results, and never ask the user. An answer may be the user's own, passed through your boss. When your part is done and its workers are finished, your last message goes back to your boss by itself: end with what you did, what you decided and what's open. {land} `brigadier read {bid} --user` has the user's own words."
    )
}

/// Whether sub-session `sid` still leads work: a worker of its own runs, or a result waits to
/// reach it. Its result goes to its boss only after [D151].
pub(super) fn leading(data: &Path, sid: &str) -> bool {
    records(data, sid)
        .iter()
        .any(|r| r.state == "starting" || owes(data, &r.wid))
        || (result::all(data, sid).iter())
            .any(|(_, r)| r.how != "asks" && matches!(r.state.as_str(), "written" | "sent"))
}

/// `brigadier send <sid> --to-user` from its boss: what sub-session `sid` asks waits on the user,
/// on its own card; its answer goes to `sid`, not back through the boss [D189].
pub fn to_user(data: &Path, me: &str, sid: &str) -> Value {
    let Some(l) = link(data, sid).filter(|l| l.parent == me && l.session) else {
        return refuse("Only a Brigade passes its own sessions' asks to the user.");
    };
    if crate::overnight::of(data, me).is_some() {
        return refuse("The user is away overnight: decide it yourself, by research, and answer.");
    }
    if let Err(e) = pass(data, sid, &l) {
        return refuse(&e);
    }
    let _ = super::take_ask(data, me, sid);
    json!({"ok": true, "text": format!("The user has it now, on {}'s card, and answers there. Go on with the rest, or end your turn.", l.title)})
}

/// Passes `sid`'s waiting ask to the user: its own request, else its open question to its boss.
fn pass(data: &Path, sid: &str, l: &Link) -> Result<(), String> {
    let note = match (
        super::asks::waiting(data, sid, None),
        peers::open_question(data, sid),
    ) {
        (Some((id, _)), _) => json!({"phase": "to_user", "id": id}),
        (None, Some((mid, text))) => {
            let boss = core::load(data, &l.parent)
                .map(|s| core::share::title(&s))
                .unwrap_or_default();
            let item =
                json!({"text": text, "options": [], "recommended": null, "multiSelect": false});
            let request = json!({"id": format!("peer-{mid}"), "title": format!("{boss} sent you this"), "items": [item]});
            json!({"phase": "to_user", "mid": mid, "text": text, "request": request})
        }
        (None, None) => return Err(format!("{sid} isn't waiting on you.")),
    };
    let note = json!({"op": "note", "data": {"event": "peer", "phase": note["phase"], "id": note["id"],
        "mid": note["mid"], "text": note["text"], "request": note["request"]}});
    owner::call(data, sid, note)
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// A sub-session's question to its boss: its third goes to the user instead [D189].
pub(super) fn third(data: &Path, sid: &str, l: &Link) -> bool {
    l.session
        && peers::asked(data, sid) >= THIRD
        && crate::overnight::of(data, sid).is_none()
        && pass(data, sid, l).is_ok()
}

/// The user's answer on a sub-session's card to the question it sent its boss: back to its wait.
pub fn user_answer(data: &Path, sid: &str, mid: &str, given: &Answers) -> io::Result<Value> {
    let l = link(data, sid).ok_or_else(|| io::Error::other("not a Brigade's session"))?;
    let [said, told] = [&given.said, &given.told].map(|of| {
        let of: Vec<&str> = of.iter().filter_map(Value::as_str).collect();
        of.join("\n")
    });
    if !given.filed() {
        return Ok(peers::answer(data, &l.parent, sid, mid, &told));
    }
    if peers::waits(data, sid, mid) {
        let images = control::beside(data, sid, given, None)?;
        if images["result"] == "refused" {
            return Ok(images);
        }
    }
    let note = json!({"phase": "answered", "mid": mid, "reply": said, "files": given.files});
    match peers::hand_back(data, sid, mid, &told, note) {
        Ok(true) => {}
        // Nobody waits any more: the user's own message, as its images need. One that can't go now
        // still names each one's file.
        Ok(false) => {
            let sent = control::steer_as(data, sid, &said, &given.parts, None, "user", false)?;
            if sent["ok"] != true {
                return Ok(peers::send(
                    data,
                    &l.parent,
                    &json!({"id": sid}),
                    &told,
                    None,
                    &|| true,
                ));
            }
        }
        Err(refusal) => return Ok(refusal),
    }
    Ok(json!({"ok": true, "text": format!("Sent to {sid}.")}))
}
