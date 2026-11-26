//! Messages held for their receiver's running turn: the receiver's row gives them, so its thread
//! shows each as waiting until the agent has it. Never in its log, so nothing else counts them.

use super::{DONE, In, Out, all, path, save};
use crate::{queue, workers};
use brigadier_core as core;
use brigadier_frames::take_lock;
use serde_json::{Value, json};
use std::collections::BTreeSet;
use std::fs;
use std::io;
use std::path::Path;
use std::sync::Mutex;

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

/// Whether `from` sent `to` a message before this one that isn't on its way yet [D67].
pub(super) fn behind(data: &Path, from: &str, to: &str, at: u64, mid: &str) -> bool {
    let earlier = |o: &Out| (o.at, o.mid.as_str()) < (at, mid);
    let outs = all::<Out>(data, from, "out").into_iter();
    outs.filter(|o| o.to == to && o.state == "written")
        .any(|o| earlier(&o))
}

/// Where `to`'s record of message `mid` stands.
pub(super) fn state(data: &Path, to: &str, mid: &str) -> Option<String> {
    workers::read_json::<In>(&path(data, to, "in", mid)).map(|r| r.state)
}

/// After a Recover gave `id`'s agent back the messages it never got [D66]: their records wait
/// again, now for its reply to the recovery that carries them.
pub(super) fn reopen(data: &Path, id: &str, mids: &Value) {
    for mid in mids
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
    {
        let p = path(data, id, "in", mid);
        let Some(mut rec) = workers::read_json::<In>(&p) else {
            continue;
        };
        rec.state = "steering".into();
        let o = path(data, &rec.from, "out", mid);
        let out = workers::read_json::<Out>(&o).filter(|o| o.state == "uncertain");
        if workers::write_json(&p, &rec).is_ok()
            && let Some(mut out) = out
        {
            out.state = "sent".into();
            let _ = workers::write_json(&o, &out);
        }
        super::open(data, &rec.from);
    }
}

/// A recovery of `id` that may log the links settling its senders' messages, a Recover's or a
/// rebirth's, and the only way one runs [D66]. Marked before it logs anything, under a lock of its
/// own, so the daemon wakes those senders once it ends, even if it dies first; what it gave back,
/// or found taken, then waits for that proof again.
pub fn recovery(data: &Path, id: &str, go: impl FnOnce() -> Value) -> io::Result<Value> {
    let at = core::session_dir(data, id).join("recover.lock");
    let mut opts = fs::OpenOptions::new();
    let lock = opts.create(true).truncate(false).write(true).open(at)?;
    lock.lock()?;
    let dir = data.join("peers-recover");
    fs::create_dir_all(&dir)?;
    fs::write(dir.join(id), "")?;
    let reply = go();
    let accepted = json!([reply["accepted"]]);
    for mids in [&reply["resent"], &reply["taken"], &accepted] {
        reopen(data, id, mids);
    }
    Ok(reply)
}

/// Each recovery that ended since: the senders of its receiver's messages still open, or settled
/// uncertain, which its links may settle now.
pub(super) fn recovered(data: &Path, open: &mut BTreeSet<String>) {
    for e in (fs::read_dir(data.join("peers-recover"))
        .into_iter()
        .flatten())
    .flatten()
    {
        let id = e.file_name().to_string_lossy().to_string();
        // Still running: its lock says so.
        if let Ok(None) = take_lock(&core::session_dir(data, &id).join("recover.lock")) {
            continue;
        }
        if fs::remove_file(e.path()).is_ok() {
            let ins = all::<In>(data, &id, "in").into_iter();
            open.extend(
                ins.filter(|r| matches!(r.state.as_str(), "uncertain" | "steering"))
                    .map(|r| r.from),
            );
        }
    }
}

/// The messages being sent now: still in their send's hands, up to when their receiver has them.
static SENDING: Mutex<BTreeSet<String>> = Mutex::new(BTreeSet::new());

pub(super) struct Sending(String);

impl Sending {
    pub(super) fn new(mid: &str) -> Sending {
        SENDING.lock().unwrap().insert(mid.into());
        Sending(mid.into())
    }
}

impl Drop for Sending {
    fn drop(&mut self) {
        SENDING.lock().unwrap().remove(&self.0);
    }
}

/// `out` as its send left it; none while that runs.
pub(super) fn current(data: &Path, from: &str, out: Out) -> Option<Out> {
    if SENDING.lock().unwrap().contains(&out.mid) {
        return None;
    }
    workers::read_json(&path(data, from, "out", &out.mid))
}

/// Hands on what `out`'s sender sent the same receiver before it and a send cut short left behind.
fn left(data: &Path, from: &str, out: &Out) -> io::Result<()> {
    let mut outs = all::<Out>(data, from, "out");
    let open = |o: &Out| matches!(o.state.as_str(), "written" | "sent");
    outs.retain(|o| o.to == out.to && (o.at, &o.mid) < (out.at, &out.mid) && open(o));
    outs.sort_by(|a, b| (a.at, &a.mid).cmp(&(b.at, &b.mid)));
    let mut log = None;
    for o in outs {
        let Some(mut o) = current(data, from, o).filter(open) else {
            continue;
        };
        let rec: Option<In> = workers::read_json(&path(data, &o.to, "in", &o.mid));
        // A steer its receiver logged is on its way, waiting on its agent's word [D66], not cut.
        let cut = match rec.as_ref().map(|r| r.state.as_str()) {
            None | Some("adding") => true,
            Some("steering") => {
                let dir = core::session_dir(data, &out.to);
                let f = match &mut log {
                    Some(f) => f,
                    None => log.insert(core::fold(&dir, true)?.fold),
                };
                !f.cids.contains_key(&o.mid)
            }
            _ => false,
        };
        if cut {
            super::reply::again(data, from, &mut o, rec.is_none())?;
        }
    }
    Ok(())
}

/// Hands a message on after those its receiver was sent before it, whoever sent them: they go in
/// the order they came, though each sender's pass runs by itself.
pub(super) fn hand(data: &Path, from: &str, out: &mut Out) -> io::Result<&'static str> {
    left(data, from, out)?;
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
            // Its sender's earlier one still waits, so this one does too, by the order its sender
            // sent them, which overlapping sends can record the other way; another sender's waits
            // only on its own [D67].
            Ok("held")
                if mine.is_some()
                    && r.from == from
                    && (sent.at, &sent.mid) < (out.at, &out.mid) =>
            {
                return Ok("held");
            }
            Ok(_) => {}
            Err(e) => eprintln!("brigadierd: message {} to {}: {e}", r.mid, out.to),
        }
    }
    super::hand(data, from, out)
}

/// What `from` has sent `to` that isn't on its way yet: their ids, in order.
pub(crate) fn written(data: &Path, from: &str, to: &str) -> Vec<String> {
    let mut outs = all::<Out>(data, from, "out");
    outs.retain(|o| o.to == to && o.state == "written");
    outs.sort_by_key(|o| o.at);
    outs.into_iter().map(|o| o.mid).collect()
}

/// Hands those on now. One that fails goes in a later pass, as any other.
pub(crate) fn hand_all(data: &Path, from: &str, sent: &[String]) {
    for mid in sent {
        if let Some(mut out) = workers::read_json::<Out>(&path(data, from, "out", mid))
            && let Err(e) = hand(data, from, &mut out)
        {
            eprintln!("brigadierd: message {mid} to {}: {e}", out.to);
        }
    }
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
