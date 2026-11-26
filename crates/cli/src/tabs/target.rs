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

/// A file, PR, attachment, note, browser and mockup tab need their target, a Review tab may have one (its file), every other kind refuses one. A
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
        ("note" | "mockup" | "workers" | "subagents", Some(id)) => core::check_id(id).is_ok(),
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
    /// An agent's browser tab: opened at the end of its group, else of the strip, with the front
    /// left as it is; or one it goes on in, or is given, now worked by `driver` and moved to its
    /// group's end, so a driver's tabs stay one group, as Chrome's [D516 D894 D909].
    pub(super) fn drive(&mut self, tab: &str, url: &str, driver: &str) -> io::Result<()> {
        core::check_id(tab)?;
        core::check_id(driver)?;
        check_target("browser", Some(url))?;
        let mine = |t: &super::Tab| t.driver.as_deref() == Some(driver);
        let end = |tabs: &[super::Tab], none: usize| {
            tabs.iter().rposition(mine).map_or(none, |at| at + 1)
        };
        match self.at(tab).filter(|&at| self.tabs[at].kind == "browser") {
            Some(at) if mine(&self.tabs[at]) => {}
            // Dropped inside or beside its group, it stays where it was let go, as Chrome's.
            Some(at)
                if self.tabs[at.saturating_sub(1)..(at + 2).min(self.tabs.len())]
                    .iter()
                    .any(mine) =>
            {
                self.tabs[at].driven(driver);
            }
            Some(at) => {
                let mut given = self.tabs.remove(at);
                given.driven(driver);
                self.tabs.insert(end(&self.tabs, at), given);
            }
            None if !self.exists(tab) => {
                let made = super::Tab {
                    id: tab.into(),
                    kind: "browser".into(),
                    opener: self.active.clone(),
                    target: Some(url.into()),
                    driver: Some(driver.into()),
                    ..Default::default()
                };
                self.tabs.insert(end(&self.tabs, self.tabs.len()), made);
            }
            None => {}
        }
        Ok(())
    }
}

impl super::Tab {
    /// Worked by `driver` now; one that was the user's is theirs given [C41].
    fn driven(&mut self, driver: &str) {
        self.given |= self.driver.is_none();
        self.driver = Some(driver.into());
    }
}

#[cfg(test)]
mod tests {
    use super::super::{Tab, Tabs};

    fn tab(id: &str, driver: Option<&str>) -> Tab {
        Tab {
            id: id.into(),
            kind: "browser".into(),
            target: Some("https://a.test/".into()),
            driver: driver.map(Into::into),
            ..Default::default()
        }
    }

    fn ids(t: &Tabs) -> Vec<&str> {
        t.tabs.iter().map(|t| t.id.as_str()).collect()
    }

    #[test]
    fn a_drivers_tabs_stay_one_group() {
        let mut t = Tabs {
            tabs: vec![
                tab("u1", None),
                tab("u0", None),
                tab("a1", Some("d")),
                tab("u2", None),
            ],
            ..Default::default()
        };
        // A new one goes to its group's end, not the strip's.
        t.drive("a2", "https://a.test/", "d").unwrap();
        assert_eq!(ids(&t), ["u1", "u0", "a1", "a2", "u2"]);
        // One given away from its group joins the group's end.
        t.drive("u1", "https://a.test/", "d").unwrap();
        assert_eq!(ids(&t), ["u0", "a1", "a2", "u1", "u2"]);
        // One let go beside or inside its group stays there.
        t.drive("u0", "https://a.test/", "d").unwrap();
        assert_eq!(ids(&t), ["u0", "a1", "a2", "u1", "u2"]);
        // One it already works stays where it is.
        t.drive("a1", "https://a.test/", "d").unwrap();
        assert_eq!(ids(&t), ["u0", "a1", "a2", "u1", "u2"]);
        // A driver with no group yet: a given tab stays in place, a new one opens at the end.
        t.drive("u2", "https://a.test/", "e").unwrap();
        t.drive("b1", "https://a.test/", "f").unwrap();
        assert_eq!(ids(&t), ["u0", "a1", "a2", "u1", "u2", "b1"]);
        assert_eq!(t.tabs[4].driver.as_deref(), Some("e"));
        assert!(t.tabs[..4].iter().all(|t| t.driver.as_deref() == Some("d")));
    }
}
