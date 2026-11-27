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
    let app = &s.app;
    // Not knowing may mean a prompt, so nothing goes.
    let Ok(a) = own(
        data,
        "automation",
        json!({"pid": s.pid, "keys": keys}),
        here,
    ) else {
        return Some(format!(
            "Brigadier couldn't tell whether {app} would save it through Apple Events, which can make macOS ask the user. Read again, then press it again."
        ));
    };
    let greyed = format!("{app} greys Save while it's behind the user's window");
    match (a["scripted"] == true)
        .then(|| a["status"].as_str())
        .flatten()?
    {
        // Cua refuses a denied app itself, with no prompt.
        "granted" | "denied" => None,
        "none" => Some(format!(
            "{greyed}, and {app} has no bundle id for Brigadier to save it through. Ask the user to save it."
        )),
        _ => Some(format!(
            "{greyed}, so saving there goes through Apple Events, and macOS is asking whether Brigadier may control {app}. Ask the user to answer macOS's prompt, then press it again."
        )),
    }
}
