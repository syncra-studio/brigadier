//! Scripted turn directives for the catalogue drill and gallery demo.

use super::{Agent, emit, limited, now, out};
use serde_json::json;
use std::os::unix::process::CommandExt;
use std::process::{Command, Stdio};
use std::time::Duration;
use std::{env, fs, io, process, thread};

impl Agent {
    /// Acts out one directive. False when the turn ended inside it.
    pub(super) fn directive(&mut self, name: &str, n: u64, word: &str, done_before: u64) -> bool {
        let left = n.saturating_sub(done_before);
        match name {
            "say" => (0..n).for_each(|i| self.say(&format!("line {i}"))),
            "recall" => self.say(&format!("I remember: {}", self.conv().join(" | "))),
            "write" => {
                let file = word.split_once(':').map_or("", |w| w.1);
                let turn = self.conv().len();
                // An edit step around the write, the way a real CLI reports a file change [D1134].
                self.tools += 1;
                let id = format!("tl{}-{}", self.tools, now());
                let change = if fs::exists(file).unwrap_or(false) {
                    "modified"
                } else {
                    "added"
                };
                self.note(&format!("tool {word}"));
                emit(
                    json!({"t": "tool", "id": id, "name": "write", "path": file, "change": change}),
                );
                let ok = fs::write(file, format!("written in turn {turn}\n")).is_ok();
                self.note(&format!("finished {word}"));
                emit(json!({"t": "tool_done", "id": id, "ok": ok}));
                self.say(&format!("wrote {file}"));
            }
            // A file changed through a shell command, with no edit step, as `>>` in a real CLI [D1187].
            "shell" => {
                let file = word.split_once(':').map_or("", |w| w.1);
                let line = format!("written by a shell in turn {}", self.conv().len());
                if !self.tool(
                    word,
                    0,
                    done_before,
                    true,
                    &format!("echo '{line}' >> '{file}'"),
                ) {
                    return false;
                }
                self.say(&format!("ran a shell command on {file}"));
            }
            "tree" => {
                let cmd = format!("sleep {left} & sleep {left} & wait");
                if !self.tool(word, n, done_before, false, &cmd) {
                    return false;
                }
            }
            "tool_sleep" => {
                if !self.tool(word, n, done_before, true, &format!("sleep {left}")) {
                    return false;
                }
            }
            "approve" => {
                if !self.approve(n) {
                    return false;
                }
            }
            "cargo" => {
                let cargo = env::var("FAKE_CARGO").unwrap_or_else(|_| "cargo".into());
                let manifest = env::var("FAKE_CARGO_MANIFEST").unwrap_or_default();
                let target = self.home.join("target");
                let cmd = format!(
                    "end=$(( $(date +%s) + {left} )); while [ $(date +%s) -lt $end ]; do nice -n 15 '{cargo}' build -q --offline -j1 --manifest-path '{manifest}' --target-dir '{}' >/dev/null 2>&1; '{cargo}' clean -q --offline --manifest-path '{manifest}' --target-dir '{}' >/dev/null 2>&1; done",
                    target.display(),
                    target.display()
                );
                if !self.tool(word, n, done_before, false, &cmd) {
                    return false;
                }
            }
            "hang" => thread::sleep(Duration::from_secs(n)),
            "ask" => {
                self.waiting = true;
                let mut ask = json!({"t": "ask", "id": format!("q{}", now()), "text": "Proceed with the change?"});
                // `ask:N`: a round of N questions, each a shape a CLI's question tool can take [D177].
                if n > 1 {
                    let shapes = [
                        json!({"text": "Which package manager should the scripts use?", "options": [{"label": "pnpm", "description": "Already in the lockfile."}, {"label": "npm"}, {"label": "yarn"}], "recommended": 0, "multiSelect": false}),
                        json!({"text": "Which checks should run before each push?", "options": [{"label": "Typecheck"}, {"label": "Lint"}, {"label": "Bundle check"}], "recommended": null, "multiSelect": true}),
                        json!({"text": "What should the new command be called?", "options": [], "recommended": null, "multiSelect": false}),
                    ];
                    ask["title"] = "Release setup".into();
                    ask["items"] = (0..n as usize).map(|k| shapes[k % 3].clone()).collect();
                }
                emit(ask);
                return false;
            }
            "limit" if !limited() => {}
            "limit" => {
                emit(
                    // When it resets, as some CLIs say: the minute its own message names.
                    json!({"t": "error", "code": 429, "message": "rate limited, try again in 60s", "resets": now() + 60_000}),
                );
                emit(json!({"t": "done", "ok": false}));
                return false;
            }
            "auth" => {
                emit(json!({"t": "error", "code": 401, "message": "login expired"}));
                emit(json!({"t": "done", "ok": false}));
                return false;
            }
            "compact" => emit(json!({"t": "compact"})),
            // The notices' signals [D487]: its own retries, a reroute, a turn failing for a cause,
            // a reply held for checks, an action its rule turned down.
            "retry" => {
                for attempt in 1..=n.max(1) {
                    emit(
                        json!({"t": "retry", "attempt": attempt, "max": n.max(1), "at": now() + 2_000}),
                    );
                    thread::sleep(Duration::from_secs(2));
                }
            }
            "reroute" => emit(json!({"t": "reroute", "from": "fake-large", "to": "fake-small"})),
            "check" => {
                emit(json!({"t": "check", "on": true}));
                thread::sleep(Duration::from_secs(n.max(1)));
                emit(json!({"t": "check", "on": false}));
            }
            "deny" => emit(json!({"t": "deny"})),
            why @ ("overload" | "nomodel" | "blocked" | "unsafe" | "review" | "fail") => {
                let (why, message) = match why {
                    "overload" => ("capacity", "The model is overloaded (529)."),
                    "nomodel" => ("model", "Model fake-large not found."),
                    "blocked" => ("blocked", "The reply was withheld by a content filter."),
                    "unsafe" => ("ended", "This conversation was ended by a safety check."),
                    "review" => ("review", "Too many actions were denied."),
                    _ => ("", "The agent stopped: its connection closed."),
                };
                emit(json!({"t": "fail", "why": why, "message": message}));
                emit(json!({"t": "done", "ok": false}));
                return false;
            }
            "unknown" => {
                emit(json!({"t": "mystery", "x": 1}));
                out(b"garbage <<<");
            }
            "badutf8" => out(&[0xff, 0xfe, b'o', b'k']),
            "bigline" => out(json!({"t": "say", "text": "x".repeat((n << 20) as usize)})
                .to_string()
                .as_bytes()),
            "bg" => drop(
                Command::new("/bin/sleep")
                    .arg(n.to_string())
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .spawn(),
            ),
            "escape" => unsafe {
                drop(
                    Command::new("/bin/sleep")
                        .arg("300")
                        .stdout(Stdio::null())
                        .pre_exec(|| {
                            (libc::setsid() >= 0)
                                .then_some(())
                                .ok_or_else(io::Error::last_os_error)
                        })
                        .spawn(),
                );
            },
            "exit" => process::exit(n as i32),
            "continue" => {
                if let Some((d, done)) = self.pending() {
                    let (name, n) = d
                        .split_once(':')
                        .map_or((d.as_str(), 0), |(a, b)| (a, b.parse().unwrap_or(0)));
                    let name = name.to_string();
                    return self.directive(&name, n, &d, done);
                }
            }
            _ => {}
        }
        true
    }
}
