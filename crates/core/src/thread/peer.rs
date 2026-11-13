//! Messages between sessions in the thread [D2034, D3014]: the sender's row of each message it
//! sent, folded from its notes by message; the receiver's bubble, with who sent it. Each stays
//! out of the work fold.

use super::Thread;
use serde_json::{Value, json};

impl Thread {
    /// A `peer` note: `sent`, `stopped` or `refused` adds a message's row; the rest move it on.
    pub(super) fn peer(&mut self, item: &Value) {
        let phase = item["phase"].as_str().unwrap_or("");
        let mid = &item["mid"];
        let at = (!mid.is_null())
            .then(|| {
                (self.items.iter()).rposition(|r| {
                    r["mid"] == *mid && matches!(r["kind"].as_str(), Some("peer" | "question"))
                })
            })
            .flatten();
        // A sub-session's own request its boss passed to the user [D189].
        if phase == "to_user" && mid.is_null() {
            let id = item["id"].as_str().unwrap_or("");
            let at = (self.pending.iter()).find(|&&at| self.items[at]["request"]["id"] == id);
            return at
                .copied()
                .into_iter()
                .for_each(|at| self.user_waits(at, item["ts"].as_u64().unwrap_or(0)));
        }
        let Some(at) = at else {
            // A worker's question to its parent is its quiet step in the fold: "Asking ‹parent›",
            // then "‹parent› answered" [D121, D122].
            if phase == "sent" && item["asks"] == true {
                self.add(
                    json!({"kind": "question", "mid": mid, "question": item["text"],
                    "options": [], "answer": null, "to": "parent"}),
                );
                return;
            }
            // A message to its own worker reads as the old lead's row: "Messaged ‹worker›", its words folded under it.
            if phase == "sent" && item["worker"] == true {
                let row = json!({"kind": "team_step", "type": "messaged", "byUser": false, "workers": [item["to"]], "text": item["text"]});
                return self.team_row(row);
            }
            if matches!(phase, "sent" | "stopped" | "refused") {
                let state = if phase == "sent" { "sending" } else { phase };
                self.break_group();
                let at = self.add(
                    json!({"kind": "peer", "mid": mid, "to": item["to"], "text": item["text"],
                    "wait": item["wait"] == true, "state": state, "why": item["why"]}),
                );
                if let Some(o) = self.open.as_mut() {
                    o.kept.push(at as u64 + 1);
                }
            }
            return;
        };
        // Its boss passed this question to the user: the user's card now, answered there [D189].
        if phase == "to_user" {
            self.items[at]["request"] = item["request"].clone();
            self.pending.push(at);
            self.pending_changed = true;
            return self.user_waits(at, item["ts"].as_u64().unwrap_or(0));
        }
        if phase == "answered"
            && self
                .unwait(&format!("peer-{}", mid.as_str().unwrap_or("")))
                .is_some()
        {
            self.end_wait(item["ts"].as_u64().unwrap_or(0));
        }
        let row = &mut self.items[at];
        match phase {
            // Sent anyway, by the user, after it stopped.
            "sent" => (row["state"], row["why"]) = ("sending".into(), Value::Null),
            "handed" | "delivered" => row["state"] = "sent".into(),
            "uncertain" | "dropped" | "stopped" => {
                (row["state"], row["why"]) = (phase.into(), item["why"].clone())
            }
            "replied" => row["waited"] = "replied".into(),
            "answered" => row["answer"] = item["reply"].clone(),
            "waited" => row["waited"] = "timeout".into(),
            _ => return,
        }
        self.changed_items.insert(at);
    }

    /// The bubble of a message another session sent, without the line its agent read first.
    pub(super) fn peer_item(from: &str, text: &str, ts: u64, cid: &Value) -> Value {
        let text = match text.strip_prefix(crate::agent::PEER_HEAD) {
            Some(rest) => rest.split_once("]\n\n").map_or(text, |(_, t)| t),
            None => text,
        };
        json!({"kind": "message", "role": "user", "text": text, "streaming": false,
            "origin": "peer", "from": from, "sentAt": ts, "cid": cid})
    }
}
