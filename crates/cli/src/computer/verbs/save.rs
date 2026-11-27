//! ⌘S where Cua would save by Apple Events, which can raise macOS's Automation prompt [C106].

use super::Sess;
use super::open::own;
use serde_json::{Value, json};
use std::path::Path;

/// Why ⌘S isn't sent: Cua would save by Apple Events, as it does where the app greys Save in the
/// background and Accessibility can't press it, and macOS hasn't let Brigadier control that app;
/// asking, it asks the user now, and the key waits for them to press it again [C106]. Proposed:
/// the words, and not sending.
pub(super) fn scripted(
    data: &Path,
    s: &Sess,
    args: &Value,
    here: &dyn Fn() -> bool,
) -> Option<String> {
    let keys: Vec<&str> = (args["keys"].as_array()?.iter())
        .filter_map(Value::as_str)
        .collect();
    // Cua's save is plain ⌘S only (invoke_menu.rs item_is_save); other keys take no such route.
    if !matches!(keys[..], ["cmd" | "command", "s"]) {
        return None;
    }
    let greyed = format!("{} greys Save while it's behind the user's window", s.app);
    let lead = format!("{greyed}, so saving there goes through Apple Events");
    let unsure = format!("whether {} would save it through Apple Events", s.app);
    let none = format!(
        "{greyed}, and {} has no bundle id for Brigadier to save it through. Ask the user to save it.",
        s.app
    );
    let words = (
        lead.as_str(),
        unsure.as_str(),
        none.as_str(),
        "press it again",
    );
    consent(data, s, json!({"pid": s.pid, "keys": keys}), words, here)
}

/// Why a Finder rename isn't sent: Cua renames through Finder's scripting, which macOS hasn't let
/// Brigadier do yet, and asking, it asks the user now [D129]. Proposed: the words.
pub(super) fn renaming(data: &Path, s: &Sess, here: &dyn Fn() -> bool) -> Option<String> {
    let words = (
        "Renaming a file in Finder in the background goes through Apple Events",
        "whether macOS lets Brigadier rename it through Finder's Apple Events",
        "Finder can't be scripted for it. Ask the user to rename it.",
        "type it again",
    );
    consent(data, s, json!({"pid": s.pid, "scripts": true}), words, here)
}

/// macOS's Automation answer, from the helper, for a call Cua would carry out by Apple Events:
/// none needed, or why nothing is sent. The words are (what goes through Apple Events, what
/// couldn't be told, what to say when the app can't be scripted, what to do again).
fn consent(
    data: &Path,
    s: &Sess,
    params: Value,
    (lead, unsure, none, again): (&str, &str, &str, &str),
    here: &dyn Fn() -> bool,
) -> Option<String> {
    let app = &s.app;
    // Not knowing may mean a prompt, so nothing goes.
    let Ok(a) = own(data, "automation", params, here) else {
        return Some(format!(
            "Brigadier couldn't tell {unsure}, which can make macOS ask the user. Read again, then {again}."
        ));
    };
    match (a["scripted"] == true)
        .then(|| a["status"].as_str())
        .flatten()?
    {
        // Cua refuses a denied app itself, with no prompt.
        "granted" | "denied" => None,
        "none" => Some(none.to_string()),
        _ => Some(format!(
            "{lead}, and macOS is asking whether Brigadier may control {app}. Ask the user to answer macOS's prompt, then {again}."
        )),
    }
}
