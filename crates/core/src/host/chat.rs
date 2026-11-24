//! A folder chat's PRs [D494, D544]: those its own commands looked at in detail, kept in its own
//! `prs.json`, and each repository it claimed's, kept beside the claim; its workers' never.

use super::github::{HOST, picked};
use super::prs::{kept, mark, sort};
use super::touched::{ran_in, touched};
use super::{Kind, Pr, Repo, gh, hosted, slug};
use crate::{folder, git, load};
use serde_json::{Value, json};
use std::cmp::Reverse;
use std::fs;
use std::path::Path;
use std::sync::atomic::AtomicBool;

/// The watch's read of the PRs a folder chat's own commands looked at, in any repository on its
/// server, named by the command: what `prs.json` now holds, or None for any other session, with no
/// repository on GitHub, or before any such command.
// shortcut: one server (github.com where a repository is on it) and one account that reads the
// folder's repositories there; ask per server, or per account, when a folder spans several.
pub fn chat(data: &Path, id: &str) -> Option<Value> {
    let spec = load(data, id).ok()?;
    let project = folder::of(&spec)?;
    let home = Path::new(&project.folder);
    // One at a time, only as far as needed: a folder may hold hundreds.
    let repos = || {
        (folder::repos(home).into_iter())
            .filter_map(|r| Some(hosted(git::at(data, &home.join(r)).ok()?)?.1))
            .filter(|r| r.kind == Kind::GitHub && slug(&r.path))
    };
    let server = repos()
        .find(|r| r.host == HOST)
        .or_else(|| repos().next())?;
    // A bare number's: the repository its command says it ran in, the folder's or the chat's copy.
    let own = |input: &str| {
        let at = fs::canonicalize(ran_in(input)?).ok()?;
        let ours = [home, Path::new(&spec.cwd)];
        (ours
            .iter()
            .any(|h| fs::canonicalize(h).is_ok_and(|h| at.starts_with(h))))
        .then_some(())?;
        let checkout = git::at(data, &at).ok()?;
        let remotes = git::read(&at, &["remote"], &AtomicBool::new(false)).ok()?;
        let (_, repo) = hosted(checkout)?;
        // With several remotes gh asks which one it is: that's never in the row.
        let one = String::from_utf8_lossy(&remotes).lines().count() == 1;
        (one && repo.host == server.host).then_some(Some(repo.path))
    };
    let found = touched(&spec.dir, &server.at(""), &own);
    if found.is_empty() && kept(&spec.dir).is_null() {
        return None;
    }
    // Read as an account that sees one of the folder's it looked at, else the folder's first.
    let named = |r: &Repo| {
        let mut all = found.iter().filter_map(|(f, _)| f.as_deref());
        r.host == server.host && all.any(|f| f.eq_ignore_ascii_case(&r.path))
    };
    let repo = repos().find(named).unwrap_or(server);
    let pr = Pr {
        id: id.into(),
        dir: spec.dir.clone(),
        account: picked(data, &project.id, Some(&repo)),
        ..super::write::page(data)
    };
    let one = pr.one();
    let _held = one.lock().unwrap_or_else(|e| e.into_inner());
    let gh = gh(&repo, pr.account.as_deref());
    let pr = Pr {
        repo: Some(repo),
        ..pr
    };
    Some(pr.keep(match gh {
        Some(gh) => pr.read(&gh, found),
        None => Err(super::NO_GH.into()),
    }))
}

/// Every PR a session's card lists: its kept ones (`prs.json`) and, in a folder chat, those of each
/// repository it claimed too, each once, as last read; why, of those that couldn't be.
pub fn listed(dir: &Path) -> Value {
    let own = kept(dir);
    let claims: Vec<Value> = (folder::claims(dir).iter())
        .map(|(_, rec)| kept(rec))
        .filter(|k| !k.is_null())
        .collect();
    if claims.is_empty() {
        return own;
    }
    let mut lists: Vec<Value> = std::iter::once(own)
        .filter(|k| !k.is_null())
        .chain(claims)
        .collect();
    let failed = lists.iter().find(|k| !k["error"].is_null());
    let of = failed.unwrap_or(&lists[0]).clone();
    lists.sort_by_key(|k| Reverse(k["okAt"].as_i64()));
    let mut rows: Vec<Value> = (lists.iter())
        .flat_map(|k| k["prs"].as_array().into_iter().flatten())
        .map(|row| mark(row.clone(), &unnamed(row)))
        .collect();
    sort(&mut rows);
    json!({"okAt": of["okAt"], "error": of["error"], "head": null, "prs": rows})
}

/// No repository, on a row's own server: marked by it, the row names its own.
fn unnamed(row: &Value) -> Repo {
    let url = row["url"].as_str().unwrap_or("");
    let host = url.split('/').nth(2).unwrap_or("");
    Repo {
        kind: Kind::GitHub,
        host: host.into(),
        path: String::new(),
    }
}
