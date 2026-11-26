//! A plan's adversarial review [D385, §6]: with Settings › Routing's switch on as its turn started,
//! the first plan an agent asks to build waits on a reviewer of another agent (`to: review`),
//! never on its answerer. Its review's notes (`plan_review`: running, sent, done, off) move it on:
//! its findings go back as the reply that keeps the agent planning, and its next plan goes to its
//! answerer with the review's line, counts as said, never guessed [D74, D357]. One review per plan:
//! a plan built, or its turn ended, starts the next cycle.

use super::Fold;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Default, Serialize, Deserialize, Clone)]
pub struct Reviews {
    /// Adversarial review was on as its last turn started: its first plan waits on a review.
    #[serde(default)]
    pub on: bool,
    /// The review of the plan asked now: none yet, or `{state, by, name, findings, line}`.
    #[serde(default)]
    pub now: Value,
    /// Each that ran, `{findings, fixed, rejected}`, for the results [§8].
    #[serde(default)]
    pub done: Vec<Value>,
}

/// The number said after `key` on the last line that says one ("Findings: 4", "**Findings:** 4",
/// any case); none when no line does [D74]. A later line naming the key with no number ("no
/// findings: all passed") doesn't hide it.
pub fn count(text: &str, key: &str) -> Option<u64> {
    let text = text.to_lowercase();
    let key = key.trim_end_matches(':');
    text.lines().rev().find_map(|l| {
        let rest = l.split_once(key)?.1;
        // Markdown's marks around the key, but its colon said.
        let marks = |c: char| matches!(c, '*' | '_' | '`' | ':' | ' ' | '\t');
        let num = rest.trim_start_matches(marks);
        if !rest[..rest.len() - num.len()].contains(':') {
            return None;
        }
        let digits: String = num.chars().take_while(char::is_ascii_digit).collect();
        digits.parse().ok()
    })
}

/// "‹head› ‹model›: 4 findings, 3 fixed, 1 rejected", each count only where it was said.
pub fn reviewed(head: &str, r: &Value, fixed: Option<u64>, rejected: Option<u64>) -> String {
    let found = r["findings"].as_u64().map(|n| match n {
        0 => "no findings".to_string(),
        1 => "1 finding".into(),
        n => format!("{n} findings"),
    });
    let parts: Vec<String> = [
        found,
        fixed.map(|n| format!("{n} fixed")),
        rejected.map(|n| format!("{n} rejected")),
    ]
    .into_iter()
    .flatten()
    .collect();
    let model = r["model"].as_str().unwrap_or("another model");
    match parts.is_empty() {
        true => format!("{head} {model}"),
        false => format!("{head} {model}: {}", parts.join(", ")),
    }
}

const HEAD: &str = "Plan reviewed by";

impl Fold {
    /// Whether this request is a plan its review holds.
    pub(super) fn held_for_review(&self, item: &Value) -> bool {
        item["request"]["action"] == "plan" && self.plans.on && self.plans.now.is_null()
    }

    /// A plan asked after its review: the review's line rides on it, its fix counts read from the
    /// revised plan; the review is counted once, here [D357].
    pub(super) fn plan_asked(&mut self, request: &mut Value) {
        if request["action"] != "plan" {
            return;
        }
        if self.plans.now["state"] == "sent" {
            let body = request["body"].as_str().unwrap_or("");
            let (fixed, rejected) = (count(body, "fixed:"), count(body, "rejected:"));
            let r =
                json!({"findings": self.plans.now["findings"], "model": self.plans.now["name"]});
            self.plans
                .done
                .push(json!({"findings": r["findings"], "fixed": fixed, "rejected": rejected}));
            (self.plans.now["state"], self.plans.now["line"]) =
                ("done".into(), reviewed(HEAD, &r, fixed, rejected).into());
        }
        if let Some(line) = self.plans.now["line"].as_str() {
            request["reviewed"] = line.into();
        }
    }

    /// A `plan_review` note, for the plan it holds: its reviewer started, its findings go back,
    /// or it lets the plan go to its answerer, with no findings or saying why it didn't run.
    pub(super) fn plan_review(&mut self, item: &Value) {
        let id = item["id"].as_str().unwrap_or("");
        let held = (self.turns.first())
            .is_some_and(|t| t.asks.get(id).is_some_and(|r| r["to"] == "review"));
        // Its findings' reply can fail after they were said to go.
        let open = matches!(
            self.plans.now["state"].as_str(),
            None | Some("running" | "sent")
        );
        if !held || !open {
            return;
        }
        let name = &item["name"];
        let line = match item["phase"].as_str() {
            Some("running") => {
                self.plans.now = json!({"state": "running", "by": item["by"], "name": name});
                let r = self.turns[0].asks.get_mut(id);
                r.into_iter()
                    .for_each(|r| r["review"] = json!({"by": item["by"], "name": name}));
                return;
            }
            Some("sent") => {
                (self.plans.now["state"], self.plans.now["findings"]) =
                    ("sent".into(), item["findings"].clone());
                return;
            }
            Some("done") => {
                let r = json!({"findings": item["findings"], "model": name});
                self.plans
                    .done
                    .push(json!({"findings": r["findings"], "fixed": null, "rejected": null}));
                reviewed(HEAD, &r, None, None)
            }
            Some("off") => {
                let word = if item["ran"] == true { "finish" } else { "run" };
                format!(
                    "Review didn't {word}: {}",
                    item["why"].as_str().unwrap_or("")
                )
            }
            _ => return,
        };
        self.plans.now = json!({"state": "done", "line": line});
        let parent = self.for_parent(&json!({"kind": "approval"}));
        if let Some(r) = self.turns[0].asks.get_mut(id) {
            r["reviewed"] = line.into();
            r.as_object_mut().map(|r| r.remove("review"));
            match parent {
                true => r["to"] = "parent".into(),
                false => _ = r.as_object_mut().map(|r| r.remove("to")),
            }
        }
    }

    /// A plan's request leaves: built, the next plan is reviewed again; one its review held that
    /// ends otherwise (its turn stopped) takes its review with it.
    pub(super) fn plan_left(&mut self, request: &Value, decision: &Value, by: &Value) {
        if request["action"] != "plan" {
            return;
        }
        let review = request["to"] == "review" && by != "review";
        if decision == "allow" || review {
            self.plans.now = Value::Null;
        }
    }
}
