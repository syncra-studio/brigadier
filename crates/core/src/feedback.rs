//! Send feedback, the old app's flow [D2100]: what the user wrote, turned by a writer into reports
//! in the shape of Brigadier's issue forms, one per bug or idea, each checked against the
//! repository's existing issues, then filed as the user with their own `gh`. The writer judges (the
//! split, the kind, the fields, which issue it repeats); this plumbs: the prompts, reading its
//! reply, and the text each issue or comment is filed with. The CLI's `feedback` runs it all.

use serde::{Deserialize, Serialize};
use serde_json::Value;

mod issue;
pub use issue::{issue_body, issue_title, repeat_comment};

/// Brigadier's repository, `owner/name`: where feedback is filed [D2017].
pub const REPO: &str = "syncra-studio/brigadier";

/// A bug's Area, as the old app's bug form listed it, less the parts this app doesn't have, each
/// with what it covers for the writer: an area is picked only when the bug plainly sits in it.
const AREAS: [(&str, &str); 6] = [
    (
        "Sessions, workers, landing or review",
        "a session's conversation, its workers or jobs, landing or reviewing their changes",
    ),
    (
        "Accounts, usage or routing",
        "the agents' accounts, usage and limits, which account or model a task goes to",
    ),
    (
        "Terminal, files or source",
        "the terminal, the file tree and editor, git and diffs",
    ),
    (
        "Settings, onboarding or uninstall",
        "Settings, the first-launch screens, removing the app",
    ),
    ("Build from source", "building Brigadier from its source"),
    (
        "Other",
        "everything else, the app's frame too: the sidebar, tabs, windows, menus, switching projects, the look",
    ),
];

/// The most reports one note becomes.
const MAX_REPORTS: usize = 10;
/// The most issues one report is checked against, by their text.
const MAX_CANDIDATES: usize = 3;
/// Most issues a new one names as maybe related.
const MAX_RELATED: usize = 3;
/// A title is cut past this many characters.
const MAX_TITLE: usize = 90;
/// A field is cut past this many characters.
const MAX_FIELD: usize = 4000;
/// How much of an existing issue's text the duplicate check reads.
const ISSUE_BODY_CHARS: usize = 2000;
/// How much of the user's note the writer reads.
const NOTE_CHARS: usize = 8000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Bug,
    Idea,
}

/// One report the writer made of the user's note, in its form's fields; the other kind's fields
/// stay empty. Written in the user's words: what they didn't say reads "Not given".
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Report {
    pub kind: Kind,
    /// One line, without the form's "[Bug]: " prefix.
    pub title: String,
    pub area: String,
    pub steps: String,
    pub expected: String,
    /// What happened.
    pub actual: String,
    /// An idea's: what they're trying to do, and what gets in the way.
    pub problem: String,
    /// What they do today.
    pub today: String,
    /// What should happen instead.
    pub wanted: String,
    /// The open issue of its kind it repeats, when the check was sure: a note goes there instead.
    pub duplicate: Option<Duplicate>,
    /// Issues close to it that it doesn't repeat: a new issue names them as maybe related.
    pub related: Vec<u64>,
    /// Whether the existing issues could be searched for one it repeats.
    pub searched: bool,
}

/// An existing issue a report repeats, and the note for it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Duplicate {
    pub number: u64,
    pub title: String,
    pub url: String,
    pub open: bool,
    /// The note for it: the report's own fields, so only what the user wrote.
    pub comment: String,
}

/// An issue of the repository as listed: enough to name it to the writer.
#[derive(Debug, Clone)]
pub struct Issue {
    pub number: u64,
    pub title: String,
    pub open: bool,
    pub url: String,
    /// Its form's kind, by its label or title prefix; `None` when it has neither.
    pub kind: Option<Kind>,
}

/// An issue's kind by its labels (`bug`, `proposal`), else its form's title prefix.
pub fn kind_of<'a>(title: &str, labels: impl IntoIterator<Item = &'a str>) -> Option<Kind> {
    for label in labels {
        match label.trim().to_ascii_lowercase().as_str() {
            "bug" => return Some(Kind::Bug),
            "proposal" => return Some(Kind::Idea),
            _ => {}
        }
    }
    let title = title.trim_start().to_ascii_lowercase();
    match () {
        _ if title.starts_with("[bug]") => Some(Kind::Bug),
        _ if title.starts_with("[proposal]") => Some(Kind::Idea),
        _ => None,
    }
}

fn kind_word(kind: Kind) -> &'static str {
    match kind {
        Kind::Bug => "bug",
        Kind::Idea => "idea",
    }
}

/// The writer's instructions: the note becomes reports, with candidates for the duplicate check.
pub fn write_prompt() -> String {
    let areas = (AREAS.iter())
        .map(|(area, covers)| format!("  \"{area}\": {covers}"))
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        "You turn a note a user wrote about Brigadier (a desktop app that runs AI coding agents' \
sessions) into issue reports for its developers. Don't use any tool: everything you need is below. \
Reply with JSON only, no code fences: \
{{\"reports\":[{{\"kind\":\"bug\",\"title\":\"\",\"area\":\"\",\"steps\":\"\",\"expected\":\"\",\
\"actual\":\"\",\"problem\":\"\",\"today\":\"\",\"wanted\":\"\",\"candidates\":[]}}]}}\n\
Rules:\n\
- One report per separate bug or idea in the note; most notes hold one. Never put two problems \
in one report, never split one problem in two.\n\
- kind: \"bug\" for something Brigadier does wrong, \"idea\" for something missing or a change \
in how it behaves.\n\
- title: one plain line naming it, at most 70 characters, no prefix.\n\
- A bug fills area, steps (to reproduce), expected and actual (what happened). area is exactly \
one of the bug form's options below, read literally: the one the bug plainly sits in, by where \
it shows, not what it might touch. When none fits plainly, \"Other\".\n{areas}\n\
- An idea fills problem (what they're trying to do and what gets in the way), today \
(what they do now) and wanted (what should happen instead). Leave the other kind's fields \"\".\n\
- Use only what the note says, in plain words close to the user's own. Never invent steps, \
versions, errors or details, and never take any from the issue list. What the note doesn't say \
reads \"Not given.\"; steps it doesn't give read \"Not given; see What happened.\"\n\
- Leave out secrets, emails, tokens and file paths.\n\
- candidates: the numbers of up to 3 existing issues listed below (open or closed) that may be \
about the same thing, closest first; [] when none come close."
    )
}

/// The writer's turn: the note, and the repository's issues when they could be read.
pub fn write_turn(note: &str, issues: Option<&[Issue]>) -> String {
    let note: String = note.trim().chars().take(NOTE_CHARS).collect();
    let mut text = format!("The note:\n<<<\n{note}\n>>>\n\n");
    match issues {
        Some([]) => text.push_str("Brigadier has no issues yet."),
        Some(issues) => {
            text.push_str("Brigadier's existing issues (number, state, title):");
            for issue in issues {
                let state = if issue.open { "open" } else { "closed" };
                text.push_str(&format!("\n#{} {state}: {}", issue.number, issue.title));
            }
        }
        None => text.push_str("The existing issues couldn't be read: give no candidates."),
    }
    text
}

/// The duplicate check's instructions. It only judges; which match becomes a comment is
/// [`mark_duplicates`]'s rule (an open issue of the report's own kind).
pub const JUDGE_PROMPT: &str = "You decide whether new reports about Brigadier repeat \
an existing GitHub issue. Don't use any tool: everything you need is below. Reply with JSON only, \
no code fences: {\"matches\":[{\"report\":0,\"issue\":123,\"issueKind\":\"bug\",\"same\":false}]}\n\
Rules:\n\
- List a report with an issue only when the issue is close to it: the same problem or wish, \
or one very like it. Same part of the app alone is not close. Reports with no close issue are \
left out.\n\
- same: true only when the issue describes the very same specific thing: the same behaviour \
going wrong in the same way, or the same wish. A broader, narrower or neighbouring problem \
is not the same (a stop that fails during setup is not every stop failing). When unsure, \
false: the report is filed as a new issue that links this one.\n\
- A bug is never the same as an idea, nor an idea as a bug.\n\
- issueKind: \"bug\" when the issue reports something Brigadier does wrong, \"idea\" when it \
asks for something new or a change.";

/// The duplicate check's turn: each report with the issues it may repeat, their text read.
pub fn judge_turn(reports: &[(Report, Vec<u64>)], bodies: &[(Issue, String)]) -> String {
    let mut text = String::new();
    for (index, (report, candidates)) in reports.iter().enumerate() {
        if candidates.is_empty() {
            continue;
        }
        let kind = kind_word(report.kind);
        text.push_str(&format!("Report {index} ({kind}): {}\n", report.title));
        for (label, field) in [
            ("Steps", &report.steps),
            ("Expected", &report.expected),
            ("What happened", &report.actual),
            ("The problem", &report.problem),
            ("Wanted", &report.wanted),
        ] {
            if !field.is_empty() {
                text.push_str(&format!("{label}: {field}\n"));
            }
        }
        text.push_str("May repeat:\n");
        for number in candidates {
            if let Some((issue, body)) = bodies.iter().find(|(issue, _)| issue.number == *number) {
                let state = if issue.open { "open" } else { "closed" };
                let body: String = body.chars().take(ISSUE_BODY_CHARS).collect();
                let kind = issue.kind.map_or("kind not marked", kind_word);
                text.push_str(&format!(
                    "--- issue #{} ({state}, {kind}): {}\n{body}\n---\n",
                    issue.number, issue.title
                ));
            }
        }
        text.push('\n');
    }
    text
}

/// The JSON object in a reply: code fences and words around it dropped.
fn json_in(reply: &str) -> Option<Value> {
    let (start, end) = (reply.find('{')?, reply.rfind('}')?);
    serde_json::from_str(reply.get(start..=end)?).ok()
}

fn cut(text: &str, max: usize) -> String {
    let text = text.trim();
    if text.chars().count() <= max {
        return text.to_owned();
    }
    let kept: String = text.chars().take(max - 1).collect();
    format!("{}…", kept.trim_end())
}

/// The writer's reply as reports, each with the issue numbers it may repeat (only listed ones, at
/// most [`MAX_CANDIDATES`]). A bug's area outside the list reads "Other"; the other kind's fields
/// are emptied. A reply with no report is an error.
pub fn reports_of(
    reply: &str,
    issues: Option<&[Issue]>,
) -> Result<Vec<(Report, Vec<u64>)>, String> {
    #[derive(Deserialize)]
    struct Reply {
        #[serde(default)]
        reports: Vec<Raw>,
    }
    #[derive(Deserialize, Default)]
    #[serde(default)]
    struct Raw {
        kind: String,
        title: String,
        area: String,
        steps: String,
        expected: String,
        actual: String,
        problem: String,
        today: String,
        wanted: String,
        candidates: Vec<Value>,
    }
    let reply: Reply = json_in(reply)
        .and_then(|value| serde_json::from_value(value).ok())
        .ok_or("the report writer's reply couldn't be read")?;
    let listed = issues.unwrap_or(&[]);
    let reports: Vec<_> = (reply.reports.into_iter())
        .filter(|raw| !raw.title.trim().is_empty())
        .take(MAX_REPORTS)
        .map(|raw| {
            let kind = match raw.kind.trim().eq_ignore_ascii_case("idea") {
                true => Kind::Idea,
                false => Kind::Bug,
            };
            let field = |text: &str, of: Kind| match kind == of {
                true => cut(text, MAX_FIELD),
                false => String::new(),
            };
            let area = match kind {
                Kind::Bug => (AREAS.iter().map(|(area, _)| *area))
                    .find(|area| area.eq_ignore_ascii_case(raw.area.trim()))
                    .unwrap_or("Other")
                    .to_string(),
                Kind::Idea => String::new(),
            };
            let mut candidates: Vec<u64> = Vec::new();
            for number in raw.candidates.iter().filter_map(|value| {
                (value.as_u64()).or_else(|| value.as_str()?.trim_start_matches('#').parse().ok())
            }) {
                if listed.iter().any(|issue| issue.number == number)
                    && !candidates.contains(&number)
                    && candidates.len() < MAX_CANDIDATES
                {
                    candidates.push(number);
                }
            }
            let report = Report {
                kind,
                title: cut(&raw.title.replace(['\n', '\r'], " "), MAX_TITLE),
                area,
                steps: field(&raw.steps, Kind::Bug),
                expected: field(&raw.expected, Kind::Bug),
                actual: field(&raw.actual, Kind::Bug),
                problem: field(&raw.problem, Kind::Idea),
                today: field(&raw.today, Kind::Idea),
                wanted: field(&raw.wanted, Kind::Idea),
                duplicate: None,
                related: Vec::new(),
                searched: issues.is_some(),
            };
            (report, candidates)
        })
        .collect();
    if reports.is_empty() {
        return Err("the report writer made no report".into());
    }
    Ok(reports)
}

/// Marks what the duplicate check's `reply` matched, among the issues each report was checked
/// against. A report repeats (and becomes a comment on) an issue only when the check says it is
/// the same thing, the issue is open, and it is of the report's kind: by its label or title
/// prefix, else as the check read it. Any other match is named as maybe related. An unreadable
/// reply marks none, so every report is filed new.
pub fn mark_duplicates(
    reports: &mut [(Report, Vec<u64>)],
    reply: &str,
    bodies: &[(Issue, String)],
) {
    #[derive(Deserialize)]
    struct Reply {
        #[serde(default)]
        matches: Vec<Raw>,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Raw {
        report: usize,
        issue: u64,
        #[serde(default)]
        issue_kind: String,
        #[serde(default)]
        same: bool,
    }
    let Some(reply) = json_in(reply).and_then(|value| serde_json::from_value::<Reply>(value).ok())
    else {
        eprintln!(
            "feedback: the duplicate check's reply couldn't be read; filing every report new"
        );
        return;
    };
    for raw in reply.matches {
        let Some((report, candidates)) = reports.get_mut(raw.report) else {
            continue;
        };
        let Some((issue, _)) = (bodies.iter())
            .find(|(issue, _)| issue.number == raw.issue && candidates.contains(&raw.issue))
        else {
            continue;
        };
        let read_kind = match raw.issue_kind.trim().to_ascii_lowercase().as_str() {
            "bug" => Some(Kind::Bug),
            "idea" | "proposal" => Some(Kind::Idea),
            _ => None,
        };
        let same_kind = issue.kind.or(read_kind) == Some(report.kind);
        if raw.same && issue.open && same_kind && report.duplicate.is_none() {
            report.related.retain(|number| *number != issue.number);
            report.duplicate = Some(Duplicate {
                number: issue.number,
                title: issue.title.clone(),
                url: issue.url.clone(),
                open: issue.open,
                comment: repeat_note(report),
            });
        } else if report.duplicate.as_ref().map(|d| d.number) != Some(issue.number)
            && !report.related.contains(&issue.number)
            && report.related.len() < MAX_RELATED
        {
            report.related.push(issue.number);
        }
    }
}

/// What a repeat says on its issue: that it was seen again, then the report's own fields (what the
/// user wrote, nothing of the issue's), leaving out what the note didn't give.
fn repeat_note(report: &Report) -> String {
    let (head, fields) = match report.kind {
        Kind::Bug => (
            "Seen again.",
            [
                ("What happened", &report.actual),
                ("Expected", &report.expected),
                ("Steps to reproduce", &report.steps),
            ],
        ),
        Kind::Idea => (
            "Asked for again.",
            [
                ("The problem", &report.problem),
                ("What they do today", &report.today),
                ("What should happen instead", &report.wanted),
            ],
        ),
    };
    let lines: Vec<String> = (fields.iter())
        .map(|(label, value)| (label, value.trim()))
        .filter(|(_, value)| !value.is_empty() && !value.starts_with("Not given"))
        .map(|(label, value)| format!("{label}: {value}"))
        .collect();
    match lines.is_empty() {
        true => head.to_owned(),
        false => format!("{head}\n\n{}", lines.join("\n")),
    }
}
