//! The agent's to-do list [D104]. Agents rewrite it whole and leave out what's finished: the Plan
//! card keeps counting that, while whatever the agent reads is the list as it wrote it.

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::io;
use std::path::Path;

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
    /// The plan up to the log's frame `seq`, without what rewinds dropped: a fork's goes on from its
    /// source's [D1063].
    pub fn replay(dir: &Path, seq: u64) -> io::Result<Todo> {
        let mut plan = Todo::default();
        let mut push = |item: &Value| {
            if item["kind"] == "plan" {
                plan.wrote(&item["steps"]);
            }
        };
        crate::fork::inherited(dir).iter().for_each(&mut push);
        crate::rewind::read_active(dir, |item| {
            if item["f"].as_u64().is_some_and(|f| f <= seq) {
                push(item);
            }
        })?;
        Ok(plan)
    }

    /// A list wholly finished, or one that shares no step with the new one, is another plan's.
    pub fn wrote(&mut self, list: &Value) {
        let (was, new) = (steps(self.written.as_ref()), steps(Some(list)));
        let has: HashSet<&str> = new.iter().map(text).collect();
        if was.iter().all(completed) || !was.iter().any(|s| has.contains(text(s))) {
            self.done.clear();
        }
        // The new list's own status goes for each step it has, as many as it has.
        let mut more = HashMap::<&str, usize>::new();
        for step in new.iter().filter(|s| completed(s)) {
            *more.entry(text(step)).or_default() += 1;
        }
        let mut take = |t: &str| match more.get_mut(t) {
            Some(n) if *n > 0 => {
                *n -= 1;
                true
            }
            _ => false,
        };
        self.done.retain(|d| !has.contains(d.as_str()) || take(d));
        for step in new {
            if take(text(step)) {
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
        let has: HashSet<&str> = steps(Some(list)).iter().map(text).collect();
        let kept = self.done.iter().filter(|d| !has.contains(d.as_str()));
        let kept = kept.map(|d| json!({"text": d, "status": "completed"}));
        let at: HashMap<&str, usize> = (self.done.iter().enumerate())
            .map(|(n, d)| (d.as_str(), n))
            .collect();
        let mut all: Vec<Value> = kept.chain(steps(Some(list)).iter().cloned()).collect();
        all.sort_by_key(|s| match completed(s) {
            true => at.get(text(s)).copied().unwrap_or(usize::MAX),
            false => usize::MAX,
        });
        all.into()
    }
}
