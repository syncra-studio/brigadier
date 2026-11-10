//! The thread in pages [D97, D98]: the newest whole turns first, then older pages as the view
//! scrolls up, and an island of turns around a row find goes to, the gap below it filled from
//! either side as it scrolls into view [D503].

use super::Thread;
use serde_json::{Value, json};
use std::collections::HashSet;

/// About how many rows the snapshot and each page carry [D98].
const PAGE: usize = 2000;

impl Thread {
    /// The view's Session with only its newest page of rows; what changed so far counts as sent.
    /// Given `from` and `to` (`n`s), it reaches back to row `from`'s turn and ends before row `to`:
    /// a view opened again gets the rows it held, an island's too, so its place comes back [D516].
    pub fn session(&mut self, id: &str, title: &str, from: Option<u64>, to: Option<u64>) -> Value {
        self.take();
        let at = |n: u64| (n.saturating_sub(1) as usize).min(self.items.len());
        let end = to.map_or(self.items.len(), at);
        let floor = from.map_or(end, at).min(end);
        let mut page = self.slice(self.start(end, floor, PAGE), end);
        page["id"] = id.into();
        page["title"] = title.into();
        page["setup"] = self.setup.clone();
        page["rewind"] = self.fold.points().into();
        page["notices"] = self.notices.clone().into();
        for (k, v) in self.requests().as_object().unwrap() {
            page[k] = v.clone();
        }
        page
    }

    /// The page just older than row `before` (an `n`), for a view scrolling up; or, given `after`,
    /// the page from row `after` on down, for one scrolling down from an island into its gap.
    pub fn older(&self, before: u64, after: Option<u64>) -> Value {
        let at = |n: u64| (n.saturating_sub(1) as usize).min(self.items.len());
        match after {
            Some(after) => self.slice(at(after), self.end(at(after), PAGE)),
            None => self.slice(self.start(at(before), at(before), PAGE), at(before)),
        }
    }

    /// The whole turns around row `n`, about half a page on each side, for find going to a match
    /// far up: `before` and `after` say where the rows not sent start on each side.
    pub fn around(&self, n: u64) -> Value {
        let at = (n.saturating_sub(1) as usize).min(self.items.len().saturating_sub(1));
        let end = self.end(at, PAGE / 2);
        self.slice(self.start(end, at, PAGE), end)
    }

    fn same_turn(&self, a: usize, b: usize) -> bool {
        self.items[a]["turnId"] == self.items[b]["turnId"]
    }

    /// Where whole turns ending at row index `end` start, reaching down to `floor` and then up to
    /// about `size` rows and at least one turn.
    fn start(&self, end: usize, floor: usize, size: usize) -> usize {
        let mut start = end;
        while start > 0 {
            let mut from = start - 1;
            while from > 0 && self.same_turn(from - 1, start - 1) {
                from -= 1;
            }
            if start < end && start <= floor && end - from > size {
                break;
            }
            start = from;
        }
        start
    }

    /// Where whole turns from row index `start` end, past about `size` rows.
    fn end(&self, start: usize, size: usize) -> usize {
        let mut end = (start + 1).min(self.items.len());
        while end < self.items.len() && (end - start <= size || self.same_turn(end - 1, end)) {
            end += 1;
        }
        end
    }

    /// Rows `start..end` with their turns and work, `before`: the `n` of the first, or null when
    /// nothing is older, and `after`: the `n` of the row past the last, or null at the newest.
    fn slice(&self, start: usize, end: usize) -> Value {
        let turn = |at: usize| &self.items[at]["turnId"];
        // Its turns run from its first row's to the next page's, so a turn with no rows yet comes too.
        let place = |at: usize| {
            self.turns
                .iter()
                .position(|t| t["id"] == *turn(at))
                .unwrap_or(self.turns.len())
        };
        let first = if start < end { place(start) } else { 0 };
        let last = if end < self.items.len() {
            place(end)
        } else {
            self.turns.len()
        };
        let turns = &self.turns[first.min(last)..last];
        let ids: HashSet<&Value> = turns.iter().map(|t| &t["id"]).collect();
        let work: Vec<&Value> = self
            .work
            .iter()
            .filter(|w| ids.contains(&w["turnId"]))
            .collect();
        let before = (start > 0).then(|| self.items[start]["n"].clone());
        let after = (end < self.items.len()).then(|| self.items[end]["n"].clone());
        let items: Vec<&Value> = self.items.range(start..end).collect();
        json!({"turns": turns, "items": items, "work": work, "before": before, "after": after})
    }
}
