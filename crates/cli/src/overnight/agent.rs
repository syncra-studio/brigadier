//! What a session's agent says of its Overnight, with `brigadier overnight …`: its words and done
//! list before the night, and in it what it decided, what is proven and what isn't. Rust keeps the
//! list: nothing here starts a night, ends one, or changes the list once it runs.

use crate::agent::refuse;
use crate::workers;
use brigadier_core::overnight::{Decision, Item, Left, Overnight, Proof, Report, change, load};
use brigadier_core::{self as core};
use serde_json::{Value, json};
use std::io;
use std::path::Path;

pub(crate) const HELP: &str = include_str!("help.txt");

const FLAGS: [&str; 10] = [
    "--item", "--may", "--why", "--other", "--by", "--proof", "--next", "--fact", "--url", "--json",
];

pub(crate) fn run(data: &Path, me: &str, args: &[String]) -> Value {
    if args.len() < 2 || args.iter().any(|a| a == "--help") {
        return json!({"ok": true, "text": HELP});
    }
    let (act, mut said, mut flags) = (args[1].as_str(), None, vec![]);
    let mut rest = args[2..].iter().map(String::as_str);
    while let Some(a) = rest.next() {
        match a {
            "--json" => {}
            a if FLAGS.contains(&a) => match rest.next().map(str::trim) {
                Some(v) if !v.is_empty() => flags.push((a, v)),
                _ => return refuse(&format!("{a} needs a value.")),
            },
            a if said.is_none() && !a.starts_with("--") => said = Some(a.trim()),
            a => {
                return refuse(&format!(
                    "`{a}` isn't an option. `brigadier help overnight` shows them."
                ));
            }
        }
    }
    let call = Call {
        said: said.unwrap_or(""),
        flags,
    };
    let dir = core::session_dir(data, me);
    if workers::link(data, me).is_some() {
        return refuse("Overnight is your lead's: report to it as you do.");
    }
    if matches!(act, "on" | "off" | "start") {
        return refuse("Only the user turns Overnight on or off and starts the night.");
    }
    if !load(&dir).on() {
        return refuse("Overnight is off: only the user turns it on.");
    }
    let done = match act {
        "ready" => ready(&dir, &call),
        "decided" => decided(&dir, &call),
        "proven" => proven(data, me, &dir, &call),
        "left" => left(&dir, &call),
        "report" => report(&dir, &call),
        _ => Err(no(
            "Not an Overnight command. `brigadier help overnight` lists them.",
        )),
    };
    crate::queue::wake::now();
    match done {
        Ok(text) => json!({"ok": true, "text": text, "overnight": load(&dir).row()}),
        Err(e) => refuse(&e.to_string()),
    }
}

struct Call<'a> {
    said: &'a str,
    flags: Vec<(&'a str, &'a str)>,
}

impl Call<'_> {
    fn all(&self, name: &str) -> Vec<String> {
        (self.flags.iter())
            .filter(|(k, _)| *k == name)
            .map(|(_, v)| v.to_string())
            .collect()
    }
    fn one(&self, name: &str) -> Option<String> {
        self.all(name).pop()
    }
    fn need(&self, name: &str) -> io::Result<String> {
        self.one(name)
            .ok_or_else(|| no(&format!("{name} is needed.")))
    }
    fn words(&self, what: &str) -> io::Result<String> {
        match self.said {
            "" => Err(no(&format!("Say {what}, in quotes."))),
            said => Ok(said.into()),
        }
    }
}

fn no(why: &str) -> io::Error {
    io::Error::other(why)
}

fn in_night(o: &Overnight) -> io::Result<()> {
    match o.night() {
        true => Ok(()),
        false => Err(no("The night hasn't started: the user starts it.")),
    }
}

/// The done list, whole. A night the user started before one was in takes it once.
fn ready(dir: &Path, call: &Call) -> io::Result<String> {
    let (words, items) = (call.words("what you do alone")?, call.all("--item"));
    if items.is_empty() {
        return Err(no(
            "Give every part of the done list its own --item \"done when …\".",
        ));
    }
    change(dir, |o| {
        if o.night() && !o.items.is_empty() {
            return Err(no(
                "The done list was fixed when the night started. Prove a part, or leave it with why.",
            ));
        }
        (o.words, o.may, o.told) = (words, call.all("--may"), true);
        o.items = (items.into_iter())
            .map(|title| Item {
                title,
                ..Item::default()
            })
            .collect();
        if o.night() {
            return Ok("Kept. The night runs: go on.".into());
        }
        o.state = "ready".into();
        Ok("Kept, and shown to the user with Start night. End your turn: only they start it. If they change the job, run it again with the whole list.".into())
    })
}

fn decided(dir: &Path, call: &Call) -> io::Result<String> {
    let d = Decision {
        title: call.words("what you decided")?,
        why: call.need("--why")?,
        other: call.need("--other")?,
    };
    change(dir, |o| {
        in_night(o)?;
        o.decided.push(d);
        Ok("Logged for the morning.".into())
    })
}

/// The part `call` names by its number, not yet closed by a proof.
fn part<'a>(o: &'a mut Overnight, call: &Call) -> io::Result<&'a mut Item> {
    in_night(o)?;
    let all = o.items.len();
    let at = (call.said.parse::<usize>().ok()).filter(|n| (1..=all).contains(n));
    let Some(at) = at else {
        return Err(no(&format!("Name the part by its number, 1 to {all}.")));
    };
    match &o.items[at - 1].proof {
        Some(_) => Err(no("That part is proven already.")),
        None => Ok(&mut o.items[at - 1]),
    }
}

fn proven(data: &Path, me: &str, dir: &Path, call: &Call) -> io::Result<String> {
    let (by, text) = (call.need("--by")?, call.need("--proof")?);
    let who = reviewer(data, me, &by)?;
    change(dir, |o| {
        let item = part(o, call)?;
        (item.proof, item.left) = (Some(Proof { by: who, text }), None);
        o.tries.open = 0;
        Ok(rest(o))
    })
}

/// Who proves a part: a reviewer of this session's, on another agent than the author's as Rust
/// picked it, finished, and begun at the commits the work is at now.
fn reviewer(data: &Path, me: &str, by: &str) -> io::Result<String> {
    let l = workers::link(data, by).filter(|l| !l.review.is_null() && l.review["plan"].is_null());
    let Some(l) = l.filter(|_| workers::below(data, me).iter().any(|r| r.wid == by)) else {
        return Err(no(
            "--by takes a reviewer of yours: `brigadier start --reviewing session \"<what to prove, by running it>\"`.",
        ));
    };
    if workers::over(data, me, by) && l.last["how"] != "finished" {
        return Err(no("That reviewer ended without finishing: start another."));
    }
    if l.last["how"] != "finished" || workers::owes(data, by) {
        return Err(no(
            "That reviewer hasn't finished. Its result comes to you by itself.",
        ));
    }
    if l.review["heads"] != workers::at(data, me) {
        return Err(no(
            "That reviewer saw another commit than your branch is at now: have what it is now reviewed.",
        ));
    }
    let ran = |k: &str| l.ran[k].as_str().unwrap_or("").to_string();
    let name = [ran("name"), ran("model"), ran("agent")]
        .into_iter()
        .find(|n| !n.is_empty());
    Ok(format!("Reviewed by {}", name.unwrap_or_else(|| by.into())))
}

fn left(dir: &Path, call: &Call) -> io::Result<String> {
    let left = Left {
        why: call.need("--why")?,
        next: call.one("--next"),
    };
    change(dir, |o| {
        let item = part(o, call)?;
        // Left already, only its words change: nothing moved.
        if item.left.replace(left).is_none() {
            o.tries.open = 0;
        }
        Ok(rest(o))
    })
}

fn rest(o: &Overnight) -> String {
    match o.open() {
        open if open.is_empty() => {
            "Kept. Every part is proven or left: run `brigadier overnight report`.".into()
        }
        open => format!("Kept. Still open: {}", open.join("; ")),
    }
}

fn report(dir: &Path, call: &Call) -> io::Result<String> {
    let report = Report {
        summary: call.words("how it went")?,
        facts: call.all("--fact"),
        url: call.one("--url"),
    };
    change(dir, |o| {
        in_night(o)?;
        if o.items.is_empty() {
            return Err(no(
                "There's no done list: run `brigadier overnight ready` first.",
            ));
        }
        let open = o.open();
        if !open.is_empty() {
            return Err(no(&format!(
                "Not done: {}. Prove each, or leave it with why.",
                open.join("; ")
            )));
        }
        o.report = Some(report);
        Ok("Kept. The night ends as your turn does: end it now, with nothing left running.".into())
    })
}
