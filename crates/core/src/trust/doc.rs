//! A CLI's settings file as JSON (written as `JSON.stringify(_, null, 2)` writes it, key order
//! kept) or TOML (format kept by `toml_edit`): one key path read, set or removed.

use serde_json::{Map, Value};
use std::io;
use toml_edit::{DocumentMut, Item, Table};

pub enum Doc {
    Json(Value),
    Toml(DocumentMut),
}

fn unsafe_edit<T>(why: &str) -> io::Result<T> {
    Err(io::Error::other(format!(
        "its settings file can't be edited safely: {why}"
    )))
}

pub fn parse(text: Option<&str>, toml: bool) -> io::Result<Doc> {
    let text = text.filter(|t| !t.trim().is_empty());
    if toml {
        let doc = text.unwrap_or("").parse::<DocumentMut>();
        return doc.map(Doc::Toml).or_else(|e| unsafe_edit(e.message()));
    }
    let v = match text {
        Some(t) => serde_json::from_str(t).or_else(|e| unsafe_edit(&e.to_string()))?,
        None => Value::Object(Map::new()),
    };
    if !v.is_object() {
        return unsafe_edit("it isn't a JSON object");
    }
    Ok(Doc::Json(v))
}

pub fn render(doc: &Doc, was: Option<&str>) -> String {
    match doc {
        Doc::Toml(d) => d.to_string(),
        Doc::Json(v) => {
            let mut out = serde_json::to_string_pretty(v).unwrap_or_default();
            if was.is_some_and(|t| t.ends_with('\n')) {
                out.push('\n');
            }
            out
        }
    }
}

/// The value at `key`, None when it or a table on the way is missing.
pub fn get(doc: &Doc, key: &[String]) -> io::Result<Option<Value>> {
    let (last, path) = key.split_last().expect("a key path");
    match doc {
        Doc::Json(v) => Ok(path
            .iter()
            .try_fold(v, |v, k| v.get(k))
            .and_then(|v| v.get(last))
            .cloned()),
        Doc::Toml(d) => {
            let mut table = d.as_table() as &dyn toml_edit::TableLike;
            for k in path {
                match table.get(k).and_then(Item::as_table_like) {
                    Some(t) => table = t,
                    None => return Ok(None),
                }
            }
            let Some(item) = table.get(last) else {
                return Ok(None);
            };
            let v = item.as_value();
            match v.and_then(|v| v.as_str().map(Value::from).or(v.as_bool().map(Value::from))) {
                Some(v) => Ok(Some(v)),
                None => match v.and_then(toml_edit::Value::as_integer) {
                    Some(i) => Ok(Some(i.into())),
                    None => unsafe_edit("the key holds a value Brigadier can't put back"),
                },
            }
        }
    }
}

/// Sets `key` to `v`, making the tables on the way; returns how many it made.
pub fn set(doc: &mut Doc, key: &[String], v: &Value) -> io::Result<usize> {
    let (last, path) = key.split_last().expect("a key path");
    let mut made = 0;
    match doc {
        Doc::Json(root) => {
            let mut obj = root;
            for k in path {
                let map = obj.as_object_mut().expect("an object");
                if !map.contains_key(k) {
                    map.insert(k.clone(), Value::Object(Map::new()));
                    made += 1;
                }
                obj = map.get_mut(k).expect("just made");
                if !obj.is_object() {
                    return unsafe_edit(&format!("\"{k}\" isn't an object"));
                }
            }
            obj.as_object_mut()
                .expect("an object")
                .insert(last.clone(), v.clone());
        }
        Doc::Toml(d) => {
            let mut item = d.as_item_mut();
            for (i, k) in path.iter().enumerate() {
                if item.as_table_like().is_some_and(|t| t.get(k).is_none()) {
                    let Some(t) = item.as_table_mut() else {
                        return unsafe_edit("a table on the way is written inline");
                    };
                    // As the CLI writes it: `[a."b"]` alone, its outer tables implicit.
                    let mut new = Table::new();
                    new.set_implicit(i + 1 < path.len());
                    t.insert(k, Item::Table(new));
                    made += 1;
                }
                item = match item.as_table_like_mut().and_then(|t| t.get_mut(k)) {
                    Some(next) if next.is_table_like() => next,
                    _ => return unsafe_edit(&format!("\"{k}\" isn't a table")),
                };
            }
            let table = item.as_table_like_mut().expect("a table");
            let mut new = match v {
                Value::String(s) => toml_edit::Value::from(s.as_str()),
                Value::Bool(b) => toml_edit::Value::from(*b),
                Value::Number(n) if n.is_i64() => toml_edit::Value::from(n.as_i64().unwrap_or(0)),
                _ => return unsafe_edit("Brigadier can't write that value"),
            };
            match table.get_mut(last).and_then(Item::as_value_mut) {
                // Its comments and spacing stay.
                Some(old) => {
                    *new.decor_mut() = old.decor().clone();
                    *old = new;
                }
                None => {
                    table.insert(last, Item::Value(new));
                }
            }
        }
    }
    Ok(made)
}

/// Removes `key`, then each of the `made` tables above it that's left empty, innermost first.
pub fn unset(doc: &mut Doc, key: &[String], made: usize) -> io::Result<()> {
    for depth in (key.len() - 1 - made..key.len()).rev() {
        let (last, path) = key[..=depth].split_last().expect("a key path");
        let last_one = depth + 1 == key.len();
        match doc {
            Doc::Json(root) => {
                let parent = path.iter().try_fold(&mut *root, |v, k| v.get_mut(k));
                let Some(map) = parent.and_then(Value::as_object_mut) else {
                    return Ok(());
                };
                let empty = map
                    .get(last)
                    .is_some_and(|v| v.as_object().is_some_and(Map::is_empty));
                if last_one || empty {
                    map.shift_remove(last);
                }
            }
            Doc::Toml(d) => {
                let mut table = d.as_table_mut() as &mut dyn toml_edit::TableLike;
                for k in path {
                    match table.get_mut(k).and_then(Item::as_table_like_mut) {
                        Some(t) => table = t,
                        None => return Ok(()),
                    }
                }
                let empty = table
                    .get(last)
                    .and_then(Item::as_table_like)
                    .is_some_and(|t| t.is_empty());
                if last_one || empty {
                    table.remove(last);
                }
            }
        }
    }
    Ok(())
}
