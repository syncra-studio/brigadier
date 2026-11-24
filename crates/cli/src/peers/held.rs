//! Messages held for their receiver's running turn: the receiver's row gives them, so its thread
//! shows each as waiting until the agent has it. Never in its log, so nothing else counts them.

use super::{DONE, In, Out, all, path, save};
use crate::{queue, workers};
use serde_json::{Value, json};
use std::io;
use std::path::Path;

/// Holds `rec` for `to`'s running turn: recorded once, as every pass tries it again.
pub(super) fn hold(data: &Path, to: &str, rec: &mut In) -> io::Result<Option<&'static str>> {
    (rec.how, rec.state) = ("steer".into(), "held".into());
    let was: Option<In> = workers::read_json(&path(data, to, "in", &rec.mid));
    if was.is_none_or(|r| r.state != "held") {
        save(data, to, "in", &rec.mid, &rec)?;
        queue::wake::now();
    }
    Ok(Some("held"))
}

/// Hands a message on after those its receiver was sent before it, whoever sent them: they go in
/// the order they came, though each sender's pass runs by itself.
pub(super) fn hand(data: &Path, from: &str, out: &mut Out) -> io::Result<&'static str> {
    let waits = |r: &In| r.state == "held";
    let mine: Option<In> = workers::read_json(&path(data, &out.to, "in", &out.mid)).filter(waits);
    let mut before = all::<In>(data, &out.to, "in");
    before.retain(|r| {
        let key = |r: &In| (r.at, r.mid.clone());
        waits(r) && r.mid != out.mid && mine.as_ref().is_none_or(|m| key(r) < key(m))
    });
    before.sort_by(|a, b| (a.at, &a.mid).cmp(&(b.at, &b.mid)));
    for r in before {
        let sent: Option<Out> = workers::read_json(&path(data, &r.from, "out", &r.mid));
        let Some(mut sent) = sent.filter(|o| !DONE.contains(&o.state.as_str())) else {
            continue;
        };
        match super::hand(data, &r.from, &mut sent) {
            // Still waiting, so this one, which came after it, does too.
            Ok("held") if mine.is_some() => return Ok("held"),
            Ok(_) => {}
            Err(e) => eprintln!("brigadierd: message {} to {}: {e}", r.mid, out.to),
        }
    }
    super::hand(data, from, out)
}

/// Whether another hand settled `from`'s message meanwhile: what it settled on stays.
pub(super) fn done(data: &Path, from: &str, mid: &str) -> bool {
    let out: Option<Out> = workers::read_json(&path(data, from, "out", mid));
    out.is_some_and(|o| DONE.contains(&o.state.as_str()))
}

/// Whether the message a row gives is still its sender's: not once that session is deleted.
pub fn kept(data: &Path, m: &Value) -> bool {
    let s = |k: &str| m[k].as_str().unwrap_or("");
    path(data, s("from"), "out", s("id")).exists()
}

/// `id`'s messages from other sessions that its agent hasn't got yet, in the order they came: one
/// on its way into its turn or queue before those held. One in its queue shows there.
pub fn row(data: &Path, id: &str) -> Vec<Value> {
    let mut ins = all::<In>(data, id, "in");
    ins.retain(|i| matches!(i.state.as_str(), "adding" | "held" | "steering"));
    ins.sort_by(|a, b| {
        let key = |i: &In| (i.state == "held", i.at, i.mid.clone());
        key(a).cmp(&key(b))
    });
    let each = |i: In| {
        let o: Out = workers::read_json(&path(data, &i.from, "out", &i.mid))?;
        Some(json!({"id": o.mid, "from": i.from, "text": o.text, "at": o.at}))
    };
    ins.into_iter().filter_map(each).collect()
}
