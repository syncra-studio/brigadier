//! `brigadier mockup` [D2055, D2056, D2058, D2067]: the lead's card offering a mockup of a big UI
//! change before it's built, the mockup worker its Yes starts on the user's "Write code" job [D555],
//! and that worker's reports of its variants and of the real screen, kept in its `mockup.json`.

use crate::agent::refuse;
use crate::{owner, workers};
use brigadier_core::{self as core, adapters};
use brigadier_frames::procs;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Sender};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

mod tab;
pub(crate) use tab::run as app;

/// How long the offer waits for the pick; a later one still counts, told to the agent as a message.
const ANSWER_WAIT: Duration = Duration::from_secs(300);
pub(crate) const LETTERS: [&str; 3] = ["A", "B", "C"];
const YES_3: &str = "Yes, 3 variants";
const YES_1: &str = "Yes, just 1";
const SKIP: &str = "Skip, build it";
const REUSE: &str = "Reuse the other build";
/// The lead's card asking for a round's pick: `mockup-pick-<worker>-<round>`.
const PICK: &str = "mockup-pick-";

/// An offer waiting on the user: its session, the change, the mockup it may reuse (session,
/// worker), and the call that waits for the pick.
struct Card {
    session: String,
    what: String,
    reuse: Option<(String, String)>,
    waiter: Option<Sender<String>>,
}

static CARDS: LazyLock<Mutex<HashMap<String, Card>>> = LazyLock::new(Mutex::default);
/// One write of a `mockup.json` at a time: the worker's reports and the tab's notes.
static WRITING: Mutex<()> = Mutex::new(());

fn file(data: &Path, wid: &str) -> PathBuf {
    core::session_dir(data, wid).join("mockup.json")
}

/// Worker `wid`'s mockup, if it draws one.
pub(crate) fn state(data: &Path, wid: &str) -> Option<Value> {
    workers::read_json(&file(data, wid))
}

/// A mockup worker's first `mockup.json`: its title, how many variants, round 1 with none yet.
pub(crate) fn begin(dir: &Path, title: &str, count: u64) -> io::Result<()> {
    let m = json!({"title": title, "count": count, "rounds": [{"variants": [], "sent": []}],
        "picked": null, "real": null});
    workers::write_json(&dir.join("mockup.json"), &m)
}

/// The mockup worker's brief after the change [D2056, D2059]: fixture pages from the repo's own
/// components with fake data in its dev server, one per named variant, each reported live.
fn brief(what: &str, count: usize) -> String {
    let n = match count {
        1 => "one named variant (A)".into(),
        _ => format!("{count} named variants ({})", LETTERS[..count].join(", ")),
    };
    format!(
        "{what}\n\n[mockup] You draw the user's mockup of this change before it is built: {n}. Build each as a fixture page from this repo's own components with fake data, served by the project's dev server (start it if it isn't running), one page per variant; plain HTML pages only when the project has no dev server. Keep the fixture code apart from the app's real screens, and change no real screen yet. As each variant's page works, report it, with its screenshot (a PNG) if you can take one: `brigadier mockup --round 1 --variant A --name \"<a name of two words or so>\" --why \"<one line: what it tries>\" --url <its page> --shot <png>`. The user sees them live side by side in the Mockup tab. Before each step, tell the user in a few words what it is, so the tab doesn't sit silent: `brigadier mockup --doing \"Starting the dev server\"`, `--doing \"Drawing B\"`, `--doing \"Fixing your notes on A\"`. Their notes come as messages, each naming the round to report next; Use tells you which variant to wire in."
    )
}

/// `brigadier mockup …` for session `me`: a mockup worker's report, else the lead's offer.
pub(super) fn run(
    data: &Path,
    me: &str,
    what: Option<&str>,
    value: &dyn Fn(&str) -> Option<String>,
    here: &dyn Fn() -> bool,
) -> Value {
    if state(data, me).is_some() {
        return report(data, me, value).unwrap_or_else(|e| refuse(&e.to_string()));
    }
    // The user named their pick in the lead's chat: it goes as the tab's Use, so the tab follows.
    if let Some(letter) = value("--use") {
        let Some(wid) = newest(data, me) else {
            return refuse("You have no mockup to pick from.");
        };
        let notes = json!({"all": value("--note").unwrap_or_default()});
        let r = tab::pick(data, &wid, letter.trim(), &notes)
            .unwrap_or_else(|e| json!({"ok": false, "message": e.to_string()}));
        let said = r["message"].as_str().unwrap_or("");
        if r["ok"] != true {
            return refuse(said);
        }
        let text = if said.is_empty() {
            format!(
                "{letter} went to mockup worker {wid} to build; the Mockup tab shows it, and its result comes to you once it's built."
            )
        } else {
            said.to_string()
        };
        return json!({"ok": true, "text": text});
    }
    let reports = [
        "--round",
        "--variant",
        "--name",
        "--why",
        "--url",
        "--shot",
        "--real",
        "--doing",
    ];
    if reports.iter().any(|k| value(k).is_some()) {
        return refuse("Only a mockup worker reports variants.");
    }
    let Some(what) = what.map(str::trim).filter(|w| !w.is_empty()) else {
        return refuse("`brigadier mockup` needs the change, in quotes.");
    };
    if workers::link(data, me).is_some() {
        return refuse(
            "Only the user's own chat offers a mockup. Say in your result that this change wants one.",
        );
    }
    let reuse = match value("--reuse") {
        Some(s) => match newest(data, &s) {
            Some(w) => Some((s, w)),
            None => return refuse(&format!("Session {s:?} has no mockup to reuse.")),
        },
        None => None,
    };
    offer(data, me, what, reuse, here)
}

/// The newest mockup session `id`'s workers drew.
fn newest(data: &Path, id: &str) -> Option<String> {
    core::check_id(id).ok()?;
    let mut all = workers::records(data, id);
    all.sort_by_key(|r| r.at);
    (all.into_iter().rev())
        .find(|r| state(data, &r.wid).is_some())
        .map(|r| r.wid)
}

/// The card, Yes, 3 / Yes, 1 / Skip [D2067], with Reuse when another session drew it [D2055],
/// and the wait for its pick; what the pick did comes back.
fn offer(
    data: &Path,
    me: &str,
    what: &str,
    reuse: Option<(String, String)>,
    here: &dyn Fn() -> bool,
) -> Value {
    let id = format!("mockup-{}", &adapters::uuid()[..8]);
    let mut options = vec![
        json!({"label": YES_3, "description": "Three takes, side by side"}),
        json!({"label": YES_1, "description": "Cheaper: one take"}),
        json!({"label": SKIP, "description": "No mockup. The change goes straight in."}),
    ];
    if let Some((_, w)) = &reuse {
        let title = state(data, w).map_or(Value::Null, |m| m["title"].clone());
        options.push(json!({"label": REUSE,
            "description": format!("Opens {}'s mockup, from your other session", title.as_str().unwrap_or("its"))}));
    }
    let item = json!({"text": what, "options": options, "recommended": 0, "multiSelect": false});
    // `held`: its card offers only these answers, no words of the user's and no Skip of its own.
    let request = json!({"id": id, "title": "Want a mockup first?", "items": [item], "held": true});
    let (to, answer) = mpsc::channel();
    let card = Card {
        session: me.into(),
        what: what.into(),
        reuse,
        waiter: Some(to),
    };
    CARDS.lock().unwrap().insert(id.clone(), card);
    let note = json!({"event": "mockup", "phase": "asked", "id": id, "request": request});
    if let Err(e) = owner::call(data, me, json!({"op": "note", "data": note})) {
        CARDS.lock().unwrap().remove(&id);
        return refuse(&format!("The user couldn't be asked: {e}"));
    }
    let until = Instant::now() + ANSWER_WAIT;
    while here() && Instant::now() < until {
        if let Ok(text) = answer.recv_timeout(Duration::from_millis(500)) {
            return json!({"ok": true, "text": text});
        }
    }
    if let Some(card) = CARDS.lock().unwrap().get_mut(&id) {
        card.waiter = None;
    }
    json!({"ok": true, "text": "No pick yet: the card stays up and the pick comes as a message. End your turn; don't build the change or ask about it until then."})
}

/// The user's pick on offer `request` of session `id`: Yes starts the mockup worker, Skip says
/// build it, Reuse opens the other session's mockup. The call that asked hears it, else a message.
pub(crate) fn answered(data: &Path, id: &str, request: &str, choice: &str) -> io::Result<Value> {
    if let Some(on) = request.strip_prefix(PICK) {
        return tab::from_card(data, id, on, choice);
    }
    let mut cards = CARDS.lock().unwrap();
    let Some(card) = cards.get(request).filter(|c| c.session == id) else {
        drop(cards);
        settle(data, id, request, choice)?;
        return Ok(json!({"ok": false, "error": "gone",
            "message": "Brigadier restarted since this was asked. Ask the agent again."}));
    };
    let reuse = card.reuse.clone().filter(|_| choice == REUSE);
    if ![YES_3, YES_1, SKIP].contains(&choice) && reuse.is_none() {
        return Ok(
            json!({"ok": false, "error": "invalid", "message": "Pick one of the card's answers."}),
        );
    }
    let card = cards.remove(request).expect("checked above");
    drop(cards);
    settle(data, id, request, choice)?;
    let text = match (choice, reuse) {
        (SKIP, _) => "The user skipped the mockup: build the change now.".into(),
        (_, Some((s, w))) => {
            let title = state(data, &w).map_or(Value::Null, |m| m["title"].clone());
            let count = state(data, &w)
                .and_then(|m| m["count"].as_u64())
                .unwrap_or(3);
            open(data, id, &w, count as usize);
            format!(
                "The user reuses the mockup session {s} already drew of this ({}): it opened in the Mockup tab. Its variants' code is on that mockup worker's branch ({w}); the variant the user picks there with Use is wired into {s}'s branch by that worker. Don't build the change yourself.",
                title.as_str().unwrap_or("its mockup")
            )
        }
        _ => start(data, id, &card.what, if choice == YES_1 { 1 } else { 3 }),
    };
    if let Some(waiter) = &card.waiter
        && waiter.send(text.clone()).is_ok()
    {
        return Ok(json!({"ok": true}));
    }
    // A turn that ended takes it as its next message.
    let text = format!("[decision] {text}");
    let _ = crate::control::steer_as(data, id, &text, &Value::Null, None, "system", false);
    Ok(json!({"ok": true}))
}

/// The card shows its answer and stops waiting on the user.
fn settle(data: &Path, id: &str, request: &str, choice: &str) -> io::Result<()> {
    let note = json!({"event": "mockup", "phase": "answered", "id": request, "choice": choice});
    owner::call(data, id, json!({"op": "note", "data": note})).map(|_| ())
}

/// The mockup worker, on the user's "Write code" job [D555] at the parent's level [D313], counted
/// as any worker [D196]; its tab opens behind [D2066].
fn start(data: &Path, me: &str, what: &str, count: usize) -> String {
    let title = core::title::from(what);
    let flags = |k: &str| match k {
        "--job" => Some("Write code".to_string()),
        "--title" => Some(title.clone()),
        "--mockup" => Some(count.to_string()),
        _ => None,
    };
    let all = procs::all();
    let running = |id: &str| crate::sessions::working(data, id, &all);
    let r = workers::start(data, me, &brief(what, count), &flags, &running, false);
    let Some(wid) = r["id"].as_str().filter(|_| r["ok"] == true) else {
        let why = r["error"].as_str().or(r["message"].as_str()).unwrap_or("");
        return format!(
            "The user wants a mockup first, but its worker couldn't start: {why} Tell the user."
        );
    };
    open(data, me, wid, count);
    let n = if count == 1 {
        "1 variant"
    } else {
        "3 variants"
    };
    format!(
        "The user wants a mockup first: mockup worker {title} ({wid}) draws {n} of it from the repo's components, which the user compares in the Mockup tab. Don't build the change yourself: the user's pick (Use) has that worker wire it in, and its result comes to you then. End your turn."
    )
}

/// The Mockup tab on worker `wid`'s mockup, behind the one in front [D2066], one per session, and
/// its row in the chat, "Mockup · drawing 3 variants · Open" [D2055, D560].
fn open(data: &Path, me: &str, wid: &str, count: usize) {
    let tab = format!("t-{}", crate::control::new_cid());
    let args = ["tabs", me, "open", &tab, "mockup", wid, "--behind"];
    let _ = crate::tabs::run(data, &args.map(String::from));
    let note = json!({"event": "mockup", "phase": "started", "id": wid, "count": count});
    let _ = owner::call(data, me, json!({"op": "note", "data": note}));
}

/// A mockup worker's report: a variant of the round it draws, by letter, or the real screen once
/// the pick is wired in. A round that's over keeps its variants as they were.
fn report(data: &Path, me: &str, value: &dyn Fn(&str) -> Option<String>) -> io::Result<Value> {
    let no = |m: String| Ok(refuse(&m));
    let _one = WRITING.lock().unwrap();
    let mut m = state(data, me).unwrap_or_default();
    let rounds = m["rounds"].as_array().map_or(0, Vec::len);
    // What it does now, shown while it works: alone, or with the report it goes with.
    if let Some(line) = value("--doing").filter(|d| !d.trim().is_empty()) {
        m["doing"] = json!({"text": line.trim(), "round": rounds});
        if value("--variant").is_none() && value("--real").is_none() {
            workers::write_json(&file(data, me), &m)?;
            return Ok(json!({"ok": true, "text": "The user sees it in the Mockup tab."}));
        }
    }
    if let Some(url) = value("--real") {
        if !web(&url) {
            return no(format!(
                "--real takes the real screen's http(s) address, not {url:?}."
            ));
        }
        m["real"] = url.into();
        news(data, me, &mut m);
        workers::write_json(&file(data, me), &m)?;
        return Ok(
            json!({"ok": true, "text": "The real screen shows beside the mockup in the user's Mockup tab."}),
        );
    }
    if value("--round") != Some(rounds.to_string()) {
        return no(format!(
            "Report with --round {rounds}, the round you draw now; an older round stays as it was."
        ));
    }
    let count = m["count"].as_u64().unwrap_or(3) as usize;
    let letters = &LETTERS[..count.min(3)];
    let letter = value("--variant").unwrap_or_default();
    if !letters.contains(&letter.as_str()) {
        return no(format!("--variant takes {}.", letters.join(", ")));
    }
    let Some(name) = value("--name").filter(|n| !n.trim().is_empty()) else {
        return no("--name gives the variant a short name the user picks it by.".into());
    };
    let url = value("--url");
    if let Some(u) = url.as_ref().filter(|u| !web(u)) {
        return no(format!(
            "--url takes the page's http(s) address in your dev server, not {u:?}."
        ));
    }
    let shot = match value("--shot") {
        Some(p) => Some(keep_shot(data, me, &p, rounds, &letter)?),
        None => None,
    };
    if url.is_none() && shot.is_none() {
        return no("Give its page with --url, or at least its screenshot with --shot.".into());
    }
    let v = json!({"letter": letter, "name": name.trim(), "why": value("--why"), "url": url, "shot": shot});
    let list = &mut m["rounds"][rounds - 1]["variants"];
    let mut all: Vec<Value> = list.as_array().cloned().unwrap_or_default();
    all.retain(|x| x["letter"] != letter.as_str());
    all.push(v);
    all.sort_by_key(|x| x["letter"].as_str().unwrap_or("").to_string());
    let full = all.len() == letters.len();
    *list = all.into();
    if full {
        news(data, me, &mut m);
    }
    workers::write_json(&file(data, me), &m)?;
    if full {
        ready(data, me, &m, rounds);
    }
    Ok(json!({"ok": true, "text": format!("Variant {letter} shows in the user's Mockup tab.")}))
}

/// The mockup has news for the user, a round drawn or its pick built: the Mockup tab's dot and
/// the lead's row's, each till the user sees it [D560].
fn news(data: &Path, me: &str, m: &mut Value) {
    let now = brigadier_frames::log::now_ms();
    m["news"] = now.into();
    if let Some(l) = workers::link(data, me) {
        let dir = core::session_dir(data, &l.parent);
        let _ = core::write_atomic(&dir.join("news"), now.to_string().as_bytes());
    }
}

/// Round `round` has every variant in: a card in the lead's chat asks the user to pick one, as the
/// tab's Use does, and the lead hears it quietly with its next input; once a round [D560].
fn ready(data: &Path, me: &str, m: &Value, round: usize) {
    let Some(l) = workers::link(data, me) else {
        return;
    };
    let count = m["count"].as_u64().unwrap_or(3);
    let n = match count {
        1 => "its variant".to_string(),
        _ => format!("all {count} variants"),
    };
    let text = format!(
        "Your mockup worker {} ({me}) drew {n} of round {round}: the user picks one with Use, on the card in your chat or in the Mockup tab, or sends notes for another round. Nothing for you to do; the pick goes to that worker, and its result comes to you once it's built.",
        l.title
    );
    let key = format!("mockup-ready-{round}");
    if !workers::told_notice(data, &l.parent, me, &key, &text).unwrap_or(false) {
        return;
    }
    let variants = m["rounds"][round - 1]["variants"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let options: Vec<Value> = (variants.iter())
        .map(|v| {
            let (letter, name) = (v["letter"].as_str().unwrap_or(""), v["name"].as_str().unwrap_or(""));
            json!({"label": format!("Use {letter}"), "description": format!("{letter} · {name}: built for real, the others' code deleted")})
        })
        .collect();
    let ask = if count == 1 {
        "Build it for real"
    } else {
        "Pick one to build for real"
    };
    let what = format!(
        "{ask}, or open the Mockup tab to pin notes on it and send them for round {}.",
        round + 1
    );
    let item = json!({"text": what, "options": options, "multiSelect": false});
    let request = json!({"id": format!("{PICK}{me}-{round}"), "title": format!("{} · round {round} is ready", m["title"].as_str().unwrap_or("Mockup")), "items": [item], "held": true});
    let note =
        json!({"event": "mockup", "phase": "asked", "id": request["id"], "request": request});
    let _ = owner::call(data, &l.parent, json!({"op": "note", "data": note}));
}

fn web(url: &str) -> bool {
    let u = url.trim().to_ascii_lowercase();
    u.starts_with("http://") || u.starts_with("https://")
}

/// A variant's screenshot, kept as one of the worker's attachments so its round keeps it and the
/// tab loads it as any attachment [D2059]; its address back.
fn keep_shot(data: &Path, me: &str, from: &str, round: usize, letter: &str) -> io::Result<String> {
    let spec = core::load(data, me)?;
    let from = Path::new(&spec.cwd).join(from);
    let png = fs::read(&from)
        .ok()
        .filter(|b| b.starts_with(b"\x89PNG"))
        .ok_or_else(|| {
            io::Error::other(format!(
                "--shot takes a PNG file; {} isn't one.",
                from.display()
            ))
        })?;
    let id = format!("mockup-{round}-{letter}");
    let to = spec.dir.join("attachments").join(&id);
    fs::create_dir_all(&to)?;
    core::write_atomic(&to.join(format!("{letter}.png")), &png)?;
    Ok(format!("/attachment/{me}/{id}"))
}
