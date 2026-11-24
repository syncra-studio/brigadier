//! A question's answers as its card sends them: a skipped one null, words alone as text, words with
//! images or files as a draft. The log keeps plain words, as it always has, the files beside them.

use super::{Message, compose_on, file_in, ids, is_image, sent, take};
use crate::Spec;
use serde_json::{Value, json};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

#[derive(Default)]
pub struct Answers {
    /// As the thread and the log have them, each image "[Image #n]" where it was.
    pub said: Vec<Value>,
    /// As the agent reads them, each image's path with its number.
    pub told: Vec<Value>,
    /// Each answer's files, Null for one of words alone.
    pub files: Vec<Value>,
    /// All of them as one message's draft, for what keeps a message's files; Null for words alone.
    pub parts: Value,
    /// Numbered over the whole round, in order.
    pub images: Vec<PathBuf>,
    /// How many images there are through each answer.
    through: Vec<usize>,
}

/// `given` as they go, their files taken into `spec`'s session. One whose file isn't there is refused.
pub fn answers(data: &Path, spec: &Spec, given: &[Value]) -> io::Result<Answers> {
    let mut out = Answers::default();
    let drafts: Vec<&Value> = given.iter().filter(|g| g.is_object()).collect();
    if !drafts.is_empty() {
        let all = joined(drafts.into_iter());
        take(data, &spec.dir, &all, None)?;
        let gone = |id: &String| file_in(&sent(&spec.dir), id).is_none();
        if ids(&all).iter().any(gone) {
            return Err(io::Error::other(
                "A file in this answer wasn't saved. Remove it and attach it again.",
            ));
        }
    }
    let placed: Vec<Value> = (given.iter())
        .map(|g| match g.is_object() {
            true => placed(&spec.dir, g),
            false => g.clone(),
        })
        .collect();
    let mut all: Vec<Value> = vec![];
    for each in &placed {
        let from = out.images.len();
        let (mut said, mut told, mut files) = (each.clone(), each.clone(), Value::Null);
        if each.is_object() {
            said = words(&spec.dir, each, from)?.into();
            let images = std::mem::take(&mut out.images);
            let m = compose_on(spec, "", each.clone(), None, images)?;
            (out.images, told) = (m.images, m.agent.into());
            files = m.parts["files"].clone();
            all.extend(files.as_array().into_iter().flatten().cloned());
        }
        out.said.push(said);
        out.told.push(told);
        out.files.push(files);
        out.through.push(out.images.len());
    }
    if out.filed() {
        out.parts = joined(placed.iter().filter(|p| p.is_object()));
        out.parts["files"] = all.into();
    }
    Ok(out)
}

/// Drafts as one message's.
fn joined<'a>(drafts: impl Iterator<Item = &'a Value> + Clone) -> Value {
    let all = |k: &str| -> Value {
        (drafts.clone())
            .flat_map(|d| d[k].as_array().cloned().unwrap_or_default())
            .collect()
    };
    json!({"parts": all("parts"), "attachmentIds": all("attachmentIds")})
}

impl Answers {
    /// A plain message that answers a question, as its one answer.
    pub fn of(spec: &Spec, text: &str, parts: &Value) -> io::Result<Self> {
        let m = match parts.is_null() {
            true => Message::plain(text),
            false => compose_on(spec, text, parts.clone(), None, vec![])?,
        };
        let said = match parts.is_null() {
            true => text.into(),
            false => words(&spec.dir, parts, 0)?,
        };
        Ok(Answers {
            said: vec![said.into()],
            told: vec![m.agent.into()],
            files: vec![m.parts["files"].clone()],
            through: vec![m.images.len()],
            parts: m.parts,
            images: m.images,
        })
    }

    /// Whether any file came with them.
    pub fn filed(&self) -> bool {
        self.files.iter().any(|f| !f.is_null())
    }

    /// What goes with the images themselves, which no agent's answer carries: whose each is.
    pub fn beside(&self, items: &Value) -> Option<String> {
        let mut from = 0;
        let mut lines = vec![];
        for (at, &to) in self.through.iter().enumerate() {
            let names: Vec<String> = (from..to).map(|n| format!("Image #{}", n + 1)).collect();
            from = to;
            if names.is_empty() {
                continue;
            }
            let round = self.through.len() == 1 && !items[1].is_null();
            let q = items[at]["text"].as_str().filter(|_| !round);
            let q = q.map_or(String::new(), |q| format!(" to \"{q}\""));
            lines.push(format!("[In the user's answer{q}: {}]", names.join(", ")));
        }
        (!lines.is_empty()).then(|| lines.join("\n"))
    }
}

/// `draft` with the images beside its text at the text's end, so each is numbered there.
fn placed(dir: &Path, draft: &Value) -> Value {
    let mut parts = draft["parts"].as_array().cloned().unwrap_or_default();
    let tiles = draft["attachmentIds"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let image = |id: &Value| {
        let file = id.as_str().and_then(|id| file_in(&sent(dir), id));
        file.is_some_and(|f| is_image(&f))
    };
    let (images, tiles): (Vec<Value>, Vec<Value>) = tiles.into_iter().partition(image);
    for id in images {
        let spaced = |p: &Value| p.as_str().is_some_and(|t| t.ends_with(char::is_whitespace));
        if parts.last().is_some_and(|p| !spaced(p)) {
            parts.push(" ".into());
        }
        parts.push(json!({"kind": "image", "attachmentId": id}));
    }
    json!({"parts": parts, "attachmentIds": tiles})
}

/// A draft's words for the thread: its chips by their names, `from` images before its first.
fn words(dir: &Path, draft: &Value, from: usize) -> io::Result<String> {
    let (mut out, mut n) = (String::new(), from);
    let file = |id: &Value| id.as_str().and_then(|id| file_in(&sent(dir), id));
    for part in draft["parts"].as_array().into_iter().flatten() {
        match (part["kind"].as_str(), file(&part["attachmentId"])) {
            (Some("image"), Some(_)) => {
                n += 1;
                out += &format!("[Image #{n}]");
            }
            (Some("paste"), Some(path)) => out += &fs::read_to_string(path)?,
            (None, _) => out += part.as_str().unwrap_or(""),
            _ => out += part["label"].as_str().unwrap_or(""),
        }
    }
    for path in (draft["attachmentIds"].as_array().into_iter().flatten()).filter_map(file) {
        if !out.is_empty() && !out.ends_with(char::is_whitespace) {
            out += " ";
        }
        out += &format!(
            "[{}]",
            path.file_name().unwrap_or_default().to_string_lossy()
        );
    }
    Ok(out)
}
