//! `brigadier git`: a checkout's status as the panel gets it, and with `--watch` what changes after,
//! one line each, from the same watch the daemon runs [D71]. `brigadier source`: what the panel and
//! the Review tab ask of it, its diffs, its moves and its files [D1035, D1036, D1043, D1103]. A
//! session's commits since its base with `git <id> --history`, and one commit's diff with
//! `--commit <sha> [--file <path>]` [D1041].

use super::{arg, flag, has};
use brigadier_core::git::change::{self, Move};
use brigadier_core::git::diff::{self, Scope};
use brigadier_core::git::{self, Status, Target, history, watch::Watch};
use serde_json::{Value, json};
use std::io::{self, Write};
use std::path::Path;
use std::sync::atomic::AtomicBool;
use std::sync::mpsc;

fn target(args: &[String]) -> io::Result<(Target<'_>, usize)> {
    Ok(match flag(args, "--project") {
        Some(project) => (Target::Project(project), 3),
        None => (Target::Session(arg(args, 1)?), 2),
    })
}

pub(super) fn run(data: &Path, args: &[String]) -> io::Result<Value> {
    let (target, _) = target(args)?;
    let checkout = git::checkout(data, &target)?;
    let never = AtomicBool::new(false);
    // A session's History and one commit's diff [D1035, D1041].
    if let Target::Session(id) = target {
        if has(args, "--history") {
            let dir = brigadier_core::session_dir(data, id);
            return Ok(json!({"ok": true, "history": history::history(&checkout, &dir, &never)?}));
        }
        if let Some(sha) = flag(args, "--commit") {
            return Ok(match flag(args, "--file") {
                Some(path) => {
                    json!({"ok": true, "contents": history::contents(&checkout, sha, path, &never)?})
                }
                None => json!({"ok": true, "review": history::commit(&checkout, sha, &never)?}),
            });
        }
    }
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

pub(super) fn source(data: &Path, args: &[String]) -> io::Result<Value> {
    let (target, at) = target(args)?;
    let checkout = git::checkout(data, &target)?;
    let stop = AtomicBool::new(false);
    let word = |i: usize| arg(args, at + i);
    let from = |i: usize| args.get(at + i).map(String::as_str).filter(|w| *w != "-");
    let done = json!({"ok": true});
    Ok(match word(0)? {
        "review" => {
            json!({"ok": true, "review": diff::list(&checkout, Scope::parse(word(1)?)?, &stop)?})
        }
        "review-file" => {
            let contents =
                diff::file(&checkout, Scope::parse(word(1)?)?, word(2)?, from(3), &stop)?;
            json!({"ok": true, "contents": contents})
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
        "file" => json!({"ok": true, "file": git::read_file(&checkout, word(1)?)?}),
        _ => return Err(io::Error::other(super::USAGE)),
    })
}
