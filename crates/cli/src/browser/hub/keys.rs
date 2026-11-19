//! The keys an agent's `brigadier browser press` names, checked here so the app gets one form.

use crate::agent::refuse;
use serde_json::Value;

/// A key as the agent names it ("Escape", "Meta+K", "⌘K", "shift+tab"): its name and modifiers,
/// in the words main's key call takes.
pub(super) fn key_of(words: &str) -> Result<(String, Vec<&'static str>), Value> {
    const NAMED: [&str; 14] = [
        "Enter",
        "Escape",
        "Tab",
        "Backspace",
        "Delete",
        "Space",
        "ArrowUp",
        "ArrowDown",
        "ArrowLeft",
        "ArrowRight",
        "Home",
        "End",
        "PageUp",
        "PageDown",
    ];
    let bad = || {
        refuse(&format!(
            "{words:?} isn't a key: name one as Enter, Escape, Tab, ArrowDown, PageDown, F5, a letter, or with modifiers as Meta+K or Shift+Tab."
        ))
    };
    let mut rest = words.trim();
    let mut modifiers = vec![];
    // ⌘K, ⇧Tab: the Mac's own marks before the key.
    while let Some(c) = rest.chars().next().filter(|_| rest.chars().count() > 1) {
        let m = match c {
            '⌘' => "meta",
            '⌥' => "alt",
            '⇧' => "shift",
            '⌃' => "control",
            _ => break,
        };
        modifiers.push(m);
        rest = &rest[c.len_utf8()..];
    }
    let mut parts: Vec<&str> = rest.split('+').collect();
    // "Meta++" names the plus key.
    if rest.ends_with("++") {
        parts.truncate(parts.len() - 2);
        parts.push("+");
    }
    let key = parts.pop().filter(|k| !k.is_empty()).ok_or_else(bad)?;
    for m in parts {
        modifiers.push(match m.to_ascii_lowercase().as_str() {
            "meta" | "cmd" | "command" => "meta",
            "control" | "ctrl" => "control",
            "alt" | "option" | "opt" => "alt",
            "shift" => "shift",
            _ => return Err(bad()),
        });
    }
    let lower = key.to_ascii_lowercase();
    let alias = match lower.as_str() {
        "return" => "Enter",
        "esc" => "Escape",
        "up" => "ArrowUp",
        "down" => "ArrowDown",
        "left" => "ArrowLeft",
        "right" => "ArrowRight",
        " " => "Space",
        _ => "",
    };
    let name = match NAMED.iter().find(|n| n.eq_ignore_ascii_case(key)) {
        Some(n) => n.to_string(),
        None if !alias.is_empty() => alias.into(),
        None if key.chars().count() == 1 && !key.chars().any(char::is_control) => key.into(),
        None if lower.starts_with('f')
            && lower[1..]
                .parse::<u8>()
                .is_ok_and(|n| (1..=12).contains(&n)) =>
        {
            key.to_ascii_uppercase()
        }
        None => return Err(bad()),
    };
    modifiers.sort_unstable();
    modifiers.dedup();
    Ok((name, modifiers))
}

/// A press's key as the user reads it: "Meta+K".
pub(super) fn keys(op: &Value) -> String {
    let mut all: Vec<&str> = (op["modifiers"].as_array().into_iter().flatten())
        .filter_map(Value::as_str)
        .collect();
    all.push(op["key"].as_str().unwrap_or(""));
    all.iter()
        .map(|k| match *k {
            "meta" => "Meta",
            "alt" => "Alt",
            "shift" => "Shift",
            "control" => "Control",
            k => k,
        })
        .collect::<Vec<_>>()
        .join("+")
}
