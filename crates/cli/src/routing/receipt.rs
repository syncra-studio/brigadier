//! A worker's receipt: what it runs on, in a line [D3018].

use super::*;

/// The receipt [D3018]: "Write code → ‹model› · High · Work (5-hour 40%, resets 15:10)", from
/// the start's snapshot in `ran`; once the reset has passed, without it, or "Usage limit" for a
/// window that was at its limit [D379]; the account alone with no quota known (proposed). One
/// from before jobs names its row.
pub(crate) fn receipt(ran: &Value) -> Option<String> {
    ran.get("label")?;
    let job = (ran["job"].as_str().map(String::from)).or(ran["row"].as_str().map(capital));
    let model = ran["name"].as_str().or(ran["model"].as_str())?;
    // A retry's: "Retry 1 of 2 → Write code: fake · High (tests failed)" [D2037] (proposed).
    let mut text = match (ran["retry"].as_str(), job) {
        (Some(t), Some(r)) => format!("{t} → {r}: {model}"),
        (None, Some(r)) => format!("{r} → {model}"),
        (Some(t), None) => format!("{t} → {model}"),
        (None, None) => model.to_string(),
    };
    if let Some(e) = ran["effort"].as_str() {
        text += &format!(" · {}", capital(e));
    }
    if let Some(f) = ran["failed"].as_str() {
        text += &format!(" ({f})");
    }
    let q = &ran["quota"];
    let passed = q["resets"].as_u64().is_some_and(|at| at <= log::now_ms());
    let quota = match (q["used"].as_u64(), passed) {
        (None, _) => String::new(),
        (Some(u), true) if u >= 100 => " (Usage limit)".into(),
        (Some(u), true) => format!(" ({} {u}%)", str_of(q, "name")),
        (Some(u), false) => match q["resets"].as_u64() {
            Some(at) => format!(" ({} {u}%, resets {})", str_of(q, "name"), clock(at)),
            None => format!(" ({} {u}%)", str_of(q, "name")),
        },
    };
    if let Some(l) = ran["label"].as_str().filter(|l| !l.is_empty()) {
        text += &format!(" · {l}{quota}");
    }
    for note in [&ran["capped"], &ran["note"]] {
        if let Some(n) = note.as_str() {
            text += &format!("; {n}");
        }
    }
    Some(text)
}

/// An account as Providers names it, for the receipt [D24]: its name, else which login it is.
pub(super) fn label(v: &Value, agent: &str, id: &str) -> String {
    if adapters::get(agent).is_none_or(|a| a.accounts().is_none()) {
        return String::new();
    }
    let name = (accounts_of(v, agent).into_iter())
        .find(|(x, _)| x == id)
        .map(|(_, n)| n)
        .unwrap_or_default();
    match (name.is_empty(), id.is_empty()) {
        (false, _) => name,
        (true, true) => "This computer's login".into(),
        (true, false) => "Another account".into(),
    }
}
