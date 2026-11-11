//! What the fold keeps for rewinding [D384]: each finished turn's place in its CLI's own record.

use super::{Fold, Turn};
use crate::adapters::{self, Cut};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// One finished turn: the Brigadier input it answers and where it sits in the CLI's record.
#[derive(Default, Serialize, Deserialize, Clone)]
pub struct Boundary {
    pub cid: String,
    pub origin: String,
    pub backend: String,
    pub account: String,
    /// The conversation it ran in.
    pub conv: String,
    pub generation: u64,
    /// It started on its own: not mid-turn, not carrying a switch.
    pub whole: bool,
    pub start: Option<String>,
    pub end: Option<String>,
}

impl Fold {
    /// A turn the CLI really ran; one refused before any output has no place in its record.
    pub(super) fn bound(&mut self, t: &Turn) {
        if !t.began {
            return;
        }
        self.boundaries.push(Boundary {
            cid: t.id.clone(),
            origin: t.origin.clone(),
            backend: t.backend.clone(),
            account: self.accounts.get(&t.backend).cloned().unwrap_or_default(),
            conv: self.resume.get(&t.backend).cloned().unwrap_or_default(),
            generation: self.generation,
            whole: !t.mid && t.switch.is_null(),
            start: t.start.clone(),
            end: t.end.clone(),
        });
    }

    pub(super) fn mark(&mut self, item: &Value) {
        let (start, end) = (item["start"].as_str(), item["end"].as_str());
        if let Some(t) = self.turns.first_mut() {
            if let Some(s) = start {
                t.start.get_or_insert_with(|| s.into());
            }
            if let Some(e) = end {
                t.end = Some(e.into());
            }
        } else if let (Some(s), Some(b)) = (start, self.boundaries.last_mut()) {
            b.start.get_or_insert_with(|| s.into());
        }
        if let (Some(e), Some(pin)) = (end, self.pin.get_mut(&self.backend)) {
            *pin = e.into();
        }
    }

    /// Resets what the dropped turns left: their boundaries, the last outcome and any limit or
    /// sign-in they ended on. `convs` keeps every conversation, grants and picks stay [D35].
    pub(super) fn rewound(&mut self, item: &Value) {
        if item["event"] == "forked" {
            return self.forked(item);
        }
        if item["event"] == "unforked" {
            return self.unforked(item);
        }
        if let Some(op) = item["op"].as_str() {
            self.rewinds.insert(op.into());
        }
        if let Some(at) = (self.boundaries.iter()).position(|b| b.cid == item["to"]) {
            self.boundaries.truncate(at);
        }
        self.turns.clear();
        self.last = None;
        (self.limit, self.resets, self.sign_in, self.refused) = (None, None, None, None);
        let backend = item["backend"].as_str().unwrap_or("").to_string();
        if item["fresh"] == true {
            self.resume.remove(&backend);
        }
        if let Some(id) = item["moved"].as_str() {
            let account = self.accounts.get(&backend).cloned().unwrap_or_default();
            self.convs.insert((backend.clone(), account, id.into()));
            self.resume.insert(backend.clone(), id.into());
        }
        match item["pin"].as_str() {
            Some(pin) => self.pin.insert(backend, pin.into()),
            None => self.pin.remove(&backend),
        };
    }

    /// A fork's start [D1063]: the source's agent and account, and the conversation it holds of
    /// its own, if any, ending at the answer it forked at: the boundary its first own message
    /// rewinds to, so that never starts an empty conversation [D384]. None: it begins from the
    /// hand-off.
    fn forked(&mut self, item: &Value) {
        let text = |k: &str| item[k].as_str().unwrap_or("").to_string();
        let (backend, account) = (text("backend"), text("account"));
        if !account.is_empty() {
            self.accounts.insert(backend.clone(), account.clone());
        }
        let Some(conv) = item["moved"].as_str() else {
            return;
        };
        // The source's own conversation, which the first launch forks at the answer: not the
        // fork's to delete [D1089].
        if item["branch"] == true {
            self.branching.insert(backend.clone());
            if let Some(end) = item["end"].as_str() {
                self.pin.insert(backend.clone(), end.into());
            }
        } else {
            self.convs
                .insert((backend.clone(), account.clone(), conv.into()));
        }
        self.resume.insert(backend.clone(), conv.into());
        self.boundaries.push(Boundary {
            cid: text("at"),
            origin: "fork".into(),
            backend,
            account,
            conv: conv.into(),
            generation: self.generation,
            whole: false,
            start: None,
            end: item["end"].as_str().map(String::from),
        });
    }

    /// A fork whose first launch can no longer fork its source begins from the hand-off: its
    /// native start goes, so its first own turn rewinds to a new conversation [D90, D1089].
    fn unforked(&mut self, item: &Value) {
        let backend = item["backend"].as_str().unwrap_or("");
        self.resume.remove(backend);
        self.pin.remove(backend);
        (self.boundaries).retain(|b| b.origin != "fork" || b.backend != backend);
    }

    /// A fork's own conversation, made by its first launch: it holds the fork point [D1089].
    pub(super) fn branched(&mut self, backend: &str, id: &str) {
        if self.branching.remove(backend) {
            let from = self.resume.get(backend);
            for b in
                (self.boundaries.iter_mut()).filter(|b| b.origin == "fork" && Some(&b.conv) == from)
            {
                b.conv = id.into();
            }
        }
    }

    /// This conversation's turns: on the agent and account it runs on now, since the last switch.
    fn current(&self) -> Vec<&Boundary> {
        let account = self
            .accounts
            .get(&self.backend)
            .cloned()
            .unwrap_or_default();
        (self.boundaries.iter())
            .filter(|b| {
                b.generation == self.generation && b.backend == self.backend && b.account == account
            })
            .collect()
    }

    /// The user's messages a rewind can go back to: only boundaries the agent can name exactly.
    pub fn points(&self) -> Vec<String> {
        let Some(adapter) = adapters::get(&self.backend) else {
            return vec![];
        };
        let mine = self.current();
        (mine.iter().enumerate())
            .filter(|(i, b)| {
                let kept = i.checked_sub(1).map(|p| mine[p]);
                b.origin == "user" && b.whole && adapter.can_cut(&Cut { kept, dropped: b })
            })
            .map(|(_, b)| b.cid.clone())
            .collect()
    }

    /// The turn before `cid`, if any, and `cid`'s turn and every later one.
    pub fn range(&self, cid: &str) -> Option<(Option<Boundary>, Vec<Boundary>)> {
        let mine = self.current();
        let at = mine.iter().position(|b| b.cid == cid)?;
        let kept = at.checked_sub(1).map(|p| mine[p].clone());
        Some((kept, mine[at..].iter().map(|b| (*b).clone()).collect()))
    }
}
