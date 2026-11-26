//! A launch's log copy only: the child still receives its original arguments.
// shortcut: opaque scripts and unnamed positional secrets aren't parsed; extend this when a launcher embeds them.

use serde_json::Value;

const HIDDEN: &str = "<redacted>";

pub(super) fn argv(words: &[&str]) -> Vec<String> {
    let mut hide = false;
    words
        .iter()
        .enumerate()
        .map(|(i, word)| {
            let logged = if i == 0 {
                word.to_string()
            } else if hide {
                HIDDEN.into()
            } else {
                text(word, 0)
            };
            hide = i > 0
                && word.starts_with('-')
                && !word.contains('=')
                && (secret(word) || container(word));
            logged
        })
        .collect()
}

fn name(key: &str) -> String {
    key.chars()
        .filter(char::is_ascii_alphanumeric)
        .map(|c| c.to_ascii_lowercase())
        .collect()
}

fn secret(key: &str) -> bool {
    let key = name(key);
    matches!(key.as_str(), "auth" | "key")
        || [
            "token",
            "secret",
            "password",
            "passwd",
            "credential",
            "authorization",
            "apikey",
            "accesskey",
            "privatekey",
            "cookie",
        ]
        .iter()
        .any(|part| key.contains(part))
}

fn container(key: &str) -> bool {
    key.split('.').any(|part| {
        matches!(
            name(part).as_str(),
            "env" | "environment" | "headers" | "httpheaders"
        )
    })
}

fn text(word: &str, depth: usize) -> String {
    // Fail closed before assignment chains or embedded configs exhaust the host's stack.
    if depth >= 32 {
        return HIDDEN.into();
    }
    let trimmed = word.trim_start();
    if trimmed.starts_with(['{', '[']) {
        // serde_json's default nesting limit still exceeds the host thread's small stack.
        let (mut nesting, mut quoted, mut escaped) = (depth, false, false);
        for byte in word.bytes() {
            match (quoted, escaped, byte) {
                (true, true, _) => escaped = false,
                (true, false, b'\\') => escaped = true,
                (_, false, b'"') => quoted = !quoted,
                (false, _, b'{' | b'[') => {
                    nesting += 1;
                    if nesting >= 32 {
                        return HIDDEN.into();
                    }
                }
                (false, _, b'}' | b']') => nesting = nesting.saturating_sub(1),
                _ => {}
            }
        }
        return match serde_json::from_str::<Value>(word) {
            Ok(mut value) => {
                scrub(&mut value, depth + 1);
                value.to_string()
            }
            // A malformed inline config must not fall back to logging its credentials.
            Err(_) => HIDDEN.into(),
        };
    }
    if word.split_once("://").is_some_and(|(scheme, _)| {
        scheme
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'))
    }) && (word.contains('@') || word.contains('?'))
    {
        return HIDDEN.into();
    }
    if word.starts_with(['/', '.']) {
        return word.into();
    }
    if let Some((key, _)) = word.split_once(':')
        && secret(key)
    {
        return format!("{key}: {HIDDEN}");
    }
    if trimmed.to_ascii_lowercase().starts_with("bearer ")
        || trimmed.to_ascii_lowercase().starts_with("basic ")
    {
        return HIDDEN.into();
    }
    if let Some((key, value)) = word.split_once('=') {
        return format!(
            "{key}={}",
            if secret(key) || container(key) {
                HIDDEN.into()
            } else {
                text(value, depth + 1)
            }
        );
    }
    word.into()
}

fn scrub(value: &mut Value, depth: usize) {
    if depth >= 32 {
        *value = HIDDEN.into();
        return;
    }
    match value {
        Value::Object(fields) => {
            for (key, value) in fields {
                if container(key) {
                    match value.as_object_mut() {
                        Some(fields) => fields.values_mut().for_each(|v| *v = HIDDEN.into()),
                        None => *value = HIDDEN.into(),
                    }
                } else if secret(key) {
                    *value = HIDDEN.into();
                } else {
                    scrub(value, depth + 1);
                }
            }
        }
        Value::Array(items) => {
            let mut hide = false;
            for item in items {
                let next = item.as_str().is_some_and(|s| {
                    s.starts_with('-') && !s.contains('=') && (secret(s) || container(s))
                });
                if hide {
                    *item = HIDDEN.into();
                } else {
                    scrub(item, depth + 1);
                }
                hide = next;
            }
        }
        Value::String(word) => *word = text(word, depth + 1),
        _ => {}
    }
}
