//! An action: it waits while the user is in its app [D910], runs once, and says how it went and
//! what changed.

use super::diff::{Seen, baseline, changes};
use super::open::{front, own};
use super::window::ours;
use super::{BUSY, Fail, PAUSE_WAIT, SESSIONS, Sess, cap, lock, refuse, said, tool};
use serde_json::{Value, json};
use std::path::Path;
use std::thread;
use std::time::{Duration, Instant};

/// Runs one action once the user isn't in its app, then says what changed: our own before/after
/// read decides, never the driver's guess [D922]. Only `type` says "done", from its read-back.
pub(super) fn act(
    data: &Path,
    me: &str,
    s: &mut Sess,
    line: &str,
    name: &str,
    args: Value,
    here: &dyn Fn() -> bool,
) -> Result<String, Value> {
    wait_for_user(data, s, here)?;
    if !s.batch {
        baseline(data, s, here);
    }
    // The control pressed, by its number in the last read.
    let target =
        (args["element_token"].as_str()).and_then(|t| t.rsplit(':').next()?.parse::<u64>().ok());
    let mut args = args;
    // Ours, not the driver's: whether the drag is meant to drop something (shot.rs).
    let drop = (args.as_object_mut()).and_then(|a| a.remove("drop")) == Some(Value::Bool(true));
    // Ours too: a Finder rename (typing.rs). It and a drop can move the rows after them.
    let voids = (args.as_object_mut()).and_then(|a| a.remove("voids")) == Some(Value::Bool(true));
    // A run's step reads nothing after it, so it needn't wait for a window to show.
    if s.batch && name != "drag" {
        args["post_action_wait"] = "none".into();
    }
    // Alive now: only then can the app's going be this click's doing.
    let alive = name == "click" && !quit(s.pid, false);
    super::sent();
    let done = tool(data, name, args, &|| !here());
    // Once sent, whatever came back (an answer, none in time, an error), the numbers are void,
    // kept past any error below; only a call never sent, or one Cua refused, keeps them.
    let refused = matches!(&done, Ok(Ok(d)) if d["effect"] == "refused");
    if (drop || voids) && !refused && !matches!(done, Err(Fail::NotSent(_))) {
        s.moved = true;
        moved(me);
    }
    // A click that ends its app (a dialog's OK) gets an AX error or no answer from it: the app's
    // process gone, by our own read, is the change [C130]. Any other error stays a failure.
    let errored = !matches!(done, Ok(Ok(_)));
    if alive && !refused && !matches!(done, Err(Fail::NotSent(_))) && quit(s.pid, errored) {
        *s = Sess {
            batch: s.batch,
            ..Sess::default()
        };
        // A run's error isn't saved by `verb`: the void session is, here.
        if s.batch {
            lock(&SESSIONS).insert(me.to_string(), s.clone());
        }
        return match s.batch {
            true => Err(refuse(&format!(
                "{line}: done, the app quit, so the steps after it weren't sent."
            ))),
            false => Ok(format!("{line}: done, the app quit.")),
        };
    }
    let done = match done {
        // A run stops at a step it can't vouch for: the next one may depend on it.
        Err(Fail::Unknown) if s.batch => {
            return Err(refuse(&format!(
                "{line}: sent, but no answer came in time: the outcome is unknown."
            )));
        }
        Err(Fail::Unknown) => {
            return Ok(format!(
                "{line}: sent, but no answer came in time: the outcome is unknown. Read again."
            ));
        }
        Err(f) => return Err(said(f)),
        // AX "cannot complete": the app often did it anyway (a button that opens a menu).
        Ok(Err(why)) if why.contains("-25204") && s.batch => {
            return Err(refuse(&format!(
                "{line}: outcome unknown, the app didn't answer."
            )));
        }
        Ok(Err(why)) if why.contains("-25204") => {
            let (_, diff) = changes(data, me, s, here);
            return Ok(format!(
                "{line}: outcome unknown, the app didn't answer.\n{diff}"
            ));
        }
        Ok(Err(why)) if why.contains("-25206") => {
            let over = target.map_or(String::new(), |n| covered(data, s, n, here));
            return Err(refuse(&format!(
                "{line}: failed, it takes no press.{over} A field takes `type`; a row or cell, its parent's number or `click N --double`."
            )));
        }
        Ok(Err(why)) => return Err(refuse(&cap(&format!("{line}: failed. {}", ours(&why))))),
        Ok(Ok(done)) => done,
    };
    // A background drag drops only through a macOS drag-and-drop session: without one, the file
    // it meant to drop wasn't moved, whatever the window shows [D129]. Cua 0.54 says a drop only in
    // its text (and `summary`, its copy): its structured result has no drag_session.
    // shortcut: matches Cua 0.54.0's drag.rs wording, so a reword makes every drop "nothing dropped"; upgrade: recheck at any Cua bump.
    let dropped = ["_text", "summary"].iter().any(|k| {
        (done[*k].as_str())
            .is_some_and(|t| t.contains("held the drop point until the session ended"))
    });
    let undropped = drop && !dropped && done["effect"] != "refused";
    if s.batch {
        return match done["effect"].as_str() {
            Some(e @ ("refused" | "partial")) => Err(refuse(&format!(
                "{line}: {e}.{}",
                ours(&format!(" {}", done["hint"].as_str().unwrap_or("")))
            ))),
            // The steps after it may count on the drop: the run stops here.
            _ if undropped => Err(refuse(&format!("{line}: {NO_DROP}"))),
            // A file dropped leaves its list, and the rows after it move: the run stops for a read.
            _ if drop => Err(refuse(&format!(
                "{line}: sent. A file dropped in Finder moves the rows after it, so the steps after it weren't sent: read again."
            ))),
            _ => Ok(format!("{line}: sent.")),
        };
    }
    let (seen, diff) = changes(data, me, s, here);
    let how = match done["effect"].as_str() {
        Some("refused") => format!(
            "refused.{}",
            ours(&format!(" {}", done["hint"].as_str().unwrap_or("")))
        ),
        _ if seen == Seen::No => format!(
            "no change seen.{} Try another way: a key, a menu item, `click N --double`, or read again.",
            target.map_or(String::new(), |n| covered(data, s, n, here))
        ),
        Some("partial") => "partly done.".into(),
        _ if seen == Seen::Unsure => "sent; I can't tell what it changed.".into(),
        _ => "change observed.".into(),
    };
    let how = match undropped {
        true => format!("{} {NO_DROP}", how.trim_end()),
        false => how,
    };
    Ok(format!("{line}: {}\n{diff}", how.trim_end()))
}

/// Whether `pid`'s process is confirmed gone; `wait`, a moment for it to exit, as an answer can
/// beat it. Unsure (no pid, or no way to ask) is not gone.
fn quit(pid: i64, wait: bool) -> bool {
    let Some(pid) = i32::try_from(pid).ok().filter(|p| *p > 0) else {
        return false;
    };
    let start = Instant::now();
    loop {
        #[cfg(unix)]
        let gone = unsafe { libc::kill(pid, 0) } == -1
            && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH);
        #[cfg(not(unix))]
        let gone = false;
        if gone || !wait || start.elapsed() >= Duration::from_secs(1) {
            return gone;
        }
        thread::sleep(Duration::from_millis(100));
    }
}

/// The window's numbers are void for `me`, kept even when the step ends in an error: `verb` saves
/// its copy of the session only on success.
fn moved(me: &str) {
    lock(&SESSIONS).entry(me.to_string()).or_default().moved = true;
}

const NO_DROP: &str = "No drag-and-drop session started, so nothing was dropped. To move a file in Finder: select it, `menu \"Edit > Copy “<file>”\"`, open the folder, then `menu \"Edit > Move Item Here\"`.";

/// Cua's background keys aren't proved in Chromium, and no app is brought to the front for them
/// [D909 D2032].
pub(super) fn no_keys(s: &Sess, what: &str) -> Value {
    refuse(&format!(
        "{what}: {} is built on Chromium or Electron, where background keys aren't proved, and no app is brought to the front for one. Pick its menu item instead (`brigadier computer menu \"File > …\"`, read --menus lists them), click a button, or, in a browser, `brigadier computer open {} <url>`.",
        s.app, s.app
    ))
}

/// What sits on control [n]'s centre when it isn't [n] itself: a dialog or a banner over it.
fn covered(data: &Path, s: &Sess, n: u64, here: &dyn Fn() -> bool) -> String {
    // An overlay accessibility doesn't show leaves no answer: said so, never taken as uncovered.
    let unseen = format!(
        " I couldn't tell what's on [{n}]'s centre: something outside what I can read may cover it, as a consent banner can. `screenshot` shows it."
    );
    let Some(f) = s.frames.get(&n) else {
        return unseen;
    };
    let at = json!({"pid": s.pid, "x": f[0] + f[2] / 2.0, "y": f[1] + f[3] / 2.0});
    let Ok(hit) = own(data, "hit", at, here) else {
        return unseen;
    };
    let chain = hit["chain"].as_array().cloned().unwrap_or_default();
    let near = |a: &Value| (0..4).all(|i| (a[i].as_f64().unwrap_or(f64::MAX) - f[i]).abs() <= 1.0);
    if chain.is_empty() {
        return unseen;
    }
    // The point is [n], or inside it: nothing covers it.
    if chain.iter().any(|e| near(&e["frame"])) {
        return String::new();
    }
    let named = |e: &&Value| e["name"].as_str().is_some_and(|n| !n.is_empty());
    let dialog = |e: &&Value| e["subrole"].as_str().is_some_and(|r| r.contains("Dialog"));
    let Some(top) = (chain.iter().find(|e| dialog(e) && named(e))).or_else(|| {
        chain
            .iter()
            .find(|e| named(e) && e["role"] != "AXWebArea" && e["role"] != "AXWindow")
    }) else {
        return String::new();
    };
    format!(
        " The point is covered by {} \"{}\": close or answer it first.",
        top["role"].as_str().unwrap_or("?"),
        top["name"].as_str().unwrap_or("")
    )
}

/// Seconds since the user last gave input of `kind` (`ANY`: moved the mouse, clicked or typed;
/// `CLICK`: a left click; `MODIFIER`: pressed or let go of ⌘, ⇧, ⌥ or ⌃) anywhere; no grant needed.
#[cfg(target_os = "macos")]
pub(super) fn idle(kind: u32) -> f64 {
    #[link(name = "CoreGraphics", kind = "framework")]
    unsafe extern "C" {
        fn CGEventSourceSecondsSinceLastEventType(state: i32, kind: u32) -> f64;
    }
    // kCGEventSourceStateHIDSystemState.
    unsafe { CGEventSourceSecondsSinceLastEventType(1, kind) }
}
/// kCGAnyInputEventType, kCGEventLeftMouseDown, kCGEventFlagsChanged.
pub(super) const ANY: u32 = u32::MAX;
pub(super) const CLICK: u32 = 1;
pub(super) const MODIFIER: u32 = 12;

#[cfg(not(target_os = "macos"))]
pub(super) fn idle(_: u32) -> f64 {
    f64::MAX
}

/// While the user is in the app (in front, input in the last 2 s), the action waits; it goes on by
/// itself once they stop, and after 50 s nothing is done [D910].
pub(super) fn wait_for_user(data: &Path, s: &Sess, here: &dyn Fn() -> bool) -> Result<(), Value> {
    let start = Instant::now();
    while idle(ANY) < BUSY {
        if front(data, here) != Some(s.pid) {
            return Ok(());
        }
        if start.elapsed() >= PAUSE_WAIT || !here() {
            return Err(refuse(&format!(
                "The user is using {}; nothing was done. Try again later.",
                s.app
            )));
        }
        thread::sleep(Duration::from_millis(500));
    }
    Ok(())
}

pub(super) fn token(s: &Sess, n: u64) -> String {
    format!("{}:{n}", s.snapshot)
}

/// A key or a combination: cmd or ctrl with any key, or a key that types nothing, so a key can
/// never type into a password field; nor can a paste in a window that has one [D903].
pub(super) fn key(s: &Sess, me: &str, keys: &str) -> Result<(&'static str, Value), Value> {
    const MODS: [&str; 7] = [
        "cmd", "command", "shift", "option", "alt", "ctrl", "control",
    ];
    const NAMED: [&str; 17] = [
        "return",
        "enter",
        "escape",
        "esc",
        "tab",
        "delete",
        "backspace",
        "forwarddelete",
        "up",
        "down",
        "left",
        "right",
        "home",
        "end",
        "pageup",
        "pagedown",
        "fn",
    ];
    let parts: Vec<String> = keys.split('+').map(|k| k.trim().to_lowercase()).collect();
    let (last, mods) = parts
        .split_last()
        .ok_or_else(|| refuse("Name the keys: brigadier computer key cmd+s"))?;
    let named = NAMED.contains(&last.as_str())
        || (last.starts_with('f') && last[1..].parse::<u8>().is_ok_and(|f| (1..=20).contains(&f)));
    // Shift and option with a letter type it (A, å).
    let types = mods
        .iter()
        .all(|m| ["shift", "option", "alt"].contains(&m.as_str()));
    if last.is_empty() || !mods.iter().all(|m| MODS.contains(&m.as_str())) || (types && !named) {
        return Err(refuse(
            "Press a named key (return, escape, tab, arrows…) or a combination with cmd or ctrl; type text with `type`.",
        ));
    }
    let cmd = mods.iter().any(|m| m == "cmd" || m == "command");
    if cmd && last == "v" && !s.secure.is_empty() {
        return Err(refuse(
            "This window has a password field, so no pasting: ask the user.",
        ));
    }
    Ok(match mods.is_empty() {
        true => (
            "press_key",
            json!({"key": last, "pid": s.pid, "window_id": s.window, "session": me}),
        ),
        false => (
            "hotkey",
            json!({"keys": parts, "pid": s.pid, "window_id": s.window, "session": me}),
        ),
    })
}

/// Accessibility is needed for everything, Screen Recording for a picture.
pub(super) fn need(data: &Path, screen: bool) -> Result<(), Value> {
    let last = *super::lock(&super::HUB.grants);
    let (ax, sr) = match last {
        Some(g) if g.0 && (g.1 || !screen) => g,
        _ => super::super::grants(data).map_err(said)?,
    };
    let ask = |what: &str| {
        refuse(&format!(
            "Computer use isn't set up: {what} isn't allowed for Brigadier Computer Use. Ask the user to open Settings › Computer use."
        ))
    };
    match (ax, sr || !screen) {
        (false, _) => Err(ask("Accessibility")),
        (_, false) => Err(ask("Screen Recording")),
        _ => Ok(()),
    }
}
