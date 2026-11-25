//! What a turn's message starts with, for its agent only: the record keeps what the user wrote
//! [D109, D127].

use crate::Spec;

/// What a Brigade's every message from its user starts with [D185].
const BRIGADE: &str = "[Brigade: you are this job's boss. Run `brigadier help brigade` and follow it before anything else.]";

/// The message as led, if it is, and Overnight's line alone, for a fresh conversation's hand-off.
pub(super) fn led(spec: &Spec, origin: &str, text: &str) -> (Option<String>, Option<String>) {
    // A Brigade's own message points its agent at the recipe first, as Fusion's did [D185].
    let led = (spec.brigade && origin == "user").then(|| format!("{BRIGADE}\n\n{text}"));
    // A note's side chat is told each time which note it's beside, as the old app's page chat was [D281].
    let led = led.or_else(|| {
        let note = spec.opts.get("note").filter(|_| origin == "user")?;
        let reads = spec.opts.get("reads").map(String::as_str);
        Some(format!(
            "{}\n\n{text}",
            crate::message::notes::lead(note, reads)
        ))
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
