//! The few calls the helper makes itself, under its own grants, where the driver has no route
//! [D928]: an app's menu bar read and pressed by pid with no window (Cua #8055), Chromium's tree
//! turned on for any app (Cua #7751 lists names), and the process in front read and given back
//! through WindowServer, as Cua's own `key_focus_guard` does after an action, and macOS's
//! Automation answer for an app [C106]. The daemon decides when; these only do.

use core_foundation::array::CFArray;
use core_foundation::base::{CFType, CFTypeRef, TCFType};
use core_foundation::boolean::CFBoolean;
use core_foundation::bundle::{CFBundle, CFBundleRef};
use core_foundation::number::CFNumber;
use core_foundation::string::{CFString, CFStringRef};
use core_foundation::url::CFURL;
use serde_json::{Value, json};
use std::ffi::{CStr, c_void};
use std::sync::{Mutex, OnceLock, PoisonError};
use std::thread;

#[link(name = "ApplicationServices", kind = "framework")]
unsafe extern "C" {
    fn AXUIElementCreateApplication(pid: i32) -> CFTypeRef;
    fn AXUIElementCopyAttributeValue(e: CFTypeRef, attr: CFStringRef, out: *mut CFTypeRef) -> i32;
    fn AXUIElementSetAttributeValue(e: CFTypeRef, attr: CFStringRef, value: CFTypeRef) -> i32;
    fn AXUIElementPerformAction(e: CFTypeRef, action: CFStringRef) -> i32;
    fn AXUIElementSetMessagingTimeout(e: CFTypeRef, seconds: f32) -> i32;
    fn AXUIElementCopyElementAtPosition(app: CFTypeRef, x: f32, y: f32, out: *mut CFTypeRef)
    -> i32;
    fn AXValueGetValue(value: CFTypeRef, kind: u32, out: *mut c_void) -> bool;
    fn CFBundleGetIdentifier(bundle: CFBundleRef) -> CFStringRef;
}

/// One `brigadier/…` call: its result, or why not.
pub fn handle(method: &str, p: &Value) -> Result<Value, String> {
    let pid = p["pid"].as_i64().unwrap_or(0) as i32;
    match method {
        "brigadier/menus" => Ok(json!({"menus": menus(&app(pid)?)})),
        "brigadier/menu" => press(&app(pid)?, p),
        "brigadier/automation" => Ok(automation(&app(pid)?, pid, p)),
        "brigadier/enable" => {
            let app = app(pid)?;
            let on = CFBoolean::true_value();
            let set = |name: &str| unsafe {
                AXUIElementSetAttributeValue(
                    app.as_CFTypeRef(),
                    CFString::new(name).as_concrete_TypeRef(),
                    on.as_CFTypeRef(),
                )
            };
            Ok(
                json!({"manual": set("AXManualAccessibility"), "enhanced": set("AXEnhancedUserInterface")}),
            )
        }
        "brigadier/front" => Ok(json!({"pid": front()})),
        "brigadier/hit" => {
            let (x, y) = (
                p["x"].as_f64().unwrap_or(0.0),
                p["y"].as_f64().unwrap_or(0.0),
            );
            Ok(json!({"chain": hit(&app(pid)?, x as f32, y as f32)}))
        }
        "brigadier/restore" => {
            let wid = p["window"].as_u64().unwrap_or(0) as u32;
            Ok(json!({"restored": restore(pid, wid) && front() == Some(pid), "front": front()}))
        }
        _ => Err(format!("{method} isn't a call of this helper.")),
    }
}

/// What the app has at a point of the screen, and its ancestors up to the window: a press that
/// does nothing may be under another element [D2032].
fn hit(app: &CFType, x: f32, y: f32) -> Vec<Value> {
    let mut out: CFTypeRef = std::ptr::null();
    let err = unsafe { AXUIElementCopyElementAtPosition(app.as_CFTypeRef(), x, y, &mut out) };
    if err != 0 || out.is_null() {
        return vec![];
    }
    let mut at = Some(unsafe { CFType::wrap_under_create_rule(out) });
    let mut chain = vec![];
    while let Some(e) = at.take() {
        let role = text(&e, "AXRole");
        let name = [text(&e, "AXTitle"), text(&e, "AXDescription")]
            .into_iter()
            .find(|n| !n.is_empty())
            .unwrap_or_default();
        chain.push(json!({"role": role, "subrole": text(&e, "AXSubrole"), "name": name, "frame": frame(&e)}));
        if role == "AXWindow" || chain.len() >= 30 {
            break;
        }
        at = attr(&e, "AXParent");
    }
    chain
}

/// An element's place on screen, as x, y, width, height.
fn frame(e: &CFType) -> Option<[f64; 4]> {
    let mut point = [0f64; 2];
    let mut size = [0f64; 2];
    // kAXValueCGPointType, kAXValueCGSizeType.
    let read = |name: &str, kind: u32, out: *mut c_void| {
        attr(e, name).is_some_and(|v| unsafe { AXValueGetValue(v.as_CFTypeRef(), kind, out) })
    };
    (read("AXPosition", 1, point.as_mut_ptr().cast())
        && read("AXSize", 2, size.as_mut_ptr().cast()))
    .then_some([point[0], point[1], size[0], size[1]])
}

fn app(pid: i32) -> Result<CFType, String> {
    if pid <= 0 {
        return Err("No app named.".into());
    }
    let e = unsafe { AXUIElementCreateApplication(pid) };
    if e.is_null() {
        return Err("No such app.".into());
    }
    // A hung app answers nothing: never wait on it for long.
    unsafe { AXUIElementSetMessagingTimeout(e, 1.0) };
    Ok(unsafe { CFType::wrap_under_create_rule(e) })
}

fn attr(e: &CFType, name: &str) -> Option<CFType> {
    let mut out: CFTypeRef = std::ptr::null();
    let key = CFString::new(name);
    let err = unsafe {
        AXUIElementCopyAttributeValue(e.as_CFTypeRef(), key.as_concrete_TypeRef(), &mut out)
    };
    (err == 0 && !out.is_null()).then(|| unsafe { CFType::wrap_under_create_rule(out) })
}

fn text(e: &CFType, name: &str) -> String {
    attr(e, name)
        .and_then(|v| v.downcast::<CFString>())
        .map(|s| s.to_string())
        .unwrap_or_default()
}

fn number(e: &CFType, name: &str) -> Option<i64> {
    attr(e, name)?.downcast::<CFNumber>()?.to_i64()
}

fn children(e: &CFType) -> Vec<CFType> {
    let Some(list) = attr(e, "AXChildren").and_then(|v| v.downcast::<CFArray<*const c_void>>())
    else {
        return vec![];
    };
    list.iter()
        .map(|p| unsafe { CFType::wrap_under_get_rule(*p) })
        .collect()
}

fn enabled(e: &CFType) -> bool {
    attr(e, "AXEnabled")
        .and_then(|v| v.downcast::<CFBoolean>())
        .is_none_or(bool::from)
}

/// A menu bar item's or menu item's own menu.
fn submenu(e: &CFType) -> Option<CFType> {
    children(e).into_iter().next()
}

/// An item's key equivalent as macOS writes it: ⌃⌥⇧⌘N.
fn shortcut(e: &CFType) -> String {
    let key = text(e, "AXMenuItemCmdChar");
    if key.is_empty() {
        return key;
    }
    let mods = number(e, "AXMenuItemCmdModifiers").unwrap_or(0);
    let mut out = String::new();
    for (bit, sign) in [(4, "⌃"), (2, "⌥"), (1, "⇧")] {
        if mods & bit != 0 {
            out.push_str(sign);
        }
    }
    if mods & 8 == 0 {
        out.push('⌘');
    }
    out + &key
}

/// The menu bar with each menu's enabled items, the Apple menu left out.
fn menus(app: &CFType) -> Vec<Value> {
    let Some(bar) = attr(app, "AXMenuBar") else {
        return vec![];
    };
    (children(&bar).iter().skip(1))
        .map(|top| {
            let items: Vec<Value> = (submenu(top).as_ref().map(children).unwrap_or_default())
                .iter()
                .filter(|i| enabled(i))
                .filter_map(|i| {
                    let title = text(i, "AXTitle");
                    (!title.is_empty()).then(|| json!({"title": title, "key": shortcut(i)}))
                })
                .collect();
            json!({"title": text(top, "AXTitle"), "items": items})
        })
        .collect()
}

fn same(a: &str, b: &str) -> bool {
    let norm = |s: &str| s.trim().replace('…', "...").to_lowercase();
    norm(a) == norm(b)
}

/// Presses a menu item by its path, or by its key equivalent (`keys`: ["cmd", "n"]), with no
/// window needed: menus belong to the app.
fn press(app: &CFType, p: &Value) -> Result<Value, String> {
    let bar = attr(app, "AXMenuBar").ok_or("This app has no menu bar.")?;
    let path_of = p["path"].as_array().filter(|p| p.len() > 1);
    let (item, path) = match (path_of, p["path"][0].as_str()) {
        // One name: an item of the menu open now (a context menu, a popup). Chromium hangs it
        // under the control that opened it, in a window AXWindows drops while it's open; Cocoa's
        // is the app's own child.
        (None, Some(name)) => {
            let found = (["AXFocusedWindow", "AXMainWindow"].iter())
                .filter_map(|a| attr(app, a))
                .chain(children(app))
                .find_map(|e| open_item(&e, name, false, 0));
            (
                found.ok_or_else(|| {
                    format!(
                        "No open menu has \"{name}\": open it first (click --right on a control)."
                    )
                })?,
                name.to_string(),
            )
        }
        (Some(path), _) => {
            let mut at = bar;
            let mut item = None;
            for (i, name) in path.iter().filter_map(Value::as_str).enumerate() {
                let menu = if i == 0 { Some(at) } else { submenu(&at) };
                let found = (menu.as_ref().map(children).unwrap_or_default())
                    .into_iter()
                    .find(|c| same(&text(c, "AXTitle"), name))
                    .ok_or_else(|| format!("No menu item \"{name}\"."))?;
                at = found.clone();
                item = Some(found);
            }
            (
                item.ok_or("No menu path.")?,
                path.iter()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join(" > "),
            )
        }
        (None, None) => by_key(&bar, p)?,
    };
    // D903: no paste into a window with a password field, the item found by its ⌘V in any language.
    let cmd_v = text(&item, "AXMenuItemCmdChar").eq_ignore_ascii_case("v")
        && number(&item, "AXMenuItemCmdModifiers").unwrap_or(0) & 8 == 0;
    if p["no_paste"] == true && (cmd_v || text(&item, "AXTitle").to_lowercase().contains("paste")) {
        return Err("This window has a password field, so no pasting: ask the user.".into());
    }
    if !enabled(&item) {
        return Err(format!("{path} is greyed out now."));
    }
    let act = |name: &str| unsafe {
        AXUIElementPerformAction(
            item.as_CFTypeRef(),
            CFString::new(name).as_concrete_TypeRef(),
        )
    };
    match act("AXPress") == 0 || act("AXPick") == 0 {
        true => Ok(json!({"pressed": path})),
        false => Err(format!("{path} didn't take the press.")),
    }
}

/// The menu bar's item whose key equivalent is `p`'s `keys` (["cmd", "n"]), and its path.
fn by_key(bar: &CFType, p: &Value) -> Result<(CFType, String), String> {
    let keys: Vec<String> = (p["keys"].as_array().into_iter().flatten())
        .filter_map(|k| k.as_str().map(str::to_lowercase))
        .collect();
    let (last, mods) = keys.split_last().ok_or("No keys.")?;
    let has = |m: &[&str]| mods.iter().any(|k| m.contains(&k.as_str()));
    let want = (has(&["shift"]) as i64)
        | (has(&["option", "alt"]) as i64) << 1
        | (has(&["ctrl", "control"]) as i64) << 2
        | (!has(&["cmd", "command"]) as i64) << 3;
    (children(bar).iter().skip(1))
        .find_map(|top| find_key(top, &text(top, "AXTitle"), last, want, 0))
        .ok_or_else(|| format!("No menu item has {}.", keys.join("+")))
}

/// Whether Cua may carry out `keys` by Apple Events, as it does a plain ⌘S item the app greys in
/// the background, and macOS's Automation answer for that app, read without asking [C106]. Where
/// macOS hasn't asked yet, it asks now, once at a time, charged to this app. Cua first tries
/// making the window key, which can enable the item: so this may say yes where Cua then presses.
fn automation(app: &CFType, pid: i32, p: &Value) -> Value {
    // As Cua's item_is_save: plain ⌘S, greyed, the app behind; in front, keys go as keys.
    let save = |item: &CFType| {
        text(item, "AXMenuItemCmdChar").eq_ignore_ascii_case("s")
            && number(item, "AXMenuItemCmdModifiers").unwrap_or(0) == 0
            && !enabled(item)
    };
    let scripted = front() != Some(pid)
        && (attr(app, "AXMenuBar").and_then(|bar| by_key(&bar, p).ok()))
            .is_some_and(|(item, _)| save(&item));
    let Some(id) = scripted.then(|| bundle_id(pid)).flatten() else {
        let status = if scripted { "none" } else { "" };
        return json!({"scripted": scripted, "status": status});
    };
    // errAEEventNotPermitted, errAEEventWouldRequireUserConsent; else it may ask.
    let status = match apple_events(&id, false) {
        0 => "granted",
        -1743 => "denied",
        _ => "ask",
    };
    static ASKING: Mutex<Vec<String>> = Mutex::new(Vec::new());
    let mut asking = ASKING.lock().unwrap_or_else(PoisonError::into_inner);
    if status == "ask" && !asking.contains(&id) {
        asking.push(id.clone());
        thread::spawn(move || {
            apple_events(&id, true);
            (ASKING.lock().unwrap_or_else(PoisonError::into_inner)).retain(|a| *a != id);
        });
    }
    json!({"scripted": true, "status": status})
}

/// The id of the app bundle `pid` runs from, as the kernel names its file; none for a bare
/// executable or a bundle without one.
fn bundle_id(pid: i32) -> Option<String> {
    let exe = brigadier_frames::procs::exe(pid)?;
    let app = exe
        .ancestors()
        .find(|a| a.extension().is_some_and(|e| e.eq_ignore_ascii_case("app")))?;
    let bundle = CFBundle::new(CFURL::from_path(app, true)?)?;
    let id = unsafe { CFBundleGetIdentifier(bundle.as_concrete_TypeRef()) };
    (!id.is_null()).then(|| unsafe { CFString::wrap_under_get_rule(id) }.to_string())
}

/// macOS's Automation answer for this app sending Apple Events to bundle `id`; with `ask`, its
/// prompt where it hasn't asked yet, which waits for the user.
fn apple_events(id: &str, ask: bool) -> i32 {
    #[repr(C)]
    struct AEDesc {
        kind: u32,
        data: *mut c_void,
    }
    #[link(name = "CoreServices", kind = "framework")]
    unsafe extern "C" {
        fn AECreateDesc(kind: u32, data: *const c_void, size: isize, out: *mut AEDesc) -> i16;
        fn AEDisposeDesc(desc: *mut AEDesc) -> i16;
        fn AEDeterminePermissionToAutomateTarget(
            target: *const AEDesc,
            class: u32,
            id: u32,
            ask: u8,
        ) -> i32;
    }
    // typeApplicationBundleID, typeWildCard.
    const BUND: u32 = 0x62756e64;
    const ANY: u32 = 0x2a2a2a2a;
    let mut desc = AEDesc {
        kind: 0,
        data: std::ptr::null_mut(),
    };
    unsafe {
        let made = AECreateDesc(BUND, id.as_ptr().cast(), id.len() as isize, &mut desc);
        if made != 0 {
            return i32::from(made);
        }
        let status = AEDeterminePermissionToAutomateTarget(&desc, ANY, ANY, u8::from(ask));
        AEDisposeDesc(&mut desc);
        status
    }
}

/// An item named `name` in a menu open under `e`; web content and the menu bar hold none.
fn open_item(e: &CFType, name: &str, in_menu: bool, depth: u8) -> Option<CFType> {
    let role = text(e, "AXRole");
    if in_menu && role == "AXMenuItem" && same(&text(e, "AXTitle"), name) {
        return Some(e.clone());
    }
    if depth > 20 || ["AXWebArea", "AXMenuBar"].contains(&role.as_str()) {
        return None;
    }
    let in_menu = in_menu || role == "AXMenu";
    children(e)
        .iter()
        .find_map(|c| open_item(c, name, in_menu, depth + 1))
}

/// The item under `e` whose key equivalent is `key` with modifiers `mods`, and its path.
fn find_key(e: &CFType, path: &str, key: &str, mods: i64, depth: u8) -> Option<(CFType, String)> {
    for item in submenu(e).as_ref().map(children).unwrap_or_default() {
        let title = text(&item, "AXTitle");
        let here = format!("{path} > {title}");
        if text(&item, "AXMenuItemCmdChar").to_lowercase() == key
            && number(&item, "AXMenuItemCmdModifiers").unwrap_or(0) == mods
        {
            return Some((item, here));
        }
        if depth < 2
            && let Some(found) = find_key(&item, &here, key, mods, depth + 1)
        {
            return Some(found);
        }
    }
    None
}

// WindowServer's front process, as Cua's skylight.rs reads and sets it.
type GetFront = unsafe extern "C" fn(*mut c_void) -> i32;
type PsnPid = unsafe extern "C" fn(*const c_void, *mut i32) -> i32;
type PidPsn = unsafe extern "C" fn(i32, *mut c_void) -> i32;
type SetFront = unsafe extern "C" fn(*const c_void, u32, u32) -> i32;
type PostRecord = unsafe extern "C" fn(*const c_void, *const u8) -> i32;

fn sym<T: Copy>(name: &CStr) -> Option<T> {
    static LOADED: OnceLock<()> = OnceLock::new();
    LOADED.get_or_init(|| unsafe {
        libc::dlopen(
            c"/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight".as_ptr(),
            libc::RTLD_LAZY | libc::RTLD_GLOBAL,
        );
    });
    let p = unsafe { libc::dlsym(libc::RTLD_DEFAULT, name.as_ptr()) };
    (!p.is_null()).then(|| unsafe { std::mem::transmute_copy(&p) })
}

/// The pid WindowServer has in front now, without waiting on a run loop.
fn front() -> Option<i32> {
    let get: GetFront = sym(c"_SLPSGetFrontProcess")?;
    let to_pid: PsnPid = sym(c"GetProcessPID")?;
    let mut psn = [0u8; 8];
    let mut pid = 0;
    (unsafe { get(psn.as_mut_ptr().cast()) } == 0
        && psn != [0; 8]
        && unsafe { to_pid(psn.as_ptr().cast(), &mut pid) } == 0
        && pid > 0)
        .then_some(pid)
}

/// Gives `pid`'s window `wid` the front and the keyboard back: a user-generated front request
/// plus the two make-key records, Cua's `return_key_to`; `activate` is only a request macOS may
/// ignore.
fn restore(pid: i32, wid: u32) -> bool {
    let (Some(psn_of), Some(set), Some(post)) = (
        sym::<PidPsn>(c"GetProcessForPID"),
        sym::<SetFront>(c"SLPSSetFrontProcessWithOptions"),
        sym::<PostRecord>(c"SLPSPostEventRecordTo"),
    ) else {
        return false;
    };
    let mut psn = [0u8; 8];
    if unsafe { psn_of(pid, psn.as_mut_ptr().cast()) } != 0
        || unsafe { set(psn.as_ptr().cast(), wid, 0x200) } != 0
    {
        return false;
    }
    [0x01u8, 0x02].iter().all(|&kind| {
        let mut record = [0u8; 0xF8];
        record[0x04] = 0xF8;
        record[0x08] = kind;
        record[0x3A] = 0x10;
        record[0x3C..0x40].copy_from_slice(&wid.to_le_bytes());
        record[0x20..0x30].fill(0xFF);
        unsafe { post(psn.as_ptr().cast(), record.as_ptr()) == 0 }
    })
}
