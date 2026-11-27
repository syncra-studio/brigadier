//! A picture of one window, its hash against the last so a stale one never passes as fresh, and
//! a drag by its pixels [D2032].

use super::typing::finder;
use super::{Sess, call, refuse};
use brigadier_core as core;
use serde_json::{Value, json};
use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

/// A drag between two controls' centres, in the window's picture pixels: one picture (it needs
/// Screen Recording) gives the window's place and scale, and is deleted at once (proposed).
pub(super) fn drag(
    data: &Path,
    me: &str,
    s: &Sess,
    from: u64,
    to: u64,
    here: &dyn Fn() -> bool,
) -> Result<Value, Value> {
    let frame = |n: u64| {
        s.frames.get(&n).copied().ok_or_else(|| {
            refuse(&format!(
                "[{n}] has no place on screen in your last read: read again."
            ))
        })
    };
    let (a, b) = (frame(from)?, frame(to)?);
    let shot = json!({"pid": s.pid, "window_id": s.window, "session": me, "include_accessibility_tree": false});
    let found = throwaway(shot, |shot| call(data, "get_window_state", shot, here))?;
    let bounds = &found["window_bounds"];
    let (Some(x), Some(y), Some(scale)) = (
        bounds["x"].as_f64(),
        bounds["y"].as_f64(),
        found["screenshot_scale"].as_f64(),
    ) else {
        return Err(not_captured(&found));
    };
    let at = |f: [f64; 4]| {
        (
            (f[0] + f[2] / 2.0 - x) * scale,
            (f[1] + f[3] / 2.0 - y) * scale,
        )
    };
    let ((fx, fy), (tx, ty)) = (at(a), at(b));
    // A file dragged in Finder, by its row, cell or name, means a drop; a pane's divider or a
    // slider means none [D129].
    let item = |c: &&super::diff::Control| c.cell || ["AXRow", "AXCell"].contains(&c.role.as_str());
    let drop = (s.controls.iter()).any(|c| c.n == from && item(&c)) && finder(s.pid);
    Ok(
        json!({"pid": s.pid, "window_id": s.window, "from_x": fx, "from_y": fy, "to_x": tx, "to_y": ty, "session": me, "drop": drop}),
    )
}

/// One capture of a window that's never kept, for what taking it gives (a drag's scale) or does
/// (macOS's capture alert): in a folder of its own, removed as the call returns and again a minute
/// later, as the driver may still write it after a call that timed out (proposed).
pub(in crate::computer) fn throwaway<R>(mut shot: Value, take: impl FnOnce(Value) -> R) -> R {
    static N: AtomicU64 = AtomicU64::new(0);
    let n = N.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!("brigadier-shot-{}-{n}", std::process::id()));
    let _ = fs::create_dir_all(&dir);
    shot["include_screenshot"] = true.into();
    shot["screenshot_out_file"] = json!(dir.join("shot.png"));
    let found = take(shot);
    let _ = fs::remove_dir_all(&dir);
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(60));
        let _ = fs::remove_dir_all(dir);
    });
    found
}

/// The window as a picture in the session's folder, gone with it [D35]; only its path comes back.
pub(super) fn screenshot(
    data: &Path,
    me: &str,
    s: &mut Sess,
    region: Option<&str>,
    here: &dyn Fn() -> bool,
) -> Result<String, Value> {
    if s.window == 0 {
        return Err(refuse(
            "Read a window first: brigadier computer read <app>.",
        ));
    }
    let dir = core::session_dir(data, me).join("computer");
    fs::create_dir_all(&dir).map_err(|e| refuse(&e.to_string()))?;
    // After the highest number taken: the folder holds the calls log too, and a name is never reused.
    let n = fs::read_dir(&dir).map_or(0, |d| {
        (d.flatten())
            .filter_map(|e| e.path().file_stem()?.to_str()?.parse::<u64>().ok())
            .max()
            .unwrap_or(0)
    }) + 1;
    let file = dir.join(format!("{n}.jpg"));
    let shot = json!({"pid": s.pid, "window_id": s.window, "session": me, "include_accessibility_tree": false, "include_screenshot": true, "screenshot_out_file": file, "screenshot_format": "jpeg", "max_dimension": 1280});
    let found = call(data, "get_window_state", shot, here)?;
    if found["screenshot_file_path"].is_null() {
        return Err(not_captured(&found));
    }
    let full = (
        found["screenshot_width"].as_u64(),
        found["screenshot_height"].as_u64(),
    );
    let size = match full {
        (Some(w), Some(h)) => format!(" ({w}×{h})"),
        _ => String::new(),
    };
    let Some(r) = region else {
        let fresh = fresh(data, s, &file, here);
        return Ok(format!(
            "Saved: {}{size}. `click --at X,Y` clicks a point of it.{fresh}",
            file.display()
        ));
    };
    // A part of the picture, cut in place (proposed).
    let n: Vec<u64> = (r.split(','))
        .filter_map(|v| v.trim().parse().ok())
        .collect();
    let [x, y, w, h] = n[..] else {
        return Err(refuse(
            "--region takes X,Y,W,H in the picture's pixels: --region 0,0,640,400",
        ));
    };
    // sips pads past an edge with black and still succeeds [D930].
    let out = |at: u64, len: u64, of: Option<u64>| {
        len == 0 || of.is_some_and(|of| at.saturating_add(len) > of)
    };
    if out(x, w, full.0) || out(y, h, full.1) {
        return Err(refuse(&format!(
            "Couldn't cut that region: it must lie inside the picture{size}."
        )));
    }
    let sips = |args: &str| {
        let cut = std::process::Command::new("sips")
            .args(args.split(' '))
            .arg(&file)
            .output();
        cut.is_ok_and(|o| o.status.success())
    };
    let crop = |y: u64, x: u64| format!("--cropToHeightWidth {h} {w} --cropOffset {y} {x}");
    // sips reads a `0 0` offset as none and cuts the centre, and `0.0` as -1 [D930, D936]: the
    // top-left corner is cut as the bottom-right one of the picture turned round.
    let cut = match (x, y, full) {
        (0, 0, (Some(fw), Some(fh))) if (fw, fh) == (w, h) => true,
        (0, 0, (Some(fw), Some(fh))) => {
            sips(&format!("-r 180 {}", crop(fh - h, fw - w))) && sips("-r 180")
        }
        (0, 0, _) => false,
        _ => sips(&crop(y, x)),
    };
    if !cut {
        return Err(refuse("Couldn't cut that region."));
    }
    // The hash is of the part saved, so two regions of one picture never read as the same.
    let fresh = fresh(data, s, &file, here);
    Ok(format!(
        "Saved: {} ({w}×{h}), the part at {x},{y} of the window's picture{size}. `click --at X,Y` takes the whole picture's pixels: add {x},{y}.{fresh}",
        file.display()
    ))
}

/// Whether a picture can be trusted: its hash against the last one's, and whether the window was
/// on show. A covered or off-Space window keeps its last frame, or none: Chromium stops painting
/// a covered window, so its web area comes back stale or blank while the tree is current [D2032].
fn fresh(data: &Path, s: &mut Sess, file: &Path, here: &dyn Fn() -> bool) -> String {
    use sha2::{Digest, Sha256};
    let hash: String = fs::read(file).map_or_else(
        |_| "unknown".into(),
        |b| {
            Sha256::digest(&b)[..6]
                .iter()
                .map(|x| format!("{x:02x}"))
                .collect()
        },
    );
    let same = s
        .shot
        .as_ref()
        .is_some_and(|(w, h)| *w == s.window && *h == hash);
    let changed = std::mem::take(&mut s.changed);
    s.shot = Some((s.window, hash.clone()));
    let mut out = format!(" Hash {hash}.");
    if same {
        out.push_str(match changed {
            true => " Same picture as your last screenshot, though the window changed since: it's stale. Trust your read, not this picture.",
            false => " Same picture as your last screenshot.",
        });
    }
    if let Some(why) = hidden(data, s, here) {
        out.push_str(&format!(" {why}: an app such as Chrome stops painting a window then, so this picture may be stale or blank. Your read is current."));
    }
    out
}

/// The window is off this Space, or wholly under one window of another app.
// shortcut: one window must cover it alone; two side by side that cover it together aren't seen.
fn hidden(data: &Path, s: &Sess, here: &dyn Fn() -> bool) -> Option<String> {
    let all = call(data, "list_windows", json!({"on_screen_only": false}), here).ok()?;
    let all = all["windows"].as_array()?;
    let mine = all
        .iter()
        .find(|w| w["window_id"].as_u64() == Some(s.window))?;
    if mine["on_current_space"] == false || mine["is_on_screen"] == false {
        return Some(format!(
            "{}'s window isn't on the screen the user sees",
            s.app
        ));
    }
    let rect = |w: &Value| {
        let b = &w["bounds"];
        let n = |k: &str| b[k].as_f64().unwrap_or(0.0);
        (n("x"), n("y"), n("x") + n("width"), n("y") + n("height"))
    };
    let (z, (x0, y0, x1, y1)) = (mine["z_index"].as_i64()?, rect(mine));
    let over = all.iter().find(|w| {
        let (a0, b0, a1, b1) = rect(w);
        w["pid"] != mine["pid"]
            // The driver's own see-through overlay, where it draws the agent cursor.
            && w["app_name"] != "cua-driver"
            && w["layer"].as_i64() == Some(0)
            && w["is_on_screen"] != false
            && w["z_index"].as_i64().is_some_and(|wz| wz > z)
            && a0 <= x0
            && b0 <= y0
            && a1 >= x1
            && b1 >= y1
    })?;
    let by = over["app_name"].as_str().unwrap_or("another app");
    Some(format!("{}'s window is covered by {by}'s", s.app))
}

/// A capture the driver couldn't make or place, in its own words.
fn not_captured(found: &Value) -> Value {
    let why = found["screenshot_error"]["code"]
        .as_str()
        .unwrap_or("no picture came back");
    refuse(&format!(
        "Couldn't capture the window: {why}. Read it again."
    ))
}
