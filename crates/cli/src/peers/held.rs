//! Messages held for their receiver's running turn: the receiver's row gives them, so its thread
//! shows each as waiting until the agent has it. Never in its log, so nothing else counts them.

use super::{In, Out, all, path, save};
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

/// `from`'s messages to other sessions, oldest first: those held go in the order they came.
pub(super) fn sent(data: &Path, from: &str) -> Vec<Out> {
    let mut outs = all::<Out>(data, from, "out");
    outs.sort_by_key(|o| o.at);
    outs
}

/// `id`'s messages from other sessions that its agent hasn't got yet, as sent, oldest first. One in
/// its queue isn't here: it shows there.
pub fn row(data: &Path, id: &str) -> Vec<Value> {
    let ins = all::<In>(data, id, "in").into_iter();
    let mut held: Vec<(String, Out)> = ins
        .filter(|i| matches!(i.state.as_str(), "held" | "steering"))
        .filter_map(|i| {
            let out = workers::read_json(&path(data, &i.from, "out", &i.mid))?;
            Some((i.from, out))
        })
        .collect();
    held.sort_by(|(_, a), (_, b)| (a.at, &a.mid).cmp(&(b.at, &b.mid)));
    let each =
        |(from, o): (String, Out)| json!({"id": o.mid, "from": from, "text": o.text, "at": o.at});
    held.into_iter().map(each).collect()
}
