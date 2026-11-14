//! A PR's Conversation as GitHub draws it, from the page's one read (`view`) [D260].

use super::view::ms;
use serde_json::{Value, json};

pub(super) fn nodes(v: &Value) -> Vec<Value> {
    v["nodes"].as_array().cloned().unwrap_or_default()
}

/// GitHub's own mark for an app's account.
pub(super) fn bot(actor: &Value) -> bool {
    actor["__typename"] == "Bot"
}

/// Why GitHub hides a comment or review ("outdated", "resolved"…), shown on a click; None when shown.
pub(super) fn hidden(c: &Value) -> Option<String> {
    (c["isMinimized"] == true).then(|| {
        c["minimizedReason"]
            .as_str()
            .unwrap_or("hidden")
            .to_lowercase()
    })
}

/// A PR's or an issue's state as the tab names it.
pub(super) fn state_of(pr: &Value) -> &'static str {
    match (pr["state"].as_str(), pr["isDraft"] == true) {
        (Some("MERGED"), _) => "merged",
        (Some("CLOSED"), _) => "closed",
        (_, true) => "draft",
        _ => "open",
    }
}

/// The Conversation as GitHub draws it under the description, oldest first [D260]: commits, comments
/// (by id, in `comments`), reviews with the threads they started, and events. A run of one person's
/// commits, or of their review requests, is one item. A review that only answered others' threads
/// shows in those threads, not on its own, as on GitHub.
pub(super) fn timeline(
    pr: &Value,
    commits: &[Value],
    reviews: &[Value],
    threads: &[Value],
) -> Vec<Value> {
    let events = nodes(&pr["timelineItems"]);
    let at = |e: &Value| ms(&e["createdAt"]).unwrap_or(0);
    let merges: Vec<u64> = (events.iter())
        .filter(|e| e["__typename"] == "MergedEvent")
        .map(at)
        .collect();
    let mut items: Vec<Value> = (commits.iter())
        .map(|c| json!({"kind": "commit", "id": c["sha"], "atMs": c["atMs"], "actor": c["author"], "commit": c}))
        .chain(nodes(&pr["talk"]).iter().map(|c| {
            json!({"kind": "comment", "id": c["databaseId"].to_string(), "atMs": ms(&c["createdAt"])})
        }))
        .collect();
    for r in reviews {
        let state = match r["state"].as_str() {
            Some("APPROVED") => "approved",
            Some("CHANGES_REQUESTED") => "changes",
            Some("COMMENTED") => "commented",
            Some("DISMISSED") => "dismissed",
            _ => continue,
        };
        let started: Vec<Value> = (threads.iter())
            .filter_map(|t| {
                let said = nodes(&t["comments"]);
                let first = said.first()?;
                (first["pullRequestReview"]["databaseId"] == r["databaseId"]).then(|| {
                    json!({"id": t["id"], "path": first["path"], "resolved": t["isResolved"],
                        "outdated": t["isOutdated"],
                        "comments": said.iter().map(|c| format!("r{}", c["databaseId"])).collect::<Vec<_>>()})
                })
            })
            .collect();
        let said = r["body"].as_str().is_some_and(|b| !b.trim().is_empty());
        if state == "commented" && !said && started.is_empty() {
            continue;
        }
        // A dismissed review says what it was: "previously approved these changes".
        let was = (events.iter())
            .find(|e| e["review"]["databaseId"] == r["databaseId"])
            .and_then(|e| e["previousReviewState"].as_str())
            .map(|s| {
                if s == "APPROVED" {
                    "approved"
                } else {
                    "changes"
                }
            });
        items.push(
            json!({"kind": "review", "id": format!("v{}", r["databaseId"]),
            "atMs": ms(&r["submittedAt"]), "actor": r["author"]["login"], "bot": bot(&r["author"]),
            "state": state, "was": was, "said": said, "threads": started,
            "minimized": hidden(r)}),
        );
    }
    for e in &events {
        let kind = match e["__typename"].as_str().unwrap_or("") {
            "ReviewRequestedEvent" => {
                let asked = &e["requestedReviewer"];
                json!({"kind": "requested", "who": [asked["login"].as_str().or(asked["name"].as_str())]})
            }
            "ReviewDismissedEvent" => json!({"kind": "dismissed",
                "who": e["review"]["author"]["login"], "sha": e["pullRequestCommit"]["commit"]["oid"]}),
            "DeployedEvent" => {
                let d = &e["deployment"];
                let status = &d["latestStatus"];
                json!({"kind": "deployed", "env": d["environment"],
                    "url": status["environmentUrl"].as_str().or(status["logUrl"].as_str())})
            }
            "CrossReferencedEvent" => {
                let s = &e["source"];
                json!({"kind": "mentioned", "number": s["number"], "title": s["title"],
                    "url": s["url"], "state": state_of(s)})
            }
            "MergedEvent" => {
                json!({"kind": "merged", "sha": e["commit"]["oid"], "base": e["mergeRefName"]})
            }
            "HeadRefDeletedEvent" => json!({"kind": "deleted", "branch": e["headRefName"]}),
            // GitHub says nothing of the close a merge makes.
            "ClosedEvent" if merges.iter().any(|m| m.abs_diff(at(e)) < 10_000) => continue,
            "ClosedEvent" => json!({"kind": "closed"}),
            "ReopenedEvent" => json!({"kind": "reopened"}),
            "ReadyForReviewEvent" => json!({"kind": "ready"}),
            "ConvertToDraftEvent" => json!({"kind": "draft"}),
            "HeadRefForcePushedEvent" => json!({"kind": "force_pushed"}),
            _ => continue,
        };
        let mut item = json!({"id": e["id"], "atMs": ms(&e["createdAt"]),
            "actor": e["actor"]["login"], "bot": bot(&e["actor"])});
        item.as_object_mut()
            .unwrap()
            .extend(kind.as_object().unwrap().clone());
        items.push(item);
    }
    items.sort_by_key(|i| i["atMs"].as_u64());
    let mut out: Vec<Value> = Vec::new();
    for mut item in items {
        if let Some(last) = out.last_mut()
            && last["actor"] == item["actor"]
            && let Some(more) = match (last["kind"].as_str(), item["kind"].as_str()) {
                (Some("commits"), Some("commit")) => Some(("commits", item["commit"].take())),
                (Some("requested"), Some("requested")) => Some(("who", item["who"][0].take())),
                _ => None,
            }
        {
            last[more.0].as_array_mut().unwrap().push(more.1);
            continue;
        }
        if item["kind"] == "commit" {
            item = json!({"kind": "commits", "id": item["id"], "atMs": item["atMs"],
                "actor": item["actor"], "commits": [item["commit"]]});
        }
        out.push(item);
    }
    out
}
