//! The branches with work that never landed which a delete asks about [D181]: the session's own, and a
//! folder chat's one per repository it claimed [D494].

use crate::{Spec, load, share, worktrees};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::io;
use std::path::{Path, PathBuf};

/// Which of them go: all or none, or those in these repositories of a folder chat, "" for a session's
/// own.
#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(untagged)]
pub enum Chosen {
    All(bool),
    In(Vec<String>),
}

impl Chosen {
    /// As recorded; none that can't be read.
    pub fn of(v: &Value) -> Chosen {
        serde_json::from_value(v.clone()).unwrap_or(Chosen::All(false))
    }

    pub fn takes(&self, repo: &str) -> bool {
        match self {
            Chosen::All(all) => *all,
            Chosen::In(repos) => repos.iter().any(|r| r == repo),
        }
    }
}

/// What deleting `ids` together asks: `branches` it may take, each with its repository in a folder
/// chat; those `kept` whatever is chosen, and why [D703]; and the folders that stay (`stays`), with who
/// still works `by` there [D1080].
pub fn branches(data: &Path, ids: &[String]) -> io::Result<Value> {
    let mut out = json!({"branches": [], "kept": [], "stays": []});
    let mut seen = vec![];
    // Read at once, then told in order: a folder two of them share is asked about once.
    for (rec, part, found) in crate::at_once(ids, |id| asks(data, ids, id))
        .into_iter()
        .flatten()
    {
        if part != "stays" && seen.contains(&rec) {
            continue;
        }
        if let Some(found) = found? {
            out[part].as_array_mut().unwrap().push(found);
        }
        if part != "stays" {
            seen.push(rec);
        }
    }
    Ok(out)
}

/// One of `ids`' asks, by the record of each folder it works in: the part it goes in and what it
/// says, if anything.
fn asks(
    data: &Path,
    ids: &[String],
    id: &str,
) -> Vec<(PathBuf, &'static str, io::Result<Option<Value>>)> {
    let Ok(spec) = load(data, id) else {
        return vec![];
    };
    let own = share::holder(data, &spec).unwrap_or_else(|| spec.clone());
    let claims = crate::folder::claims(&spec.dir).into_iter();
    let recs: Vec<(String, PathBuf, PathBuf)> = claims
        .filter_map(|(name, rec)| worktrees::folder(&rec).map(|f| (name, rec, f)))
        .chain([(String::new(), own.dir, PathBuf::from(&spec.cwd))])
        .collect();
    let mut out = vec![];
    for (repo, rec, folder) in recs {
        let mut users: Vec<Spec> = share::in_folder(data, &folder, Some(id));
        users.retain(|u| !ids.contains(&u.id));
        if let Some(by) = users.first() {
            out.push((
                rec,
                "stays",
                Ok(Some(json!({"id": id, "repo": repo, "by": by.id}))),
            ));
            continue;
        }
        let found = worktrees::own_unlanded(&rec).and_then(|branch| match branch {
            None => Ok(None),
            Some(branch) => Ok(Some(match worktrees::kept(&rec)? {
                Some((branch, why)) => {
                    ("kept", json!({"repo": repo, "branch": branch, "why": why}))
                }
                None => (
                    "branches",
                    json!({"id": id, "title": share::title(&spec),
                    "repo": repo, "branch": branch}),
                ),
            })),
        });
        let part = match &found {
            Ok(Some((part, _))) => *part,
            _ => "branches",
        };
        out.push((rec, part, found.map(|f| f.map(|(_, v)| v))));
    }
    out
}
