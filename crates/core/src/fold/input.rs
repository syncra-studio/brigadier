//! An input written to the agent, and the app's `set`: what each sets up for the turn it starts.

use super::{Fold, Turn};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

/// Another agent's model and effort, picked for the next message.
#[derive(Serialize, Deserialize, Clone)]
pub struct Picked {
    pub backend: String,
    pub model: String,
    pub effort: Option<String>,
    #[serde(default)]
    pub fast: bool,
    /// Its name as the picker shows it; the id where none was given.
    #[serde(default)]
    pub name: String,
    /// Picked mid-turn, it waits for that turn's end, unless the user said Switch now: the turn
    /// stops, and it carries on from the conversation [D557].
    #[serde(default)]
    pub now: bool,
}

impl Fold {
    /// What the running child takes, as its agent confirmed it: its level, or its `real` model.
    pub(super) fn took(&mut self, k: &str, v: &Value) {
        if let Some(g) = self.given.as_mut().filter(|g| g.is_object()) {
            g[k] = v.clone();
        }
    }

    /// What the child runs with now, confirmed between turns, or that it isn't known.
    pub(super) fn retuned(&mut self, item: &Value) {
        self.gave(&item["setup"], false);
    }

    /// A setup the child runs with. A reused child said its real model once, at its start: kept
    /// while it runs that model [D383].
    fn gave(&mut self, setup: &Value, starts: bool) {
        let real = (self.given.as_ref())
            .filter(|g| !starts && g["model"] == setup["model"])
            .map(|g| g["real"].clone())
            .filter(|r| !r.is_null());
        self.given = Some(setup.clone());
        real.inspect(|r| self.took("real", r));
    }

    /// The app's `set` [D129]: the conversation's agent takes the model and effort from its next
    /// turn, which drops a pick; another agent is picked, for the next message [D90].
    pub(super) fn setup(&mut self, item: &Value) {
        let b = item["backend"].as_str().unwrap_or("").to_string();
        let model = item["model"].as_str().unwrap_or("").to_string();
        let effort = item["effort"].as_str().map(String::from);
        let fast = item["fast"] == true;
        self.setup_op = item["op"].as_str().map(String::from);
        if item["pick"] == true {
            self.picked = Some(Picked {
                name: item["name"].as_str().unwrap_or(&model).into(),
                backend: b,
                model,
                effort,
                fast,
                now: false,
            });
            return;
        }
        self.picked = None;
        match fast {
            true => self.fast.insert(b.clone()),
            false => self.fast.remove(&b),
        };
        match effort {
            Some(e) => self.efforts.insert(b.clone(), e),
            None => self.efforts.remove(&b),
        };
        self.models.insert(b, model);
    }

    pub(super) fn input(&mut self, item: &Value, ts: u64) {
        let str_of = |k: &str| item[k].as_str().unwrap_or("").to_string();
        let cid = str_of("cid");
        *self.cids.entry(cid.clone()).or_default() += 1;
        if item["ack"] == true {
            self.acking.insert(cid.clone());
        }
        // The user's words to a worker, a steer too, for its parent's one-line note [D294, D303].
        if item["direct"] == true && !self.direct.iter().any(|d| d["cid"] == cid.as_str()) {
            let text: String = item["text"]
                .as_str()
                .unwrap_or("")
                .chars()
                .take(200)
                .collect();
            self.direct
                .push(json!({"cid": cid, "ts": ts, "text": text, "steer": item["steer"] == true}));
        }
        if item["setup"].is_object() {
            self.gave(&item["setup"], item["starts_child"] == true);
            self.plans.on = item["review"] == true;
        }
        // An answer starts the agent's silence over: the wait on the user was none of its own [D327].
        if item["control"]["kind"] == "answer" {
            self.last_out = self.last_out.max(ts);
        }
        if self.control(item, &cid) {
            return;
        }
        if item["origin"] != "system" {
            self.runs.ran.clear();
        }
        // A message ends what a held turn's subagent asked, as any new turn ends what waits.
        if self.turns.first().is_some_and(|t| t.held) {
            self.close("withdrawn", Value::Null, ts);
        }
        (self.limit, self.resets) = (None, None);
        self.sign_in = None;
        self.refused = None;
        self.hold = None;
        // A switch takes effect with the input that continues it, in the same frame [D51].
        let switch = &item["switch"];
        // The turn it carries on, by that turn's stable id where it's the one just ended; so does
        // Brigadier's resume once the network is back [D339].
        let back = item["origin"] == "system" && item["text"] == crate::send::RECONNECT;
        if let Some(of) = item["retry_of"]
            .as_str()
            .filter(|_| back || switch["to"]["backend"].is_string())
        {
            let last = self.last.as_ref().filter(|l| l["cid"] == of);
            let of = last.and_then(|l| l["id"].as_str()).unwrap_or(of);
            self.carried.insert(of.into(), cid.clone());
        }
        if let Some(to) = switch["to"]["backend"].as_str() {
            self.generation += 1;
            let account = switch["to"]["account"].as_str().unwrap_or("");
            match account {
                "" => self.accounts.remove(to),
                a => self.accounts.insert(to.into(), a.into()),
            };
            if let Some(m) = switch["to"]["model"].as_str() {
                self.models.insert(to.into(), m.into());
            }
            match switch["to"]["effort"].as_str() {
                Some(e) => self.efforts.insert(to.into(), e.into()),
                None => self.efforts.remove(to),
            };
            match switch["to"]["fast"] == true {
                true => self.fast.insert(to.into()),
                false => self.fast.remove(to),
            };
            self.picked = None;
            // For delete, `convs` keeps the old conversation, or the same one's new account.
            if switch["fresh"] == true {
                self.resume.remove(to);
                self.pin.remove(to);
                self.context = None;
            } else if let Some(id) = self.resume.get(to) {
                self.convs.insert((to.into(), account.into(), id.clone()));
            }
        }
        // An input while the agent waits on a question is its answer, not a new turn.
        if let Some(t) = self.turns.first_mut().filter(|t| t.question.is_some()) {
            t.question = None;
            let asked = t.asks.iter().filter(|(_, r)| r["items"].is_array());
            let asked: Vec<String> = asked.map(|(id, _)| id.clone()).collect();
            asked.iter().for_each(|id| self.end_ask(id, "answered"));
            let t = &mut self.turns[0];
            t.delivered = None;
            t.cid = Some(cid);
            t.ts = ts;
            return;
        }
        self.backend = str_of("backend");
        if item["origin"] == "user" {
            self.sent = ts;
        }
        let retry_of = item["retry_of"].as_str().map(String::from);
        // A switch's or recovery's continuation of a turn the user started stays the user's [D305].
        let direct = item["direct"] == true || retry_of.as_deref().is_some_and(|t| self.told(t));
        let mid = !self.turns.is_empty();
        self.turns.push(Turn {
            mid,
            id: cid.clone(),
            cid: Some(cid),
            origin: str_of("origin"),
            backend: str_of("backend"),
            text: str_of("text"),
            parts: item["parts"].clone(),
            brigade: item["brigade"] == true,
            retry_of,
            model: item["setup"]["model"].as_str().map(String::from),
            switch: item["switch"].clone(),
            ts,
            spawning: item["starts_child"] == true,
            quiet: str_of("origin").starts_with("result:asks:"),
            direct,
            ..Default::default()
        });
    }

    /// Whether `turn` is one the user started here, or carries one on, back through the switches.
    fn told<'a>(&'a self, mut turn: &'a str) -> bool {
        loop {
            if self
                .direct
                .iter()
                .any(|d| d["cid"] == turn && d["steer"] != true)
            {
                return true;
            }
            match self.carried.iter().find(|(_, to)| to.as_str() == turn) {
                Some((of, _)) => turn = of,
                None => return false,
            }
        }
    }
}
