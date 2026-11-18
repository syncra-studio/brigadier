//! An action: it waits while the user is in its app [D910], runs once, and says how it went and
//! what changed.

use super::open::front;
use super::window::{NO_CHANGE, changes, ours};
use super::{BUSY, Fail, PAUSE_WAIT, Sess, cap, refuse, said, tool};
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
    let mut args = args;
    // A run's step reads nothing after it, so it needn't wait for a window to show.
    if s.batch && name != "drag" {
        args["post_action_wait"] = "none".into();
    }
    let done = match tool(data, name, args, &|| !here()) {
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
            let diff = changes(data, me, s, here);
            return Ok(format!(
                "{line}: outcome unknown, the app didn't answer.\n{diff}"
            ));
        }
        Ok(Err(why)) if why.contains("-25206") => {
            return Err(refuse(&format!(
                "{line}: failed, it takes no press. A field takes `type`; a row or cell, its parent's number or `click N --double`."
            )));
        }
        Ok(Err(why)) => return Err(refuse(&cap(&format!("{line}: failed. {}", ours(&why))))),
        Ok(Ok(done)) if s.batch => {
            return match done["effect"].as_str() {
                Some(e @ ("refused" | "partial")) => Err(refuse(&format!(
                    "{line}: {e}.{}",
                    ours(&format!(" {}", done["hint"].as_str().unwrap_or("")))
                ))),
                _ => Ok(format!("{line}: sent.")),
            };
        }
        Ok(Ok(done)) => done,
    };
    let diff = changes(data, me, s, here);
    let how = match done["effect"].as_str() {
        Some("refused") => format!("refused.{}", ours(&format!(" {}", done["hint"].as_str().unwrap_or("")))),
        _ if diff == NO_CHANGE => {
            "no change seen. Try another way: a key, a menu item, `click N --double`, or read again.".into()
        }
        Some("partial") => "partly done.".into(),
        _ => "change observed.".into(),
    };
    Ok(format!("{line}: {}\n{diff}", how.trim_end()))
}

/// Seconds since the user last moved the mouse, clicked or typed anywhere; no grant needed.
#[cfg(target_os = "macos")]
pub(super) fn idle() -> f64 {
    #[link(name = "CoreGraphics", kind = "framework")]
    unsafe extern "C" {
        fn CGEventSourceSecondsSinceLastEventType(state: i32, kind: u32) -> f64;
    }
    // kCGEventSourceStateHIDSystemState, kCGAnyInputEventType.
    unsafe { CGEventSourceSecondsSinceLastEventType(1, u32::MAX) }
}

#[cfg(not(target_os = "macos"))]
pub(super) fn idle() -> f64 {
    f64::MAX
}

/// While the user is in the app (in front, input in the last 2 s), the action waits; it goes on by
/// itself once they stop, and after 50 s nothing is done [D910].
pub(super) fn wait_for_user(data: &Path, s: &Sess, here: &dyn Fn() -> bool) -> Result<(), Value> {
    let start = Instant::now();
    while idle() < BUSY {
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
