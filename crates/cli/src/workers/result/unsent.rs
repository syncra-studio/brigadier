//! A result its parent can't take now [C26]: the refusal is said once, in a row of the parent's
//! thread that changes in place as it clears, never a stale warning; while a routing rule still
//! bars the parent's model it isn't sent again, and nothing switches models [D376]. Its block and
//! the user's queued words wait as before [D48]. The row says delivered only on the parent's
//! log's proof that the agent took it [D66, D74, D80].

use super::{Res, all, settled};
use crate::owner;
use crate::workers::write_json;
use brigadier_core::{self as core, Spec, fold};
use serde_json::{Value, json};
use std::io;
use std::path::Path;

/// The row's words once it goes, and once the agent took it.
const GOING: &str = "A worker's result that was waiting is on its way.";
const TOOK: &str = "A worker's result that was waiting is delivered.";

/// Send's own routing check on the parent's next launch, and that launch's agent.
fn ruled(spec: &Spec, f: &fold::Fold) -> (Option<String>, &'static str) {
    let spec = Spec {
        rules: Some(crate::routing::launch),
        ..spec.clone()
    };
    let b = if f.backend.is_empty() {
        &spec.backend
    } else {
        &f.backend
    };
    let agent = core::adapters::get(b).map_or("", |a| a.label());
    (core::as_run(&spec, f, b, None).ruled(b).err(), agent)
}

/// Whether a refused result waits: a rule still bars the parent's model, so sending it would be
/// refused again. Any other refusal (trust, a level) goes again each pass, as before.
pub(super) fn waits(spec: &Spec, f: &fold::Fold, r: &Res) -> bool {
    !r.refused.is_empty() && ruled(spec, f).0.is_some()
}

/// After its send: logged, it's sent, its row on its way; refused in new words, its row says why.
pub(super) fn after(
    data: &Path,
    pid: &str,
    spec: &Spec,
    path: &Path,
    mut r: Res,
    reply: &Value,
) -> io::Result<()> {
    let f = core::fold(&core::session_dir(data, pid), true)?.fold;
    if f.cids.contains_key(&r.id) {
        r.state = "sent".into();
        if !r.refused.is_empty() {
            on_way(data, pid, &r);
        }
        return write_json(path, &r);
    }
    // `changed` is send's own race: it goes again next pass, as before.
    let why = (reply["error"].as_str()).filter(|e| reply["result"] == "refused" && *e != "changed");
    let Some(why) = why.filter(|why| *why != r.refused) else {
        return Ok(());
    };
    r.refused = why.into();
    let (rule, agent) = ruled(spec, &f);
    let mut text = format!(
        "A worker's result is waiting: {}.",
        why.trim_end_matches('.')
    );
    if rule.as_deref() == Some(why) {
        text += &format!(
            " It goes once you pick another {agent} model or lift the rule in Settings › Routing."
        );
    }
    // Not shown: it isn't marked said, so the next pass tries again.
    note(data, pid, &r, "warning", &text)?;
    write_json(path, &r)
}

/// One that waited went with a message: its row says it's on its way, or delivered, once proven.
pub(super) fn on_way(data: &Path, pid: &str, r: &Res) {
    let _ = note(data, pid, r, "info", GOING);
}

/// Each that waited and went since: its row says delivered once the parent's log proves the agent
/// took it, its own input or the message that carried it; taken by the parent's own `wait`, the
/// wait gave it. Says whether one is still to prove.
pub(super) fn proved(data: &Path, pid: &str, f: &fold::Fold, state: &str) -> io::Result<bool> {
    let mut more = false;
    for (path, mut r) in all(data, pid)
        .into_iter()
        .filter(|(_, r)| !r.refused.is_empty())
    {
        let proof = match r.state.as_str() {
            "taken" if r.going.is_empty() => Some("delivered"),
            "taken" => settled(f, &r.going, state),
            "delivered" => Some("delivered"),
            "uncertain" | "dropped" => Some(""),
            _ => continue,
        };
        let Some(proof) = proof else {
            more = true;
            continue;
        };
        // Not shown (its host not back yet): it stays to say, next pass.
        if proof == "delivered" && note(data, pid, &r, "info", TOOK).is_err() {
            more = true;
            continue;
        }
        r.refused.clear();
        write_json(&path, &r)?;
    }
    Ok(more)
}

/// Its row, one per result by its id. A worker's ask to its parent gives the user none [D121].
fn note(data: &Path, pid: &str, r: &Res, level: &str, text: &str) -> io::Result<()> {
    if r.how == "asks" {
        return Ok(());
    }
    let note = json!({"event": "worker", "phase": "unsent", "ids": [r.wid], "result": r.id, "level": level, "text": text});
    owner::ensure(data, &core::load(data, pid)?)?;
    owner::call(data, pid, json!({"op": "note", "data": note})).map(drop)
}
