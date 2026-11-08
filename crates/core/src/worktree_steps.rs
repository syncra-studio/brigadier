//! Worktree startup facts and their thread fold. Presentation words stay in the UI.

use crate::{adapters, write_atomic};
use serde_json::{Value, json};
use std::{fs, io, path::Path};

const RECORD: &str = "worktree-setup.json";

pub fn begin(dir: &Path, branch: &str, base: &str) -> io::Result<()> {
    write_atomic(
        &dir.join(RECORD),
        &serde_json::to_vec(&json!({
            "since": brigadier_frames::log::now_ms(),
            "steps": [{"kind": "worktree", "state": "running", "branch": branch, "base": base, "error": null}]
        }))?,
    )
}

pub fn finish(dir: &Path, error: Option<String>) -> io::Result<()> {
    let Some(mut setup) = read(dir) else {
        return Ok(());
    };
    setup["steps"][0]["state"] = if error.is_some() { "failed" } else { "done" }.into();
    setup["steps"][0]["error"] = error.into();
    write_atomic(&dir.join(RECORD), &serde_json::to_vec(&setup)?)
}

pub fn read(dir: &Path) -> Option<Value> {
    serde_json::from_slice::<Value>(&fs::read(dir.join(RECORD)).ok()?)
        .ok()
        .filter(|setup| {
            setup["steps"]
                .as_array()
                .is_some_and(|steps| steps.len() == 1 && steps[0]["kind"] == "worktree")
        })
}

#[derive(Default)]
pub struct Startup {
    launches: Vec<Value>,
    backend: String,
}

impl Startup {
    pub fn push(&mut self, item: &Value) {
        if let Some(backend) = item["backend"].as_str() {
            self.backend = backend.into();
        }
        if item["cid"].is_string()
            && (item["kind"] == "spawned"
                || (item["kind"] == "note" && item["event"] == "spawn_failed"))
        {
            let failed = item["event"] == "spawn_failed";
            self.launches.push(
                json!({"ts": item["ts"], "cid": item["cid"], "wrapped": super::setup_launch(item),
                "cli": adapters::get(&self.backend).map(|a| a.label()),
                "state": if failed { "failed" } else { "running" }, "error": item["error"]}),
            );
        } else if let Some(last) = self.launches.last_mut().filter(|l| l["state"] == "running") {
            match item["kind"].as_str() {
                Some("resume_id" | "turn_start" | "text" | "tool" | "reasoning") => {
                    last["state"] = "done".into();
                }
                Some("unknown") if item["raw"].is_string() => last["error"] = item["raw"].clone(),
                Some("stderr") => last["error"] = item["text"].clone(),
                Some("exited" | "stopped") => {
                    last["state"] = "failed".into();
                    last["code"] = item["code"].clone();
                    last["signal"] = item["signal"].clone();
                }
                _ => {}
            }
        }
    }

    fn launch(&self, setup: &Value) -> Option<&Value> {
        let since = setup["since"].as_u64()?;
        self.launches
            .iter()
            .find(|l| l["ts"].as_u64().unwrap_or(0) >= since)
    }

    pub fn running(&self, setup: &Value) -> bool {
        self.launch(setup).is_some_and(|l| l["state"] == "running")
            || setup["steps"].as_array().is_some_and(|steps| {
                steps
                    .iter()
                    .any(|s| s["kind"] == "setupScript" && s["state"] == "running")
            })
    }

    pub fn sync(&self, mut setup: Value, alive: bool) -> (Value, Option<&str>) {
        if !setup.is_object() {
            return (setup, None);
        }
        let launch = self.launch(&setup);
        let steps = setup["steps"].as_array_mut().unwrap();
        if !alive {
            for step in steps
                .iter_mut()
                .filter(|s| s["kind"] == "setupScript" && s["state"] == "running")
            {
                step["state"] = "failed".into();
                step["interrupted"] = true.into();
            }
        }
        // The wrapper is logged before it creates setup.started; keep that first snapshot honest.
        if launch.is_some_and(|l| l["wrapped"] == true)
            && !steps.iter().any(|s| s["kind"] == "setupScript")
        {
            let state = &launch.unwrap()["state"];
            steps.push(json!({"kind": "setupScript", "state": if !alive && state == "running" { "failed" } else { state.as_str().unwrap_or("running") },
                "error": null, "interrupted": !alive && state == "running"}));
        }
        let script_running = steps
            .iter()
            .any(|s| s["kind"] == "setupScript" && s["state"] == "running");
        if !script_running && let Some(launch) = launch {
            let mut cli = json!({"kind": "cli", "state": launch["state"], "cli": launch["cli"],
                "error": launch["error"], "code": launch["code"], "signal": launch["signal"]});
            if !alive && cli["state"] == "running" {
                cli["state"] = "failed".into();
            }
            if cli["state"] != "failed" {
                cli["error"] = Value::Null;
            }
            steps.push(cli);
        }
        setup["state"] = if steps
            .iter()
            .any(|s| s["kind"] != "cli" && s["state"] == "failed")
        {
            "failed"
        } else if steps.iter().any(|s| s["state"] == "running") {
            "running"
        } else {
            "done"
        }
        .into();
        setup.as_object_mut().unwrap().remove("since");
        (setup, launch.and_then(|l| l["cid"].as_str()))
    }
}
