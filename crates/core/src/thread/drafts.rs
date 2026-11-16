//! A `show_draft` card in its reply's row [D529].

use super::Thread;
use crate::adapters::s;
use serde_json::Value;

impl Thread {
    /// A `show_draft` card joins the reply row it follows, and so do the words after it, so the
    /// reply copies whole, in order [D525, D529]. True when it went into that row.
    pub(super) fn drafted(&mut self, item: &Value, kind: &str, ts: u64) -> bool {
        let n = self.items.len();
        let o = self.open.as_mut();
        let Some(o) = o.filter(|o| self.streaming.is_none() && o.answer == Some(n as u64)) else {
            return false;
        };
        let row = &mut self.items[n - 1];
        let was = row["text"].as_str().unwrap_or("").to_string();
        let card = |t: &str| {
            t.rfind(crate::norm::DRAFT)
                .is_some_and(|i| t[i..].matches('\n').count() == 2 && t.ends_with("```"))
        };
        let text = s(item, &["text"]);
        if row["role"] != "assistant"
            || !(card(text) || card(&was))
            || !matches!(kind, "text" | "text_delta")
        {
            return false;
        }
        let base = was + "\n\n";
        row["text"] = format!("{base}{text}").into();
        if kind == "text_delta" {
            (row["streaming"], o.after) = (true.into(), Some(base));
            self.streaming = Some(n - 1);
        } else {
            row["sentAt"] = ts.into();
        }
        self.changed_items.insert(n - 1);
        true
    }
}
