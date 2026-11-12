//! The text each report is filed with: a new issue's title and body in the shape of Brigadier's
//! issue forms, or the comment a repeat adds to its issue, as the old app wrote them [D2100].

use super::{Kind, Report};

/// A report's issue title, with its form's prefix.
pub fn issue_title(report: &Report) -> String {
    let prefix = match report.kind {
        Kind::Bug => "[Bug]",
        Kind::Idea => "[Proposal]",
    };
    format!("{prefix}: {}", report.title)
}

/// What goes with feedback, as one line: "Brigadier 0.1.0, macOS 27.0 (arm64), Claude Code 2.1.4".
/// `details` is that list, the app's version first, then the system and the agent CLIs found.
fn environment(details: &[String]) -> String {
    details
        .iter()
        .skip(1)
        .cloned()
        .collect::<Vec<_>>()
        .join(", ")
}

/// A report's issue body, as its form would render it: where it came from (and the issues it's
/// close to but doesn't repeat), then each field under its heading ("_No response_" when empty, as
/// GitHub writes it). The forms' "Before you file" boxes are left out: the reporter didn't tick them.
pub fn issue_body(report: &Report, version: &str, details: &[String]) -> String {
    let from = match report.searched {
        true => {
            "_Filed from Brigadier’s Send feedback, written up from the reporter’s note. Brigadier searched open and closed issues for a duplicate first._"
        }
        false => {
            "_Filed from Brigadier’s Send feedback, written up from the reporter’s note. Brigadier couldn’t search the issues for a duplicate._"
        }
    };
    let env = environment(details);
    let fields: Vec<(&str, &str)> = match report.kind {
        Kind::Bug => vec![
            ("Version or commit", version),
            ("Environment", &env),
            ("Area", &report.area),
            ("Steps to reproduce", &report.steps),
            ("Expected", &report.expected),
            ("What happened", &report.actual),
            (
                "AI assistance",
                "Written up by Brigadier from the reporter’s own words.",
            ),
        ],
        Kind::Idea => vec![
            ("The problem", &report.problem),
            ("What you do today", &report.today),
            ("What should happen instead", &report.wanted),
        ],
    };
    let mut parts = vec![from.to_string()];
    if !report.related.is_empty() {
        let related: Vec<String> = report.related.iter().map(|n| format!("#{n}")).collect();
        parts.push(format!("Maybe related: {}", related.join(", ")));
    }
    for (label, value) in fields {
        let value = match value.trim() {
            "" => "_No response_",
            value => value,
        };
        parts.push(format!("### {label}\n\n{value}"));
    }
    parts.join("\n\n")
}

/// The comment a repeat adds to the issue it repeats, with the versions it was seen on.
pub fn repeat_comment(report: &Report, details: &[String]) -> String {
    let note = (report.duplicate.as_ref())
        .map(|d| d.comment.trim())
        .filter(|c| !c.is_empty())
        .unwrap_or("Seen again.");
    let mut parts = vec!["_Reported again from Brigadier’s Send feedback._", note];
    let seen = format!("Seen on: {}", details.join(", "));
    if !details.is_empty() {
        parts.push(&seen);
    }
    parts.join("\n\n")
}
