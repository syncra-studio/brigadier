//! The agent's to-do list [D104]. Agents rewrite it whole and leave out what's finished: the Plan
//! card keeps counting that, while whatever the agent reads is the list as it wrote it.

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Default, Serialize, Deserialize, Clone)]
pub struct Todo {
    /// The list as the agent last wrote it; none until it writes one.
    pub written: Option<Value>,
    /// Each finished step's text, the ones since left out too, in the order they were finished.
    done: Vec<String>,
}

fn steps(list: Option<&Value>) -> &[Value] {
    list.and_then(Value::as_array).map_or(&[], Vec::as_slice)
}

fn text(step: &Value) -> &str {
    step["text"].as_str().unwrap_or("")
}

fn completed(step: &Value) -> bool {
    step["status"] == "completed"
}

impl Todo {
    /// A list wholly finished, or one that shares no step with the new one, is another plan's.
    pub fn wrote(&mut self, list: &Value) {
        let (was, new) = (steps(self.written.as_ref()), steps(Some(list)));
        let shared = was.iter().any(|w| new.iter().any(|s| text(s) == text(w)));
        if !shared || was.iter().all(completed) {
            self.done.clear();
        }
        // The new list's own status goes for each step it has.
        (self.done).retain(|d| new.iter().all(|s| text(s) != d || completed(s)));
        for step in new.iter().filter(|s| completed(s)) {
            if !self.done.iter().any(|d| d == text(step)) {
                self.done.push(text(step).into());
            }
        }
        self.written = Some(list.clone());
    }

    /// The card's steps: the finished ones oldest first, the ones left out too, then the rest as written.
    pub fn shown(&self) -> Value {
        let Some(list) = &self.written else {
            return Value::Null;
        };
        let written = steps(Some(list));
        let kept = (self.done.iter()).filter(|d| written.iter().all(|s| text(s) != *d));
        let kept = kept.map(|d| json!({"text": d, "status": "completed"}));
        let mut all: Vec<Value> = kept.chain(written.iter().cloned()).collect();
        let at = |s: &Value| self.done.iter().position(|d| completed(s) && d == text(s));
        all.sort_by_key(|s| at(s).unwrap_or(usize::MAX));
        all.into()
    }
}
