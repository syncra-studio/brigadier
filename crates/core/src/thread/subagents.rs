//! A subagent's own steps, kept on its row for the side panel: the thread shows only that it
//! started and how it ended [D78, D115]. A step carries no output, so a row
//! sent again on each step stays small.

use super::{Open, Thread};
use serde_json::{Value, json};
use std::collections::BTreeSet;

impl Thread {
    /// A turn's end: its work folds now, or, while subagents it started run on, it stays one open
    /// block, its answer an update in it, counting on and saying how many run [D67, D114, D118].
    pub(super) fn end_work(&mut self, o: Open, work: Value, ts: u64) {
        self.ended = Some(o.clone());
        let helpers = self.helpers(&o.id);
        if helpers > 0 || self.working() {
            self.turns[o.at]["helpers"] = helpers.into();
            self.turns[o.at]["held"] = true.into();
            self.final_answer(&o, false);
            self.held.insert(o.id.clone(), (o, work));
        } else if !work.is_null() {
            self.push_work(work, ts.saturating_sub(o.started).saturating_sub(o.waited));
        }
    }

    pub(super) fn helpers(&self, turn: &str) -> usize {
        (self.children.values())
            .filter(|&&c| self.items[c]["turnId"] == turn)
            .count()
    }

    /// A worker a turn started still runs: it holds the newest block as a subagent does, its
    /// result the wake that carries the block on [D106, D151]. The status fold keeps which.
    pub(super) fn working(&self) -> bool {
        !self.fold.workers.is_empty()
    }

    /// A worker ended, by its result or an End: a block held meanwhile counts its time up to now,
    /// and no longer waits on the user for it [D551].
    pub(super) fn worker_ended(&mut self, ts: u64) {
        let over = &self.over;
        self.asking.retain(|w| !over.contains(w));
        self.end_wait(ts);
        for turn in self.held.keys().cloned().collect::<Vec<_>>() {
            self.held_left(&turn, ts);
        }
    }

    /// Workers holding an ended turn that the daemon finds `over`, though no note of their end is in
    /// the log (a build before results were noted, or a note a dead host missed): they hold it no
    /// more, its time still its own end's [D328, D336].
    pub fn workers_over(&mut self, over: impl Fn(&str) -> bool) {
        let n = self.fold.workers.len();
        if !self.held.is_empty() {
            self.fold.workers.retain(|w| !over(w));
        }
        if self.fold.workers.len() < n {
            self.settle_held(false);
        }
    }

    /// A fork's copy of its source's rows: the workers its source still waits on aren't the
    /// fork's, so no block of it is held for them.
    pub(super) fn settled(items: &[Value]) -> Thread {
        let mut from = Thread::default();
        items.iter().for_each(|item| from.push(item));
        from.fold.workers.clear();
        from.settle_held(false);
        from
    }

    /// A subagent at row `row` ended: the turn that waits on it counts one fewer. With none left it
    /// stays open for the turn its agent wakes for next, which carries it on; one that can't come
    /// now, as another turn runs, folds it at once.
    pub(super) fn helper_ended(&mut self, row: usize, ts: u64) {
        let turn = self.items[row]["turnId"].as_str().unwrap_or("").to_string();
        self.count_helpers(&turn);
        self.held_left(&turn, ts);
    }

    /// While its turn still runs, its header counts the subagents it waits on too [D114, D118].
    pub(super) fn count_helpers(&mut self, turn: &str) {
        if let Some(at) = self.open.as_ref().filter(|o| o.id == turn).map(|o| o.at) {
            self.turns[at]["helpers"] = self.helpers(turn).into();
            self.changed_turns.insert(at);
        }
    }

    fn held_left(&mut self, turn: &str, ts: u64) {
        let Some(at) = self.held.get(turn).map(|(o, _)| o.at) else {
            return;
        };
        let left = self.helpers(turn);
        self.turns[at]["helpers"] = left.into();
        self.turns[at]["endedAt"] = ts.into();
        self.changed_turns.insert(at);
        if left == 0 && !self.working() && self.open.is_some() {
            self.settle_held(false);
        }
    }

    /// Every held turn whose subagents all ended, and whose wake didn't come, folds now: its time
    /// up to its last subagent's end, its last answer final. A Brigadier cut waits for its carry-on
    /// past its process's end, until `cuts` says another turn came instead [D108, D124].
    pub(super) fn settle_held(&mut self, cuts: bool) {
        let done: Vec<String> = (self.held.iter())
            .filter(|(_, (o, _))| {
                (cuts || !o.cut()) && self.turns[o.at]["helpers"] == 0 && !self.working()
            })
            .map(|(id, _)| id.clone())
            .collect();
        for id in done {
            let (mut o, work) = self.held.remove(&id).unwrap();
            let ended = self.turns[o.at]["endedAt"].as_u64().unwrap_or(o.started);
            self.turns[o.at]["held"] = Value::Null;
            // Its subagent's ask still waited: the wait ends with it.
            if let Some(since) = o.wait.take() {
                o.waited += ended.saturating_sub(since);
                self.turns[o.at]["waitingSince"] = Value::Null;
                self.turns[o.at]["waitedMs"] = o.waited.into();
            }
            // A cut whose carry-on never came ended where it was stopped.
            if o.cut() {
                self.turns[o.at]["status"] = "cancelled".into();
            }
            self.changed_turns.insert(o.at);
            self.final_answer(&o, true);
            if !work.is_null() {
                self.push_work(
                    work,
                    ended.saturating_sub(o.started).saturating_sub(o.waited),
                );
            }
        }
    }

    /// A Brigadier cut, held open for its carry-on: one block, its answer an update in it [D108,
    /// D124]. A reply it cut mid-way, only its divider or thinking (its group too) after it, stays
    /// out of the fold with the carry-on that finishes it: one reply under "Worked for" [D118].
    pub(super) fn hold_cut(&mut self, mut o: Open) {
        self.final_answer(&o, false);
        let mid = |n: u64| {
            let row = &self.items[n as usize - 1];
            o.kept.contains(&n)
                || row["hidden"] == true
                || matches!(row["kind"].as_str(), Some("reasoning" | "compaction"))
                || (row["kind"] == "group" && row["steps"].as_array().is_some_and(Vec::is_empty))
        };
        if let Some(answer) = (o.answer).filter(|&a| (a + 1..=self.items.len() as u64).all(mid)) {
            o.kept.push(answer);
        }
        self.turns[o.at]["held"] = true.into();
        self.turns[o.at]["helpers"] = 0.into();
        self.held.insert(o.id.clone(), (o, Value::Null));
    }

    fn final_answer(&mut self, o: &Open, last: bool) {
        if let Some(answer) = o.answer {
            self.items[answer as usize - 1]["final"] = last.into();
            self.changed_items.insert(answer as usize - 1);
        }
    }

    /// The turn the agent woke for, on its own or at Brigadier's word, carries on the one its
    /// subagents held: one block, counting from that turn's start, folding above the new answer;
    /// the earlier answer becomes part of its work [D106].
    pub(super) fn rejoin(&mut self, mut o: Open) {
        // A reply a Stop or a cut left mid-way, nothing after it but lines and thinking, is
        // finished by the carry-on's text in the same row: one reply [D124, D154].
        let mid = |n: u64| {
            let row = &self.items[n as usize - 1];
            o.kept.contains(&n)
                || row["hidden"] == true
                || matches!(row["kind"].as_str(), Some("reasoning" | "compaction"))
                || (row["kind"] == "group" && row["steps"].as_array().is_some_and(Vec::is_empty))
        };
        // Not a model picked mid-turn: its carry-on starts under the divider, where it was picked [D124, D362].
        let cut = (o.cut() && !self.fold.switched) || o.stop.0.as_deref() == Some("user");
        o.joins = (o.answer)
            .filter(|&a| cut && (a + 1..=self.items.len() as u64).all(mid))
            .map(|a| {
                (
                    a,
                    self.items[a as usize - 1]["text"]
                        .as_str()
                        .unwrap_or("")
                        .into(),
                    String::new(),
                )
            });
        // Its "You stopped" line would sit under the one reply, its pause a wait in its header.
        for at in o.joins.as_ref().map_or(self.items.len(), |j| j.0 as usize)..self.items.len() {
            if self.items[at]["reason"] == "stopped" {
                self.items[at]["hidden"] = true.into();
                self.changed_items.insert(at);
            }
        }
        // Otherwise it marks where the Stop fell, folding with the steps around it [D170].
        let items = &self.items;
        o.kept
            .retain(|&n| items[n as usize - 1]["reason"] != "stopped");
        // A Stop of the turn that carries it on draws its own line.
        o.stop = (None, false);
        let turn = &mut self.turns[o.at];
        turn["status"] = "running".into();
        turn["endedAt"] = Value::Null;
        turn["held"] = Value::Null;
        self.changed_turns.insert(o.at);
        self.final_answer(&o, false);
        // The view keeps the work it has until this turn's new work replaces it by turn id.
        if let Some(i) = self.work.iter().position(|w| w["turnId"] == o.id.as_str()) {
            self.work.remove(i);
            if i < self.sent_work {
                self.sent_work -= 1;
            }
        }
        self.open = Some(o);
    }

    fn push_work(&mut self, mut work: Value, ms: u64) {
        work["ms"] = ms.into();
        self.work.push(work);
    }

    /// A step the subagent at row `at` began; a repeated start only fills in its input.
    pub(super) fn sub_started(&mut self, at: usize, item: &Value, ts: u64) {
        let row = &mut self.items[at];
        let id = format!(
            "{}:{}",
            row["id"].as_str().unwrap_or(""),
            item["id"].as_str().unwrap_or("")
        );
        let turn = row["turnId"].clone();
        let log = log(row);
        match log.iter_mut().find(|s| s["id"] == id.as_str()) {
            Some(s) => s["input"] = item["input"].clone(),
            None => log.push(json!({"id": id, "turnId": turn, "kind": "tool", "name": item["name"],
                "input": item["input"], "output": "", "progress": "running", "exitCode": null,
                "step": item["step"], "server": item["server"], "description": item["description"], "startedAt": item["at"].as_u64().unwrap_or(ts), "endedAt": null})),
        }
        self.changed_items.insert(at);
        self.heard(at, ts);
    }

    /// A step of the subagent at row `at` ended.
    pub(super) fn sub_done(&mut self, at: usize, item: &Value, ts: u64) {
        let row = &mut self.items[at];
        let id = format!(
            "{}:{}",
            row["id"].as_str().unwrap_or(""),
            item["id"].as_str().unwrap_or("")
        );
        if let Some(s) = log(row).iter_mut().find(|s| s["id"] == id.as_str()) {
            s["progress"] = if item["ok"] == true { "done" } else { "failed" }.into();
            s["exitCode"] = item["exit"].clone();
            s["endedAt"] = item["at"].as_u64().unwrap_or(ts).into();
            count(row);
            self.changed_items.insert(at);
        }
        self.heard(at, ts);
    }

    /// A held turn's subagent did something: its quiet clock starts again [D114].
    fn heard(&mut self, row: usize, ts: u64) {
        let turn = self.items[row]["turnId"].as_str().unwrap_or("");
        if let Some(at) = self.held.get(turn).map(|(o, _)| o.at) {
            self.turns[at]["heardAt"] = ts.into();
            self.changed_turns.insert(at);
        }
    }
}

/// The subagent row's steps, made on its first.
fn log(row: &mut Value) -> &mut Vec<Value> {
    if !row["log"].is_array() {
        row["log"] = json!([]);
    }
    row["log"].as_array_mut().unwrap()
}

/// Steps' counts per kind, in the order the kinds came: ended steps only, so a live count only goes
/// up [D173]. Edits count distinct files [D48]; an MCP server's calls count apart [D176].
pub(super) fn counts<'a>(rows: impl Iterator<Item = &'a Value>) -> Vec<Value> {
    let mut steps: Vec<(String, Value, u64)> = vec![];
    let (mut files, mut unnamed) = (BTreeSet::new(), 0u64);
    for row in rows {
        // Thoughts are lines of the group, never counted as steps [D752].
        if row["hidden"] == true
            || row["kind"] == "reasoning"
            || matches!(row["progress"].as_str(), Some("running" | "pending"))
        {
            continue;
        }
        let kind = match row["kind"].as_str().unwrap_or("") {
            "fileChange" => "edit",
            "childAgent" => "agent",
            _ => row["step"].as_str().unwrap_or("other"),
        };
        let server = &row["server"];
        match steps.iter_mut().find(|(k, s, _)| k == kind && s == server) {
            Some((_, _, n)) => *n += 1,
            None => steps.push((kind.into(), server.clone(), 1)),
        }
        if kind == "edit" {
            let changes = row["changes"].as_array().cloned().unwrap_or_default();
            files.extend(
                changes
                    .iter()
                    .filter_map(|c| c["path"].as_str().map(String::from)),
            );
            unnamed += changes.is_empty() as u64;
        }
    }
    steps
        .into_iter()
        .map(|(kind, server, n)| {
            let n = if kind == "edit" {
                files.len() as u64 + unnamed
            } else {
                n
            };
            json!({"kind": kind, "n": n, "server": server})
        })
        .collect()
}

/// Its steps still running when the subagent itself ends end with it, so none spins on.
pub(super) fn settle(row: &mut Value, progress: &str) {
    for s in log(row).iter_mut().filter(|s| s["progress"] == "running") {
        s["progress"] = progress.into();
    }
    count(row);
}

/// Its ended steps counted as a group's, for a skill's row to group them as the thread does [D227].
fn count(row: &mut Value) {
    row["logSteps"] = counts(log(row).iter()).into();
}

/// A reply a stop cut mid-way and its carry-on, as one text. A carry-on that starts the cut line
/// again (its first words, at a line's start) takes that line's place, any words before it gone;
/// until its first words show which, it adds nothing. One that starts afresh (no CLI keeps the cut
/// words, so a fresh conversation or a Resume never finishes them) follows the cut's last whole
/// sentence, the unfinished words gone, never glued to them.
pub(super) fn joined(cut: &str, next: &str) -> String {
    let (head, tail) = cut.rsplit_once('\n').unwrap_or(("", cut));
    let next = next.trim_start_matches(' ');
    let key = tail
        .split_whitespace()
        .take(2)
        .collect::<Vec<_>>()
        .join(" ");
    if !key.is_empty() {
        let again = (next.match_indices(&key).map(|(i, _)| i))
            .find(|&i| i == 0 || next[..i].ends_with('\n'));
        if let Some(i) = again {
            return [head, &next[i..]]
                .join("\n")
                .trim_start_matches('\n')
                .into();
        }
        if key.starts_with(next.trim_end()) {
            return cut.into();
        }
    }
    let first = next.chars().next();
    if !first.is_some_and(|c| c.is_lowercase() || ".,;:!?)".contains(c)) {
        let t = cut.trim_end();
        let line = cut.len() - tail.len();
        let keep = if cut.ends_with('\n') {
            cut
        } else if t.ends_with(['.', '!', '?', ':']) {
            t
        } else {
            // A sentence's end, not a list's number (2. ).
            (tail.match_indices(['.', '!', '?', ':']))
                .rfind(|&(i, _)| {
                    tail[i + 1..].starts_with(' ')
                        && tail[..i].ends_with(|c: char| !c.is_ascii_digit())
                })
                .map_or(&cut[..line], |(i, _)| &cut[..line + i + 1])
        };
        // A list goes on as one list; anything else after the cut is a paragraph of its own.
        let item = |l: &str| {
            let l = l.trim_start();
            let n = l.trim_start_matches(|c: char| c.is_ascii_digit());
            ["- ", "* ", "+ "].iter().any(|m| l.starts_with(m))
                || (n.len() < l.len() && (n.starts_with(". ") || n.starts_with(") ")))
        };
        let (keep, next) = (keep.trim_end(), next.trim_start());
        let last = keep.rsplit('\n').next().unwrap_or("");
        let gap = match keep {
            "" => "",
            _ if item(last) && item(next) => "\n",
            _ => "\n\n",
        };
        return format!("{keep}{gap}{next}");
    }
    // shortcut: a word cut in two gets a space inside it; no CLI says where its cut fell.
    let gap = match (cut.chars().last(), first) {
        (Some(c), _) if c.is_whitespace() => "",
        (_, Some(c)) if ".,;:!?)".contains(c) => "",
        _ => " ",
    };
    format!("{cut}{gap}{next}")
}
