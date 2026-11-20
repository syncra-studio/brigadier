//! Fork from a folder chat [D494, D3105]: the fork gets its own copy of each repo its source had
//! claimed by the answer, on a branch of its own, with that repo's files as they were at the answer
//! where a snapshot has them, else today's, said per repo, as a worktree fork does [D1068].

use crate::rewind::{Shot, Store, write_into};
use crate::{Spec, folder, projects, worktrees};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::{fs, io};

/// A source's claimed repo, and where a fork's copy gets its files: `snapshot`, as the answer ended;
/// `gone`, the same from today's base, its commit being gone; `none`, today's: no snapshot of the
/// answer, or the source gone; `later`, no copy: it was claimed after the answer.
pub struct Repo {
    name: String,
    rec: PathBuf,
    files: &'static str,
    shot: Option<Shot>,
}

/// The repos `src` claimed, for a fork from `at`; `order`, its turns oldest first. A claim whose
/// turn is unknown counts as made by then: never left out unsaid.
pub fn of(src: &Spec, gone: bool, order: &[String], at: &str) -> Vec<Repo> {
    let pos = |c: &str| order.iter().position(|o| o == c);
    let claims = folder::claims(&src.dir).into_iter();
    claims
        .map(|(name, rec)| {
            let store = Store::claim(&rec);
            let turn = folder::claimed_in(&rec).flatten();
            let later = (turn.and_then(|t| pos(&t)).zip(pos(at))).is_some_and(|(t, a)| t > a);
            let end = (store.as_ref().filter(|_| !gone)).and_then(|s| s.load(at)?.end);
            let (files, shot) = match end {
                None if later => ("later", None),
                None => ("none", None),
                Some(mut end) => {
                    let has = |h: &String| store.as_ref().is_some_and(|s| s.has(h));
                    end.head = end.head.filter(has);
                    let files = if end.head.is_some() {
                        "snapshot"
                    } else {
                        "gone"
                    };
                    (files, Some(end))
                }
            };
            Repo {
                name,
                rec,
                files,
                shot,
            }
        })
        .collect()
}

/// The worktree row's word for them all, each repo's, and what the fingerprint covers.
pub fn offer(repos: &[Repo], gone: bool) -> (&'static str, Value, String) {
    let word = match repos.iter().all(|r| r.files == "snapshot") {
        _ if gone => "sourceGone",
        true => "snapshot",
        false => "repos",
    };
    let each: Vec<Value> = (repos.iter())
        .map(|r| json!({"name": r.name, "files": r.files}))
        .collect();
    let print = (repos.iter())
        .map(|r| {
            let shot = r.shot.as_ref().map(|s| (&s.tree, &s.head));
            format!(":{}:{}:{shot:?}", r.name, r.files)
        })
        .collect();
    (word, each.into(), print)
}

/// Makes the fork `new`'s copy of each repo but those claimed later, in its own folder, each as
/// `folder::claim` makes one; the paths left as they were, as `<repo>/<path>`.
pub fn make(src: &Spec, new: &Spec, repos: Vec<Repo>, title: &str) -> io::Result<Vec<String>> {
    let gone = || io::Error::other("This chat's folder of repos is gone.");
    let project = folder::of(src).ok_or_else(gone)?;
    let home = PathBuf::from(&project.folder);
    fs::create_dir_all(&new.cwd)?;
    let mut left = vec![];
    for r in repos.into_iter().filter(|r| r.files != "later") {
        let missing = || io::Error::other(format!("The copy of {} is gone.", r.name));
        let store = Store::claim(&r.rec).ok_or_else(missing)?;
        let shot = match r.shot {
            Some(shot) => shot,
            None => store.capture()?,
        };
        let rec = folder::record(&new.dir, &r.name);
        let path = Path::new(&new.cwd).join(&r.name);
        fs::create_dir_all(&rec)?;
        fs::create_dir_all(path.parent().unwrap_or(&path))?;
        let repo = projects::Project {
            folder: home.join(&r.name).display().to_string(),
            ..project.clone()
        };
        let claimer = Spec {
            dir: rec.clone(),
            ..new.clone()
        };
        let base = worktrees::base(&r.rec);
        let head = shot.head.as_deref();
        worktrees::create(
            &claimer,
            &repo,
            base.as_deref(),
            head,
            title,
            Some(&path),
            None,
        )?;
        folder::mark(&rec, None)?;
        let kept = write_into(&store, &shot, &path)?;
        left.extend(kept.into_iter().map(|p| format!("{}/{p}", r.name)));
    }
    Ok(left)
}
