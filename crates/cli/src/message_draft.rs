//! The background commit draft, pinned to exactly what will be committed [D1212].

use super::commit::{author, commit_prompt, written};
use brigadier_core::git::commit::{self, Prepared};
use brigadier_core::git::{Checkout, Target};
use brigadier_core::{write_atomic, writer};
use brigadier_frames::log::now_ms;
use serde_json::{Value, json};
use std::fs::{self, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;

fn path(data: &Path, target: &Target) -> Option<PathBuf> {
    Some(writer::home(&author(data, target)?.0.dir).join("commit-draft.json"))
}

fn read(path: &Path) -> Value {
    fs::read(path)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or(Value::Null)
}

fn matches(draft: &Value, checkout: &Checkout, prepared: &Prepared, all: bool) -> bool {
    draft["root"] == checkout.root.to_string_lossy().as_ref()
        && draft["head"] == json!(prepared.head)
        && draft["tree"] == prepared.tree
        && draft["all"] == all
}

/// Only the message for this exact HEAD and index/whole-folder tree can be reused at click.
pub(super) fn cached(
    data: &Path,
    target: &Target,
    checkout: &Checkout,
    prepared: &Prepared,
    all: bool,
) -> Option<String> {
    let draft = read(&path(data, target)?);
    (matches(&draft, checkout, prepared, all) && draft["state"] == "ready")
        .then(|| {
            draft["text"]
                .as_str()
                .filter(|s| !s.trim().is_empty())
                .map(String::from)
        })
        .flatten()
}

/// The caller starts this request in the background after an idle checkout changes. No commit.
pub(super) fn run(
    data: &Path,
    target: &Target,
    checkout: &Checkout,
    all: bool,
    cached: bool,
    refresh: bool,
) -> io::Result<Value> {
    let reply = |draft: Value| json!({"ok": true, "draft": draft});
    let stop = AtomicBool::new(false);
    let prepared = match commit::prepare(checkout, all, &stop) {
        Ok(prepared) => prepared,
        Err(e) if e.to_string() == "There's nothing to commit." => {
            return Ok(reply(json!({"state": "empty", "text": null})));
        }
        Err(e) => return Err(e),
    };
    let Some(path) = path(data, target) else {
        return Ok(reply(
            json!({"state": "error", "text": null, "error": "No session here has an agent to write with."}),
        ));
    };
    fs::create_dir_all(path.parent().unwrap())?;
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(path.with_extension("lock"))?;
    let held = match lock.try_lock() {
        Ok(()) => true,
        Err(std::fs::TryLockError::WouldBlock) => false,
        Err(std::fs::TryLockError::Error(e)) => return Err(e),
    };
    let draft = read(&path);
    let same = matches(&draft, checkout, &prepared, all);
    if same && draft["state"] != "pending" && !refresh {
        return Ok(reply(draft));
    }
    if !held {
        return Ok(reply(json!({"state": "pending", "text": null})));
    }
    if cached {
        return Ok(reply(
            json!({"state": if draft.is_null() { "empty" } else { "stale" }, "text": null}),
        ));
    }
    let mut draft = json!({"state": "pending", "text": null, "head": prepared.head, "tree": prepared.tree,
        "root": checkout.root, "all": all, "atMs": now_ms()});
    write_atomic(&path, &serde_json::to_vec(&draft)?)?;
    match written(data, target, commit_prompt(checkout, &prepared, &stop)) {
        Ok(text) => {
            draft["state"] = "ready".into();
            draft["text"] = text.into();
        }
        Err(why) => {
            eprintln!("message draft: {why}");
            draft["state"] = "error".into();
            draft["error"] = "Couldn't write a message".into();
        }
    }
    draft["atMs"] = now_ms().into();
    write_atomic(&path, &serde_json::to_vec(&draft)?)?;
    Ok(reply(draft))
}
