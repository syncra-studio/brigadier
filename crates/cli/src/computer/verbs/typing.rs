//! `type`: replacing a field's value, read back to say whether it landed, and `--submit`'s real
//! Return, which in an address bar says whether the page changed [D2032].

use super::act::{act, token};
use super::{Sess, Words, call, refuse, window};
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
    // `type` replaces: the field is emptied first, else the text goes in at its caret.
    let old = s.values.get(&n).cloned().unwrap_or_default();
    if !old.is_empty() {
        let clear = json!({"element_token": token(s, n), "pid": s.pid, "window_id": s.window, "value": "", "session": me});
        call(data, "set_value", clear, here)?;
    }
    let args = json!({"text": text, "element_token": token(s, n), "pid": s.pid, "window_id": s.window, "session": me});
    let line = format!("Typed {} characters into [{n}]", text.chars().count());
    let mut out = act(data, me, s, &line, "type_text", args, here)?;
    // Done only when the field reads the text back.
    if s.batch {
        return Ok(out);
    }
    let landed = window::shows(s, n, text);
    // The old text still there beside the new: it went in at the caret, not over it.
    let kept = !old.is_empty() && !text.contains(old.trim()) && window::shows(s, n, &old);
    let typed = match (landed, kept) {
        (true, false) => format!("{line}: done, [{n}] reads it back."),
        (true, true) => format!(
            "{line}: [{n}] holds its old text too: \"{}\". Read it before going on.",
            s.values[&n]
        ),
        (false, _) => {
            format!("{line}: [{n}] doesn't read it back. Read it before going on.")
        }
    };
    let landed = landed && !kept;
    out = out.replacen(out.lines().next().unwrap_or(""), &typed, 1);
    // Return only after text that landed: never on a refusal or an unknown outcome.
    if w.flags.contains("--submit") && !landed {
        out.push_str("\nNot submitted: read the window, then `key return`.");
    } else if w.flags.contains("--submit") {
        // A real Return to the field: Chromium's address bar takes only a hardware one.
        let mut enter = json!({"key": "return", "element_token": token(s, n), "pid": s.pid, "window_id": s.window, "session": me});
        if window::chromium(data, s.pid, here) {
            enter["delivery_mode"] = "foreground".into();
        }
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
