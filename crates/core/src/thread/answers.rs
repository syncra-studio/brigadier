//! The answers to the user's own messages stay out of their block's work fold [D57].

use super::{Open, Thread};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeSet;

#[derive(Default, Clone, Serialize, Deserialize)]
pub(super) struct Answers {
    /// The first message its running turn took, by `n`, and how many its block took.
    asked: Option<u64>,
    took: usize,
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
    /// once it took several messages: a lone one's is its last reply [D118].
    pub(super) fn kept_till(&self, answer: u64) -> Vec<u64> {
        let replies = self
            .answers
            .replies
            .iter()
            .filter(|_| self.answers.took > 1);
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
            o.answers.took += 1;
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
            o.answers.took += 1;
            // Kept to carry on from, as the held one is.
            if let Some(ended) = self.ended.as_mut().filter(|e| e.id == o.id) {
                ended.answers.took += 1;
            }
            if let (Some(answer), false) = (o.answer, work.is_null()) {
                work["kept"] = o.kept_till(answer).into();
            }
        }
    }
}
