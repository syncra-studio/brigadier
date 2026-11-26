//! What a turn's message starts with, for its agent only: the record keeps what the user wrote
//! [D109, D127].

use crate::Spec;

/// The message as led, if it is, and Overnight's line alone, for a fresh conversation's hand-off.
pub(super) fn led(spec: &Spec, origin: &str, text: &str) -> (Option<String>, Option<String>) {
    // A note's side chat is told each time which note it's beside, as the old app's page chat was [D281].
    let note = spec.opts.get("note").filter(|_| origin == "user");
    let led = note.map(|note| {
        let reads = spec.opts.get("reads").map(String::as_str);
        format!("{}\n\n{text}", crate::message::notes::lead(note, reads))
    });
    let night = match origin {
        "user" | "system" => crate::overnight::led(&spec.dir),
        _ => None,
    };
    match (&night, led.as_deref().unwrap_or(text)) {
        (Some(line), all) if !all.is_empty() => (Some(format!("{line}\n\n{all}")), night),
        _ => (led, night),
    }
}
