//! The session's last test or build run, for Review's brief [D1188, D1192]: each finished `run`
//! step whose command line reads as a test or build, with the exit code its CLI reported (none is
//! kept as none, never 0) and its end time; and the files edit steps changed that began after it.

use super::Fold;
use super::turns::paths_of;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
use std::hash::{DefaultHasher, Hash, Hasher};

#[derive(Default, Serialize, Deserialize, Clone)]
pub struct Run {
    pub command: String,
    pub exit: Option<i64>,
    /// When it ended (ms).
    pub at: u64,
    /// Paths edit steps changed that began after it ended, as the steps named them.
    pub after: BTreeSet<String>,
}

/// Commands that test or build, matched at the start of a command in the line [D1188] (proposed).
const COMMANDS: &[&str] = &[
    "cargo test",
    "cargo build",
    "cargo check",
    "cargo clippy",
    "cargo nextest",
    "npm test",
    "npm run test",
    "npm run build",
    "npm run check",
    "npm run typecheck",
    "pnpm test",
    "pnpm run test",
    "pnpm build",
    "pnpm run build",
    "pnpm typecheck",
    "pnpm run typecheck",
    "yarn test",
    "yarn build",
    "bun test",
    "bun run test",
    "bun run build",
    "go test",
    "go build",
    "go vet",
    "pytest",
    "python -m pytest",
    "python3 -m pytest",
    "tox",
    "make",
    "tsc",
    "npx tsc",
    "vitest",
    "npx vitest",
    "jest",
    "npx jest",
    "mvn",
    "gradle",
    "./gradlew",
    "swift test",
    "swift build",
    "xcodebuild",
    "dotnet test",
    "dotnet build",
    "mix test",
    "rspec",
    "rake test",
    "bundle exec rspec",
    "phpunit",
    "deno test",
    "ctest",
    "cmake --build",
    "just test",
    "just build",
];

/// Whether a command line runs a test or build: any of its commands, joined by `&&`, `;` or pipes.
pub fn tests_or_builds(line: &str) -> bool {
    line.split(['&', ';', '|', '\n']).any(|part| {
        let part = part.trim();
        COMMANDS.iter().any(|c| {
            part.strip_prefix(c)
                .is_some_and(|rest| rest.is_empty() || rest.starts_with([' ', ':']))
        })
    })
}

#[derive(Default, Serialize, Deserialize, Clone)]
pub struct Runs {
    /// Test and build steps still running, by id: their command.
    open: BTreeMap<String, String>,
    /// Edit steps that began after the last run ended, by id: their paths so far.
    late: BTreeMap<String, Vec<String>>,
    pub last: Option<Run>,
    /// Every path the session's ended turns' edit steps confirm they changed, as the steps named
    /// them: your own folder's "From the agent" [D1192, D1213].
    #[serde(default)]
    pub agent: BTreeSet<String>,
    /// The tool calls and to-do lists since the last message: one made again is nothing new to the
    /// guard [D144].
    #[serde(default)]
    pub ran: BTreeSet<String>,
}

impl Fold {
    /// Whether a tool call wasn't made since the last message, the same tool on the same input: one
    /// made again is no new work to the guard [D144].
    // shortcut: a search's input is its pattern alone, so one pattern over other paths reads as made
    // before; key on the CLI's whole input if a long search job stalls.
    pub(super) fn new_call(&mut self, item: &Value) -> bool {
        self.new_work(json!([
            item["name"],
            item["step"],
            item["input"],
            item["command"]
        ]))
    }

    /// The agent wrote its to-do list: one that moved is new work to the guard [D144].
    pub(super) fn planned(&mut self, steps: &Value) {
        self.plan.wrote(steps);
        let new = self.new_work(json!(["plan", steps]));
        if let Some(t) = self.turns.first_mut() {
            t.moved |= new;
        }
    }

    /// Kept as a hash, so a big input doesn't grow the checkpoint.
    fn new_work(&mut self, work: Value) -> bool {
        let mut hash = DefaultHasher::new();
        work.to_string().hash(&mut hash);
        self.runs.ran.insert(format!("{:016x}", hash.finish()))
    }

    /// A step began: a test or build run waits for its end; an edit after the last run is watched.
    pub(super) fn run_started(&mut self, item: &Value, ts: u64) {
        let id = item["id"].as_str().unwrap_or_default().to_string();
        let input = item["input"].as_str().unwrap_or_default();
        let at = item["at"].as_u64().unwrap_or(ts);
        match item["step"].as_str() {
            Some("run") if tests_or_builds(input) => {
                self.runs.open.insert(id, input.into());
            }
            Some("edit") if self.runs.last.as_ref().is_some_and(|r| at > r.at) => {
                let mut paths = paths_of(&item["changes"]);
                if paths.is_empty() && !input.is_empty() {
                    paths.push(input.into());
                }
                self.runs.late.insert(id, paths);
            }
            _ => {}
        }
    }

    /// A step ended: a run whose end its CLI reported becomes the last run; one cut off (sent to
    /// the background, interrupted) stays open, as the agent's end of it may come later [D74].
    pub(super) fn run_done(&mut self, item: &Value, ts: u64) {
        let id = item["id"].as_str().unwrap_or_default();
        if let Some(paths) = self.runs.late.remove(id)
            && let Some(run) = self.runs.last.as_mut().filter(|_| item["ok"] == true)
        {
            run.after
                .extend(paths.into_iter().chain(paths_of(&item["changes"])));
        }
        if item["cut"] == true {
            return;
        }
        if let Some(command) = self.runs.open.remove(id) {
            self.runs.last = Some(Run {
                command,
                exit: item["exit"].as_i64(),
                at: item["at"].as_u64().unwrap_or(ts),
                after: BTreeSet::new(),
            });
            self.runs.late.clear();
        }
    }
}
