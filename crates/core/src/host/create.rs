//! The branch row's Create PR, Attach and Compare [D168, D169]: a session's branch made into a PR
//! through the user's own gh, an existing PR tied to the session, and the host's compare page.

use super::prs::{Key, kept};
use super::view::{keep, read_kept};
use super::{GH_SECS, Kind, Pr, err, failed, gh, setup};
use crate::git::branch;
use serde_json::{Value, json};
use std::io;
use std::sync::atomic::AtomicBool;

/// What the Create PR dialog sends [D168].
pub struct Create<'a> {
    /// A new branch to make from what's checked out first.
    pub branch: Option<&'a str>,
    /// Commit and push local changes: everything changed, committed as this.
    pub commit: Option<&'a str>,
    pub title: &'a str,
    pub body: &'a str,
    pub draft: bool,
    /// Its base on the host; the session's own when None.
    pub base: Option<&'a str>,
    /// Its head on the host; the checked-out branch when None.
    pub head: Option<&'a str>,
}

impl Pr {
    /// Makes the PR, each part only if it's still to do, so a retry never repeats one that landed:
    /// the new branch, the commit, the push, then `gh pr create`. A PR already open for the head is
    /// answered with its address (`existing`). The caller holds the branch fence for a branch or a
    /// commit [D1021].
    pub fn create(&self, c: &Create) -> io::Result<Value> {
        let Some(repo) = self.repo.as_ref().filter(|r| r.kind == Kind::GitHub) else {
            return err("Only GitHub's pull requests can be made here.");
        };
        let on = c.branch.unwrap_or(&self.branch);
        let head = c.head.unwrap_or(on);
        let base = c.base.map(String::from).unwrap_or_else(|| self.landing());
        // Never a commit or a push onto the base itself: the PR needs a branch of its own first.
        if head.is_empty() || head == base {
            return err("Name a new branch for this pull request.");
        }
        let stop = AtomicBool::new(false);
        if let Some(name) = c.branch
            && name != self.branch
        {
            branch::create(&self.checkout, name, None, &stop)?;
        }
        let committed = match c.commit {
            Some(message) => branch::commit_all(&self.checkout, message, &stop)?,
            None => false,
        };
        let pushed = match head == on {
            true => {
                let remote = crate::git::push::remote(&self.checkout, on)?;
                branch::push(&self.checkout, &remote, on, &stop)?
            }
            false => false,
        };
        let gh = gh(repo, self.account.as_deref()).ok_or_else(|| io::Error::other(super::NO_GH))?;
        let at = format!("{}/{}", repo.host, repo.path);
        let mut command = gh.command();
        command.args(["pr", "create", "-R", &at, "--head", head]);
        // No base known: gh lands it into the repository's default branch.
        if !base.is_empty() {
            command.args(["--base", &base]);
        }
        command.args(["--title", c.title, "--body-file", "-"]);
        if c.draft {
            command.arg("--draft");
        }
        let out =
            setup::run_fed(&mut command, GH_SECS, &stop, Some(c.body)).map_err(io::Error::other)?;
        let said = String::from_utf8_lossy(&out.stdout).to_string()
            + &String::from_utf8_lossy(&out.stderr);
        // gh names the PR by its address, on success and when one is already open.
        let url = (said.split_whitespace())
            .find(|w| w.starts_with("https://") && w.contains("/pull/"))
            .map(String::from);
        let existing = !out.status.success() && said.contains("already exists");
        let Some(url) = url.filter(|_| out.status.success() || existing) else {
            return err(failed(&out));
        };
        let number = (url.rsplit('/').next()).and_then(|n| n.parse::<u64>().ok());
        Ok(
            json!({"url": url, "number": number, "ref": number.map(|n| format!("{at}#{n}")),
            "existing": existing, "committed": committed, "pushed": pushed}),
        )
    }

    /// Ties PR `at#number` to the session, so its card lists it, or unties it (Undo) [D169]. Only a
    /// PR on the session's own server: its card reads one server.
    pub fn attach(&self, at: &str, number: u64, on: bool) -> io::Result<()> {
        let Some(repo) = self.repo.as_ref() else {
            return err("This remote's host isn't one Brigadier knows.");
        };
        let Some(path) = (at.split_once('/')).filter(|(h, _)| h.eq_ignore_ascii_case(&repo.host))
        else {
            return err(format!("Only a PR on {} can be attached here.", repo.host));
        };
        let key: Key = match path.1.eq_ignore_ascii_case(&repo.path) {
            true => (None, number),
            false => (Some(path.1.to_ascii_lowercase()), number),
        };
        let one = self.one();
        let _held = one.lock().unwrap_or_else(|e| e.into_inner());
        let mut all = attached(&self.dir);
        all.retain(|k| *k != key);
        if on {
            all.push(key);
        } else {
            // Its row goes with it; the next read brings it back only if the session touched it.
            let mut prs = kept(&self.dir);
            if let Some(rows) = prs["prs"].as_array_mut() {
                rows.retain(|r| {
                    let repo = r["repo"].as_str().map(str::to_ascii_lowercase);
                    (repo, r["number"].as_u64().unwrap_or(0)) != key
                });
                self.save(&prs);
            }
        }
        keep(&self.dir.join("attached.json"), &json!(all));
        Ok(())
    }

    /// The base a PR of the session's lands into: its own, else the push remote's default branch as
    /// git last fetched it; empty when neither is known.
    pub fn landing(&self) -> String {
        if !self.base.is_empty() {
            return self.base.clone();
        }
        let never = AtomicBool::new(false);
        let head = format!("refs/remotes/{}/HEAD", self.remote);
        let out = crate::git::read(
            &self.checkout.root,
            &["symbolic-ref", "--quiet", "--short", &head],
            &never,
        );
        let name = out
            .map(|o| String::from_utf8_lossy(&o).trim().to_string())
            .unwrap_or_default();
        name.strip_prefix(&format!("{}/", self.remote))
            .unwrap_or_default()
            .to_string()
    }

    /// The host's page comparing `head` to `base` [D169].
    pub fn compare(&self, base: &str, head: &str) -> io::Result<String> {
        let Some(repo) = self.repo.as_ref().filter(|r| r.kind == Kind::GitHub) else {
            return err("Only GitHub's branches can be compared here.");
        };
        let encode = crate::adapters::encode;
        let base = match base.is_empty() {
            true => self.landing(),
            false => base.to_string(),
        };
        // No base known: GitHub compares the branch with the repository's default one.
        Ok(match base.is_empty() {
            true => format!("{}/compare/{}", repo.url(), encode(head)),
            false => format!(
                "{}/compare/{}...{}",
                repo.url(),
                encode(&base),
                encode(head)
            ),
        })
    }

    /// What the message writer reads to name a PR: the branch's commits past its base and what's
    /// changed and not yet committed.
    pub fn changes(&self, base: Option<&str>) -> String {
        let never = AtomicBool::new(false);
        let base = base.unwrap_or(&self.base_ref);
        let range = format!("{base}..HEAD");
        let read = |args: &[&str]| {
            crate::git::read(&self.checkout.root, args, &never)
                .map(|out| String::from_utf8_lossy(&out).into_owned())
                .unwrap_or_default()
        };
        let log = match base.is_empty() || base.starts_with('-') {
            true => String::new(),
            false => read(&["log", "--format=%s%n%b", &range]),
        };
        format!("{log}\n{}", read(&["diff", "--stat", "HEAD"]))
    }
}

/// The PRs tied to a session by Attach [D169].
pub(super) fn attached(dir: &std::path::Path) -> Vec<Key> {
    serde_json::from_value(read_kept(dir.join("attached.json"))).unwrap_or_default()
}
