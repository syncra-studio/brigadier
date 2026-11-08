//! Codex CLI: chat runs its app-server through Brigadier's helper, a thread per session [D159]; the
//! terminal is its TUI on the same thread. `exec --json` output is still parsed, for older sessions' logs.

use super::setup::{first_field, newest};
use super::{
    Accounts, Adapter, Can, Check, Delivery, Event, Launch, ModelInfo, Retune, Timing, base_env,
    cli_home, drop_lines, file_lines, home_path, in_pty, paste, probe_as, s, version,
};
use crate::Spec;
use serde_json::{Value, json};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

mod control;
mod events;
mod models;
mod record;
mod server;
mod trust;
use record::{diff, rollouts, thread_files};

pub struct Codex;

const MODEL: &str = "gpt-5.6-luna";

impl Adapter for Codex {
    fn name(&self) -> &'static str {
        "codex"
    }

    fn label(&self) -> &'static str {
        "Codex"
    }

    fn bin(&self) -> (&'static str, &'static [&'static str]) {
        ("codex", &[".local/bin"])
    }

    fn install(&self) -> Option<&'static str> {
        // Without it the installer asks "Start Codex now?" on the terminal, and a yes starts Codex
        // inside the install, which fails there and fails the install.
        Some("curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh")
    }

    /// The OpenAI logo, from apps-sdk-ui (MIT), in the current colour, as the old app drew it [D123].
    fn mark(&self) -> Option<&'static str> {
        Some(
            r#"<svg viewBox="0 0 24 24" fill="currentColor"><path d="M9.20509 8.76514V6.50548C9.20509 6.31517 9.27649 6.17237 9.44293 6.07733L13.9861 3.46091C14.6046 3.10416 15.342 2.93772 16.103 2.93772C18.9573 2.93772 20.7651 5.14986 20.7651 7.50457C20.7651 7.67101 20.7651 7.86132 20.7412 8.05164L16.0316 5.29243C15.7462 5.12599 15.4607 5.12599 15.1753 5.29243L9.20509 8.76514ZM19.8136 17.566V12.1665C19.8136 11.8334 19.6708 11.5955 19.3854 11.4291L13.4152 7.95637L15.3656 6.83836C15.5321 6.74332 15.6749 6.74332 15.8413 6.83836L20.3845 9.45477C21.6928 10.216 22.5728 11.8334 22.5728 13.4032C22.5728 15.2108 21.5025 16.8759 19.8136 17.5657V17.566ZM7.80173 12.8088L5.8513 11.6671C5.68486 11.5721 5.61346 11.4293 5.61346 11.239V6.00616C5.61346 3.46114 7.56389 1.53436 10.2042 1.53436C11.2033 1.53436 12.1307 1.86746 12.9159 2.46205L8.2301 5.17374C7.94475 5.34018 7.80196 5.57801 7.80196 5.91112V12.809L7.80173 12.8088ZM12 15.2349L9.20509 13.6651V10.3352L12 8.76537L14.7947 10.3352V13.6651L12 15.2349ZM13.7958 22.4659C12.7967 22.4659 11.8693 22.1328 11.0841 21.5382L15.7699 18.8265C16.0553 18.6601 16.198 18.4223 16.198 18.0892V11.1912L18.1723 12.3329C18.3388 12.4279 18.4102 12.5707 18.4102 12.7611V17.9939C18.4102 20.5389 16.4359 22.4657 13.7958 22.4657V22.4659ZM8.15848 17.1617L3.61528 14.5453C2.30696 13.784 1.42701 12.1667 1.42701 10.5969C1.42701 8.76537 2.52115 7.12417 4.20987 6.43431V11.8575C4.20987 12.1906 4.35266 12.4284 4.63802 12.5948L10.5846 16.0437L8.63415 17.1617C8.46771 17.2567 8.32492 17.2567 8.15848 17.1617ZM7.897 21.0626C5.20919 21.0626 3.23488 19.0407 3.23488 16.5432C3.23488 16.3529 3.25875 16.1626 3.2824 15.9723L7.96817 18.684C8.25352 18.8504 8.53911 18.8504 8.82447 18.684L14.7947 15.2351V17.4948C14.7947 17.6851 14.7233 17.8279 14.5568 17.9229L10.0136 20.5394C9.39518 20.8961 8.6578 21.0626 7.89677 21.0626H7.897ZM13.7958 23.8929C16.6739 23.8929 19.0762 21.8475 19.6235 19.1358C22.2874 18.4459 24 15.9484 24 13.4034C24 11.7383 23.2865 10.121 22.002 8.95546C22.121 8.45591 22.1924 7.95637 22.1924 7.45705C22.1924 4.05573 19.4331 1.51048 16.2458 1.51048C15.6037 1.51048 14.9852 1.60553 14.3668 1.81971C13.2963 0.773101 11.8215 0.107117 10.2042 0.107117C7.32606 0.107117 4.92383 2.15259 4.37653 4.86428C1.7126 5.55414 0 8.05164 0 10.5967C0 12.2617 0.713506 13.8791 1.99795 15.0446C1.87904 15.5441 1.80764 16.0437 1.80764 16.543C1.80764 19.9443 4.56685 22.4896 7.75421 22.4896C8.39632 22.4896 9.01478 22.3945 9.63324 22.1803C10.7035 23.2269 12.1783 23.8929 13.7958 23.8929Z"/></svg>"#,
        )
    }

    fn sign_in(&self) -> Option<(&'static str, &'static [&'static str])> {
        Some(("Sign in", &["login"]))
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
        Ok(Check {
            version: version(exe, cwd)?,
            signed_in: Some(signed_in),
            how: how.into(),
            models: if signed_in {
                models::list(spec, exe, cwd, 15)
                    .unwrap_or_else(|| vec![ModelInfo::plain(MODEL, false)])
            } else {
                vec![]
            },
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
        let line = match msg["kind"].as_str() {
            Some("answer") => control::answer(spec, msg)?,
            Some("steer") => json!({"id": spec.cid, "steer": msg["text"]}),
            Some("interrupt") => json!({"id": spec.cid, "interrupt": true}),
            _ => return Err("Codex takes no such control message.".into()),
        };
        Ok(Delivery::Stdin(format!("{line}\n")))
    }

    fn launch(&self, spec: &Spec, resume: Option<&str>, text: Option<&str>) -> Launch {
        let exe = self.exe().unwrap_or_default();
        if spec.mode != "pty" {
            let helper = (std::env::current_exe().unwrap_or_default()).with_file_name("brigadier");
            // A thread that never took a turn has no record, and Codex refuses to resume it.
            let home = cli_home(spec, ".codex", "");
            let resume = resume.filter(|id| !rollouts(&home, &[format!("-{id}.jsonl")]).is_empty());
            let open =
                json!({"open": control::open(spec, resume), "grants": spec.grants, "id": spec.cid});
            let lines = [Some(open), text.map(|t| control::turn(spec, t))];
            return Launch {
                argv: vec![
                    helper.display().to_string(),
                    "helper".into(),
                    "codex".into(),
                    exe.display().to_string(),
                ],
                env: base_env(spec, &exe, self.keys()),
                keep_stdin: true,
                input: Some(lines.iter().flatten().map(|l| format!("{l}\n")).collect()),
            };
        }
        let model = spec.model.clone().unwrap_or_else(|| MODEL.into());
        // Its TUI would otherwise join a shared background server, outside this session's
        // process group [D60]; the sandbox flag also skips its trust screen.
        let mut argv = vec![exe.display().to_string()];
        argv.extend(["--no-daemon", "--sandbox", "workspace-write"].map(String::from));
        argv.extend([
            "-m".into(),
            model,
            "-c".into(),
            "model_reasoning_effort=\"low\"".into(),
        ]);
        if let Some(id) = resume {
            argv.extend(["resume".into(), id.into()]);
        }
        argv.extend(text.map(String::from));
        Launch {
            argv,
            env: base_env(spec, &exe, self.keys()),
            keep_stdin: true,
            input: None,
        }
    }

    fn encode(&self, spec: &Spec, text: &str) -> String {
        if spec.mode == "pty" {
            return paste(text);
        }
        format!("{}\n", control::turn(spec, text))
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

    fn external(&self, spec: &Spec, resume: &str) -> Vec<PathBuf> {
        let mut ids = BTreeSet::from([resume.to_string()]);
        let mut backend = String::new();
        let _ = crate::read(&spec.dir, |item| {
            if let Some(b) = item["backend"].as_str() {
                backend = b.into();
            }
            if backend == self.name() && item["kind"] == "tool" && item["name"] == "spawn_agent" {
                ids.insert(s(item, &["id"]).into());
            }
        });
        let names: Vec<String> = ids
            .into_iter()
            .filter(|id| crate::check_id(id).is_ok())
            .collect();
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

    /// Its prompt history by thread id, and a writer lock a killed process left; one a live
    /// writer holds stays, by Codex's own rule [D35].
    fn forget(&self, spec: &Spec, resume: &str) -> Result<(), String> {
        delete_thread(self, spec, resume)?;
        drop_lines(
            &cli_home(spec, ".codex", "history.jsonl"),
            "session_id",
            resume,
        )
        .map_err(|e| e.to_string())?;
        // Its thread names, by thread id.
        drop_lines(
            &cli_home(spec, ".codex", "session_index.jsonl"),
            "id",
            resume,
        )
        .map_err(|e| e.to_string())?;
        let lock = cli_home(spec, ".codex", "thread-writer-locks").join(format!("{resume}.lock"));
        if let Ok(f) = std::fs::File::open(&lock)
            && f.try_lock().is_ok()
        {
            let _ = std::fs::remove_file(&lock);
        }
        Ok(())
    }

    /// Its TUI resumes a thread by id; a new thread's id can't be picked, so the first message of
    /// a session goes through chat (proposed).
    fn terminal(&self, spec: &Spec, resume: Option<&str>) -> Result<(Launch, String), String> {
        let id = resume.ok_or("Send the first message in chat. The terminal then opens on it.")?;
        Ok((self.launch(&in_pty(spec), Some(id), None), id.into()))
    }

    fn mirror_from(&self, spec: &Spec, conv: &str) -> Option<String> {
        let path = rollouts(&cli_home(spec, ".codex", ""), &[format!("-{conv}.jsonl")]).pop()?;
        let len = std::fs::metadata(&path).ok()?.len();
        Some(format!("{len}\t{}", path.display()))
    }

    fn mirror(&self, _spec: &Spec, _conv: &str, cursor: &str) -> (Vec<String>, String) {
        let (from, path) = cursor.split_once('\t').unwrap_or(("0", ""));
        let (lines, end) = file_lines(std::path::Path::new(path), from.parse().unwrap_or(0));
        (lines, format!("{end}\t{path}"))
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
