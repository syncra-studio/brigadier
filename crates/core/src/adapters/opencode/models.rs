//! Its models and what they need, as a server of its own lists them [D2098]: the server fills its
//! catalogue after it starts, so it's asked until it holds what `models`, which waits, lists.

use super::super::{ModelInfo, mark_superseded, probe, uuid};
use super::{control, http, image};
use brigadier_frames::base64;
use serde_json::Value;
use std::io::{BufRead, BufReader};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdout, Command, Stdio};
use std::sync::mpsc::RecvTimeoutError;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

/// How long its server has to fill its catalogue.
const FILL: Duration = Duration::from_secs(15);

/// `opencode serve`, which runs for as long as its stdin is held open.
pub(super) fn serve(command: &mut Command, password: &str) -> Result<Child, String> {
    command
        .args(["serve", "--stdio", "--hostname", "127.0.0.1", "--port", "0"])
        .env("OPENCODE_PASSWORD", password)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .map_err(|e| format!("OpenCode didn't start: {e}"))
}

/// The server it says it runs, and the rest of what it prints.
pub(super) fn dial(
    out: Option<ChildStdout>,
    password: &str,
) -> Result<(BufReader<ChildStdout>, http::Server), String> {
    let mut out = BufReader::new(out.ok_or("no stdout")?);
    let mut first = String::new();
    out.read_line(&mut first).map_err(|e| e.to_string())?;
    let url: Value =
        serde_json::from_str(&first).map_err(|_| format!("OpenCode said {first:?}"))?;
    let addr = super::s(&url, &["url"]).trim_start_matches("http://");
    let server = http::Server {
        addr: addr.into(),
        auth: base64(format!("opencode:{password}").as_bytes()),
    };
    Ok((out, server))
}

/// The variables its providers' keys are read from, as its last check found them.
pub(super) fn keys_file() -> PathBuf {
    crate::data_dir().join("agents/opencode.keys")
}

/// The models it can run in `cwd`; with their names, efforts and window where its server says, by
/// their ids alone where it doesn't.
pub(super) fn list(
    exe: &Path,
    cwd: &Path,
    keys: &[String],
    local: &impl Fn(&str) -> bool,
) -> Result<Vec<ModelInfo>, String> {
    let out = probe(exe, cwd, keys, &["models", "--standalone"], 30)?;
    if !out.status.success() {
        let said = [out.stdout, out.stderr].concat();
        return Err(String::from_utf8_lossy(&said).into_owned());
    }
    let ids: Vec<String> = (String::from_utf8_lossy(&out.stdout).lines())
        .filter(|l| l.contains('/') && !l.contains(' '))
        .map(String::from)
        .collect();
    let read = catalogue(exe, cwd, keys, &ids).unwrap_or_else(|e| {
        eprintln!("OpenCode's models are known by their ids alone: {e}");
        Catalogue::default()
    });
    let mut models: Vec<ModelInfo> = (ids.iter())
        .map(|id| {
            let found = read.models.iter().find(|m| of(m) == *id);
            let mut info = match found {
                Some(m) => control::model_info(m, local, read.images),
                None => ModelInfo::plain(id, local(id)),
            };
            info.default = read.default.as_ref() == Some(id);
            info
        })
        .collect();
    models.sort_by(|a, b| a.id.cmp(&b.id));
    mark_superseded(&mut models);
    Ok(models)
}

fn of(m: &Value) -> String {
    format!("{}/{}", super::s(m, &["providerID"]), super::s(m, &["id"]))
}

#[derive(Default)]
struct Catalogue {
    models: Vec<Value>,
    images: Option<bool>,
    default: Option<String>,
}

/// What a server of its own says of `ids`, once it holds them all or its time is up.
fn catalogue(exe: &Path, cwd: &Path, keys: &[String], ids: &[String]) -> Result<Catalogue, String> {
    let mut command = Command::new(exe);
    command
        .env_clear()
        .envs(super::base_env(&crate::Spec::default(), exe, keys))
        .current_dir(cwd)
        .stderr(Stdio::null())
        .process_group(0);
    let password = uuid();
    let mut child = serve(&mut command, &password)?;
    let (_lease, out) = (child.stdin.take(), child.stdout.take());
    // A hung one is ended by the clock, whatever it's waited on for.
    let child = Arc::new(Mutex::new(child));
    let (over, wait) = std::sync::mpsc::channel::<()>();
    let held = child.clone();
    thread::spawn(move || {
        if wait.recv_timeout(FILL * 2) == Err(RecvTimeoutError::Timeout) {
            end(&held);
        }
    });
    let read = dial(out, &password).and_then(|(out, server)| {
        // Read on, so it never waits on a full pipe.
        thread::spawn(move || std::io::copy(&mut { out }, &mut std::io::sink()));
        ask(&server, ids)
    });
    drop(over);
    end(&child);
    let _ = child.lock().unwrap().wait();
    read
}

/// Ends its whole group, a wrapper's server too, while it still runs: its pid is its own till then.
fn end(child: &Mutex<Child>) {
    let mut child = child.lock().unwrap();
    if let Ok(None) = child.try_wait() {
        unsafe { libc::killpg(child.id() as i32, libc::SIGKILL) };
    }
}

fn ask(server: &http::Server, ids: &[String]) -> Result<Catalogue, String> {
    let get = |path: &str| -> Result<Value, String> {
        match server.request("GET", path, &Value::Null) {
            Ok((200, body)) => serde_json::from_str(&body).map_err(|e| e.to_string()),
            Ok((status, _)) => Err(format!("{path}: {status}")),
            Err(e) => Err(format!("{path}: {e}")),
        }
    };
    let till = Instant::now() + FILL;
    let models = loop {
        let mut all = get("/api/model")?["data"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        all.retain(|m| m["enabled"] != false);
        let held: std::collections::HashSet<String> = all.iter().map(of).collect();
        if ids.iter().all(|id| held.contains(id)) || Instant::now() > till {
            break all;
        }
        thread::sleep(Duration::from_millis(200));
    };
    if let Ok(v) = get("/api/integration") {
        keep_keys(&v);
    }
    let default = get("/api/model/default").ok();
    Ok(Catalogue {
        models,
        images: image::any(get(image::LIST)),
        default: default
            .filter(|v| v["data"].is_object())
            .map(|v| of(&v["data"])),
    })
}

/// The API-key variables its providers read, kept for its next launch's environment. Other variables
/// they name (a cloud's credentials, a GitHub token) are other tools' too, so they aren't passed on.
fn keep_keys(integrations: &Value) {
    let methods = (integrations["data"].as_array().into_iter().flatten())
        .flat_map(|i| i["methods"].as_array().into_iter().flatten())
        .flat_map(|m| m["names"].as_array().into_iter().flatten());
    let mut names: Vec<&str> = (methods.filter_map(Value::as_str))
        .filter(|n| n.ends_with("_API_KEY"))
        .collect();
    names.sort();
    names.dedup();
    let (path, text) = (keys_file(), names.join("\n"));
    if !names.is_empty() && std::fs::read_to_string(&path).ok().as_ref() != Some(&text) {
        let _ = std::fs::create_dir_all(path.parent().unwrap());
        if let Err(e) = crate::write_atomic(&path, text.as_bytes()) {
            eprintln!("OpenCode's key names weren't kept: {e}");
        }
    }
}

/// The company that made a model, from every word of its id: `anthropic/claude-sonnet-4-5`, a
/// gateway's `openrouter/anthropic/claude-…`, `amazon-bedrock/anthropic.claude-…`,
/// `github-copilot/gpt-…` (opencode.ai/docs/providers, read 2026-11-27). None where no word names
/// one, or two name different ones: never taken for another company [bugfix-1112 D399].
pub(super) fn maker(id: &str) -> Option<&'static str> {
    const MAKERS: &[(&str, &[&str])] = &[
        ("Anthropic", &["anthropic", "claude"]),
        ("OpenAI", &["openai", "gpt", "codex"]),
        ("Google", &["google", "gemini", "gemma"]),
        ("xAI", &["xai", "grok"]),
        (
            "Mistral",
            &[
                "mistral",
                "devstral",
                "codestral",
                "magistral",
                "ministral",
                "pixtral",
            ],
        ),
        ("DeepSeek", &["deepseek"]),
        ("Alibaba", &["alibaba", "qwen"]),
        ("Meta", &["meta", "llama"]),
        ("Moonshot", &["moonshot", "kimi"]),
        ("Z.ai", &["zai", "zhipu", "glm"]),
        ("MiniMax", &["minimax"]),
    ];
    let lower = id.to_lowercase();
    let words = lower.split(|c: char| !c.is_ascii_alphanumeric());
    let mut found = words.filter_map(|w| {
        // OpenAI's reasoning models are named o1, o3, o4 alone.
        let o = matches!(w, "o1" | "o3" | "o4");
        (MAKERS.iter())
            .find(|(_, names)| names.iter().any(|n| w.starts_with(n)))
            .map(|m| m.0)
            .or(o.then_some("OpenAI"))
    });
    let first = found.next()?;
    found.all(|m| m == first).then_some(first)
}
