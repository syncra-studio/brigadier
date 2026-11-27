//! `type`: replacing a field's value, read back to say whether it landed, and `--submit`'s real
//! Return, which in an address bar says whether the page changed [D2032].

use super::act::{act, no_keys, token, wait_for_user};
use super::apps::app_of;
use super::{Sess, Words, call, cap, refuse, save, still, window};
use serde_json::{Value, json};
use std::path::Path;

pub(super) fn type_into(
    data: &Path,
    me: &str,
    s: &mut Sess,
    w: &Words,
    n: u64,
    here: &dyn Fn() -> bool,
) -> Result<String, Value> {
    let text = w
        .values
        .get("--stdin")
        .filter(|t| !t.is_empty())
        .ok_or_else(|| refuse("Pipe the text in: echo \"…\" | brigadier computer type 4"))?;
    if s.moved {
        return Err(refuse(
            "The window's numbers moved: read it again before typing.",
        ));
    }
    if s.secure.contains(&n) {
        return Err(refuse(&format!(
            "[{n}] is a password field: ask the user to type it."
        )));
    }
    if w.flags.contains("--submit") && window::chromium(data, s.pid, here) {
        return Err(no_keys(
            s,
            "Nothing typed, as Return can't follow (type without --submit fills the field)",
        ));
    }
    if (s.controls.iter()).any(|c| c.n == n && c.cell) && finder(s.pid) {
        return rename(data, me, s, n, text, here);
    }
    // `type` replaces: the field is emptied first, else the text goes in at its caret. Not while
    // the user is in the app, and put back if the typing doesn't go through.
    let old = s.values.get(&n).cloned().unwrap_or_default();
    let field = Field::of(s, n);
    if !old.is_empty() {
        wait_for_user(data, s, here)?;
        set(data, me, s, &token(s, n), "", here)?;
    }
    let args = json!({"text": text, "element_token": token(s, n), "pid": s.pid, "window_id": s.window, "session": me});
    let line = format!("Typed {} characters into [{n}]", text.chars().count());
    let done = act(data, me, s, &line, "type_text", args, here);
    let refused = (done.as_ref()).map_or(true, |o| {
        o.lines().next().is_some_and(|l| l.contains(": refused"))
    });
    if refused && !old.is_empty() {
        let back = restore(data, me, s, &field, &old, here);
        return match done {
            Ok(out) => Ok(out.replacen('\n', &format!("{back}\n"), 1)),
            Err(e) => Err(refuse(&format!(
                "{}{back}",
                e["error"].as_str().unwrap_or("Typing failed.")
            ))),
        };
    }
    let mut out = done?;
    if refused {
        return Ok(out);
    }
    // Done only when the field reads the text back.
    if s.batch {
        return Ok(out);
    }
    let landed = window::shows(s, n, text);
    // What the app said of the typing, kept beside the read-back: unknown or partly done.
    let first = out.lines().next().unwrap_or("");
    let said = match () {
        _ if first.contains("the outcome is unknown") => " sent, but no answer came in time, and",
        _ if first.ends_with("partly done.") => " partly done, and",
        _ => "",
    };
    // The old text still there beside the new: it went in at the caret, not over it.
    let kept = !old.is_empty() && !text.contains(old.trim()) && window::shows(s, n, &old);
    let typed = match (landed, kept) {
        (true, false) => format!("{line}: done, [{n}] reads it back."),
        (true, true) => format!(
            "{line}: [{n}] holds its old text too: \"{}\". Read it before going on.",
            s.values[&n]
        ),
        // Partly done, no answer in time, or not read back: the user's text it cleared goes back.
        (false, _) if !old.is_empty() => format!(
            "{line}:{said} [{n}] doesn't read it back.{} Read it before going on.",
            restore(data, me, s, &field, &old, here)
        ),
        (false, _) => {
            format!("{line}:{said} [{n}] doesn't read it back. Read it before going on.")
        }
    };
    let landed = landed && !kept;
    out = out.replacen(out.lines().next().unwrap_or(""), &typed, 1);
    // Return only after text that landed: never on a refusal or an unknown outcome.
    if w.flags.contains("--submit") && !landed {
        out.push_str("\nNot submitted: read the window, then `key return`.");
    } else if w.flags.contains("--submit") {
        // A real Return to the field.
        let enter = json!({"key": "return", "element_token": token(s, n), "pid": s.pid, "window_id": s.window, "session": me});
        let title = |s: &Sess| (s.wins.iter().find(|w| w.0 == s.window)).map(|w| w.1.clone());
        let (address, before) = (s.address == Some(n), title(s));
        out = act(data, me, s, "Pressed Return", "press_key", enter, here)?;
        if address {
            let url = s
                .address
                .and_then(|a| s.values.get(&a))
                .cloned()
                .unwrap_or_default();
            out.push_str(&match (url == old, title(s) == before) {
                    (true, _) => format!("\nThe address bar still shows \"{old}\": the page didn't change."),
                    (false, true) => format!("\nThe address bar shows \"{url}\", but the page title is the same: read to check it loaded."),
                    (false, false) => format!("\nThe address bar shows \"{url}\": the page changed."),
                });
        }
        out = format!("{typed}\n{out}");
    }
    Ok(out)
}

/// Finder itself, on the sealed system volume: no other app can be at its path.
pub(super) fn finder(pid: i64) -> bool {
    app_of(pid).is_ok_and(|a| a == Path::new("/System/Library/CoreServices/Finder.app"))
}

/// A file's name in a Finder window: the driver renames the file through Finder, in the
/// background, given the whole new name, and reads it back from disk. Emptying the field first
/// would be a rename to "", and a Return opens Finder's rename field, which the driver can't reach.
fn rename(
    data: &Path,
    me: &str,
    s: &mut Sess,
    n: u64,
    text: &str,
    here: &dyn Fn() -> bool,
) -> Result<String, Value> {
    // `voids`: once sent, act() voids the numbers, whatever comes back.
    let args = json!({"element_token": token(s, n), "pid": s.pid, "window_id": s.window, "value": text, "session": me, "voids": true});
    let line = format!("Renamed [{n}] to \"{text}\"");
    if let Some(no) = save::renaming(data, s, here) {
        return Err(refuse(&format!("[{n}] isn't renamed: {no}")));
    }
    let out = act(data, me, s, &line, "set_value", args, here)?;
    let first = out.lines().next().unwrap_or("").to_string();
    if first.contains(": refused") {
        return Ok(out);
    }
    // A window sorted by name moves the file's row and the rows between, so a run's later steps
    // would act on the old numbers: it stops here for a read.
    if s.batch {
        return Err(refuse(&format!(
            "{line}: sent. A renamed file can move in Finder's list, so the steps after it weren't sent: read again."
        )));
    }
    if first.contains("the outcome is unknown") {
        return Ok(out);
    }
    // It's found again by its new name, never by [n].
    let found = call(data, "get_window_state", window::state_args(s, me), here);
    let said = match found.ok().as_ref().map(|f| named(f, text)) {
        Some(Some(m)) => {
            format!("{line}: done, [{m}] reads it back. Read again before using the numbers.")
        }
        _ => format!(
            "{line}: I can't find a file named \"{text}\" in the window to check it. Read it before going on."
        ),
    };
    Ok(out.replacen(&first, &said, 1))
}

/// The one name cell of a read whose value is `name`.
fn named(found: &Value, name: &str) -> Option<u64> {
    let cells = window::in_cells(found["tree_markdown"].as_str().unwrap_or(""));
    let mut of = (found["elements"].as_array().into_iter().flatten()).filter_map(|e| {
        let n = e["element_index"].as_u64()?;
        (cells.contains(&n) && window::value(e) == Some(name)).then_some(n)
    });
    of.next().filter(|_| of.next().is_none())
}

fn set(
    data: &Path,
    me: &str,
    s: &Sess,
    token: &str,
    value: &str,
    here: &dyn Fn() -> bool,
) -> Result<Value, Value> {
    let args = json!({"element_token": token, "pid": s.pid, "window_id": s.window, "value": value, "session": me});
    call(data, "set_value", args, here)
}

/// Which field was cleared: its number may be another control's by the time the typing failed.
struct Field {
    window: u64,
    role: Option<String>,
    frame: Option<[f64; 4]>,
}

impl Field {
    fn of(s: &Sess, n: u64) -> Field {
        Field {
            window: s.window,
            role: (s.controls.iter().find(|c| c.n == n)).map(|c| c.role.clone()),
            frame: s.frames.get(&n).copied(),
        }
    }

    /// Its row in a read: the one control of its role at its place. A field's height follows its text.
    fn row<'a>(&self, found: &'a Value) -> Option<&'a Value> {
        let (role, f) = (self.role.as_deref()?, self.frame?);
        let here = |e: &&Value| {
            let at =
                |k: &str, v: f64| (e["frame"][k].as_f64()).is_some_and(|x| (x - v).abs() <= 1.0);
            e["role"] == role && at("x", f[0]) && at("y", f[1]) && at("w", f[2])
        };
        let mut rows = (found["elements"].as_array()?.iter()).filter(here);
        rows.next().filter(|_| rows.next().is_none())
    }
}

/// Puts back the text this cleared, as a sentence for the agent.
fn restore(
    data: &Path,
    me: &str,
    s: &mut Sess,
    field: &Field,
    old: &str,
    here: &dyn Fn() -> bool,
) -> String {
    match still::undo(|| put_back(data, me, s, field, old, here)) {
        Ok(()) => " Its old text is put back.".to_string(),
        Err(why) => cap(&format!(
            " Its old text isn't put back: {why}. Read it; it was \"{old}\"."
        )),
    }
}

/// Writes the old text into a field this cleared, unless the user, or a part of the typing, has
/// put something there since.
fn put_back(
    data: &Path,
    me: &str,
    s: &mut Sess,
    field: &Field,
    old: &str,
    here: &dyn Fn() -> bool,
) -> Result<(), &'static str> {
    if s.window != field.window {
        return Err("its window is gone");
    }
    let found = call(data, "get_window_state", window::state_args(s, me), here)
        .map_err(|_| "the window couldn't be read")?;
    // This read voids the numbers the agent has.
    s.moved = true;
    let row = (field.row(&found)).ok_or("I can't tell which field it is now")?;
    // The driver leaves an empty value out.
    if window::value(row).is_some_and(|v| !v.is_empty()) {
        return Err("the field has other text now");
    }
    let token = row["element_token"].as_str().unwrap_or("");
    set(data, me, s, token, old, here).map_or(Err("writing it failed"), |_| Ok(()))
}
