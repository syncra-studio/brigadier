//! Codex CLI: chat runs its app-server through Brigadier's helper, a thread per session [D159].

use super::Seed;
use super::setup::{first_field, newest};
use super::{
    Accounts, Adapter, Can, Check, Cut, Delivery, Event, Failed, Fork, Forked, Landing, Launch,
    Retune, Rewound, Timing, base_env, cli_home, home_path, probe_as, s, version,
};
use crate::Spec;
use crate::fold::Boundary;
use serde_json::{Value, json};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::time::Duration;

mod control;
mod events;
mod grants;
mod models;
mod record;
mod server;
mod trust;
use record::{diff, forget_thread, held, helpers, rollouts, thread_files};

pub struct Codex;

impl Adapter for Codex {
    fn name(&self) -> &'static str {
        "codex"
    }

    fn label(&self) -> &'static str {
        "Codex"
    }

    fn seeds(&self) -> &'static [Seed] {
        &[
            ("Write code", "gptsol", Some("high")),
            ("Research the web", "gptterra", None),
            ("Review", "gptsol", Some("high")),
        ]
    }

    // `agents.default_subagent_*` are defaults its `spawn_agent` overrides [D376].
    fn draws_first(&self) -> bool {
        true
    }

    fn subagents(&self) -> super::Subagents {
        super::Subagents::Defaults
    }

    fn bin(&self) -> (&'static str, &'static [&'static str]) {
        ("codex", &[".local/bin"])
    }

    fn install(&self) -> Option<&'static str> {
        // Also its update, run again (learn.chatgpt.com/docs/codex/cli). Without the variable the
        // installer asks "Start Codex now?" on the terminal, and a yes starts Codex inside the
        // install, which fails there and fails the install.
        Some("curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh")
    }

    /// What its installer installs, the version npm names latest, as the old app read it.
    fn latest(&self) -> Option<String> {
        super::setup::npm_latest("@openai/codex", "latest")
    }

    /// The OpenAI logo, from apps-sdk-ui (MIT), in the current colour, as the old app drew it [D123].
    fn mark(&self) -> Option<&'static str> {
        Some(include_str!("codex.svg"))
    }

    /// The device code sign-in: no callback to this computer's browser, so it works whatever opens
    /// the page.
    fn sign_in(&self) -> Option<(&'static str, &'static [&'static str])> {
        Some(("Sign in", &["login", "--device-auth"]))
    }

    /// "2. Enter this one-time code (expires in 15 minutes)", then the code on the next line in
    /// colour (codex-cli 0.167.1).
    fn device_code(&self, out: &str) -> Option<String> {
        let after = &out[out.find("one-time code")?..];
        let line = after.split_once('\n')?.1;
        let mut code = String::new();
        let mut chars = line.chars();
        while let Some(c) = chars.next() {
            match c {
                // A colour escape, `ESC [ … m`.
                '\x1b' => while chars.next().is_some_and(|c| !c.is_ascii_alphabetic()) {},
                c if c.is_ascii_alphanumeric() || c == '-' => code.push(c),
                _ if code.is_empty() => {}
                _ => break,
            }
        }
        (code.len() >= 6).then_some(code)
    }

    /// Its last line: a failed sign-in ends on its error, "Error logging in: …" or "ChatGPT
    /// login is disabled. …" (codex-rs/cli/src/login.rs).
    fn sign_in_error(&self, out: &str) -> Option<String> {
        let mut said = String::new();
        let mut chars = out.chars();
        while let Some(c) = chars.next() {
            match c {
                // A terminal escape, `ESC [ … m`.
                '\x1b' => while chars.next().is_some_and(|c| !c.is_ascii_alphabetic()) {},
                c => said.push(c),
            }
        }
        let line = said.lines().map(str::trim).rfind(|l| !l.is_empty())?;
        Some(line.into())
    }

    /// `codex login status` exits 0 when signed in and says how on stderr. Only the kind of
    /// sign-in is kept: its API-key line shows part of the key.
    fn check(&self, spec: &Spec, exe: &Path, cwd: &Path) -> Result<Check, String> {
        let out = probe_as(spec, exe, cwd, &[], &["login", "status"], 15)?;
        let said = String::from_utf8_lossy(&out.stderr).to_string()
            + &String::from_utf8_lossy(&out.stdout);
        let signed_in = out.status.success();
        let how = if !signed_in {
            ""
        } else if said.contains("ChatGPT") {
            "ChatGPT account"
        } else if said.contains("API key") {
            "API key"
        } else {
            "signed in"
        };
        let listed = match signed_in {
            true => models::list(spec, exe, cwd, 15).unwrap_or_default(),
            false => Check::default(),
        };
        Ok(Check {
            version: version(exe, cwd)?,
            signed_in: Some(signed_in),
            // Its account's kind where it's read, else by its words.
            how: match listed.how.as_str() {
                "" => how.into(),
                kind => kind.into(),
            },
            ..listed
        })
    }

    /// `CODEX_HOME` holds its login, in `auth.json` or a keyring entry keyed by that folder
    /// (developers.openai.com/codex/auth), and its history [D51].
    fn accounts(&self) -> Option<Accounts> {
        Some(Accounts {
            var: "CODEX_HOME",
            home: ".codex",
            links: &["sessions", "archived_sessions", "config.toml", "AGENTS.md"],
            vendor: "OpenAI",
            sign_in: &["login"],
            sign_out: &["logout"],
            kinds: &["ChatGPT account", "API key"],
            trust: Some(trust::TRUST),
        })
    }

    /// The folder each rollout ran in, from its first line.
    fn projects(&self) -> Vec<PathBuf> {
        newest(&home_path(".codex/sessions"), ".jsonl", 3, 300)
            .iter()
            .filter_map(|p| first_field(p, &["payload", "cwd"]).map(PathBuf::from))
            .collect()
    }

    fn per_turn(&self) -> bool {
        false
    }

    /// Started at its first code-mode call, inside a turn; `node_repl`, the ChatGPT app's MCP server
    /// in Codex's config, again for each subagent's thread.
    fn helpers(&self) -> &[&str] {
        &["codex-code-mode-host", "node_repl"]
    }

    /// Each line to the helper is one request to its server, applied only once its reply names it.
    fn acks(&self) -> bool {
        true
    }

    /// A message sent mid-turn would need its own queue: only a steer goes then (until 1p).
    fn queues(&self) -> bool {
        false
    }

    fn helper(&self, args: &[String]) -> Result<(), String> {
        server::run(args)
    }

    fn can(&self) -> Can {
        Can {
            steer: true,
            stop: true,
            resume: true,
            levels: &["ask", "auto", "full"],
        }
    }

    /// Level, model and effort ride on the next `turn/start`, checked with it [D222].
    fn retune(&self, _last: &Spec, _next: &Spec) -> Retune {
        Retune::InMessage
    }

    fn control(&self, spec: &Spec, msg: &Value) -> Result<Delivery, String> {
        control::control(spec, msg)
    }

    fn command(&self, spec: &Spec, name: &str) -> Result<Delivery, String> {
        control::command(spec, name)
    }

    fn mcp_servers(&self, folder: &Path) -> Vec<Value> {
        control::shared(&home_path(".codex"), folder)
    }

    fn launched_servers(&self, spec: &Spec) -> Vec<Value> {
        control::servers(&cli_home(spec, ".codex", ""), Path::new(&spec.cwd))
    }

    /// Its compact, then the skills its folders hold: the repo's `.agents`, its home's, the user's
    /// `.agents` (ext/skills host_roots.rs).
    fn fixed_commands(&self, cwd: Option<&Path>, run: Option<&Spec>) -> Vec<Value> {
        let home = run.map_or_else(|| home_path(".codex"), |s| cli_home(s, ".codex", ""));
        let roots = (cwd.map(|c| c.join(".agents/skills")).into_iter())
            .chain([home.join("skills"), home_path(".agents/skills")]);
        let skills = super::files::skills_in(roots.map(|r| (r, String::new())));
        std::iter::once(events::compact()).chain(skills).collect()
    }

    fn launch(&self, spec: &Spec, resume: Option<&str>, text: Option<&str>) -> Launch {
        let exe = self.exe().unwrap_or_default();
        let helper = (std::env::current_exe().unwrap_or_default()).with_file_name("brigadier");
        // A thread that never took a turn has no record, and Codex refuses to resume it.
        let home = cli_home(spec, ".codex", "");
        let resume = resume.filter(|id| !rollouts(&home, &[format!("-{id}.jsonl")]).is_empty());
        let mut open = control::open(spec, resume);
        // Its app-server's own flags for the library [D407].
        let flags = (open.as_object_mut()).and_then(|o| o.remove("launch"));
        let flags = (flags
            .into_iter()
            .flat_map(|f| f.as_array().cloned().unwrap_or_default()))
        .filter_map(|f| f.as_str().map(String::from));
        let open = json!({"open": open, "grants": spec.grants, "id": spec.cid});
        let lines = [Some(open), text.map(|t| control::turn(spec, t))];
        Launch {
            argv: [helper, "helper".into(), "codex".into(), exe.clone()]
                .map(|a| a.display().to_string())
                .into_iter()
                .chain(flags)
                .collect(),
            env: base_env(spec, &exe, &self.keys()),
            keep_stdin: true,
            input: Some(lines.iter().flatten().map(|l| format!("{l}\n")).collect()),
        }
    }

    fn encode(&self, spec: &Spec, text: &str) -> String {
        format!("{}{}\n", control::redial(spec), control::turn(spec, text))
    }

    fn parse(&self, line: &str) -> Vec<Event> {
        events::parse(line)
    }

    fn timing(&self) -> Timing {
        Timing {
            silent_ms: 20_000,
            stall_ms: 120_000,
            no_start_ms: 30_000,
        }
    }

    fn api_host(&self) -> Option<String> {
        Some("api.openai.com:443".into())
    }

    fn external(&self, spec: &Spec, resume: &str) -> Vec<PathBuf> {
        let names = spawned(self, spec, resume);
        let mut paths = rollouts(
            &cli_home(spec, ".codex", ""),
            &names
                .iter()
                .map(|id| format!("-{id}.jsonl"))
                .collect::<Vec<_>>(),
        );
        paths.extend(thread_files(spec, &names));
        paths
    }

    /// The thread and the Auto reviewers that worked for it, each by its own id; the thread goes
    /// last, so a retry after a failure can still find them [D35].
    fn forget(&self, spec: &Spec, resume: &str) -> Result<(), String> {
        let home = cli_home(spec, ".codex", "");
        let mut ids = helpers(&home, &spawned(self, spec, resume));
        ids.push(resume.to_string());
        for id in &ids {
            forget_thread(self, spec, id)?;
        }
        Ok(())
    }

    /// Its record keeps each message with the id `turn/start` gave it.
    fn accepted(&self, spec: &Spec, resume: &str, cid: &str) -> bool {
        let found = rollouts(&cli_home(spec, ".codex", ""), &[format!("-{resume}.jsonl")]);
        found.iter().any(|path| {
            std::fs::read_to_string(path).is_ok_and(|all| {
                all.lines()
                    .filter_map(|l| serde_json::from_str::<Value>(l).ok())
                    .any(|v| v["payload"]["item"]["client_id"] == cid)
            })
        })
    }

    fn can_cut(&self, cut: &Cut) -> bool {
        cut.kept.is_none_or(|k| k.end.is_some())
    }

    /// Before the first turn, a new thread; otherwise a fork that ends at the last turn kept.
    fn rewind(&self, spec: &Spec, _resume: &str, cut: &Cut) -> Result<Rewound, Failed> {
        let Some(kept) = cut.kept else {
            return Ok(Rewound {
                fresh: true,
                ..Rewound::default()
            });
        };
        let exe = (self.exe()).ok_or_else(|| Failed::Refused("Codex is not installed".into()))?;
        let id = models::fork(
            spec,
            &exe,
            Path::new(&spec.cwd),
            &kept.conv,
            kept.end.as_deref().unwrap_or(""),
        )?;
        Ok(Rewound {
            turns: held(spec, &id),
            moved: Some(id),
            ..Rewound::default()
        })
    }

    // Off until the live checks pass (D494, D506): Codex forks from the hand-off meanwhile.
    fn forking(&self) -> Option<&dyn Fork> {
        None
    }

    /// Its original never changes: whether or not a fork was made, this cut didn't take.
    fn landed(&self, spec: &Spec, resume: &str, cut: &Cut, at: u64) -> Landing {
        if let (Some(kept), Some(exe)) = (cut.kept, self.exe()) {
            models::drop_fork(spec, &exe, Path::new(&spec.cwd), &kept.conv, resume, at);
        }
        Landing::NotApplied
    }

    fn transcript(&self, spec: &Spec, resume: &str) -> Option<(u64, u64)> {
        let (mut texts, mut tools) = (0, 0);
        for path in self.external(spec, resume) {
            if !path
                .file_name()?
                .to_string_lossy()
                .ends_with(&format!("-{resume}.jsonl"))
            {
                continue;
            }
            for v in std::fs::read_to_string(path)
                .ok()?
                .lines()
                .filter_map(|l| serde_json::from_str::<Value>(l).ok())
            {
                if v["type"] != "response_item" {
                    continue;
                }
                match s(&v, &["payload", "type"]) {
                    "message" if s(&v, &["payload", "role"]) == "assistant" => texts += 1,
                    t if t.ends_with("_call") => tools += 1,
                    _ => {}
                }
            }
        }
        Some((texts, tools))
    }

    fn diffs(&self, resume: &str, turn: u64) -> Option<Vec<Vec<(String, String)>>> {
        crate::check_id(resume).ok()?;
        let path = rollouts(&home_path(".codex"), &[format!("-{resume}.jsonl")]).pop()?;
        let (mut turns, mut edits) = (0, vec![]);
        for v in std::fs::read_to_string(path)
            .ok()?
            .lines()
            .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        {
            let p = &v["payload"];
            match s(p, &["type"]) {
                "task_started" => turns += 1,
                "item_completed" if turns == turn + 1 && p["item"]["type"] == "FileChange" => {
                    let files = p["item"]["changes"].as_object()?;
                    edits.push(files.iter().map(|(f, c)| (f.clone(), diff(c))).collect());
                }
                _ => {}
            }
        }
        (turns > turn).then_some(edits)
    }
}

/// Its own delete: the thread's rows in its databases, its subagents' threads and its rollout. With
/// no Codex to ask, only a home that's gone proves nothing is left [D35, D244].
fn delete_thread(codex: &Codex, spec: &Spec, resume: &str) -> Result<(), String> {
    match codex.exe() {
        Some(exe) => models::delete(spec, &exe, &home_path(""), resume),
        None if cli_home(spec, ".codex", "").exists() => {
            Err("Codex isn't installed, so its record of this thread can't be removed.".into())
        }
        None => Ok(()),
    }
}

impl Fork for Codex {
    /// `thread/fork` with the fork's folder as the server's, on the source's account [D1089].
    fn fork(
        &self,
        spec: &Spec,
        at: &Boundary,
        _next: Option<&Boundary>,
        cwd: &Path,
    ) -> Result<Forked, Failed> {
        let exe = (self.exe()).ok_or_else(|| Failed::Refused("Codex is not installed".into()))?;
        let end = at.end.as_deref().unwrap_or("");
        let conv = models::fork(spec, &exe, cwd, &at.conv, end)?;
        // Past its creation second, so a rewind's sweep of forks (by second) can't take it [D1089].
        let ms = brigadier_frames::log::now_ms() % 1000;
        std::thread::sleep(Duration::from_millis(1000 - ms));
        Ok(Forked {
            turns: held(spec, &conv),
            conv,
        })
    }

    fn forks(&self, spec: &Spec, conv: &str) -> Option<Vec<String>> {
        models::forks(spec, &self.exe()?, Path::new(&spec.cwd), conv)
    }

    fn unfork(
        &self,
        spec: &Spec,
        conv: &str,
        before: &[String],
        owned: &BTreeSet<String>,
    ) -> Result<(), String> {
        let exe = self.exe().ok_or("Codex is not installed")?;
        let cwd = Path::new(&spec.cwd);
        let now = models::forks(spec, &exe, cwd, conv).ok_or("Codex couldn't list its threads")?;
        for id in now
            .iter()
            .filter(|id| !before.contains(id) && !owned.contains(*id))
        {
            models::delete(spec, &exe, cwd, id)?;
        }
        Ok(())
    }
}

/// The thread and the agents it spawned, by the ids its log holds.
fn spawned(codex: &Codex, spec: &Spec, resume: &str) -> Vec<String> {
    let mut ids = BTreeSet::from([resume.to_string()]);
    let mut backend = String::new();
    let _ = crate::read(&spec.dir, |item| {
        if let Some(b) = item["backend"].as_str() {
            backend = b.into();
        }
        if backend == codex.name() && item["kind"] == "tool" && item["name"] == "spawn_agent" {
            ids.insert(s(item, &["id"]).into());
        }
    });
    ids.into_iter()
        .filter(|id| crate::check_id(id).is_ok())
        .collect()
}
