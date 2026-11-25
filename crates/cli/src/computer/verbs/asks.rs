//! Ask's yes for an app [D31]: at Ask, the first use of an app in a chat waits on one card in the
//! thread of the session that asks, and a yes holds for that app in that chat, its workers included.
//! Auto and Full never ask [D903]. An app is the bundle its process runs from, as the kernel says,
//! so a name, an id or a pid used again never stands for another one. Kept in memory only.

use super::{Sess, Words, apps::past_app, lock, refuse, take};
use crate::owner;
use brigadier_core::{self as core, adapters};
use brigadier_frames::procs;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::thread;
use std::time::{Duration, Instant};

/// How long a call waits for the answer, as the browser's; one that comes later is a message.
const ANSWER_WAIT: Duration = Duration::from_secs(300);
const TICK: Duration = Duration::from_millis(500);

/// A card in `session`'s thread: the app it is for, and the turns that wait on it.
struct Card {
    data: PathBuf,
    chat: String,
    app: PathBuf,
    session: String,
    turn: String,
    waiters: Vec<(String, String)>,
    /// Its answer is being recorded.
    answering: bool,
}

#[derive(Default)]
struct Asks {
    cards: HashMap<String, Card>,
    /// The apps each chat may use; the chat's birth, so an id made again inherits nothing.
    yes: HashMap<(String, PathBuf), u64>,
    /// What a session was told no to, for that turn.
    no: HashMap<(String, PathBuf), (String, String)>,
    /// The calls waiting now, by session and app.
    calls: Vec<(String, PathBuf)>,
}

static ASKS: LazyLock<Mutex<Asks>> = LazyLock::new(Mutex::default);

/// The app a process runs as: the innermost bundle its file is in, else the file.
pub(super) fn app_of(pid: i64) -> Result<PathBuf, Value> {
    let exe = i32::try_from(pid)
        .ok()
        .filter(|p| *p > 0)
        .and_then(procs::exe);
    let exe = exe.ok_or_else(|| refuse("That app isn't running any more: read it again."))?;
    let exe = exe.canonicalize().unwrap_or(exe);
    let app = exe.ancestors().find(|p| is_app(p)).map(Path::to_path_buf);
    Ok(app.unwrap_or(exe))
}

fn is_app(p: &Path) -> bool {
    p.extension().is_some_and(|e| e.eq_ignore_ascii_case("app"))
}

/// An app as its card names it: its file's own name, nothing in it that changes how it reads.
fn shown(text: &str) -> String {
    let plain = |c: &char| {
        !c.is_control()
            && !matches!(c, '\u{200b}'..='\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2060}'..='\u{206f}' | '\u{feff}' | '`')
    };
    text.chars().filter(plain).collect()
}

fn name(app: &Path) -> String {
    shown(&app.file_stem().unwrap_or_default().to_string_lossy())
}

/// Whether session `me` is at Ask now, and its running turn. Its saved level, held to Ask in a
/// folder that isn't trusted, and Auto asking for a turn its own check gave no verdict in [D455].
/// What can't be read is Ask.
fn level(data: &Path, me: &str) -> (bool, Option<String>) {
    let Ok(spec) = core::load(data, me) else {
        return (true, None);
    };
    let Ok(f) = core::fold(&spec.dir, true) else {
        return (true, None);
    };
    let turn = f.fold.turns.first();
    let backend = turn.map_or(f.fold.backend.as_str(), |t| t.backend.as_str());
    let backend = if backend.is_empty() {
        &spec.backend
    } else {
        backend
    };
    let held = core::projects::held(data, &spec);
    let level = adapters::get(backend).map(|a| core::level(&spec, a, held));
    let asks = match level {
        Some(Ok(Some("full"))) => false,
        Some(Ok(Some("auto"))) => turn.is_some_and(|t| t.unchecked),
        _ => true,
    };
    (asks, turn.map(|t| t.id.clone()))
}

fn born(data: &Path, chat: &str) -> Option<u64> {
    core::load(data, chat).ok().map(|s| s.created)
}

fn allowed(data: &Path, chat: &str, app: &Path) -> bool {
    let yes = (lock(&ASKS).yes.get(&(chat.into(), app.into()))).copied();
    yes.is_some() && yes == born(data, chat)
}

/// Whether `me` may not use the app with `pid` now.
pub(super) fn shut(data: &Path, me: &str, pid: i64) -> bool {
    let chat = crate::workers::place(data, me).0;
    level(data, me).0 && !app_of(pid).is_ok_and(|app| allowed(data, &chat, &app))
}

/// The verbs on the app a session is in, before anything of it is read or done. `open` and a
/// `read` that names its app ask once they've found it; `apps` gives names only.
pub(super) fn check(
    data: &Path,
    me: &str,
    w: &Words,
    s: &Sess,
    rows: &dyn Fn() -> Vec<Value>,
    here: &dyn Fn() -> bool,
) -> Result<(), Value> {
    let names = w.verb == "read" && !w.rest.is_empty();
    if ["apps", "open"].contains(&w.verb) || names || s.pid == 0 {
        return Ok(());
    }
    if !gate(data, me, s.pid, rows, here)? {
        return Ok(());
    }
    match past_app(w, s) {
        true => Err(refuse(&format!(
            "The Apple menu and Services reach past {}: ask the user.",
            s.app
        ))),
        false => Ok(()),
    }
}

/// Before `open` starts an app or hands it something: the app's path to start, at Ask.
pub(super) fn opening(
    data: &Path,
    me: &str,
    listed: Option<&Value>,
    target: Option<&str>,
    rows: &dyn Fn() -> Vec<Value>,
    here: &dyn Fn() -> bool,
) -> Result<Option<PathBuf>, Value> {
    if !level(data, me).0 {
        return Ok(None);
    }
    let pid = listed.and_then(|a| a["pid"].as_i64()).filter(|p| *p > 0);
    let path = listed.and_then(|a| a["launch_path"].as_str());
    let app = match (pid, path) {
        (Some(pid), _) => app_of(pid)?,
        (None, Some(p)) => Path::new(p).canonicalize().unwrap_or(p.into()),
        _ => {
            return Err(refuse(
                "That app isn't in macOS's list of apps, so the user can't be asked about it: ask them to open it.",
            ));
        }
    };
    if let Some(t) = target {
        let file = Path::new(t);
        if t.to_lowercase().starts_with("file:") {
            return Err(refuse("Give a file by its path."));
        }
        if is_app(file) || file.canonicalize().is_ok_and(|f| is_app(&f)) {
            return Err(refuse(
                "An app is opened by its own name: brigadier computer open <app>.",
            ));
        }
    }
    asked(data, me, &app, rows, here)?;
    Ok(Some(app))
}

/// Ask's yes for the app with `pid`; whether `me` is at Ask.
pub(super) fn gate(
    data: &Path,
    me: &str,
    pid: i64,
    rows: &dyn Fn() -> Vec<Value>,
    here: &dyn Fn() -> bool,
) -> Result<bool, Value> {
    match level(data, me).0 {
        true => asked(data, me, &app_of(pid)?, rows, here),
        false => Ok(false),
    }
}

/// Waits for the user's yes to `app`, where it still needs one; false once `me` is past Ask.
fn asked(
    data: &Path,
    me: &str,
    app: &Path,
    rows: &dyn Fn() -> Vec<Value>,
    here: &dyn Fn() -> bool,
) -> Result<bool, Value> {
    let chat = crate::workers::place(data, me).0;
    if allowed(data, &chat, app) {
        return Ok(true);
    }
    let (_, turn) = level(data, me);
    let Some(turn) = turn else {
        return Err(refuse(
            "At Ask the user is asked first, which needs a running turn.",
        ));
    };
    // No card for a computer another session has, nor one for this agent's word alone [D907].
    take(me, rows)?;
    let call = Call::new(me, app);
    let start = Instant::now();
    let past = loop {
        if allowed(data, &chat, app) {
            break false;
        }
        let no = lock(&ASKS).no.get(&(me.into(), app.into())).cloned();
        if let Some((_, why)) = no.filter(|(t, _)| *t == turn) {
            return Err(refuse(&why));
        }
        if !super::super::on(data) {
            left(me, &|_| true, Some(app));
            return Err(refuse(super::OFF));
        }
        let (asks, now) = level(data, me);
        if !asks {
            left(me, &|_| true, Some(app));
            break true;
        }
        if now.as_ref() != Some(&turn) {
            left(me, &|t| t == turn, Some(app));
            return Err(refuse("Stopped."));
        }
        if !here() || start.elapsed() >= ANSWER_WAIT {
            return Err(refuse(&format!(
                "No answer yet: may you use {}? Nothing was done. Their answer comes as a message; on a yes, make this same call again.",
                name(app)
            )));
        }
        join(data, me, &turn, &chat, app)?;
        thread::sleep(TICK);
    };
    drop(call);
    // The caller may have gone, or another session taken the computer, while the card was up.
    if !here() {
        return Err(refuse("Stopped."));
    }
    take(me, rows)?;
    Ok(!past)
}

/// A call that waits: its session needs no message when the answer comes.
struct Call(String, PathBuf);

impl Call {
    fn new(me: &str, app: &Path) -> Call {
        lock(&ASKS).calls.push((me.into(), app.into()));
        Call(me.into(), app.into())
    }
}

impl Drop for Call {
    fn drop(&mut self) {
        let mut a = lock(&ASKS);
        if let Some(at) = a
            .calls
            .iter()
            .position(|c| (&c.0, &c.1) == (&self.0, &self.1))
        {
            a.calls.remove(at);
        }
    }
}

/// `me`'s turn waits on the chat's one card for `app`, raised in its thread if none is up.
fn join(data: &Path, me: &str, turn: &str, chat: &str, app: &Path) -> Result<(), Value> {
    // A card of an earlier turn of its own went with that turn.
    left(me, &|t| t != turn, Some(app));
    let waiter = (me.to_string(), turn.to_string());
    let born = born(data, chat);
    let id = {
        let mut a = lock(&ASKS);
        // Answered since this call last looked.
        let yes = a.yes.get(&(chat.into(), app.into())).copied();
        let no = a.no.get(&(me.into(), app.into()));
        if (yes.is_some() && yes == born) || no.is_some_and(|n| n.0 == turn) {
            return Ok(());
        }
        let mut cards = a.cards.values_mut();
        if let Some(card) = cards.find(|c| c.chat == chat && c.app == app) {
            if !card.waiters.contains(&waiter) {
                card.waiters.push(waiter);
            }
            return Ok(());
        }
        let id = new_id();
        let card = Card {
            data: data.into(),
            chat: chat.into(),
            app: app.into(),
            session: me.into(),
            turn: turn.into(),
            waiters: vec![waiter],
            answering: false,
        };
        a.cards.insert(id.clone(), card);
        id
    };
    show(&id).map_err(|e| refuse(&format!("The user couldn't be asked: {e}")))
}

fn new_id() -> String {
    format!("computer-{}", &adapters::uuid()[..8])
}

fn note(data: &Path, session: &str, item: Value) -> io::Result<()> {
    let data_of = json!({"event": "computer", "item": item});
    owner::call(data, session, json!({"op": "note", "data": data_of})).map(drop)
}

/// The card, in its session's thread; gone again if it can't be.
fn show(id: &str) -> io::Result<()> {
    let (data, session, app) = match lock(&ASKS).cards.get(id) {
        Some(c) => (c.data.clone(), c.session.clone(), c.app.clone()),
        None => return Ok(()),
    };
    // One a daemon before this one left up: nothing waits on it.
    let f = core::fold(&core::session_dir(&data, &session), true)?.fold;
    for (old, r) in f.turns.first().map(|t| &t.asks).into_iter().flatten() {
        let ours = r["action"] == "computer" && !lock(&ASKS).cards.contains_key(old);
        if ours {
            let _ = note(&data, &session, json!({"kind": "resolved", "id": old}));
        }
    }
    let path = shown(&app.to_string_lossy());
    let request = json!({"id": id, "action": "computer", "reason": format!("Use {} on your Mac?", name(&app)),
        "body": format!("Reads, clicks and types in it for the rest of this chat.\n{path}"), "input": path});
    let shown = note(
        &data,
        &session,
        json!({"kind": "approval", "id": id, "request": request}),
    );
    if shown.is_err() {
        lock(&ASKS).cards.remove(id);
    }
    shown
}

/// `session`'s turns that `gone` says left wait no more, on `app`'s card or any: a card in its
/// thread goes with them, to the next turn that waits on it, else for good.
fn left(session: &str, gone: &dyn Fn(&str) -> bool, app: Option<&Path>) {
    let (mut settle, mut raise) = (vec![], vec![]);
    {
        let mut a = lock(&ASKS);
        let ids: Vec<String> = a.cards.keys().cloned().collect();
        for id in ids {
            let Some(c) = a.cards.get_mut(&id) else {
                continue;
            };
            if app.is_some_and(|app| c.app != app) {
                continue;
            }
            c.waiters.retain(|w| w.0 != session || !gone(&w.1));
            if c.session != session || !gone(&c.turn) {
                continue;
            }
            let Some(mut c) = a.cards.remove(&id) else {
                continue;
            };
            settle.push((c.data.clone(), id));
            if let Some((s, t)) = c.waiters.first().cloned() {
                (c.session, c.turn, c.answering) = (s, t, false);
                let id = new_id();
                a.cards.insert(id.clone(), c);
                raise.push(id);
            }
        }
    }
    for (data, id) in settle {
        let _ = note(&data, session, json!({"kind": "resolved", "id": id}));
    }
    for id in raise {
        let _ = show(&id);
    }
}

/// A turn of `session`'s ended: what it waited on goes, its no with it.
pub(super) fn ended(session: &str) {
    let data = {
        let a = lock(&ASKS);
        let waits = (a.cards.values())
            .find(|c| c.session == session || c.waiters.iter().any(|w| w.0 == session));
        waits.map(|c| c.data.clone())
    };
    let Some(data) = data else {
        return;
    };
    let session = session.to_string();
    // Its host is asked, so not on the daemon's own pass.
    thread::spawn(move || {
        let turn = level(&data, &session).1;
        left(&session, &|t| Some(t) != turn.as_deref(), None);
    });
}

/// Computer use was turned off: every yes goes, and every card.
pub(in crate::computer) fn forget() {
    let cards = {
        let mut a = lock(&ASKS);
        a.yes.clear();
        std::mem::take(&mut a.cards)
    };
    for (id, c) in cards {
        let settled = json!({"kind": "resolved", "id": id});
        thread::spawn(move || note(&c.data, &c.session, settled));
    }
}

/// The answer on card `request` of session `id`: a yes holds in its chat, a no for the turns that
/// waited, and a turn with no call waiting any more hears it as a message.
pub(crate) fn answered(data: &Path, id: &str, request: &str, control: &Value) -> io::Result<Value> {
    let allow = match control["decision"].as_str() {
        Some("allow") => true,
        Some("deny") => false,
        _ => return Ok(crate::control::refused("invalid", "decision".into())),
    };
    let pending = core::fold(&core::session_dir(data, id), true)?.fold;
    let pending = (pending.turns.first())
        .is_some_and(|t| t.asks.get(request).is_some_and(|r| r["to"].is_null()));
    let first = (lock(&ASKS).cards.get_mut(request))
        .filter(|c| pending && c.session == id)
        .map(|c| !std::mem::replace(&mut c.answering, true));
    let gone = || crate::control::refused("not_pending", Value::Null);
    let decision = match (first, allow) {
        (Some(true), true) => json!("approved"),
        (Some(true), false) => json!("denied"),
        (Some(false), _) => return Ok(gone()),
        // Left up by a daemon before this one, its call gone: nothing is allowed.
        (None, _) => Value::Null,
    };
    let settled = json!({"kind": "resolved", "id": request, "decision": decision});
    if let Err(e) = note(data, id, settled) {
        if let Some(c) = lock(&ASKS).cards.get_mut(request) {
            c.answering = false;
        }
        return Err(e);
    }
    let (app, why, heard) = {
        let mut a = lock(&ASKS);
        // Gone meanwhile, its turn over or computer use off: nothing is allowed.
        let Some(card) = first.and_then(|_| a.cards.remove(request)) else {
            return Ok(gone());
        };
        let app = name(&card.app);
        let why = format!(
            "{}. Nothing was done in {app}; don't reach it another way.",
            adapters::denied(control).trim_end_matches('.')
        );
        if allow && let Some(born) = born(data, &card.chat) {
            a.yes.insert((card.chat.clone(), card.app.clone()), born);
        }
        for (session, turn) in card.waiters.iter().filter(|_| !allow) {
            a.no.retain(|k, v| k.0 != *session || v.0 == *turn);
            let said = (turn.clone(), why.clone());
            a.no.insert((session.clone(), card.app.clone()), said);
        }
        let waits =
            |w: &&(String, String)| !(a.calls.iter()).any(|c| c.0 == w.0 && c.1 == card.app);
        let heard: Vec<(String, String)> = card.waiters.iter().filter(waits).cloned().collect();
        (app, why, heard)
    };
    let text = match allow {
        true => format!(
            "[decision] The user said yes: you may use {app} in this chat. Make the same call again now."
        ),
        false => format!("[decision] {why}"),
    };
    for (session, _) in heard {
        // A turn that ended refuses it: it waits no more.
        let _ =
            crate::control::steer_as(data, &session, &text, &Value::Null, None, "system", false);
    }
    Ok(json!({"ok": true}))
}
