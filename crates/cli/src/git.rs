//! `brigadier git`: a checkout's status as the panel gets it, and with `--watch` what changes after,
//! one line each, from the same watch the daemon runs [D71]. `brigadier source`: what the panel and
//! the Review tab ask of it, its diffs, its moves and its files [D1035, D1036, D1043, D1103], and a
//! session's commits since its base and one commit's diff [D1041].

use super::{arg, has};
use brigadier_core::git::change::{self, Move};
use brigadier_core::git::diff::{self, Scope};
use brigadier_core::git::{
    self, Checkout, Status, Target, files, history, replace, search, watch::Watch,
};
use serde_json::{Value, json};
use std::io::{self, Write};
use std::path::Path;
use std::sync::atomic::AtomicBool;
use std::sync::mpsc;

/// Whose checkout: `--project <id>` only right after the command, so a search or a replacement
/// that reads `--project` stays text.
fn target(args: &[String]) -> io::Result<(Target<'_>, usize)> {
    Ok(match arg(args, 1)? {
        "--project" => (Target::Project(arg(args, 2)?), 3),
        session => (Target::Session(session), 2),
    })
}

pub(super) fn run(data: &Path, args: &[String]) -> io::Result<Value> {
    let (target, _) = target(args)?;
    let checkout = git::checkout(data, &target)?;
    let never = AtomicBool::new(false);
    if !has(args, "--watch") {
        let status = git::status(&checkout, &never)?;
        return Ok(json!({"ok": true, "n": 0, "git": status.json()}));
    }
    let (tx, rx) = mpsc::channel();
    let _watch = Watch::start(checkout, move |read| tx.send(read).is_ok());
    let (mut last, mut n) = (None::<Status>, 0u64);
    for read in rx {
        let status = read?;
        let line = match last.as_ref().and_then(|old| status.delta(old)) {
            Some(mut delta) => {
                n += 1;
                delta["n"] = n.into();
                delta
            }
            None => json!({"ok": true, "n": 0, "git": status.json()}),
        };
        let mut stdout = io::stdout().lock();
        writeln!(stdout, "{line}")?;
        stdout.flush()?;
        last = Some(status);
    }
    Ok(Value::Null)
}

fn parse(text: &str) -> io::Result<Value> {
    serde_json::from_str(text).map_err(io::Error::other)
}

/// A session's base, and where its branch left it: Branch since base's start. A project or a
/// Local checkout has none [D1035].
fn since(
    data: &Path,
    target: &Target,
    checkout: &Checkout,
    stop: &AtomicBool,
) -> io::Result<(String, String)> {
    let base = match target {
        Target::Session(id) => {
            brigadier_core::worktrees::base(&brigadier_core::session_dir(data, id))
        }
        Target::Project(_) => None,
    };
    let base =
        base.ok_or_else(|| io::Error::other("This checkout has no base to compare with."))?;
    let since = history::since(checkout, &base, stop)?;
    Ok((base, since))
}

pub(super) fn source(data: &Path, args: &[String]) -> io::Result<Value> {
    let (target, at) = target(args)?;
    let checkout = git::checkout(data, &target)?;
    let stop = AtomicBool::new(false);
    let word = |i: usize| arg(args, at + i);
    let from = |i: usize| args.get(at + i).map(String::as_str).filter(|w| *w != "-");
    let done = json!({"ok": true});
    Ok(match word(0)? {
        "review" if word(1)? == "branch" => {
            let (base, since) = since(data, &target, &checkout, &stop)?;
            let mut review = diff::list(&checkout, Scope::Branch(&since), &stop)?;
            (review["base"], review["since"]) = (base.into(), since.into());
            json!({"ok": true, "review": review})
        }
        "review" => {
            json!({"ok": true, "review": diff::list(&checkout, Scope::parse(word(1)?)?, &stop)?})
        }
        "review-file" if word(1)? == "branch" => {
            let (_, since) = since(data, &target, &checkout, &stop)?;
            let contents = diff::file(&checkout, Scope::Branch(&since), word(2)?, from(3), &stop)?;
            json!({"ok": true, "contents": contents})
        }
        "review-file" => {
            let contents =
                diff::file(&checkout, Scope::parse(word(1)?)?, word(2)?, from(3), &stop)?;
            json!({"ok": true, "contents": contents})
        }
        // Where the branch left its base now: Review looks again when it moves, which the watch doesn't see.
        "since" => {
            let (base, since) = since(data, &target, &checkout, &stop)?;
            json!({"ok": true, "base": base, "since": since})
        }
        // The Files tree, an ignored folder opened in it, and the filename search [D1002].
        "files" => json!({"ok": true, "list": files::list(&checkout, &stop)?}),
        "folder" => json!({"ok": true, "entries": files::folder(&checkout, word(1)?)?}),
        "find" => json!({"ok": true, "found": files::find(&checkout, word(1)?, &stop)?}),
        // Search in one answer (the app streams it through the daemon's `grep`), and Replace all [D1003].
        "search" => {
            let matcher = search::Matcher::new(&parse(word(1)?)?)?;
            let mut found = vec![];
            let done = search::search(&checkout, &matcher, &stop, |batch| {
                found.extend(batch);
                true
            })?;
            json!({"ok": true, "files": found, "done": done})
        }
        "replace" => {
            let matcher = search::Matcher::new(&parse(word(1)?)?)?;
            let files = parse(word(3)?)?;
            let keep = match target {
                Target::Session(id) => Some(brigadier_core::session_dir(data, id).join("replaced")),
                Target::Project(_) => None,
            };
            let files = files.as_array().map_or(&[][..], Vec::as_slice);
            let outcome =
                replace::replace(&checkout, &matcher, word(2)?, files, keep.as_deref(), &stop)?;
            json!({"ok": true, "outcome": outcome})
        }
        verb @ ("stage" | "unstage" | "discard") => {
            let paths = args.get(at + 2..).unwrap_or_default();
            if paths.is_empty() {
                return Err(io::Error::other(super::USAGE));
            }
            change::files(
                &checkout,
                Scope::parse(word(1)?)?,
                Move::parse(verb)?,
                paths,
                &stop,
            )?;
            done
        }
        "hunk" => {
            let (action, scope) = (Move::parse(word(1)?)?, Scope::parse(word(2)?)?);
            change::hunk(&checkout, scope, action, word(3)?, from(4), word(5)?, &stop)?;
            done
        }
        "file" => {
            let mut file = git::read_file(&checkout, word(1)?)?;
            file["ignored"] = files::ignored(&checkout, word(1)?).into();
            json!({"ok": true, "file": file})
        }
        // A session's History and one commit's diff; a project has no base [D1035, D1041].
        "history" => {
            let Target::Session(id) = target else {
                return Err(io::Error::other(super::USAGE));
            };
            let dir = brigadier_core::session_dir(data, id);
            json!({"ok": true, "history": history::history(&checkout, &dir, &stop)?})
        }
        "commit" => match args.get(at + 2) {
            Some(path) => {
                json!({"ok": true, "contents": history::contents(&checkout, word(1)?, path, from(3), &stop)?})
            }
            None => json!({"ok": true, "review": history::commit(&checkout, word(1)?, &stop)?}),
        },
        _ => return Err(io::Error::other(super::USAGE)),
    })
}
