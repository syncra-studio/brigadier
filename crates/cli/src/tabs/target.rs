//! What a tab may show: each kind's target, checked before it's kept.

use brigadier_core as core;
use std::fs;
use std::io;
use std::path::Path;

/// The longest page address a browser tab keeps.
const URL_MAX: usize = 8192;

/// A thread row's path may be absolute: a Review tab keeps it relative to the session's checkout [D1038].
pub(crate) fn relative(data: &Path, id: &str, target: String) -> io::Result<String> {
    let path = Path::new(&target);
    if !path.is_absolute() {
        return Ok(target);
    }
    let root = core::git::checkout(data, &core::git::Target::Session(id))?.root;
    // The checkout's root is canonical; a deleted file's folder still resolves.
    let real = (path.parent().and_then(|dir| fs::canonicalize(dir).ok()))
        .zip(path.file_name())
        .map_or_else(|| path.to_path_buf(), |(dir, name)| dir.join(name));
    match real.strip_prefix(&root) {
        Ok(rel) => Ok(rel.to_string_lossy().into_owned()),
        Err(_) => Err(io::Error::other(format!(
            "{target} isn't in this session's checkout"
        ))),
    }
}

/// A file, PR and attachment tab need their target, a Review tab may have one (its file), every other kind refuses one. A
/// file's is its file, relative and staying in the session's checkout; a PR's is its number, written plainly so one
/// PR is one tab [D1032].
pub(crate) fn check_target(kind: &str, target: Option<&str>) -> io::Result<()> {
    let ok = match (kind, target) {
        // shortcut: a string check, so a symlink in the checkout could lead out; resolve it when 2.23 reads the file.
        // A Review tab may open on one file [D1032, D1038].
        ("file" | "review", Some(path)) => {
            !path.contains('\0')
                && path
                    .split('/')
                    .all(|s| !s.is_empty() && s != "." && s != "..")
        }
        // `list`: the session's PRs when it has several [D205]; `owner/name#n`, another repository's [D213].
        ("pr", Some(target)) => target == "list" || core::host::pr_ref(target).is_some(),
        ("attachment", Some(target)) => target.split_once('/').is_some_and(|(id, name)| {
            core::check_id(id).is_ok() && !name.is_empty() && !name.contains(['/', '\0'])
        }),
        ("note" | "mockup", Some(id)) => core::check_id(id).is_ok(),
        // A web page only: no file: or other scheme opens in the browser [D506].
        ("browser", Some(url)) => {
            url.len() <= URL_MAX
                && !url.contains(|c: char| c.is_control())
                && ["http://", "https://"].iter().any(|scheme| {
                    url.get(..scheme.len())
                        .is_some_and(|start| start.eq_ignore_ascii_case(scheme))
                })
        }
        ("file" | "pr" | "attachment" | "note" | "browser" | "mockup", None) => false,
        (_, target) => target.is_none(),
    };
    if ok {
        Ok(())
    } else {
        Err(io::Error::other(format!(
            "not a {kind} tab's target: {}",
            target.unwrap_or("none")
        )))
    }
}

impl super::Tabs {
    /// An agent's browser tab: opened at the end with the front left as it is, or one it goes on
    /// in, now worked by `driver` [D516].
    pub(super) fn drive(&mut self, tab: &str, url: &str, driver: &str) -> io::Result<()> {
        core::check_id(tab)?;
        core::check_id(driver)?;
        check_target("browser", Some(url))?;
        match self.at(tab).filter(|&at| self.tabs[at].kind == "browser") {
            Some(at) => self.tabs[at].driver = Some(driver.into()),
            None if !self.exists(tab) => self.tabs.push(super::Tab {
                id: tab.into(),
                kind: "browser".into(),
                opener: self.active.clone(),
                target: Some(url.into()),
                driver: Some(driver.into()),
                ..Default::default()
            }),
            None => {}
        }
        Ok(())
    }
}
