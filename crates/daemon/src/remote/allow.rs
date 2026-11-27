//! What a phone may send (remote design §4.1, the one table): each request is rebuilt here from
//! its allowed fields only, or refused with "Not from the phone". The result is a [`Checked`],
//! which only this file can make and which is the only thing the bridge writes to a phone's
//! `ops::serve` [beat-competitors D51]. Rows needing a fresh Face ID signature carry what it must
//! name (`fresh`); the rows of M3c are refused until it lands.

use super::Host;
use super::fresh::{self, Need};
use serde_json::{Map, Value, json};
use std::path::Path;

pub(super) const REFUSED: &str = "Not from the phone";

/// A request that passed the table, as it is sent on. Its field is private: nothing else builds one.
pub(super) struct Checked(Value, Option<Need>);

impl Checked {
    pub(super) fn value(&self) -> &Value {
        &self.0
    }

    /// The fresh signature this command needs, if any (§4.2).
    pub(super) fn need(&self) -> Option<&Need> {
        self.1.as_ref()
    }
}

/// What the table needs about the device and the Mac's own rows.
pub(super) struct Ctx<'a> {
    pub(super) device: &'a str,
    pub(super) host: &'a Host,
    pub(super) data: &'a Path,
}

type Fail = &'static str;

impl Ctx<'_> {
    /// A session the daemon lists to this device: one of its own rows, never a field's say-so.
    pub(super) fn visible(&self, id: &str) -> Result<Value, Fail> {
        plain(id)?;
        (self.host.row)(id).ok_or(REFUSED)
    }

    fn worker_of(&self, worker: &str, lead: &str) -> Result<(), Fail> {
        let row = self.visible(worker)?;
        (row["worker"]["parent"] == lead)
            .then_some(())
            .ok_or(REFUSED)
    }

    fn project(&self, p: &str) -> Result<(), Fail> {
        plain(p)?;
        (self.host.project)(p).then_some(()).ok_or(REFUSED)
    }
}

fn plain(id: &str) -> Result<(), Fail> {
    brigadier_core::check_id(id).map_err(|_| REFUSED)
}

/// A command's free text. The CLI finds a flag anywhere in its arguments (`crates/cli/src/lib.rs`
/// `flag`, `has`), so text that is one, as `queue <id> add --shell`, would pass as that flag.
fn words(s: &str) -> Result<(), Fail> {
    (!s.starts_with("--")).then_some(()).ok_or(REFUSED)
}

fn number(s: &str) -> Result<(), Fail> {
    s.parse::<u64>().map(|_| ()).map_err(|_| REFUSED)
}

fn ids(list: &str) -> Result<(), Fail> {
    list.split(',').try_for_each(plain)
}

fn json_of(s: &str) -> Result<Value, Fail> {
    serde_json::from_str(s).map_err(|_| REFUSED)
}

/// A request frame from a signed-in phone, after `hello`.
pub(super) fn check(cx: &Ctx, req: &Value) -> Result<Checked, Fail> {
    let op = req["op"].as_str().unwrap_or("");
    let mut out = Map::new();
    let mut need = None;
    out.insert("id".into(), req["id"].as_u64().ok_or(REFUSED)?.into());
    out.insert("op".into(), op.into());
    let mut copy = |key: &str, ok: &dyn Fn(&Value) -> bool| -> Result<(), Fail> {
        match &req[key] {
            Value::Null => Ok(()),
            v if ok(v) => {
                out.insert(key.into(), v.clone());
                Ok(())
            }
            _ => Err(REFUSED),
        }
    };
    let num = |v: &Value| v.is_u64();
    let text = |v: &Value| v.is_string();
    let fields: &[&str] = match op {
        "subscribe" => &[],
        "thread" | "peek" => {
            copy("from", &num)?;
            copy("to", &num)?;
            &["from", "to"]
        }
        "thread_older" | "thread_around" | "thread_find" => {
            for key in ["before", "after", "n", "limit"] {
                copy(key, &num)?;
            }
            copy("query", &text)?;
            &["before", "after", "n", "limit", "query"]
        }
        // The `@` menu: chats, workers, tabs, notes and plugins. Its file and folder results are
        // taken out of the reply (`bridge`): inside the project from step 2, outside power (e).
        "mention" => {
            copy("q", &text)?;
            &["q", "owner"]
        }
        // The Review tab's status watch of a session's own checkout; never a project's.
        "git" => &[],
        "run" => {
            let args: Vec<String> = (req["args"].as_array().ok_or(REFUSED)?.iter())
                .map(|a| a.as_str().map(String::from).ok_or(REFUSED))
                .collect::<Result<_, _>>()?;
            out.insert("args".into(), json!(run(cx, args, true, &mut need)?));
            &["args", "act"]
        }
        _ => return Err(REFUSED),
    };
    // The session a reading op names, visible to this device; `mention` names it `owner`.
    let session = match op {
        "subscribe" | "run" => None,
        "mention" => Some(("owner", &req["owner"])),
        _ => Some(("session", &req["session"])),
    };
    if let Some((key, id)) = session {
        cx.visible(id.as_str().ok_or(REFUSED)?)?;
        out.insert(key.into(), id.clone());
    }
    let known = ["id", "op", "args", "session"];
    let keys = req.as_object().ok_or(REFUSED)?.keys();
    if keys
        .into_iter()
        .any(|k| !known.contains(&k.as_str()) && !fields.contains(&k.as_str()))
    {
        return Err(REFUSED);
    }
    Ok(Checked(Value::Object(out), need))
}

/// The flags after a command's positional words: each allowed one at most once, its value checked.
struct Flags<'a> {
    found: Vec<(&'a str, Option<&'a str>)>,
}

impl<'a> Flags<'a> {
    /// `spec` is each allowed flag and whether it takes a value.
    fn parse(rest: &'a [String], spec: &[(&str, bool)]) -> Result<Self, Fail> {
        let mut found = vec![];
        let mut at = 0;
        while at < rest.len() {
            let name = rest[at].as_str();
            let &(_, takes) = spec.iter().find(|(f, _)| *f == name).ok_or(REFUSED)?;
            if found.iter().any(|(f, _)| *f == name) {
                return Err(REFUSED);
            }
            let value = if takes {
                at += 1;
                Some(rest.get(at).ok_or(REFUSED)?.as_str())
            } else {
                None
            };
            found.push((name, value));
            at += 1;
        }
        Ok(Self { found })
    }

    fn has(&self, name: &str) -> bool {
        self.found.iter().any(|(f, _)| *f == name)
    }

    fn get(&self, name: &str) -> Option<&'a str> {
        self.found
            .iter()
            .find(|(f, _)| *f == name)
            .and_then(|(_, v)| *v)
    }
}

/// `--parts` (design §4.1 "The parts rule"): plain text, mentions of a visible chat, a note, a
/// worker of `session`, a tab or a plugin, images and pastes by attachment id, command chips.
/// A file or folder mention carries a Mac path: refused (power (e), step 2).
fn parts(cx: &Ctx, session: Option<&str>, raw: &str) -> Result<(), Fail> {
    let parts = json_of(raw)?;
    if parts.is_null() {
        return Ok(());
    }
    for part in parts["parts"].as_array().into_iter().flatten() {
        let id = part["id"].as_str().unwrap_or("");
        match (part["kind"].as_str(), part["type"].as_str()) {
            (None, _) if part.is_string() => {}
            (Some("mention"), Some("chat")) => drop(cx.visible(id)?),
            (Some("mention"), Some("worker")) => cx.worker_of(id, session.ok_or(REFUSED)?)?,
            (Some("mention"), Some("note" | "tab" | "plugin")) => {}
            (Some("image" | "paste"), _) => plain(part["attachmentId"].as_str().ok_or(REFUSED)?)?,
            (Some("command"), _) => {}
            _ => return Err(REFUSED),
        }
    }
    for id in parts["attachmentIds"].as_array().into_iter().flatten() {
        plain(id.as_str().ok_or(REFUSED)?)?;
    }
    Ok(())
}

/// The draft a command names: a visible session, `@home`, or `@home:<known project>`.
fn draft_target(cx: &Ctx, target: &str) -> Result<(), Fail> {
    match target.strip_prefix("@home") {
        Some("") => Ok(()),
        Some(rest) => cx.project(rest.strip_prefix(':').ok_or(REFUSED)?),
        None => cx.visible(target).map(drop),
    }
}

/// A `run` command as the phone may send it (§4.1 "Acting"), with `--slot <device>` added last
/// where the device's own draft slot applies (lane D, `crates/cli/src/attach/slot.rs`). `top` is
/// false for the command a `draft adopt` keeps to try again, which itself passes this table.
fn run(
    cx: &Ctx,
    mut args: Vec<String>,
    top: bool,
    need: &mut Option<Need>,
) -> Result<Vec<String>, Fail> {
    let a = |i: usize| args.get(i).map(String::as_str).ok_or(REFUSED);
    let n = args.len();
    let rest = |from: usize| args.get(from..).unwrap_or(&[]);
    let mut slot = false;
    match a(0)? {
        "seen" if n == 3 => {
            cx.visible(a(1)?)?;
            number(a(2)?)?;
        }
        "stop" if n == 2 => drop(cx.visible(a(1)?)?),
        "title" if n == 2 => words(a(1)?)?,
        "chips" if n == 2 => drop(cx.visible(a(1)?)?),
        "reconnect" if n == 3 && a(2)? == "--now" => drop(cx.visible(a(1)?)?),
        "rebirth" if n == 3 && a(2)? == "--go-on" => drop(cx.visible(a(1)?)?),
        "send" => {
            let id = a(1)?;
            cx.visible(id)?;
            words(a(2)?)?;
            let f = Flags::parse(rest(3), &SEND)?;
            plain(f.get("--cid").ok_or(REFUSED)?)?;
            send_flags(cx, id, &f)?;
            if let Some(from) = f.get("--from") {
                // Messaging a worker directly: `<id>` is a worker of the visible `--from`, as a steer.
                cx.worker_of(id, from)?;
                // Without the slot its files would come from the Mac's own draft: none, for now.
                let files = f.get("--parts").map(json_of).transpose()?.is_some_and(|p| {
                    p["attachmentIds"].as_array().is_some_and(|a| !a.is_empty())
                        || (p["parts"].as_array().into_iter().flatten())
                            .any(|x| matches!(x["kind"].as_str(), Some("image" | "paste")))
                });
                if files || !f.has("--steer") || f.has("--draft") {
                    return Err(REFUSED);
                }
            } else {
                slot = true;
            }
        }
        "queue" => {
            let id = a(1)?;
            cx.visible(id)?;
            match (a(2)?, n) {
                ("add", _) => {
                    words(a(3)?)?;
                    let f = Flags::parse(rest(4), &QUEUE_ADD)?;
                    plain(f.get("--qid").ok_or(REFUSED)?)?;
                    f.get("--at").map(number).transpose()?;
                    if let Some(w) = f.get("--to") {
                        cx.worker_of(w, id)?;
                    }
                    // `!`: power (a), the line shown whole on the phone and signed as it is.
                    if f.has("--shell") {
                        if f.has("--to") || f.has("--parts") || f.has("--chips") {
                            return Err(REFUSED);
                        }
                        *need = fresh::power("shell", &args);
                    }
                    send_flags(cx, id, &f)?;
                    slot = true;
                }
                ("remove" | "edit" | "steer", 4) => plain(a(3)?)?,
                ("move", 5) => {
                    plain(a(3)?)?;
                    number(a(4)?)?;
                }
                ("restore" | "resume", 3) => {}
                ("background", 4) => {
                    plain(a(3)?)?;
                    *need = fresh::power("shell", &args);
                }
                _ => return Err(REFUSED),
            }
        }
        "draft" => {
            draft_target(cx, a(1)?)?;
            slot = true;
            match a(2).ok() {
                None => {}
                Some("retry" | "drop") if n == 4 => plain(a(3)?)?,
                Some("adopt") => {
                    plain(a(3)?)?;
                    let f = Flags::parse(rest(4), &ADOPT)?;
                    let kind = f.get("--kind").ok_or(REFUSED)?;
                    let op: Vec<String> =
                        serde_json::from_str(f.get("--op").ok_or(REFUSED)?).map_err(|_| REFUSED)?;
                    // A kept command is tried again with no one to sign it: none that needs a signature.
                    let mut signed = None;
                    let kept = run(cx, op.clone(), false, &mut signed)?;
                    if !top
                        || signed.is_some()
                        || op.first().map(String::as_str) != Some(kind)
                        || kept != op
                    {
                        return Err(REFUSED);
                    }
                    json_of(f.get("--draft").ok_or(REFUSED)?)?;
                    f.get("--draft-rev").map(number).transpose()?;
                }
                Some(words) => {
                    json_of(words)
                        .or_else(|_| words.is_empty().then_some(Value::Null).ok_or(REFUSED))?;
                    let f = Flags::parse(rest(3), &[("--base", true), ("--took", true)])?;
                    f.get("--base").map(number).transpose()?;
                    f.get("--took").map(ids).transpose()?;
                }
            }
        }
        "models" => {
            let f = Flags::parse(
                rest(1),
                &[("--session", true), ("--project", true), ("--fresh", false)],
            )?;
            match (f.get("--session"), f.get("--project")) {
                (Some(s), None) => drop(cx.visible(s)?),
                (None, Some(p)) if !f.has("--fresh") => cx.project(p)?,
                (None, None) if !f.has("--fresh") => {}
                _ => return Err(REFUSED),
            }
        }
        "commands" => match a(1)? {
            "@home" => {
                let f = Flags::parse(rest(2), &[("--backend", true), ("--project", true)])?;
                plain(f.get("--backend").ok_or(REFUSED)?)?;
                f.get("--project").map(|p| cx.project(p)).transpose()?;
            }
            id if n == 2 => drop(cx.visible(id)?),
            _ => return Err(REFUSED),
        },
        "rewind" => {
            cx.visible(a(1)?)?;
            plain(a(2)?)?;
            let f = Flags::parse(
                rest(3),
                &[
                    ("--preview", false),
                    ("--op", true),
                    ("--restore", false),
                    ("--undo", false),
                ],
            )?;
            let preview = f.has("--preview") && f.found.len() == 1;
            let undo =
                f.has("--op") && !(f.has("--restore") && f.has("--undo")) && !f.has("--preview");
            if !preview && !undo {
                return Err(REFUSED);
            }
        }
        "shell" if n == 4 && matches!(a(2)?, "output" | "stop") => {
            cx.visible(a(1)?)?;
            plain(a(3)?)?;
        }
        "answer" | "level" | "overnight" => *need = fresh::row(cx, &args)?,
        "jobs" => {
            cx.visible(a(1)?)?;
            match (a(2)?, n) {
                ("history", 3) => {}
                ("stop", 5) => {
                    number(a(3)?)?;
                    number(a(4)?)?;
                }
                _ => return Err(REFUSED),
            }
        }
        _ => return Err(REFUSED),
    }
    if slot && top {
        args.extend(["--slot".into(), cx.device.into()]);
    }
    Ok(args)
}

const SEND: [(&str, bool); 8] = [
    ("--cid", true),
    ("--parts", true),
    ("--steer", false),
    ("--chips", true),
    ("--retry-of", true),
    ("--draft", true),
    ("--draft-rev", true),
    ("--from", true),
];
const QUEUE_ADD: [(&str, bool); 8] = [
    ("--shell", false),
    ("--qid", true),
    ("--at", true),
    ("--parts", true),
    ("--chips", true),
    ("--draft", true),
    ("--draft-rev", true),
    ("--to", true),
];
const ADOPT: [(&str, bool); 4] = [
    ("--kind", true),
    ("--op", true),
    ("--draft", true),
    ("--draft-rev", true),
];

/// The fields `send` and `queue add` share.
fn send_flags(cx: &Ctx, session: &str, f: &Flags) -> Result<(), Fail> {
    f.get("--parts")
        .map(|p| parts(cx, Some(session), p))
        .transpose()?;
    f.get("--chips").map(ids).transpose()?;
    f.get("--retry-of").map(plain).transpose()?;
    f.get("--draft").map(json_of).transpose()?;
    f.get("--draft-rev").map(number).transpose()?;
    if f.has("--draft-rev") && !f.has("--draft") {
        return Err(REFUSED);
    }
    Ok(())
}
