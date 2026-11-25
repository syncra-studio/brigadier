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
    let (mut branches, mut kept, mut stays, mut seen) = (vec![], vec![], vec![], vec![]);
    for id in ids {
        let Ok(spec) = load(data, id) else { continue };
        let own = share::holder(data, &spec).unwrap_or_else(|| spec.clone());
        let claims = crate::folder::claims(&spec.dir).into_iter();
        let recs: Vec<(String, PathBuf, PathBuf)> = claims
            .filter_map(|(name, rec)| worktrees::folder(&rec).map(|f| (name, rec, f)))
            .chain([(String::new(), own.dir, PathBuf::from(&spec.cwd))])
            .collect();
        for (repo, rec, folder) in recs {
            let mut users: Vec<Spec> = share::in_folder(data, &folder, Some(id));
            users.retain(|u| !ids.contains(&u.id));
            if let Some(by) = users.first() {
                stays.push(json!({"id": id, "repo": repo, "by": by.id}));
                continue;
            }
            if seen.contains(&rec) {
                continue;
            }
            if let Some(branch) = worktrees::own_unlanded(&rec)? {
                match worktrees::kept(&rec)? {
                    Some((branch, why)) => {
                        kept.push(json!({"repo": repo, "branch": branch, "why": why}))
                    }
                    None => branches.push(json!({"id": id, "title": share::title(&spec),
                        "repo": repo, "branch": branch})),
                }
            }
            seen.push(rec);
        }
    }
    Ok(json!({"branches": branches, "kept": kept, "stays": stays}))
}
