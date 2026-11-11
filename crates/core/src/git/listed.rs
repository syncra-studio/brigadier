//! A scope's files as `git diff` lists them, read into Review's list [D1035, D1036]: shared by
//! the git scopes and Last turn, which reads its two captures the same way.

use super::diff::LARGE_LINES;
use serde_json::{Value, json};
use std::collections::BTreeMap;

/// `--name-status -z` and `--numstat -z` read together: each file with its status and counts.
pub(super) fn listed(names: &[u8], counts: &[u8], staged: bool) -> BTreeMap<String, Value> {
    let mut files: BTreeMap<String, Value> = BTreeMap::new();
    let names = String::from_utf8_lossy(names);
    let mut parts = names.split('\0').filter(|p| !p.is_empty());
    while let Some(code) = parts.next() {
        let (status, from) = match code.as_bytes()[0] {
            b'R' | b'C' => (
                if code.starts_with('R') {
                    "renamed"
                } else {
                    "copied"
                },
                parts.next(),
            ),
            b'A' => ("added", None),
            b'D' => ("deleted", None),
            b'T' => ("typeChanged", None),
            b'U' => ("conflicted", None),
            _ => ("modified", None),
        };
        let Some(path) = parts.next() else { break };
        files.insert(
            path.into(),
            json!({"path": path, "from": from, "status": status, "insertions": 0, "deletions": 0,
                   "binary": false, "staged": staged, "large": false}),
        );
    }
    // `--numstat -z`: "added\tremoved\tpath\0", or for a rename "added\tremoved\t\0old\0new\0".
    let counts = String::from_utf8_lossy(counts);
    let mut parts = counts.split('\0');
    while let Some(record) = parts.next() {
        let mut fields = record.splitn(3, '\t');
        let (Some(added), Some(removed), Some(path)) =
            (fields.next(), fields.next(), fields.next())
        else {
            continue;
        };
        let path = match path {
            "" => {
                parts.next();
                parts.next().unwrap_or("")
            }
            path => path,
        };
        if let Some(file) = files.get_mut(path) {
            let lines = |n: &str| n.parse::<u64>().ok();
            file["binary"] = (added == "-").into();
            file["insertions"] = lines(added).unwrap_or(0).into();
            file["deletions"] = lines(removed).unwrap_or(0).into();
        }
    }
    files
}

/// The files as Review's list: each marked large past the threshold, with the totals.
pub(super) fn review_of(name: &str, mut files: BTreeMap<String, Value>) -> Value {
    let (mut insertions, mut deletions) = (0, 0);
    for file in files.values_mut() {
        let (i, d) = (
            file["insertions"].as_u64().unwrap_or(0),
            file["deletions"].as_u64().unwrap_or(0),
        );
        insertions += i;
        deletions += d;
        file["large"] = (i + d > LARGE_LINES).into();
    }
    json!({"scope": name, "base": null, "files": files.into_values().collect::<Vec<_>>(),
           "insertions": insertions, "deletions": deletions})
}
