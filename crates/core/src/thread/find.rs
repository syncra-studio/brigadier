//! Find in the conversation, for the rows the view hasn't loaded [D470]: the old app's engine
//! search [D48], over the same words the view's own find reads (`thread/find-text.ts`).

use super::Thread;
use serde_json::{Value, json};

/// What a row says, as find reads it while not drawn: the words it shows, not every label.
fn words(item: &Value) -> Vec<&str> {
    let text = |key: &str| item[key].as_str();
    let fields: Vec<Option<&str>> = match item["kind"].as_str() {
        Some("message") | Some("notice") => vec![text("text")],
        Some("tool") => vec![text("name"), text("input")],
        Some("question") => vec![text("question"), text("answer")],
        Some("childAgent") => vec![text("title"), text("answer")],
        Some("fileChange") => item["changes"]
            .as_array()
            .map_or(vec![], |c| c.iter().map(|c| c["path"].as_str()).collect()),
        _ => vec![],
    };
    fields.into_iter().flatten().collect()
}

impl Thread {
    /// Where `query` is, case aside, in the rows older than row `before` (an `n`): each row's `n`
    /// and how many times, oldest first, counted from the newest up to `limit` in all; `more` when
    /// it stopped there.
    pub fn find(&self, before: u64, query: &str, limit: usize) -> Value {
        let needle = query.to_lowercase();
        let (mut matches, mut more, mut left) = (vec![], false, limit);
        for item in self.items.iter().rev() {
            let Some(n) = item["n"].as_u64() else {
                continue;
            };
            if needle.is_empty() || n >= before || item["hidden"] == true {
                continue;
            }
            let count: usize = words(item)
                .iter()
                .map(|w| w.to_lowercase().matches(&needle).count())
                .sum();
            let take = count.min(left);
            if take > 0 {
                matches.push(json!({"n": n, "count": take}));
                left -= take;
            }
            if count > take {
                more = true;
                break;
            }
        }
        matches.reverse();
        json!({"matches": matches, "more": more})
    }
}
