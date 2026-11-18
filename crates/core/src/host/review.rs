//! A PR's file through the user's own gh [D262]: its two sides whole, so its diff opens what
//! GitHub's patch leaves out.

use super::view::kept_files;
use super::{GH_SECS, Pr, err, failed, setup};
use serde_json::{Value, json};
use std::io;

impl Pr {
    /// File `path` of PR `number` whole on both sides, so its diff opens the lines GitHub's patch
    /// leaves out [D262]: the new side as of the head its Files changed was read at, the old one
    /// that with the patch taken back out, so both match the patch shown.
    pub fn sides(&self, other: Option<&str>, number: u64, path: &str) -> io::Result<Value> {
        let kept = kept_files(&self.dir, other, number);
        let file = (kept["files"].as_array().into_iter().flatten()).find(|f| f["path"] == path);
        let (Some(patch), Some(head)) = (
            file.and_then(|f| f["patch"].as_str()),
            kept["head"].as_str(),
        ) else {
            return err(format!("{path} has no diff in #{number}'s Files changed."));
        };
        let (repo, gh) = self.gh_repo(other)?;
        let mut command = gh.command();
        command.args([
            "api",
            "--hostname",
            &repo.host,
            "-H",
            "Accept: application/vnd.github.raw",
            &format!(
                "repos/{}/contents/{}?ref={head}",
                repo.path,
                crate::adapters::encode(path)
            ),
        ]);
        let out = setup::run(&mut command, GH_SECS).map_err(io::Error::other)?;
        if !out.status.success() {
            return err(failed(&out));
        }
        let after = String::from_utf8_lossy(&out.stdout).into_owned();
        match unapply(&after, patch) {
            Some(before) => Ok(json!({"before": before, "after": after})),
            None => err(format!("{path} on {head} doesn't match its patch.")),
        }
    }
}

/// The old side of a file: its new side `after` with GitHub's `patch` of it taken back out. None
/// where they don't match.
fn unapply(after: &str, patch: &str) -> Option<String> {
    let new: Vec<&str> = after.split_inclusive('\n').collect();
    let (mut old, mut at, mut hunks, mut dropped) = (String::new(), 0, false, false);
    // split, not lines: a CRLF file's removed lines keep their \r.
    for line in patch.trim_end_matches('\n').split('\n') {
        if let Some(rest) = line.strip_prefix("@@ -") {
            // `@@ -a,b +c,d @@`: the new side's lines before c are unchanged.
            let plus = rest.split(' ').nth(1)?.strip_prefix('+')?;
            let start: usize = plus.split(',').next()?.parse().ok()?;
            let to = start.saturating_sub(1).max(at);
            old.extend(new.get(at..to)?.iter().copied());
            (at, hunks) = (to, true);
            continue;
        }
        if !hunks {
            continue;
        }
        match line.as_bytes().first() {
            // An unchanged line; an empty one may have lost its space.
            Some(b' ') | None => {
                let same = new.get(at)?;
                let text = line.get(1..).unwrap_or("");
                if same.trim_end_matches(['\n', '\r']) != text.trim_end_matches('\r') {
                    return None;
                }
                old.push_str(same);
                at += 1;
            }
            Some(b'-') => {
                old.push_str(&line[1..]);
                old.push('\n');
            }
            Some(b'+') => at += 1,
            // `\ No newline at end of file`, after a removed line: it had none.
            Some(b'\\') if dropped => {
                old.pop();
            }
            _ => {}
        }
        dropped = line.starts_with('-');
    }
    old.extend(new.get(at..)?.iter().copied());
    Some(old)
}
