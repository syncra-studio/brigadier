//! Search across a checkout [D1003], ported from the old app's `manager/search.rs`: the text or
//! pattern found file by file in the files git lists (ignored files and `.git` stay out), sent in
//! batches as it goes and stopped when a newer search starts; and Replace all, which rewrites the
//! files listed only if every one is still as the search found it, all of them or none.

use super::{Checkout, files::listed, lock};
use globset::{GlobBuilder, GlobSet, GlobSetBuilder};
use regex::{Regex, RegexBuilder};
use serde_json::{Value, json};
use std::collections::HashSet;
use std::fs;
use std::hash::{DefaultHasher, Hasher};
use std::io::{self, Write as _};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

/// Files bigger than this are left out: generated or data files, not what is searched for.
const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
/// How far into a file a NUL byte marks it as binary (as git decides).
const BINARY_PROBE: usize = 8000;
/// A search stops once it found this many matches, or matches in this many files.
const MAX_MATCHES: u64 = 20_000;
const MAX_FILES: u64 = 2_000;
/// Lines listed for one file; its count still has every match.
const LINES_PER_FILE: usize = 1_000;
/// How many matches in one file pass between looks at whether the search was stopped.
const STOP_CHECK_EVERY: u64 = 4_096;
/// How much of a long line its preview keeps: some text before the first match, then up to the
/// whole preview's length.
const PREVIEW_BEFORE: usize = 40;
const PREVIEW_CHARS: usize = 250;
/// Found files are sent together at most this often, or once this many are waiting.
const BATCH_EVERY: Duration = Duration::from_millis(50);
const BATCH_FILES: usize = 64;
/// The longest pattern compiled, in bytes of its program.
const REGEX_SIZE: usize = 10 * 1024 * 1024;

fn invalid<T>(message: String) -> io::Result<T> {
    Err(io::Error::new(io::ErrorKind::InvalidInput, message))
}

/// The compiled query `{text, matchCase, wholeWord, regex, include, exclude}`, with which files it
/// reads.
pub struct Matcher {
    regex: Regex,
    /// Literal text replaces as it is: `$` means `$`.
    literal: bool,
    include: Option<GlobSet>,
    exclude: Option<GlobSet>,
}

impl Matcher {
    pub fn new(query: &Value) -> io::Result<Self> {
        let text = query["text"].as_str().unwrap_or("");
        let on = |key: &str| query[key].as_bool().unwrap_or(false);
        if text.is_empty() {
            return invalid("There is nothing to search for.".into());
        }
        let pattern = match on("regex") {
            true => text.to_string(),
            false => regex::escape(text),
        };
        // Non-capturing, so the user's own groups keep their numbers in the replacement.
        let pattern = match on("wholeWord") {
            true => format!(r"\b(?:{pattern})\b"),
            false => pattern,
        };
        let regex = RegexBuilder::new(&pattern)
            .case_insensitive(!on("matchCase"))
            .multi_line(true)
            .size_limit(REGEX_SIZE)
            .build()
            .or_else(|e| match e {
                regex::Error::Syntax(text) => invalid(format!(
                    "The search isn't a valid regular expression: {}",
                    text.lines().last().unwrap_or(&text).trim()
                )),
                other => invalid(format!("The search is too large: {other}")),
            })?;
        let globs_of = |key: &str, field: &str| globs(query[key].as_str().unwrap_or(""), field);
        Ok(Self {
            regex,
            literal: !on("regex"),
            include: globs_of("include", "Files to include")?,
            exclude: globs_of("exclude", "Files to exclude")?,
        })
    }

    /// Whether a file at `path` (relative, with `/`) is searched.
    fn wants(&self, path: &str) -> bool {
        self.include.as_ref().is_none_or(|set| set.is_match(path))
            && !self.exclude.as_ref().is_some_and(|set| set.is_match(path))
    }

    /// The matches in `text`; an empty match (of `a*`, say) is none.
    fn find<'t>(&self, text: &'t str) -> impl Iterator<Item = regex::Match<'t>> {
        self.regex.find_iter(text).filter(|found| !found.is_empty())
    }
}

/// Comma-separated globs as a set, none for an empty list. A glob without a `/` matches at any
/// depth (`*.ts`, `node_modules`), one starting with `/` or `./` only from the top, and a folder's
/// glob matches what it holds.
fn globs(list: &str, field: &str) -> io::Result<Option<GlobSet>> {
    let mut set = GlobSetBuilder::new();
    let mut any = false;
    for glob in list.split(',').map(str::trim).filter(|g| !g.is_empty()) {
        let anchored = glob.starts_with('/') || glob.starts_with("./");
        let glob = (glob.trim_start_matches("./").trim_start_matches('/')).trim_end_matches('/');
        if glob.is_empty() {
            continue;
        }
        let glob = match anchored || glob.contains('/') {
            true => glob.to_owned(),
            false => format!("**/{glob}"),
        };
        for pattern in [glob.clone(), format!("{glob}/**")] {
            let built = GlobBuilder::new(&pattern).literal_separator(true).build();
            set.add(built.or_else(|e| invalid(format!("{field}: `{glob}` {e}")))?);
        }
        any = true;
    }
    if !any {
        return Ok(None);
    }
    set.build()
        .map(Some)
        .or_else(|e| invalid(format!("{field}: {e}")))
}

/// A file's text and its hash when it is searched: a plain file, not too big, not binary, UTF-8.
fn searchable(path: &Path) -> Option<(String, String)> {
    let meta = fs::symlink_metadata(path).ok()?;
    if !meta.is_file() || meta.len() > MAX_FILE_BYTES {
        return None;
    }
    let bytes = fs::read(path).ok()?;
    if bytes[..bytes.len().min(BINARY_PROBE)].contains(&0) {
        return None;
    }
    let hash = hash(&bytes);
    Some((hash, String::from_utf8(bytes).ok()?))
}

/// Tells one version of a file from another, within this build.
fn hash(bytes: &[u8]) -> String {
    let mut hasher = DefaultHasher::new();
    hasher.write(bytes);
    format!("{:016x}-{}", hasher.finish(), bytes.len())
}

/// Searches the files git lists in path order, handing what it finds to `send` in batches, until
/// it is done, reaches its limits or is stopped (`send` returning false stops it too). Says how it
/// ended: `{files, matches, capped}`, or none once stopped.
pub fn search(
    checkout: &Checkout,
    matcher: &Matcher,
    stop: &AtomicBool,
    mut send: impl FnMut(Vec<Value>) -> bool,
) -> io::Result<Option<Value>> {
    let paths = listed(checkout, stop)?;
    let (mut files, mut matches, mut capped) = (0u64, 0u64, false);
    let mut batch = vec![];
    let mut sent = Instant::now();
    for path in paths {
        if stop.load(Ordering::SeqCst) {
            return Ok(None);
        }
        if !matcher.wants(&path) {
            continue;
        }
        let Some((hash, text)) = searchable(&checkout.root.join(&path)) else {
            continue;
        };
        if let Some((count, found)) = search_file(matcher, &path, hash, &text, stop) {
            files += 1;
            matches = matches.saturating_add(count);
            batch.push(found);
        }
        capped = files >= MAX_FILES || matches >= MAX_MATCHES;
        if !batch.is_empty()
            && (capped || batch.len() >= BATCH_FILES || sent.elapsed() >= BATCH_EVERY)
        {
            if !send(std::mem::take(&mut batch)) {
                return Ok(None);
            }
            sent = Instant::now();
        }
        if capped {
            break;
        }
    }
    if stop.load(Ordering::SeqCst) || (!batch.is_empty() && !send(batch)) {
        return Ok(None);
    }
    Ok(Some(
        json!({"files": files, "matches": matches, "capped": capped}),
    ))
}

/// One file's matches as `{path, matches, hash, lines}`, line by line, with its count; none when
/// it has none or the search is stopped.
fn search_file(
    matcher: &Matcher,
    path: &str,
    hash: String,
    text: &str,
    stop: &AtomicBool,
) -> Option<(u64, Value)> {
    let line_end_from = |start: usize| text[start..].find('\n').map_or(text.len(), |at| start + at);
    let mut lines: Vec<Value> = vec![];
    let mut count = 0u64;
    // The current line: where it starts and ends and its number, moved forward as matches come,
    // so each line is scanned once however many matches it holds.
    let (mut line_start, mut line_number) = (0usize, 1u64);
    let mut line_end = line_end_from(0);
    let mut current: Option<(usize, Vec<(usize, usize)>)> = None;
    let flush =
        |current: &mut Option<(usize, Vec<(usize, usize)>)>, number, lines: &mut Vec<Value>| {
            if let Some((start, ranges)) = current.take()
                && lines.len() < LINES_PER_FILE
            {
                lines.push(preview(text, start, number, &ranges));
            }
        };
    for found in matcher.find(text) {
        count += 1;
        if count.is_multiple_of(STOP_CHECK_EVERY) && stop.load(Ordering::SeqCst) {
            return None;
        }
        // The line the match starts on; a match at a line's newline stays on that line.
        if line_end < found.start() {
            flush(&mut current, line_number, &mut lines);
            while line_end < found.start() {
                line_start = line_end + 1;
                line_number += 1;
                line_end = line_end_from(line_start);
            }
        }
        let range = (
            found.start() - line_start,
            found.end().min(line_end) - line_start,
        );
        match &mut current {
            Some((_, ranges)) => ranges.push(range),
            None => current = Some((line_start, vec![range])),
        }
    }
    flush(&mut current, line_number, &mut lines);
    (count > 0).then(|| {
        let file = json!({"path": path, "matches": count, "hash": hash, "lines": lines});
        (count, file)
    })
}

/// A line's preview `{line, preview, ranges}`: the whole line, or around its first match when
/// long. `ranges` are byte offsets in the line; the preview's are UTF-16 offsets in it, as the
/// UI's strings count.
fn preview(text: &str, start: usize, number: u64, ranges: &[(usize, usize)]) -> Value {
    let end = text[start..].find('\n').map_or(text.len(), |at| start + at);
    let line = text[start..end]
        .strip_suffix('\r')
        .unwrap_or(&text[start..end]);
    // Matches at a line's end can sit past its trimmed carriage return.
    let first = ranges.first().map_or(0, |range| range.0).min(line.len());
    // The line's indent is left out, unless a match is in it.
    let indent = (line.len() - line.trim_start().len()).min(first);
    // Character boundaries: up to PREVIEW_BEFORE characters before the first match.
    let from = match line[indent..first].chars().count() > PREVIEW_BEFORE {
        true => (line[..first].char_indices().rev())
            .nth(PREVIEW_BEFORE - 1)
            .map_or(0, |(at, _)| at),
        false => indent,
    };
    let to = (line[from..].char_indices())
        .nth(PREVIEW_CHARS)
        .map_or(line.len(), |(at, _)| from + at);
    let mut preview = String::new();
    if from > indent {
        preview.push('…');
    }
    let offset = preview.encode_utf16().count();
    preview.push_str(&line[from..to]);
    let units = |bytes: usize| offset + line[from..from + bytes].encode_utf16().count();
    let ranges: Vec<Value> = (ranges.iter())
        .map(|&(a, b)| (a.min(line.len()), b))
        .filter(|range| range.0 >= from && range.0 < to.max(from + 1))
        .map(|(a, b)| json!({"start": units(a - from), "end": units(b.min(line.len()).min(to) - from)}))
        .collect();
    if to < line.len() {
        preview.push('…');
    }
    json!({"line": number, "preview": preview, "ranges": ranges})
}

/// One listed file's rewrite, ready to go: its new text written beside it, not yet in place.
struct Staged {
    path: String,
    full: PathBuf,
    /// What the search found in it, and what the rewrite holds.
    hash: String,
    new_hash: String,
    matches: u64,
    temp: PathBuf,
    /// Where the file is moved aside while the rewrite takes its place, until all are in.
    aside: PathBuf,
    /// Whether its folder takes hard links, probed before any original is moved.
    hard_links: bool,
}

/// Replace all [D1003]: rewrites the files listed (`[{path, hash, matches}]`), all of them or
/// none, under the checkout's lock [D1060]. Each is checked against what the search found and its
/// rewrite is written beside it; any that changed, can't be searched or written stops it all
/// before a byte moves. Then each in turn is moved aside, checked once more (it may have changed
/// since: an agent's save takes no lock of ours), and its rewrite linked or exclusively renamed into
/// its place, refusing anything that took the place meanwhile. A failure puts back every file
/// already rewritten; one that something else changed meanwhile stays as it is, and its text from
/// before is kept in `keep` (the session's folder [D35]), or beside it for a project, and listed in
/// `unrestored`. With a regular expression, `$1` or `${name}` stand for what a group matched.
/// Answers `{files, matches, skipped: [{path, reason}], unrestored: [{path, reason}]}`.
pub fn replace(
    checkout: &Checkout,
    matcher: &Matcher,
    replacement: &str,
    files: &[Value],
    keep: Option<&Path>,
    stop: &AtomicBool,
) -> io::Result<Value> {
    let _exclusive = lock(checkout, true, stop)?;
    let eligible: HashSet<String> = listed(checkout, stop)?.into_iter().collect();
    let (mut skipped, mut unrestored) = (vec![], vec![]);
    let skip = |path: &str, reason: String| json!({"path": path, "reason": reason});
    let mut staged: Vec<Staged> = vec![];
    for file in files {
        let path = file["path"].as_str().unwrap_or("");
        let result = match eligible.contains(path) && matcher.wants(path) {
            false => Err("it is not one of the checkout's searchable files".into()),
            true => stage_file(checkout, matcher, replacement, file),
        };
        match result {
            Ok(file) => staged.push(file),
            Err(reason) => skipped.push(skip(path, reason)),
        }
    }
    let discard = |staged: &[Staged]| {
        for file in staged {
            let _ = fs::remove_file(&file.temp);
        }
    };
    let outcome = |files: u64, matches: u64, skipped: Vec<Value>, unrestored: Vec<Value>| json!({"files": files, "matches": matches, "skipped": skipped, "unrestored": unrestored});
    if !skipped.is_empty() {
        discard(&staged);
        return Ok(outcome(0, 0, skipped, unrestored));
    }
    let mut probed: Vec<(PathBuf, Result<bool, String>)> = vec![];
    for file in &mut staged {
        let parent = file.full.parent().unwrap_or(&checkout.root).to_path_buf();
        let known = probed
            .iter()
            .find(|(dir, _)| *dir == parent)
            .map(|(_, r)| r.clone());
        let result = known.unwrap_or_else(|| {
            let result = probe(file).map_err(|e| format!("couldn't prepare to replace it: {e}"));
            probed.push((parent, result.clone()));
            result
        });
        match result {
            Ok(hard_links) => file.hard_links = hard_links,
            Err(reason) => {
                skipped.push(skip(&file.path, reason));
                discard(&staged);
                return Ok(outcome(0, 0, skipped, unrestored));
            }
        }
    }
    let kept = |file: &Staged| keep_aside(file, keep);
    let mut placed = 0;
    for file in &staged {
        let Err((reason, moved)) = place(file) else {
            placed += 1;
            continue;
        };
        // Moved aside but not replaced: it goes back first, only where nothing took its place.
        if moved && let Err(why) = undo_place(file, &kept) {
            unrestored.push(skip(&file.path, why));
        }
        for done in staged[..placed].iter().rev() {
            if let Err(why) = put_back(done, &kept) {
                unrestored.push(skip(&done.path, why));
            }
        }
        skipped.push(skip(&file.path, reason));
        discard(&staged);
        return Ok(outcome(0, 0, skipped, unrestored));
    }
    for file in &staged {
        let _ = fs::remove_file(&file.aside);
        let _ = fs::remove_file(&file.temp);
    }
    let matches = staged.iter().map(|f| f.matches).sum();
    Ok(outcome(staged.len() as u64, matches, skipped, unrestored))
}

/// Checks a listed file against its search and writes its rewrite beside it.
fn stage_file(
    checkout: &Checkout,
    matcher: &Matcher,
    replacement: &str,
    file: &Value,
) -> Result<Staged, String> {
    let path = file["path"].as_str().unwrap_or("");
    let full = checkout_file(checkout, path)?;
    let (hash, text) = searchable(&full).ok_or("it can't be searched any more")?;
    if Some(hash.as_str()) != file["hash"].as_str() {
        return Err("it changed since the search".into());
    }
    let mut out = String::with_capacity(text.len());
    let (mut last, mut count) = (0, 0u64);
    for captures in matcher.regex.captures_iter(&text) {
        let Some(whole) = captures.get(0).filter(|whole| !whole.is_empty()) else {
            continue;
        };
        count += 1;
        out.push_str(&text[last..whole.start()]);
        match matcher.literal {
            true => out.push_str(replacement),
            false => captures.expand(replacement, &mut out),
        }
        last = whole.end();
    }
    out.push_str(&text[last..]);
    if Some(count) != file["matches"].as_u64() {
        return Err("its matches changed since the search".into());
    }
    let temp =
        write_beside(&full, out.as_bytes()).map_err(|e| format!("couldn't write it: {e}"))?;
    Ok(Staged {
        path: path.to_string(),
        aside: sibling(&full, "replaced"),
        full,
        hash,
        new_hash: self::hash(out.as_bytes()),
        matches: count,
        temp,
        hard_links: true,
    })
}

/// Probes a folder before any original moves: a hard link, or else an exclusive rename using only
/// the rewrite. A failed probe leaves every original untouched.
fn probe(file: &Staged) -> io::Result<bool> {
    let probe = sibling(&file.full, "replace-probe");
    if fs::hard_link(&file.temp, &probe).is_ok() {
        fs::remove_file(&probe)?;
        return Ok(true);
    }
    rename_into(&file.temp, &probe)?;
    let result = fs::rename(&probe, &file.temp);
    if result.is_err() {
        let _ = fs::remove_file(&probe);
    }
    result.map(|()| false)
}

/// Moves a rewrite or original into an empty path, refusing a concurrent writer atomically.
#[cfg(target_os = "macos")]
fn rename_into(from: &Path, to: &Path) -> io::Result<()> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let from = CString::new(from.as_os_str().as_bytes()).map_err(io::Error::other)?;
    let to = CString::new(to.as_os_str().as_bytes()).map_err(io::Error::other)?;
    // SAFETY: both paths are NUL-terminated and live for the whole call.
    match unsafe { libc::renamex_np(from.as_ptr(), to.as_ptr(), libc::RENAME_EXCL) } {
        0 => Ok(()),
        _ => Err(io::Error::last_os_error()),
    }
}

#[cfg(target_os = "linux")]
fn rename_into(from: &Path, to: &Path) -> io::Result<()> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let from = CString::new(from.as_os_str().as_bytes()).map_err(io::Error::other)?;
    let to = CString::new(to.as_os_str().as_bytes()).map_err(io::Error::other)?;
    // SAFETY: both paths are NUL-terminated and live for the whole call.
    let done = unsafe {
        libc::renameat2(
            libc::AT_FDCWD,
            from.as_ptr(),
            libc::AT_FDCWD,
            to.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    match done {
        0 => Ok(()),
        _ => Err(io::Error::last_os_error()),
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn rename_into(_: &Path, _: &Path) -> io::Result<()> {
    // Without an exclusive rename, the probe fails before an original moves.
    Err(io::ErrorKind::Unsupported.into())
}

/// Puts a staged rewrite in its file's place: the file moved aside, checked unchanged, and the
/// rewrite placed where nothing may have appeared meanwhile. On failure, whether the file was
/// moved aside (and so needs putting back).
fn place(file: &Staged) -> Result<(), (String, bool)> {
    fs::rename(&file.full, &file.aside).map_err(|e| (format!("couldn't move it: {e}"), false))?;
    let unchanged = fs::read(&file.aside).is_ok_and(|bytes| hash(&bytes) == file.hash);
    if !unchanged {
        let why = "it changed while the files were being replaced";
        return Err((why.into(), true));
    }
    // Both ways refuse a file that took the place meanwhile.
    let placed = match file.hard_links {
        true => fs::hard_link(&file.temp, &file.full),
        false => rename_into(&file.temp, &file.full),
    };
    placed.map_err(|e| {
        let reason = match e.kind() {
            io::ErrorKind::AlreadyExists => {
                "it was written again while the files were being replaced".into()
            }
            _ => format!("couldn't write it: {e}"),
        };
        (reason, true)
    })
}

/// Undoes a `place` that failed after moving the file aside. Nothing in its place now is this
/// write's: the file from before goes back only where nothing is. Where a newer save took its
/// place, that stays; the text from before goes too when it's just what was checked.
fn undo_place(file: &Staged, kept: &impl Fn(&Staged) -> PathBuf) -> Result<(), String> {
    let Err(undo) = restore(file, kept) else {
        return Ok(());
    };
    let taken = fs::symlink_metadata(&file.full).is_ok();
    if taken && fs::read(&file.aside).is_ok_and(|bytes| hash(&bytes) == file.hash) {
        let _ = fs::remove_file(&file.aside);
        return Ok(());
    }
    Err(undo)
}

/// Puts back a file `place` placed: its rewrite (if still as written) goes, and the file from
/// before comes back. When something else is in its place, both stay: why, and where the text
/// from before is.
fn put_back(file: &Staged, kept: &impl Fn(&Staged) -> PathBuf) -> Result<(), String> {
    match fs::read(&file.full) {
        Ok(bytes) if hash(&bytes) == file.new_hash => {
            fs::remove_file(&file.full).map_err(|e| format!("couldn't undo it: {e}"))?;
        }
        Ok(_) => {
            return Err(format!(
                "it changed while the files were being replaced; its text from before is in {}",
                kept(file).display()
            ));
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("couldn't undo it: {e}")),
    }
    restore(file, kept)
}

/// Moves a file moved aside back into its place, refusing anything that took the place.
fn restore(file: &Staged, kept: &impl Fn(&Staged) -> PathBuf) -> Result<(), String> {
    let restored = match file.hard_links {
        true => fs::hard_link(&file.aside, &file.full).and_then(|()| fs::remove_file(&file.aside)),
        false => rename_into(&file.aside, &file.full),
    };
    restored.map_err(|e| {
        let kept = kept(file);
        format!(
            "couldn't undo it ({e}); its text from before is in {}",
            kept.display()
        )
    })
}

/// Where a file's text from before stays when it can't go back: moved into `keep` (the session's
/// folder, so delete takes it [D35]), else beside it.
fn keep_aside(file: &Staged, keep: Option<&Path>) -> PathBuf {
    let Some(keep) = keep else {
        return file.aside.clone();
    };
    let name = file.full.file_name().unwrap_or_default().to_string_lossy();
    let to = keep.join(format!("{}-{name}", crate::adapters::uuid()));
    let moved = fs::create_dir_all(keep)
        .and_then(|()| fs::copy(&file.aside, &to))
        .and_then(|_| fs::remove_file(&file.aside));
    match moved {
        Ok(()) => to,
        Err(_) => {
            let _ = fs::remove_file(&to);
            file.aside.clone()
        }
    }
}

/// The checkout file at `path`, refused unless it's a plain file there: a listed link isn't
/// followed into a write to its target.
fn checkout_file(checkout: &Checkout, path: &str) -> Result<PathBuf, String> {
    let outside = || "it is not a file in the checkout".to_owned();
    let full = super::inside(checkout, path).map_err(|_| outside())?;
    // No link on the way either: resolved, it's the same path.
    match fs::canonicalize(&full) {
        Ok(real) if real == full && real.is_file() => Ok(full),
        _ => Err(outside()),
    }
}

/// A new hidden name beside `path` that no one else will guess.
fn sibling(path: &Path, what: &str) -> PathBuf {
    let name = path.file_name().unwrap_or_default().to_string_lossy();
    path.with_file_name(format!(".{name}.{what}-{}", crate::adapters::uuid()))
}

/// Writes `bytes` to a new file beside `path`, with its permissions.
fn write_beside(path: &Path, bytes: &[u8]) -> io::Result<PathBuf> {
    let temp = sibling(path, "replace");
    // Exclusive creation refuses existing files and links, even if a name is guessed.
    let mut out = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp)?;
    let result = (|| {
        out.write_all(bytes)?;
        out.sync_all()?;
        fs::set_permissions(&temp, fs::metadata(path)?.permissions())
    })();
    match result {
        Ok(()) => Ok(temp),
        Err(e) => {
            let _ = fs::remove_file(&temp);
            Err(e)
        }
    }
}
