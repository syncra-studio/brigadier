//! Title-based branch names, with git's own validation and collisions [D1214, D1217].

use super::{git, lock, read, write};
use std::fs::File;
use std::io;
use std::path::Path;

pub const PREFIX: &str = "brigadier/";

pub fn has_remotes(repo: &Path) -> io::Result<bool> {
    Ok(!git(repo, &["remote"])?.is_empty())
}

/// A prefix is literal, so appending a plain slug must still make a valid branch.
pub fn check_prefix(prefix: &str) -> io::Result<()> {
    let mut command = std::process::Command::new("git");
    command.args(["check-ref-format", "--branch", &format!("{prefix}session")]);
    let out = crate::adapters::setup::run(&mut command, 5).map_err(io::Error::other)?;
    if out.status.success() && !prefix.starts_with('-') {
        Ok(())
    } else {
        Err(io::Error::other(
            "That prefix doesn't make a valid git branch name.",
        ))
    }
}

fn slug(title: &str) -> String {
    let plain = deunicode::deunicode(&crate::title::from(title)).to_ascii_lowercase();
    let words: Vec<&str> = plain
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|w| !w.is_empty())
        .collect();
    match words.is_empty() {
        true => "session".into(),
        false => words.join("-"),
    }
}

/// A remote ref is compared after its remote name, even when that name contains a slash.
fn branches(repo: &Path) -> io::Result<Vec<String>> {
    let refs = git(
        repo,
        &[
            "for-each-ref",
            "--format=%(refname)",
            "refs/heads",
            "refs/remotes",
        ],
    )?;
    let remotes = git(repo, &["remote"])?;
    Ok(refs
        .lines()
        .filter_map(|r| {
            r.strip_prefix("refs/heads/").or_else(|| {
                remotes
                    .lines()
                    .find_map(|remote| r.strip_prefix(&format!("refs/remotes/{remote}/")))
            })
        })
        .map(String::from)
        .collect())
}

pub fn choose(
    repo: &Path,
    prefix: Option<&str>,
    title: &str,
    old: Option<&str>,
) -> io::Result<String> {
    let prefix = prefix.unwrap_or(PREFIX);
    check_prefix(prefix)?;
    let stem = format!("{prefix}{}", slug(title));
    let branches = branches(repo)?;
    if branches
        .iter()
        .filter(|b| Some(b.as_str()) != old)
        .any(|b| stem.starts_with(&format!("{b}/")))
    {
        return Err(io::Error::other(
            "A branch occupies this prefix. Change the project's branch prefix first.",
        ));
    }
    for suffix in 1.. {
        let name = if suffix == 1 {
            stem.clone()
        } else {
            format!("{stem}-{suffix}")
        };
        if !branches
            .iter()
            .filter(|b| Some(b.as_str()) != old)
            .any(|b| b == &name || b.starts_with(&format!("{name}/")))
        {
            return Ok(name);
        }
    }
    unreachable!()
}

/// Serialises naming and creation across sessions using the repository's existing folder lock.
pub fn reserve(
    repo: &Path,
    prefix: Option<&str>,
    title: &str,
    old: Option<&str>,
) -> io::Result<(File, String)> {
    let common = git(
        repo,
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
    )?;
    let lock = File::open(common)?;
    lock.lock()?;
    Ok((lock, choose(repo, prefix, title, old)?))
}

/// Once a push is attempted the name stays put, even if tracking or the remote is later removed.
pub fn publishing(checkout: &crate::git::Checkout) -> io::Result<()> {
    if checkout.worktree {
        let dir = checkout.root.parent().unwrap();
        let _one = lock(dir)?;
        if let Some(mut owned) = read(dir)? {
            owned.published = true;
            write(dir, &owned)?;
        }
    }
    Ok(())
}

/// Local evidence of publication, including refs on every remote; uncertain reads refuse rename.
pub fn unpublished(dir: &Path) -> io::Result<bool> {
    let _one = lock(dir)?;
    let Some(mut owned) = read(dir)? else {
        return Ok(false);
    };
    if owned.published {
        return Ok(false);
    }
    let Some(branch) = &owned.branch else {
        return Ok(false);
    };
    let repo = Path::new(&owned.repo);
    let upstream = git(
        repo,
        &[
            "for-each-ref",
            "--format=%(upstream)",
            &format!("refs/heads/{branch}"),
        ],
    )?;
    let remotes = git(repo, &["remote"])?;
    let refs = git(
        repo,
        &["for-each-ref", "--format=%(refname)", "refs/remotes"],
    )?;
    let published = !upstream.trim().is_empty()
        || remotes.lines().any(|r| {
            refs.lines()
                .any(|f| f == format!("refs/remotes/{r}/{branch}"))
        });
    if published {
        owned.published = true;
        write(dir, &owned)?;
    }
    Ok(!published)
}
