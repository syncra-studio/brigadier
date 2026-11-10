//! What the Review tab shows of a checkout [D1035, D1036]: a scope's file list with its counts,
//! then each file's two sides and git's hunks over them, asked for one file at a time. Rust cuts
//! the patches; the UI only draws them [D71]. Hunks keep an id while their lines don't change, so
//! a stage or revert names the hunk the user saw [D30, D1043].

use super::{Checkout, err, inside, lock, read};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::fs;
use std::io::{self, Read};
use std::sync::atomic::AtomicBool;

/// Proposed: a file changing more lines than this arrives folded, its contents read when it's
/// opened [D1036].
pub(super) const LARGE_LINES: u64 = 1500;
/// Proposed: a side bigger than this isn't sent; the file says why instead.
const SIDE_MAX: u64 = 4 * 1024 * 1024;
/// A NUL in a file's first bytes makes it binary, as git and the old viewer decide.
const BINARY_PROBE: usize = 8000;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Scope {
    /// HEAD to the files: everything not committed.
    Uncommitted,
    /// HEAD to the index.
    Staged,
    /// The index to the files.
    Unstaged,
}

impl Scope {
    pub fn parse(word: &str) -> io::Result<Scope> {
        match word {
            "uncommitted" => Ok(Scope::Uncommitted),
            "staged" => Ok(Scope::Staged),
            "unstaged" => Ok(Scope::Unstaged),
            _ => err(format!("no review scope {word:?}")),
        }
    }

    fn name(self) -> &'static str {
        match self {
            Scope::Uncommitted => "uncommitted",
            Scope::Staged => "staged",
            Scope::Unstaged => "unstaged",
        }
    }
}

/// What `git diff` compares for a scope: none for the index to the files.
pub(super) fn base(
    checkout: &Checkout,
    scope: Scope,
    stop: &AtomicBool,
) -> io::Result<Vec<String>> {
    // A branch with no commit yet compares with the empty tree.
    let head = match read(
        &checkout.root,
        &["rev-parse", "-q", "--verify", "HEAD"],
        stop,
    ) {
        Ok(_) => "HEAD".to_string(),
        Err(_) => {
            let out = read(
                &checkout.root,
                &["hash-object", "-t", "tree", "/dev/null"],
                stop,
            )?;
            String::from_utf8_lossy(&out).trim().to_string()
        }
    };
    Ok(match scope {
        Scope::Uncommitted => vec![head],
        Scope::Staged => vec!["--cached".into(), head],
        Scope::Unstaged => vec![],
    })
}

fn diff(
    checkout: &Checkout,
    scope: Scope,
    extra: &[&str],
    stop: &AtomicBool,
) -> io::Result<Vec<u8>> {
    let base = base(checkout, scope, stop)?;
    let mut args = vec!["diff", "--no-color", "--no-ext-diff", "--no-textconv", "-M"];
    args.extend(base.iter().map(String::as_str));
    args.extend(extra);
    read(&checkout.root, &args, stop)
}

/// The untracked files, which the scopes that reach the files list as added.
fn untracked(checkout: &Checkout, stop: &AtomicBool) -> io::Result<Vec<String>> {
    let out = read(
        &checkout.root,
        &["ls-files", "--others", "--exclude-standard", "-z"],
        stop,
    )?;
    Ok(String::from_utf8_lossy(&out)
        .split('\0')
        .filter(|p| !p.is_empty())
        .map(String::from)
        .collect())
}

/// A file's bytes as far as `max`, and whether it held more.
fn bytes_of(checkout: &Checkout, rel: &str, max: u64) -> io::Result<Option<(Vec<u8>, bool)>> {
    let path = inside(checkout, rel)?;
    let file = match fs::File::open(&path) {
        Ok(file) => file,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e),
    };
    let size = file.metadata()?.len();
    let mut bytes = vec![];
    file.take(max).read_to_end(&mut bytes)?;
    Ok(Some((bytes, size > max)))
}

fn binary(bytes: &[u8]) -> bool {
    bytes[..bytes.len().min(BINARY_PROBE)].contains(&0)
}

fn text(bytes: Vec<u8>) -> String {
    String::from_utf8(bytes).unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned())
}

/// The scope's files with their counts, first and fast [D1036]: `{scope, base, files, insertions,
/// deletions}`. `staged` on a file: every change of it is in the index, so its action is Unstage.
pub fn list(checkout: &Checkout, scope: Scope, stop: &AtomicBool) -> io::Result<Value> {
    let _shared = lock(checkout, false, stop)?;
    let names = diff(checkout, scope, &["--name-status", "-z"], stop)?;
    let counts = diff(checkout, scope, &["--numstat", "-z"], stop)?;
    let mut files: BTreeMap<String, Value> = BTreeMap::new();
    let names = String::from_utf8_lossy(&names);
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
                   "binary": false, "staged": scope == Scope::Staged, "large": false}),
        );
    }
    // `--numstat -z`: "added\tremoved\tpath\0", or for a rename "added\tremoved\t\0old\0new\0".
    let counts = String::from_utf8_lossy(&counts);
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
    if scope != Scope::Staged {
        for path in untracked(checkout, stop)? {
            let Ok(Some((bytes, _))) = bytes_of(checkout, &path, SIDE_MAX) else {
                continue;
            };
            let is_binary = binary(&bytes);
            let lines = if is_binary {
                0
            } else {
                text(bytes).lines().count() as u64
            };
            files.insert(
                path.clone(),
                json!({"path": path, "from": null, "status": "untracked", "insertions": lines,
                       "deletions": 0, "binary": is_binary, "staged": false, "large": false}),
            );
        }
    }
    if scope == Scope::Uncommitted {
        // A file with nothing left between the index and the files is wholly staged.
        let out = read(&checkout.root, &["diff", "--name-only", "-z"], stop)?;
        let unstaged = String::from_utf8_lossy(&out);
        let unstaged: Vec<&str> = unstaged.split('\0').collect();
        for (path, file) in files.iter_mut() {
            file["staged"] =
                (file["status"] != "untracked" && !unstaged.contains(&path.as_str())).into();
        }
    }
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
    Ok(
        json!({"scope": scope.name(), "base": null, "files": files.into_values().collect::<Vec<_>>(),
              "insertions": insertions, "deletions": deletions}),
    )
}

/// One hunk of a patch as git cut it: its `@@` line, where it sits on each side, and its lines.
#[derive(Clone, Debug)]
pub(super) struct Hunk {
    pub header: String,
    pub old: (u64, u64),
    pub new: (u64, u64),
    pub lines: Vec<String>,
}

impl Hunk {
    /// Lines `a..a+n` on one side, or for none the gap after line `a`, meet lines `b..b+m`.
    fn meets(a: (u64, u64), b: (u64, u64)) -> bool {
        let span = |(start, n): (u64, u64)| match n {
            0 => (start * 2 + 1, start * 2 + 1),
            n => (start * 2, (start + n - 1) * 2),
        };
        let ((a0, a1), (b0, b1)) = (span(a), span(b));
        a0 <= b1 + 1 && b0 <= a1 + 1
    }

    pub fn meets_old(&self, other: &Hunk) -> bool {
        Hunk::meets(self.old, other.old)
    }

    pub fn meets_new(&self, other: &Hunk) -> bool {
        Hunk::meets(self.new, other.new)
    }
}

/// A file's patch: the lines before its first hunk (which say what the file is) and its hunks.
#[derive(Clone, Debug, Default)]
pub(super) struct Patch {
    pub head: Vec<String>,
    pub hunks: Vec<Hunk>,
}

impl Patch {
    pub fn parse(bytes: &[u8]) -> Patch {
        let text = String::from_utf8_lossy(bytes);
        let mut patch = Patch::default();
        for line in text.split_inclusive('\n') {
            let line = line.strip_suffix('\n').unwrap_or(line);
            if let Some(rest) = line.strip_prefix("@@ -") {
                let range = |word: &str| -> (u64, u64) {
                    let mut it = word.splitn(2, ',');
                    let start = it.next().and_then(|n| n.parse().ok()).unwrap_or(0);
                    (start, it.next().and_then(|n| n.parse().ok()).unwrap_or(1))
                };
                let mut words = rest.split(' ');
                let old = range(words.next().unwrap_or(""));
                let new = range(words.next().unwrap_or("").trim_start_matches('+'));
                patch.hunks.push(Hunk {
                    header: line.into(),
                    old,
                    new,
                    lines: vec![],
                });
            } else if let Some(hunk) = patch.hunks.last_mut() {
                hunk.lines.push(line.into());
            } else {
                patch.head.push(line.into());
            }
        }
        patch
    }

    /// The patch with only `hunks`, as `git apply` takes it.
    pub fn with(&self, hunks: &[&Hunk]) -> String {
        let mut out = String::new();
        for line in self.head.iter().chain(
            hunks
                .iter()
                .flat_map(|h| std::iter::once(&h.header).chain(&h.lines)),
        ) {
            out.push_str(line);
            out.push('\n');
        }
        out
    }
}

/// A hunk's id: its lines, numbered among the file's hunks with the same lines, so it holds while
/// another hunk moves it up or down.
pub(super) fn ids(scope: Scope, path: &str, hunks: &[Hunk]) -> Vec<String> {
    let mut seen: BTreeMap<u32, u32> = BTreeMap::new();
    (hunks.iter())
        .map(|hunk| {
            let mut hash = crc32fast::Hasher::new();
            for part in [scope.name(), path]
                .into_iter()
                .chain(hunk.lines.iter().map(String::as_str))
            {
                hash.update(part.as_bytes());
                hash.update(b"\n");
            }
            let sum = hash.finalize();
            let n = seen.entry(sum).or_default();
            *n += 1;
            format!("{sum:08x}-{n}")
        })
        .collect()
}

/// The file's patch in `scope`, with `context` lines around each change; an untracked file is
/// one hunk adding it whole.
pub(super) fn patch(
    checkout: &Checkout,
    scope: Scope,
    path: &str,
    from: Option<&str>,
    context: u8,
    stop: &AtomicBool,
) -> io::Result<Patch> {
    let context = format!("-U{context}");
    let mut args = vec![context.as_str(), "--"];
    args.extend(from);
    args.push(path);
    let patch = Patch::parse(&diff(checkout, scope, &args, stop)?);
    if !patch.head.is_empty()
        || scope == Scope::Staged
        || !untracked(checkout, stop)?.iter().any(|p| p == path)
    {
        return Ok(patch);
    }
    let after = match bytes_of(checkout, path, SIDE_MAX)? {
        Some((bytes, false)) if !binary(&bytes) => text(bytes),
        _ => return Ok(patch),
    };
    let lines: Vec<String> = after.lines().map(|l| format!("+{l}")).collect();
    Ok(Patch {
        head: vec![],
        hunks: vec![Hunk {
            header: format!("@@ -0,0 +1,{} @@", lines.len()),
            old: (0, 0),
            new: (1, lines.len() as u64),
            lines,
        }],
    })
}

/// One side of a file: a blob git holds (`HEAD:path`, `:path`), or the file itself.
pub(super) fn side(
    checkout: &Checkout,
    spec: Option<String>,
    path: &str,
    stop: &AtomicBool,
) -> io::Result<Result<String, String>> {
    let too_big = || Ok(Err("This file is too big to show here.".to_string()));
    let bytes = match spec {
        Some(spec) => {
            let size = read(&checkout.root, &["cat-file", "-s", &spec], stop);
            let Ok(size) = size else {
                return Ok(Ok(String::new()));
            };
            if String::from_utf8_lossy(&size)
                .trim()
                .parse::<u64>()
                .unwrap_or(0)
                > SIDE_MAX
            {
                return too_big();
            }
            read(&checkout.root, &["cat-file", "blob", &spec], stop)?
        }
        None => match bytes_of(checkout, path, SIDE_MAX)? {
            None => vec![],
            Some((_, true)) => return too_big(),
            Some((bytes, false)) => bytes,
        },
    };
    Ok(Ok(text(bytes)))
}

/// A file's contents in `scope` [D1036]: `{before, after, hunks}`, or `{error}` when it can't be
/// shown. Each hunk as the Review tab draws it, with its id.
pub fn file(
    checkout: &Checkout,
    scope: Scope,
    path: &str,
    from: Option<&str>,
    stop: &AtomicBool,
) -> io::Result<Value> {
    let _shared = lock(checkout, false, stop)?;
    inside(checkout, path)?;
    if let Some(from) = from {
        inside(checkout, from)?;
    }
    let head = base(checkout, scope, stop)?.pop();
    let old = from.unwrap_or(path);
    let (before, after) = match scope {
        Scope::Uncommitted => (Some(format!("{}:{old}", head.unwrap_or_default())), None),
        Scope::Staged => (
            Some(format!("{}:{old}", head.unwrap_or_default())),
            Some(format!(":{path}")),
        ),
        Scope::Unstaged => (Some(format!(":{path}")), None),
    };
    let before = side(checkout, before, old, stop)?;
    let after = side(checkout, after, path, stop)?;
    let (before, after) = match (before, after) {
        (Ok(before), Ok(after)) => (before, after),
        (Err(why), _) | (_, Err(why)) => return Ok(json!({"error": why})),
    };
    let patch = patch(checkout, scope, path, from, 3, stop)?;
    let staged = match scope {
        Scope::Staged => vec![true; patch.hunks.len()],
        Scope::Unstaged => vec![false; patch.hunks.len()],
        // A hunk is staged when nothing between the index and the files touches it.
        Scope::Uncommitted => {
            let unstaged = patch_of(checkout, Scope::Unstaged, path, stop)?;
            (patch.hunks.iter())
                .map(|h| !unstaged.hunks.iter().any(|u| u.meets_new(h)))
                .collect()
        }
    };
    let ids = ids(scope, path, &patch.hunks);
    let hunks: Vec<Value> = (patch.hunks.iter().zip(ids).zip(staged))
        .map(|((hunk, id), staged)| shape(hunk, id, staged))
        .collect();
    Ok(json!({"before": before, "after": after, "hunks": hunks}))
}

/// The file's changes in `scope` cut to the bone (no context), for matching across scopes.
pub(super) fn patch_of(
    checkout: &Checkout,
    scope: Scope,
    path: &str,
    stop: &AtomicBool,
) -> io::Result<Patch> {
    patch(checkout, scope, path, None, 0, stop)
}

/// A hunk as `ReviewHunk`: its counts; its first new line and the unchanged lines before its first
/// change, where its bar sits; and the lines it changes, on the new side unless it only deletes.
fn shape(hunk: &Hunk, id: String, staged: bool) -> Value {
    let (mut old_at, mut new_at) = (hunk.old.0, hunk.new.0);
    let (mut added, mut removed, mut leading) = (vec![], vec![], None::<u64>);
    for line in &hunk.lines {
        match line.as_bytes().first() {
            Some(b'+') => {
                added.push(new_at);
                new_at += 1;
            }
            Some(b'-') => {
                removed.push(old_at);
                old_at += 1;
            }
            Some(b'\\') => continue,
            _ => {
                old_at += 1;
                new_at += 1;
                if added.is_empty() && removed.is_empty() {
                    *leading.get_or_insert(0) += 1;
                    continue;
                }
            }
        }
        leading.get_or_insert(0);
    }
    let (side, lines) = match added.is_empty() {
        false => ("additions", &added),
        true => ("deletions", &removed),
    };
    json!({"id": id, "header": hunk.header, "insertions": added.len(), "deletions": removed.len(),
           "staged": staged, "newStart": hunk.new.0.max(1), "leading": leading.unwrap_or(0), "side": side,
           "start": lines.first().copied().unwrap_or(hunk.new.0), "end": lines.last().copied().unwrap_or(hunk.new.0)})
}
