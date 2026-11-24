//! A project's settings [D171]: what `set` changes, checked in full before any is saved.

use super::{Project, change, clean, err, find, icon, repo, sessions, taken};
use std::io;
use std::path::Path;

/// What `set` changes; None leaves a field as it is.
#[derive(Default)]
pub struct Change {
    pub branch_prefix: Option<String>,
    pub name: Option<String>,
    pub folder: Option<String>,
    pub trusted: Option<Option<bool>>,
    pub setup: Option<String>,
    pub include: Option<Vec<String>>,
    pub github_account: Option<Option<String>>,
    pub browser_profile: Option<Option<String>>,
    pub pinned: Option<Option<u64>>,
    /// `""`, `tag:<n>`, `emoji:<it>` or `image:<path>`, whose file is copied in (icon.rs).
    pub icon: Option<String>,
}

/// Changes a project's settings [D171]. A new folder resets its trust, so it's asked again, and is
/// refused while the project has sessions (proposed), so trust never moves under them [D166].
/// Every trust change goes through here; its caller then syncs the CLIs' own entries (1i).
pub fn set(data: &Path, id: &str, new: Change) -> io::Result<Project> {
    let name = new.name.as_deref().map(clean).transpose()?;
    if let Some(prefix) = &new.branch_prefix {
        crate::worktrees::names::check_prefix(prefix)?;
    }
    let bad = |c: char| !(c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if let Some(Some(login)) = &new.github_account
        && (login.starts_with('-') || login.contains(bad))
    {
        return err(format!("\"{login}\" isn't a GitHub login."));
    }
    let folder = new.folder.map(|f| repo(data, &f)).transpose()?;
    let include = new
        .include
        .map(|paths| {
            paths
                .iter()
                .map(|p| path(p))
                .collect::<io::Result<Vec<_>>>()
        })
        .transpose()?;
    let count = folder
        .as_ref()
        .map_or(Ok(0), |_| sessions(data, id).map(|s| s.len()))?;
    // Last, as an image is copied in (into a project that exists): dropped should the save fail.
    let (icon, copied) = match &new.icon {
        Some(value) => super::get(data, id)
            .and_then(|_| icon::checked(data, id, value))
            .map(|(icon, copied)| (Some(icon), copied))?,
        None => (None, None),
    };
    let done = change(data, |list| {
        let now = find(list, id)?.folder.clone();
        if let Some(folder) = folder.filter(|f| Path::new(&now) != f) {
            taken(list, &folder)?;
            let p = find(list, id)?;
            if count > 0 {
                let sessions = if count == 1 { "session" } else { "sessions" };
                return err(format!(
                    "\"{}\" has {count} {sessions}, so its folder can't change.",
                    p.name
                ));
            }
            p.folder = folder.display().to_string();
            p.kind = crate::folder::kind(&folder);
            p.trusted = None;
        }
        let p = find(list, id)?;
        if let Some(prefix) = new.branch_prefix {
            p.branch_prefix = Some(prefix);
        }
        if let Some(name) = name {
            p.name = name;
        }
        if let Some(trusted) = new.trusted {
            p.trusted = trusted;
        }
        if let Some(setup) = new.setup {
            p.setup = setup;
        }
        if let Some(include) = include {
            p.include = include;
        }
        if let Some(account) = new.github_account {
            p.github_account = account;
        }
        if let Some(profile) = new.browser_profile {
            p.browser_profile = profile;
        }
        if let Some(pinned) = new.pinned {
            p.pinned = pinned;
        }
        let old = icon.map(|icon| std::mem::replace(&mut p.icon, icon));
        Ok((old, p.clone()))
    });
    // The record is written before the image it no longer shows goes: a crash leaves an orphan.
    let saved = done
        .as_ref()
        .ok()
        .map(|(_, (old, _))| old.clone().flatten());
    icon::tidy(data, id, saved, copied);
    done.map(|(_, (_, project))| project)
}

/// One path to copy into worktrees, from the repository's top; never out of it.
fn path(p: &str) -> io::Result<String> {
    let p = p.trim().trim_end_matches('/');
    if p.is_empty() {
        return err("A file to copy can't be empty.".into());
    }
    if p.starts_with('/') || p.starts_with('~') {
        return err(format!("\"{p}\" must be relative to the repository root."));
    }
    if p.split('/').any(|part| part == "..") {
        return err(format!("\"{p}\" must stay inside the repository."));
    }
    Ok(p.into())
}
