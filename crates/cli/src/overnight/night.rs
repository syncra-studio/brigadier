//! The daemon's pass over each night: what still needs its user is answered for them, a turn that
//! ended with parts left is carried on, a limit or a failure is waited out, and the night ends
//! once its agent has reported. All of it is judged from the log and the kept state, so a
//! restart, an update or a sleep goes on where it was; every message has its own command id, so
//! it goes once [D54].

use super::{end, load, settle};
use crate::{control, owner, queue, switching, workers};
use brigadier_core::overnight::{Left, Overnight, Tries, change};
use brigadier_core::{self as core, fold::Fold};
use brigadier_frames::log;
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::thread;

/// What an ask that would wait on the user hears instead.
const AWAY: &str = "The user is away overnight and can't answer. Decide it yourself by research, log it with `brigadier overnight decided`, and go on without asking.";

const MINUTE: u64 = 60_000;
/// Proposed: a turn's end is left this long, for what is already on its way to go first.
const SETTLE_MS: u64 = 3_000;
/// Proposed: how long a session's own background jobs alone hold its next message back (a server
/// left running would for good), and how long a silent turn is left before it's stopped.
const JOBS_MS: u64 = 15 * MINUTE;
const SILENT_MS: u64 = 30 * MINUTE;
/// Proposed: how long a message the agent took has to begin its turn before it's stopped.
const BEGIN_MS: u64 = 5 * MINUTE;
/// Proposed: Overnight turned on between turns, how long the user has to say the job first.
const ASK_MS: u64 = 20_000;
/// Proposed: when a limit that gave no reset is tried again.
const LIMIT_MS: u64 = 30 * MINUTE;
/// Messages in a row that changed nothing: from `STUCK` it's told to change approach, at `GIVE_UP`
/// its first open part is left.
const STUCK: u64 = 3;
const GIVE_UP: u64 = 5;
/// Proposed: messages a part gets before it's left, whatever they changed, so no night is endless.
const MOST: u64 = 40;
/// Proposed: failures in a row, none of them passing, that end the night.
const FAILURES: u32 = 8;
const FAILING: &str = "Its agent kept failing, so the night ended early.";
const CUT: &str =
    "your last turn was cut off before it started: check where you were before you go on";
const NEVER: u64 = u64::MAX / 2; // Not again while its row stays the same.

/// Sessions and workers looked at now, or not again before this (ms) while the row's turn is this.
static NEXT: Mutex<Option<HashMap<String, (u64, Value)>>> = Mutex::new(None);

/// Runs `f` for `id` off the daemon's loop, one at a time, and again only once `f`'s wait is over
/// or its row moved on.
fn once(id: &str, row: &Value, f: impl FnOnce() -> io::Result<u64> + Send + 'static) {
    let at = json!([
        row["state"],
        row["finished"],
        row["reason"],
        row["overnight"],
        row["overnight_due"]
    ]);
    let now = log::now_ms();
    {
        let mut next = NEXT.lock().unwrap();
        let next = next.get_or_insert_with(HashMap::new);
        match next.get(id) {
            Some((u64::MAX, _)) => return,
            Some((until, was)) if now < *until && *was == at => return,
            _ => next.insert(id.into(), (u64::MAX, Value::Null)),
        };
    }
    let id = id.to_string();
    thread::spawn(move || {
        let wait = f().unwrap_or_else(|e| {
            eprintln!("brigadierd: overnight {id}: {e}");
            MINUTE
        });
        if let Some(next) = NEXT.lock().unwrap().as_mut() {
            next.insert(id, (log::now_ms() + wait, at));
        }
    });
}

pub fn pass(data: &Path, rows: &BTreeMap<String, Value>) {
    let nights = || (rows.iter()).filter(|(_, r)| r["overnight"]["state"] == "night");
    for (id, row) in rows.iter().filter(|(_, r)| r["overnight_due"] == true) {
        let (data, sid) = (data.to_path_buf(), id.clone());
        once(&format!("{id} due"), row, move || {
            settle(&data, &sid).map(|()| 10_000)
        });
    }
    let asks = |r: &Value| {
        let between = matches!(r["state"].as_str(), Some("idle" | "idle_jobs" | "stopped"));
        r["overnight"]["state"] == "asking" && between
    };
    for (id, row) in rows.iter().filter(|(_, r)| asks(r)) {
        let (data, sid) = (data.to_path_buf(), id.clone());
        once(id, &row.clone(), move || ask(&data, &sid));
    }
    for (id, row) in nights() {
        let team: Vec<Value> = (workers::below(data, id).iter())
            .filter_map(|r| rows.get(&r.wid).cloned())
            .collect();
        for row in team.iter().filter(|r| waits_on_us(r)) {
            let (data, row) = (data.to_path_buf(), row.clone());
            let wid = str_of(&row, "id");
            once(&wid.clone(), &row.clone(), move || {
                unstick(&data, &wid, &row)
            });
        }
        let (data, sid, row) = (data.to_path_buf(), id.clone(), row.clone());
        once(id, &row.clone(), move || step(&data, &sid, &row, &team));
    }
}

/// Turned on in a session already going: its agent is told as its turn ends, or a little later
/// between turns, unless the user's own message told it.
fn ask(data: &Path, id: &str) -> io::Result<u64> {
    let dir = core::session_dir(data, id);
    let (o, f) = (load(&dir), core::fold(&dir, true)?.fold);
    let Some(last) = f.last.as_ref().filter(|_| f.turns.is_empty()) else {
        return Ok(MINUTE);
    };
    if o.told || o.state != "asking" {
        return Ok(MINUTE);
    }
    let ended = last["ts"].as_u64().unwrap_or(0) + SETTLE_MS;
    let wait = (ended.max(o.on + ASK_MS)).saturating_sub(log::now_ms());
    if wait > 0 || queue::takes(&dir, None) {
        return Ok(wait.max(1_000));
    }
    let (turn, cid) = (str_of(last, "id"), format!("ask{}", o.on));
    let takes = || queue::takes(&dir, None);
    const TEXT: &str = "[Brigadier: the user turned Overnight on, for the job you have. Ask what's still open before they go.]";
    queue::own(data, id, &turn, &cid, TEXT, true, &takes)?;
    Ok(5_000)
}

fn str_of(row: &Value, key: &str) -> String {
    row[key].as_str().unwrap_or("").into()
}

/// Whether a worker stands still till someone acts: the user's ask, a cut-off run, a silent turn.
fn waits_on_us(row: &Value) -> bool {
    matches!(
        row["state"].as_str(),
        Some(
            "waiting_answer"
                | "interrupted"
                | "undelivered"
                | "uncertain"
                | "stalled"
                | "no_turn_started"
        )
    )
}

/// Moves a session or a worker on from what its user would settle. Says how long to leave it (ms).
fn unstick(data: &Path, id: &str, row: &Value) -> io::Result<u64> {
    match row["state"].as_str().unwrap_or("") {
        "waiting_answer" => answer(data, id).map(|()| 2_000),
        "stalled" => {
            // Its process stopped, or not a word for long: a tool it runs would show as working.
            let silent = row["reason"]["silent_ms"].as_u64().unwrap_or(SILENT_MS);
            if silent >= SILENT_MS {
                halt(data, id)?;
            }
            Ok(MINUTE)
        }
        "no_turn_started" => {
            if row["reason"].as_u64().unwrap_or(0) >= BEGIN_MS {
                halt(data, id)?;
            }
            Ok(MINUTE)
        }
        "interrupted" => {
            let dir = core::session_dir(data, id);
            let f = core::fold(&dir, true)?.fold;
            // The user's own Stop on it stays theirs.
            if (f.last.as_ref()).is_some_and(|l| f.turns.is_empty() && l["halted"] == true) {
                return Ok(MINUTE);
            }
            let r = queue::recover(data, id, false)?;
            if r["ok"] == true {
                return Ok(MINUTE);
            }
            eprintln!("brigadierd: overnight {id}: {}", r["error"]);
            // Never sent again unproven [D66, D80]: a worker's result tells its parent; a lead's cut,
            // once logged closed (the refusal logs it), counts once its message goes.
            match (workers::link(data, id).is_some(), f.turns.is_empty()) {
                (true, _) => Ok(NEVER),
                (_, false) => Ok(2_000),
                _ if load(&dir).tries.failed >= FAILURES => finish(data, id, Some(FAILING)),
                _ => {
                    let turn = f.last.as_ref().map(|l| str_of(l, "id")).unwrap_or_default();
                    carry_on(data, id, &f, &turn, true, true).map(|()| MINUTE)
                }
            }
        }
        // Never sent again unproven: stopped, so its session goes on with a message of its own.
        _ => {
            if queue::recover(data, id, false)?["ok"] != true {
                halt(data, id)?;
            }
            Ok(MINUTE)
        }
    }
}

/// Ends a turn that can't end itself, as Brigadier's, never the user's Stop.
fn halt(data: &Path, id: &str) -> io::Result<()> {
    if control::interrupt(data, id, "overnight")?.is_none() {
        owner::call(data, id, json!({"op": "stop", "by": "overnight"}))?;
    }
    Ok(())
}

/// Every request of `id`'s that waits on its user, answered for them: a question hears they're
/// away, an approval is denied with that, a reviewed plan goes ahead, a mockup is skipped, a worker out of
/// quota waits for its reset.
fn answer(data: &Path, id: &str) -> io::Result<()> {
    let f = core::fold(&core::session_dir(data, id), true)?.fold;
    let choose = |request: &str, choice: &str| {
        let answers = json!([choice]).to_string();
        let args = ["answer", id, request, "--answers", &answers].map(String::from);
        control::answer(data, &args).map(|_| ())
    };
    if let Some(hold) = f.hold.as_ref().filter(|_| core::fold::held(&f)) {
        let options = hold["request"]["items"][0]["options"].as_array();
        // Out of retries it stops, its lead told; else it waits.
        let at = match hold["retry"] == true {
            true => options.and_then(|o| o.last()),
            false => options.and_then(|o| o.first()),
        };
        let choice = at.map(|o| str_of(o, "label")).unwrap_or_default();
        return choose(&str_of(hold, "id"), &choice);
    }
    let Some(turn) = f.turns.first() else {
        return Ok(());
    };
    for (card, _) in f.mockups.cards.iter().filter(|(_, t)| **t == turn.id) {
        choose(card, crate::relay::mockup::SKIP)?;
    }
    for (request, r) in turn.asks.iter().filter(|(_, r)| r["to"].is_null()) {
        if r["items"].is_array() {
            control::reply(data, id, AWAY, &Value::Null, None, Some("overnight"))?;
        } else if r["action"] == "plan" {
            // Asked in a turn from before its night, no review held it: its next turn's has one.
            if !f.plans.on && workers::link(data, id).is_none() {
                return halt(data, id);
            }
            control::answer_as(data, id, request, "allow", None, "overnight")?;
        } else {
            control::answer_as(data, id, request, "deny", Some(AWAY), "overnight")?;
        }
    }
    Ok(())
}

/// Whether anything of its team still works or has a result on its way to it.
fn team_works(data: &Path, id: &str, team: &[Value]) -> bool {
    let row = |wid: &str| team.iter().find(|r| r["id"] == wid);
    let working = |r: &Value| {
        // Waiting out its model's limit, or answered above this instant.
        r["worker"]["due"].is_u64()
            || r["worker"]["kind"] == "working"
            || r["state"] == "waiting_answer"
    };
    team.iter().any(working)
        || workers::records(data, id).iter().any(|r| {
            let row = row(&r.wid);
            // A mockup left from before the night waits on the user's eyes.
            let idle = row.is_some_and(|r| r["worker"]["kind"] == "needsYou");
            let paused = row.is_some_and(|r| r["worker"]["kind"] == "paused");
            !idle && !paused && !workers::over(data, id, &r.wid)
        })
}

/// What its night needs now, if anything. Says how long to leave it while its row stays the same.
fn step(data: &Path, id: &str, row: &Value, team: &[Value]) -> io::Result<u64> {
    if waits_on_us(row) {
        return unstick(data, id, row);
    }
    let dir = core::session_dir(data, id);
    let o = load(&dir);
    let f = core::fold(&dir, true)?.fold;
    let state = row["state"].as_str().unwrap_or("");
    let Some(last) = f.last.as_ref().filter(|_| f.turns.is_empty()) else {
        return Ok(2_000);
    };
    if !o.night()
        || o.full
        || row["rebirth"].is_string()
        || row["optimizing"] == true
        || queue::takes(&dir, None)
    {
        return Ok(1_000);
    }
    if team_works(data, id, team) {
        return Ok(5_000);
    }
    let (now, ended) = (log::now_ms(), last["ts"].as_u64().unwrap_or(0));
    let until = |due: u64| due.saturating_sub(now);
    let go = |act: &dyn Fn() -> io::Result<()>, due: u64| match until(due) {
        0 => act().map(|()| 5_000),
        wait => Ok(wait),
    };
    // 1, 2, 4, 8, then 15 minutes apart.
    let backoff = ended + (MINUTE << o.tries.failed.min(4)).min(15 * MINUTE);
    let turn = str_of(last, "id");
    let carry = || carry_on(data, id, &f, &turn, false, false);
    match state {
        "limited" | "out_of_credits" => {
            let due = match f.resets {
                Some(at) => at.max(ended) + MINUTE,
                None => ended + LIMIT_MS,
            };
            go(&carry, due)
        }
        // Its conversation can't be resumed: a fresh one, from the hand-off, on the same account.
        "unresumable" => go(
            &|| {
                let r = switching::switch_session(data, id, None, false)?;
                match r["ok"] == true {
                    true => Ok(()),
                    false => Err(io::Error::other(r["error"].to_string())),
                }
            },
            ended + MINUTE,
        ),
        "failed" if core::adapters::temporary(&str_of(last, "why")) => go(
            &|| {
                failed(&dir)?;
                switching::reconnect::run(data, id, true).map(drop)
            },
            backoff,
        ),
        "failed" if o.tries.failed >= FAILURES => finish(data, id, Some(FAILING)),
        "failed" => go(&|| carry_on(data, id, &f, &turn, true, false), backoff),
        "idle" | "idle_jobs" | "stopped" => {
            let by = last["reason"]
                .as_str()
                .filter(|_| last["outcome"] == "stopped" && ended >= o.since);
            // Stopped or rewound by the user in the night: it's theirs till they go on.
            if by.is_some_and(|by| !matches!(by, "overnight" | "stall")) {
                return Ok(5_000);
            }
            let jobs = state == "idle_jobs" || row["holding"] == true;
            let due = ended + if jobs { JOBS_MS } else { SETTLE_MS };
            match o.report.is_some() || over(&o) {
                true => go(&|| finish(data, id, None).map(drop), ended + SETTLE_MS),
                false => go(&carry, due),
            }
        }
        _ => Ok(5_000),
    }
}

/// Whether a night with nothing left to do, or never a list to do, has been told so enough.
fn over(o: &Overnight) -> bool {
    o.open().is_empty() && o.tries.same + 1 >= GIVE_UP
}

fn finish(data: &Path, id: &str, why: Option<&str>) -> io::Result<u64> {
    change(&core::session_dir(data, id), |o| {
        if o.night() {
            end(o, false, why);
        }
        Ok(())
    })?;
    queue::wake::now();
    settle(data, id).map(|()| MINUTE)
}

fn failed(dir: &Path) -> io::Result<()> {
    change(dir, |o| {
        o.tries.failed += 1;
        Ok(())
    })
}

/// What a night has to show so far: it changes with each proof, part left, decision, commit and
/// worker.
fn mark(data: &Path, id: &str, o: &Overnight) -> String {
    let head = core::load(data, id).ok();
    let head = head.and_then(|s| workers::git(&s.cwd, &["rev-parse", "HEAD"]));
    let left = o.items.len() - o.done() - o.open().len();
    let (made, head) = (workers::below(data, id).len(), head.unwrap_or_default());
    format!(
        "{} {} {left} {} {made} {}",
        o.items.len(),
        o.done(),
        o.decided.len(),
        head.trim()
    )
}

/// Brigadier's own next message, under an id of its own: what's still open, and to try otherwise
/// once nothing moved for a while; a part that had its turns is left first. `fails`: the last
/// turn failed, which says nothing of the work. `cut`: it was cut before it started.
fn carry_on(data: &Path, id: &str, f: &Fold, turn: &str, fails: bool, cut: bool) -> io::Result<()> {
    let dir: PathBuf = core::session_dir(data, id);
    let last = f.last.clone().unwrap_or_default();
    let ran = matches!(last["outcome"].as_str(), Some("done" | "stopped"));
    let o = load(&dir);
    let cid = format!("on{}-{}", o.since, o.tries.sent + 1);
    let now = mark(data, id, &o);
    let first = o.tries.sent == 0;
    let mut t: Tries = o.tries.clone();
    if ran {
        t.same = if t.mark == now || first {
            t.same + u64::from(!first)
        } else {
            0
        };
        (t.open, t.mark, t.failed) = (t.open + 1, now, 0);
    }
    // Its turns used up: the part is left, and the message goes on to the next.
    let mut gone = None;
    if ran && (t.same >= GIVE_UP || t.open > MOST) {
        let spun = t.same >= GIVE_UP;
        (t.same, t.open) = (0, 0);
        gone = change(&dir, |o| {
            let at = (o.items.iter()).position(|i| i.proof.is_none() && i.left.is_none());
            let why = match spun {
                true => "Five turns in a row moved nothing: no proof, decision, commit or worker",
                false => "It used up its turns without a proof",
            };
            Ok(at.map(|at| {
                o.items[at].left = Some(Left {
                    why: why.into(),
                    next: None,
                });
                // The next message's own count starts over.
                (o.tries.same, o.tries.open) = (0, 0);
                format!("{}. {}", at + 1, o.items[at].title)
            }))
        })?;
        if gone.is_some() {
            t.mark = mark(data, id, &load(&dir));
        } else {
            t.same = GIVE_UP;
        }
    }
    // Cut with a conversation before it (a hand-off's launch, or its resend cut again): the fresh
    // one gets the hand-off, from the record. shortcut: a resend's says rebirth for its reason.
    let (sw, from) = (&last["switch"], str_of(&last["switch"], "from_label"));
    let why = sw["why"].as_str().unwrap_or("rebirth");
    let mut text = match cut && !f.convs.is_empty() {
        true => core::handoff::renewal(&core::load(data, id)?, f, why, &last, &from)?,
        false => String::new(),
    };
    let plain = cut && text.is_empty(); // A hand-off says where it was.
    text += &words(&load(&dir), &t, first, plain, gone.as_deref());
    let takes = || queue::takes(&dir, None);
    if !f.cids.contains_key(&cid) && !queue::own(data, id, turn, &cid, &text, true, &takes)? {
        return Ok(());
    }
    change(&dir, |o| {
        if !o.night() {
            return Ok(());
        }
        t.sent = o.tries.sent + 1;
        t.failed += u32::from(fails);
        // Closed while the message was on its way.
        o.tries = t;
        Ok(())
    })
}

fn words(o: &Overnight, t: &Tries, first: bool, cut: bool, gone: Option<&str>) -> String {
    let open = o.open().join("; ");
    let mut say = vec![];
    if first {
        say.push("the user pressed Start night and is away from now on. You have Full access and this job is yours".to_string());
    }
    if cut {
        say.push(CUT.into());
    } else if !first {
        say.push("your turn ended and nothing of yours is running".into());
    }
    if let Some(gone) = gone {
        say.push(format!(
            "this part is recorded as left, its turns used up: {gone}"
        ));
    }
    say.push(match (o.items.is_empty(), open.is_empty()) {
        (true, _) => "there's no done list: run `brigadier overnight ready` with the job's parts, once, then do them".into(),
        (_, true) => "every part is proven or left: run `brigadier overnight report`, then end your turn".into(),
        _ => format!("go on till every part is proven or left. Still open: {open}"),
    });
    if t.same >= STUCK && !open.is_empty() {
        say.push(format!("the last {} turns brought no proof, decision, commit or worker: change your approach, or research how others solved this, before you try again", t.same));
    }
    let said: Vec<String> = (say.iter())
        .map(|s| s[..1].to_uppercase() + &s[1..])
        .collect();
    format!("[Brigadier: {}.]", said.join(". "))
}
