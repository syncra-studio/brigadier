//! The answers to the user's own messages stay out of their block's work fold [D57].

use super::{Open, Thread};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeSet;

#[derive(Default, Clone, Serialize, Deserialize)]
pub(super) struct Answers {
    /// The first message its running turn took, by `n`.
    asked: Option<u64>,
    /// One came after the request that opened its block, whoever made that.
    followed: bool,
    /// The last reply of each turn that took some and ended well, by `n`.
    replies: Vec<u64>,
}

impl Open {
    /// Its running turn ended: its last reply answers the user's messages it took, when it ended
    /// well. A cut one's are its carry-on's to answer.
    pub(super) fn answered(&mut self, done: bool) {
        let asked = if self.cut() {
            None
        } else {
            self.answers.asked.take()
        };
        let reply = self.answer.filter(|&a| asked.is_some_and(|n| a > n));
        self.answers.replies.extend(reply.filter(|_| done));
    }

    /// `n` of its rows before its last reply that stay out of its work fold, those answers too
    /// once it was followed up: till then the block's answer is its last reply [D118].
    pub(super) fn kept_till(&self, answer: u64) -> Vec<u64> {
        let replies = self
            .answers
            .replies
            .iter()
            .filter(|_| self.answers.followed);
        let kept: BTreeSet<u64> = self.kept.iter().chain(replies).copied().collect();
        kept.range(..answer).copied().collect()
    }
}

impl Thread {
    /// A row added: the user's own message is one its block took.
    pub(super) fn asked(&mut self, row: &Value, n: u64) {
        let user = row["kind"] == "message" && row["role"] == "user" && row["origin"] == "user";
        if let Some(o) = self.open.as_mut().filter(|_| user) {
            o.answers.asked.get_or_insert(n);
            o.answers.followed |= row["cid"] != o.id.as_str();
        }
    }

    /// An item a rewind dropped: the user's message into a held block still counts as its, so the
    /// answer that message let out of the fold stays out [D57].
    pub(super) fn dropped(&mut self, item: &Value) {
        let user = item["kind"] == "input" && item["origin"] == "user";
        let last = self.turns.last().and_then(|t| t["id"].as_str());
        let Some(id) = last.filter(|_| user && !item["control"].is_object()) else {
            return;
        };
        let holds = self.helpers(id) > 0 || self.working();
        if let Some((o, work)) = (self.held.get_mut(id)).filter(|(o, _)| holds && !o.cut()) {
            o.answers.followed = true;
            // Kept to carry on from, as the held one is.
            if let Some(ended) = self.ended.as_mut().filter(|e| e.id == o.id) {
                ended.answers.followed = true;
            }
            if let (Some(answer), false) = (o.answer, work.is_null()) {
                work["kept"] = o.kept_till(answer).into();
            }
        }
    }

    /// A running or held block's rows its fold would leave out, on its turn as they change: shut by
    /// the user, it hides only its work, as once it folds [D63].
    pub(super) fn show_kept(&mut self) {
        let blocks = self.open.iter().chain(self.held.values().map(|(o, _)| o));
        let lists: Vec<_> = blocks
            .map(|o| (o.at, json!(o.kept_till(u64::MAX))))
            .collect();
        for (at, kept) in lists {
            if self.turns[at]["kept"] != kept {
                self.turns[at]["kept"] = kept;
                self.changed_turns.insert(at);
            }
        }
    }
}
