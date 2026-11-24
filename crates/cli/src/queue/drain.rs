//! The queue's drain [D188]: what may go now goes, a message to the agent, a `!` command to its shell.

use super::*;

/// What the agent reads after a command's report (proposed words).
const REPLY: &str =
    "\n\nIf it needs nothing from you, say how it went in one short line; else go on from it.";

/// The states a session takes its next queued message in: between turns, however the last ended
/// but at a limit, a sign-in or a cut-off run, which need the user (D237); but for a cut-off
/// worker, which its parent's message carries on (`cut`).
pub(super) const DRAINS: [&str; 4] = ["idle", "idle_jobs", "stopped", "failed"];

/// The daemon's pass: each session between turns whose queue waits and isn't paused sends its
/// first message, off the daemon's loop; a worker's go to it once it's free.
pub fn drain(data: &Path, rows: &BTreeMap<String, Value>) {
    to::pass(data, rows);
    for (id, row) in rows {
        judge::pass(data, id, row);
        let q = &row["queue"];
        // While its block is held open the user's own wait, as mid-turn; another session's goes [D521, D300].
        let state = row["state"].as_str().unwrap_or("");
        let cut = state == "interrupted";
        let Ok(q) = serde_json::from_value::<Queue>(q.clone()) else {
            continue;
        };
        let first = (q.items.iter().enumerate()).find(|(at, i)| {
            q.goes(*at, row["holding"] == true)
                && (!cut || cut::parents(&core::session_dir(data, id), i.origin.as_deref()))
        });
        if first.is_none_or(|(_, i)| i.error.is_some())
            || q.paused
            || !(cut || DRAINS.contains(&state))
            // A rebirth due goes first: what's queued lands in its fresh conversation [D88].
            || !row["rebirth"].is_null()
        {
            continue;
        }
        let (data, id) = (data.to_path_buf(), id.clone());
        thread::spawn(move || {
            if let Err(e) = send_first(&data, &id) {
                eprintln!("brigadierd: queue {id}: {e}");
            }
        });
    }
}

/// Sends the first queued message, judged and sent under the queue's lock (another pass that finds
/// it held leaves it). The host takes it only if nothing reached the log since the session was
/// judged between turns; a changed session keeps it queued. It leaves the queue only once the log
/// has it; a refusal stays on it, and the queue waits there.
fn send_first(data: &Path, id: &str) -> io::Result<()> {
    let dir = core::session_dir(data, id);
    let Some(_lock) = take_lock(&dir.join("queue.lock"))? else {
        return Ok(());
    };
    let spec = core::load(data, id)?;
    crate::rewind::settle_held(data, &spec)?;
    let holding = crate::workers::holding(data, id);
    locked(&dir, |q| {
        let (f, state) = cut::now(data, id)?;
        let cut = state == "interrupted";
        let goes = |at: &usize| {
            let origin = q.items[*at].origin.as_deref();
            q.goes(*at, holding) && (!cut || cut::carries(&dir, &f, origin))
        };
        let Some(at) = (0..q.items.len()).find(goes) else {
            return Ok(());
        };
        let item = q.items[at].clone();
        if q.paused || item.error.is_some() {
            return Ok(());
        }
        if f.cids.contains_key(&item.id) {
            q.items.remove(at);
            return Ok(());
        }
        if item.shell.as_deref() == Some("wait") {
            if f.turns.is_empty() && DRAINS.contains(&state.as_str()) {
                match crate::tabs::terminal::shell::start(data, id, &item.id, &item.text) {
                    Ok(()) => {
                        q.items.remove(at);
                        q.running.push(item.id);
                    }
                    Err(e) => q.items[at].error = Some(e.to_string()),
                }
            }
            return Ok(());
        }
        owner::ensure(data, &spec)?;
        let ping = owner::call(data, id, json!({"op": "ping"}))?;
        let Some(len) = ping["len"].as_u64() else {
            return Ok(());
        };
        let f = core::fold(&dir, true)?;
        let live = fold::live(&f.fold, owner::state(data, id), &dir, &procs::all());
        let status = fold::status(&f.fold, &live);
        let state = status["state"].as_str().unwrap_or("");
        let free = match cut {
            // A turn still open in the log is ended by its child's exit, on its way.
            true => state == "interrupted" && f.fold.turns.is_empty(),
            false => DRAINS.contains(&state),
        };
        if live.owner != Owner::Alive || !free {
            return Ok(());
        }
        if cut {
            core::sweep(&f.fold, &dir);
        }
        let child = ping["child"]
            .as_i64()
            .map(|_| ping["spawn"].as_u64().unwrap_or(0));
        let call = |mut req: Value| {
            // A replace judges idleness itself, later: its own guard stands.
            if req["if_len"].is_null() && matches!(req["op"].as_str(), Some("input" | "spawn")) {
                req["if_len"] = len.into();
            }
            owner::call(data, id, req)
        };
        let mut msg = core::message::compose(&spec, &item.text, item.parts.clone(), None)?;
        if item.shell.is_some() {
            msg.agent += REPLY;
        }
        // What's held for the parent's next message goes with it [D329].
        let held = crate::workers::with_next(data, id, Some(&item.id), &mut msg.agent);
        let reply = core::send(
            &crate::routing::told(data, &spec),
            &f.fold,
            child,
            &call,
            &item.id,
            item.origin.as_deref().unwrap_or("user"),
            &msg,
            None,
            None,
        );
        if went(&dir, &reply, &item.id) {
            crate::workers::went_with(data, id, held);
            q.items.remove(at);
        } else if reply["error"] != "changed" {
            let why = reply["message"]
                .as_str()
                .or(reply["error"].as_str())
                .unwrap_or("refused");
            q.items[at].error = Some(why.into());
        }
        Ok(())
    })
}
