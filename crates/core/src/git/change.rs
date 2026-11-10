//! Stage, unstage and discard by file, and stage, unstage and revert by hunk [D1043, D1103]: the
//! one set of moves Source's menus and Review's headers both use. Each runs under the checkout's
//! lock, names only paths inside it, and changes only what its confirm says:
//!
//! - Stage: the index takes the file's (or the hunk's) lines from the files. The files stay.
//! - Unstage: the index goes back to HEAD for them. The files stay.
//! - Discard unstaged (Unstaged scope): the files go back to the index; an untracked file is deleted.
//! - Discard staged or uncommitted: index and files go back to HEAD, so its unstaged changes go too;
//!   a file new since HEAD is deleted.
//! - Revert hunk: in Unstaged, its lines go back to the index in the files. In Staged and
//!   Uncommitted, its lines go back to HEAD in both the index and the files ("staged or not"). The
//!   file's other hunks stay as they were.
//!
//! A hunk is named by the id the Review tab got; one whose lines changed since is refused, so a
//! move never lands on lines the user didn't see [D30].

use super::diff::{Hunk, Patch, Scope, ids, patch, patch_of};
use super::{Checkout, err, inside, lock, read};
use std::io::{self, Write};
use std::process::Stdio;
use std::sync::atomic::AtomicBool;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Move {
    Stage,
    Unstage,
    /// Discard for a file, Revert for a hunk.
    Revert,
}

impl Move {
    pub fn parse(word: &str) -> io::Result<Move> {
        match word {
            "stage" => Ok(Move::Stage),
            "unstage" => Ok(Move::Unstage),
            "discard" | "revert" => Ok(Move::Revert),
            _ => err(format!("no move {word:?}")),
        }
    }
}

/// A git that changes the checkout, given `input` on its stdin.
fn write(checkout: &Checkout, args: &[&str], input: Option<&str>) -> io::Result<()> {
    let mut command = crate::worktrees::command(&checkout.root);
    command
        .env("GIT_LITERAL_PATHSPECS", "1")
        .args(args)
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    let mut child = command.spawn()?;
    if let (Some(input), Some(mut stdin)) = (input, child.stdin.take()) {
        stdin.write_all(input.as_bytes())?;
    }
    let out = child.wait_with_output()?;
    if !out.status.success() {
        let why = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return err(format!("git {}: {why}", args.first().unwrap_or(&"")));
    }
    Ok(())
}

/// What a path is now: in HEAD, in the index, untracked.
struct Known {
    in_head: bool,
    in_index: bool,
}

fn known(checkout: &Checkout, path: &str, stop: &AtomicBool) -> io::Result<Known> {
    let head = read(
        &checkout.root,
        &["ls-tree", "--name-only", "-z", "HEAD", "--", path],
        stop,
    );
    let index = read(&checkout.root, &["ls-files", "-z", "--", path], stop)?;
    Ok(Known {
        in_head: head.is_ok_and(|out| !out.is_empty()),
        in_index: !index.is_empty(),
    })
}

fn delete(checkout: &Checkout, path: &str) -> io::Result<()> {
    match std::fs::remove_file(inside(checkout, path)?) {
        Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e),
        _ => Ok(()),
    }
}

/// Moves whole files, the paths the user's confirm named and no others.
pub fn files(
    checkout: &Checkout,
    scope: Scope,
    action: Move,
    paths: &[String],
    stop: &AtomicBool,
) -> io::Result<()> {
    for path in paths {
        inside(checkout, path)?;
    }
    let _exclusive = lock(checkout, true, stop)?;
    let list: Vec<&str> = paths.iter().map(String::as_str).collect();
    fn with<'a>(first: &[&'a str], list: &[&'a str]) -> Vec<&'a str> {
        first
            .iter()
            .copied()
            .chain(["--"])
            .chain(list.iter().copied())
            .collect()
    }
    match action {
        Move::Stage => write(checkout, &with(&["add", "-A"], &list), None),
        Move::Unstage => {
            let head = read(
                &checkout.root,
                &["rev-parse", "-q", "--verify", "HEAD"],
                stop,
            )
            .is_ok();
            match head {
                true => write(checkout, &with(&["reset", "-q", "HEAD"], &list), None),
                false => write(
                    checkout,
                    &with(&["rm", "-q", "--cached", "-r", "--ignore-unmatch"], &list),
                    None,
                ),
            }
        }
        Move::Revert => {
            for path in paths {
                let now = known(checkout, path, stop)?;
                match (scope, now.in_index, now.in_head) {
                    // Untracked: nothing git can bring back.
                    (Scope::Unstaged, false, _) | (_, false, false) => delete(checkout, path)?,
                    (Scope::Unstaged, true, _) => {
                        write(checkout, &["checkout", "-q", "--", path], None)?
                    }
                    // Back to HEAD in both, a staged delete (a rename's old path) included.
                    (_, _, true) => write(checkout, &["checkout", "-q", "HEAD", "--", path], None)?,
                    // New since HEAD: out of the index and gone.
                    (_, true, false) => {
                        write(checkout, &["rm", "-q", "--cached", "--", path], None)?;
                        delete(checkout, path)?;
                    }
                }
            }
            Ok(())
        }
    }
}

fn apply(checkout: &Checkout, patch: &str, flags: &[&str]) -> io::Result<()> {
    let mut args = vec!["apply", "--unidiff-zero", "--whitespace=nowarn"];
    args.extend(flags);
    write(checkout, &args, Some(patch))
}

/// The hunk the user saw, found again by its id.
fn find(
    checkout: &Checkout,
    scope: Scope,
    path: &str,
    from: Option<&str>,
    id: &str,
    stop: &AtomicBool,
) -> io::Result<(Patch, Hunk)> {
    let patch = patch(checkout, scope, path, from, 3, stop)?;
    let at = ids(scope, path, &patch.hunks)
        .iter()
        .position(|each| each == id);
    match at {
        Some(at) => {
            let hunk = patch.hunks[at].clone();
            Ok((patch, hunk))
        }
        None => err("This change is no longer there. Look at it again."),
    }
}

/// The bare changes of `scope` that meet `hunk`, as one patch, or None when none do.
fn meeting(
    checkout: &Checkout,
    scope: Scope,
    path: &str,
    hunk: &Hunk,
    old_side: bool,
    stop: &AtomicBool,
) -> io::Result<Option<String>> {
    let bare = patch_of(checkout, scope, path, stop)?;
    let picked: Vec<&Hunk> = (bare.hunks.iter())
        .filter(|h| {
            if old_side {
                h.meets_old(hunk)
            } else {
                h.meets_new(hunk)
            }
        })
        .collect();
    Ok((!picked.is_empty()).then(|| bare.with(&picked)))
}

/// Moves one hunk, as the module's head says.
pub fn hunk(
    checkout: &Checkout,
    scope: Scope,
    action: Move,
    path: &str,
    from: Option<&str>,
    id: &str,
    stop: &AtomicBool,
) -> io::Result<()> {
    inside(checkout, path)?;
    if let Some(from) = from {
        inside(checkout, from)?;
    }
    let _exclusive = lock(checkout, true, stop)?;
    let (patch, hunk) = find(checkout, scope, path, from, id, stop)?;
    // An untracked file is its one hunk: it moves as the file.
    if patch.head.is_empty() {
        drop(_exclusive);
        return files(checkout, scope, action, &[path.to_string()], stop);
    }
    let own = patch.with(&[&hunk]);
    match (scope, action) {
        (Scope::Unstaged, Move::Stage) => apply(checkout, &own, &["--cached"]),
        (Scope::Unstaged, Move::Revert) => apply(checkout, &own, &["-R"]),
        (Scope::Staged, Move::Unstage) => apply(checkout, &own, &["--cached", "-R"]),
        // Its lines in the files, which HEAD numbers the same as the hunk's old side.
        (Scope::Staged, Move::Revert) => {
            let files = meeting(checkout, Scope::Uncommitted, path, &hunk, true, stop)?;
            if let Some(files) = &files {
                apply(checkout, files, &["-R", "--check"])?;
            }
            apply(checkout, &own, &["--cached", "-R"])?;
            files.map_or(Ok(()), |files| apply(checkout, &files, &["-R"]))
        }
        // HEAD to the files: the index's part numbers its old side as HEAD does, the files' part
        // its new side as the files do.
        (Scope::Uncommitted, Move::Stage) => {
            match meeting(checkout, Scope::Unstaged, path, &hunk, false, stop)? {
                Some(unstaged) => apply(checkout, &unstaged, &["--cached"]),
                None => Ok(()),
            }
        }
        (Scope::Uncommitted, Move::Unstage) => {
            match meeting(checkout, Scope::Staged, path, &hunk, true, stop)? {
                Some(staged) => apply(checkout, &staged, &["--cached", "-R"]),
                None => Ok(()),
            }
        }
        (Scope::Uncommitted, Move::Revert) => {
            let staged = meeting(checkout, Scope::Staged, path, &hunk, true, stop)?;
            if let Some(staged) = &staged {
                apply(checkout, staged, &["--cached", "-R", "--check"])?;
            }
            apply(checkout, &own, &["-R"])?;
            staged.map_or(Ok(()), |staged| {
                apply(checkout, &staged, &["--cached", "-R"])
            })
        }
        (Scope::Staged, Move::Stage) | (Scope::Unstaged, Move::Unstage) => {
            err("That change is already there.")
        }
    }
}
