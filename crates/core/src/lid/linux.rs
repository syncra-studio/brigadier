//! logind's lid hold lives in the daemon's fd: no administrator, marker or guard, and even a
//! killed daemon releases it. Refused sessions stay unsupported without affecting keep-awake.

use serde_json::{Value, json};
use std::io;
use std::os::fd::OwnedFd;
use std::path::Path;
use std::time::{Duration, Instant};

const LOGIN: &str = "org.freedesktop.login1";
const MANAGER: &str = "org.freedesktop.login1.Manager";
const OBJECT: &str = "/org/freedesktop/login1";
const WHAT: &str = "handle-lid-switch";

fn reason(data: &Path) -> String {
    format!("Sessions are working ({})", data.display())
}

async fn inhibit(conn: &zbus::Connection, data: &Path) -> zbus::Result<OwnedFd> {
    let reply = conn
        .call_method(
            Some(LOGIN),
            OBJECT,
            Some(MANAGER),
            "Inhibit",
            &(WHAT, "Brigadier", reason(data), "block"),
        )
        .await?;
    Ok(reply.body().deserialize::<zbus::OwnedFd>()?.into())
}

pub fn status(data: &Path) -> io::Result<Value> {
    let state = zruntime::block_on(async {
        let conn = zbus::Connection::system().await?;
        let reply = conn
            .call_method(Some(LOGIN), OBJECT, Some(MANAGER), "ListInhibitors", &())
            .await?;
        let holds: Vec<(String, String, String, String, u32, u32)> = reply.body().deserialize()?;
        if holds.iter().any(|(what, who, why, mode, _, _)| {
            what.split(':').any(|w| w == WHAT)
                && who == "Brigadier"
                && why == &reason(data)
                && mode == "block"
        }) {
            return Ok("on");
        }
        // Taking and dropping the fd checks this session's actual permission, without prompting.
        inhibit(&conn, data).await?;
        zbus::Result::Ok("ready")
    })
    .unwrap_or("unsupported");
    Ok(json!({"ok": true, "lid": state}))
}

pub fn set_up(data: &Path) -> io::Result<Value> {
    status(data)
}

pub fn seen(_data: &Path, _at: Option<&String>) -> io::Result<Value> {
    Ok(json!({"ok": true}))
}

pub fn wanted(data: &Path) -> bool {
    let saved: Value = std::fs::read(data.join("settings.json"))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();
    saved["awake_lid"] == "true"
}

pub fn recover(_data: &Path) {}

#[derive(Default)]
pub struct Lid {
    held: Option<OwnedFd>,
    retry: Option<Instant>,
}

impl Lid {
    pub fn set(&mut self, data: &Path, want: bool) {
        if !want {
            self.held = None;
            self.retry = None;
        } else if self.held.is_none() && self.retry.is_none_or(|at| Instant::now() >= at) {
            self.retry = Some(Instant::now() + Duration::from_secs(10));
            self.held = zruntime::block_on(async {
                inhibit(&zbus::Connection::system().await?, data).await
            })
            .inspect_err(|e| eprintln!("brigadierd: can't keep going with the lid closed: {e}"))
            .ok();
        }
    }

    pub fn shown(&self, _data: &Path) -> Value {
        json!({"held": self.held.is_some(), "warned": null, "slept": null})
    }
}
