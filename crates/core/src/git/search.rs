//! Search across a checkout [D1003], ported from the old app's `manager/search.rs`: the text or
//! pattern found file by file in the files git lists (ignored files and `.git` stay out), sent in
//! batches as it goes and stopped when a newer search starts. Replace all is `replace`.

use super::{Checkout, files::listed};
use globset::{GlobBuilder, GlobSet, GlobSetBuilder};
use regex::{Regex, RegexBuilder};
use serde_json::{Value, json};
use std::fs;
use std::hash::{DefaultHasher, Hasher};
use std::io;
use std::path::Path;
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
    pub(super) regex: Regex,
    /// Literal text replaces as it is: `$` means `$`.
    pub(super) literal: bool,
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
    pub(super) fn wants(&self, path: &str) -> bool {
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
pub(super) fn searchable(path: &Path) -> Option<(String, String)> {
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
pub(super) fn hash(bytes: &[u8]) -> String {
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
        // A tracked folder replaced by a link out of the checkout isn't followed.
        let Some((hash, text)) = super::inside(checkout, &path)
            .ok()
            .and_then(|full| searchable(&full))
        else {
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
