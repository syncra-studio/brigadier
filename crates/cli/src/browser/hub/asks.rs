//! What an agent's browser call asks of the page, and the user's yes first where it needs one, on
//! one "Go ahead in the browser?" card [D503, D518, D533]: Ask asks before every click and typing;
//! Ask and Auto before an action that pays, sends, deletes, signs in or fills a card, a code or
//! beside a password; Auto also before a script; Full runs them all. Password fields stay closed
//! at every level (the page's script).

use super::keys::{key_of, keys};
use super::{HUB, Words, lock, tab_of};
use crate::agent::refuse;
use crate::owner;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::path::Path;
use std::sync::mpsc::{self, Sender};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

/// How long a call that asks the user waits for the answer; one that comes later still counts,
/// told to the agent as a message.
const ANSWER_WAIT: Duration = Duration::from_secs(300);
/// The most of a script a card shows whole.
const SCRIPT_MOST: usize = 16 * 1024;
/// What a yes for the session lets through on its site.
const COVERED: [&str; 4] = ["script", "action", "delete", "send"];

/// A card waiting on the user: its session, the call it lets through, and who waits for it.
struct Card {
    session: String,
    key: Option<(String, String, String)>,
    /// The site a yes for the session covers, when the kind of ask is one it may.
    site: Option<String>,
    approved: Value,
    question: String,
    tab: String,
    waiter: Option<Sender<(bool, String)>>,
}

static CARDS: LazyLock<Mutex<HashMap<String, Card>>> = LazyLock::new(Mutex::default);

/// The op an agent's words ask of the app; words that say too little or too much are refused.
pub(super) fn op(w: &Words, me: &str, owner: &str, level: &str) -> Result<Value, Value> {
    let one = |what: &str| match w.rest.as_slice() {
        [it] => Ok(it.to_string()),
        _ => Err(refuse(&format!(
            "`brigadier browser {}` takes {what}.",
            w.action
        ))),
    };
    let none = || match w.rest.as_slice() {
        [] => Ok(()),
        _ => Err(refuse(&format!(
            "`brigadier browser {}` takes no words.",
            w.action
        ))),
    };
    let tab = || tab_of(w, me);
    let declared = match w.values.get("--asks").copied() {
        None => Value::Null,
        Some("pay") => "pay".into(),
        Some("send") => "send".into(),
        Some("sign-in") => "signIn".into(),
        Some(_) => return Err(refuse("--asks takes pay, send or sign-in.")),
    };
    // Full runs every action; Ask and Auto ask before a sensitive one, Ask before any, and Auto
    // before a script.
    let (asks, always) = (level != "full", level == "ask");
    Ok(match w.action {
        "open" => {
            json!({"op": "open", "url": web_address(&one("a web address")?)?})
        }
        "navigate" => match (w.rest.as_slice(), w.values.get("--go").copied()) {
            ([url], None) => json!({"op": "navigate", "tab": tab()?, "url": web_address(url)?}),
            ([], Some(go @ ("back" | "forward" | "reload"))) => {
                json!({"op": "go", "tab": tab()?, "action": go})
            }
            _ => {
                return Err(refuse(
                    "`brigadier browser navigate` takes a web address, or --go back|forward|reload.",
                ));
            }
        },
        "snapshot" => none().and_then(|()| Ok(json!({"op": "read", "tab": tab()?})))?,
        "click" => {
            // OK to the page's confirm box asks as a delete would, unless the agent said what it is [D781].
            let confirm = w.flags.contains("--confirm");
            let declared = match (&declared, confirm) {
                (Value::Null, true) => "delete".into(),
                _ => declared,
            };
            json!({"op": "click", "tab": tab()?, "target": one("a ref, as a snapshot gave it")?, "declared": declared, "asks": asks, "always": always, "confirm": confirm})
        }
        "type" => match w.rest.as_slice() {
            [target, text] => json!({"op": "type", "tab": tab()?, "target": target, "text": text,
                "submit": w.flags.contains("--submit"), "declared": declared, "asks": asks, "always": always}),
            _ => {
                return Err(refuse(
                    "`brigadier browser type` takes a ref and the text, in quotes.",
                ));
            }
        },
        "press" => {
            let (key, modifiers) =
                key_of(&one("a key, such as Escape, Tab, ArrowDown or Meta+K")?)?;
            json!({"op": "press", "tab": tab()?, "key": key, "modifiers": modifiers,
                "target": w.values.get("--ref"), "declared": declared, "asks": asks, "always": always})
        }
        "hover" => {
            json!({"op": "hover", "tab": tab()?, "target": one("a ref, as a snapshot gave it")?})
        }
        "scroll" => match w.rest.as_slice() {
            [way @ ("down" | "up")] => json!({"op": "scroll", "tab": tab()?, "way": way}),
            [target] => json!({"op": "scroll", "tab": tab()?, "target": target}),
            _ => {
                return Err(refuse(
                    "`brigadier browser scroll` takes down, up or a ref.",
                ));
            }
        },
        "wait" => {
            none()?;
            let ms = match w.values.get("--ms").map(|s| s.parse::<u64>()) {
                None => Value::Null,
                Some(Ok(n)) if n <= 20_000 => n.into(),
                Some(_) => return Err(refuse("--ms takes milliseconds, 20000 at most.")),
            };
            match (w.values.get("--text"), w.values.get("--gone")) {
                (Some(_), Some(_)) => {
                    return Err(refuse(
                        "`brigadier browser wait` takes --text or --gone, not both.",
                    ));
                }
                (text, gone) => {
                    json!({"op": "wait", "tab": tab()?, "text": text, "gone": gone, "ms": ms})
                }
            }
        }
        "tabs" => none().map(|()| json!({"op": "tabs"}))?,
        // Hands the agent's tab to the user for what only they do; their Done hands it back [D781].
        "ask" => {
            let what: String = one("what the user should do there, in quotes")?
                .chars()
                .take(300)
                .collect();
            json!({"op": "ask", "tab": tab()?, "what": what})
        }
        "screenshot" => none().and_then(|()| Ok(json!({"op": "screenshot", "tab": tab()?})))?,
        "eval" => {
            json!({"op": "eval", "tab": tab()?, "script": shown_script(&one("a script, in quotes")?)?, "asks": level == "auto"})
        }
        "events" => {
            none()?;
            let since = match w.values.get("--since").map(|s| s.parse::<u64>()) {
                None => 0,
                Some(Ok(n)) => n,
                Some(Err(_)) => {
                    return Err(refuse("--since takes the number the last answer gave."));
                }
            };
            let kinds: Vec<&str> = w
                .values
                .get("--kinds")
                .map_or(vec![], |k| k.split(',').collect());
            if let Some(k) = kinds
                .iter()
                .find(|k| !["navigation", "network", "console", "error"].contains(k))
            {
                return Err(refuse(&format!(
                    "--kinds takes navigation, network, console and error, not {k:?}."
                )));
            }
            json!({"op": "events", "tab": tab()?, "since": since, "kinds": kinds})
        }
        "show" if me != owner => {
            return Err(refuse(
                "Only the thread brings a tab to the front, when the user asks to see it.",
            ));
        }
        "show" => none().and_then(|()| Ok(json!({"op": "show", "tab": tab()?})))?,
        "close" => none().and_then(|()| Ok(json!({"op": "close", "tab": tab()?})))?,
        other => {
            return Err(refuse(&format!(
                "`brigadier browser {other}` isn't a browser command. `brigadier browser --help` lists them."
            )));
        }
    })
}

/// `url` when it is a web address a tab may load.
fn web_address(url: &str) -> Result<String, Value> {
    let lower = url.trim().to_ascii_lowercase();
    match lower.starts_with("http://") || lower.starts_with("https://") {
        true => Ok(url.trim().to_string()),
        false => Err(refuse(&format!(
            "{url} isn't a web address: the browser opens http and https pages only."
        ))),
    }
}

/// `script` when the card can show the user exactly what runs: not empty, not too long to read,
/// and with nothing that changes how the text reads.
fn shown_script(script: &str) -> Result<String, Value> {
    if script.trim().is_empty() {
        return Err(refuse("`brigadier browser eval` needs a script."));
    }
    if script.len() > SCRIPT_MOST {
        return Err(refuse(&format!(
            "That script is {} bytes; the user reads it on a card, so {SCRIPT_MOST} is the most. Send a shorter one.",
            script.len()
        )));
    }
    let hidden = |c: char| {
        (c.is_control() && !matches!(c, '\n' | '\t' | '\r'))
            || matches!(c, '\u{200b}'..='\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2060}'..='\u{206f}' | '\u{feff}')
    };
    if script.chars().any(hidden) {
        return Err(refuse(
            "That script has invisible characters, so the user's card couldn't show what really runs. Write them as \\u escapes.",
        ));
    }
    Ok(script.to_string())
}

/// The call an op is, for a yes to hold for it alone: clicks, typing and scripts.
pub(super) fn fingerprint(op: &Value) -> Option<String> {
    let s = |k: &str| op[k].as_str().unwrap_or("").to_string();
    match op["op"].as_str()? {
        "click" => Some(format!("click\u{1f}{}\u{1f}{}", s("target"), op["confirm"])),
        "type" => Some(format!(
            "type\u{1f}{}\u{1f}{}\u{1f}{}",
            s("target"),
            op["submit"],
            s("text")
        )),
        "press" => Some(format!(
            "press\u{1f}{}\u{1f}{}\u{1f}{}",
            s("target"),
            s("key"),
            op["modifiers"]
        )),
        "eval" => Some(format!("eval\u{1f}{}", s("script"))),
        _ => None,
    }
}

/// A page's site as the user knows it: its host.
fn site(url: &str) -> &str {
    let rest = url.split_once("://").map_or(url, |(_, rest)| rest);
    let host = rest.split(['/', '?', '#']).next().unwrap_or(rest);
    let host = host.rsplit_once('@').map_or(host, |(_, host)| host);
    if host.is_empty() { url } else { host }
}

/// The grant a yes for the session leaves: session `me` on `site`, kept in HUB.grants beside the
/// one-call yeses as long as the hub runs, its value the session's birth so an id made again
/// inherits nothing.
fn site_key(me: &str, site: &str) -> (String, String, String) {
    (me.into(), String::new(), format!("site\u{1f}{site}"))
}

fn born(data: &Path, me: &str) -> Value {
    brigadier_core::load(data, me).map_or(Value::Null, |s| s.created.into())
}

/// A card's question for the action that asks, as the user would say it. One that asks because of
/// a filled password says what it does, which may be no sign-in at all ("Show password").
fn question(op: &Value, sensitive: &str, what: &str, url: &str) -> String {
    let site = site(url);
    // `what` is the control as the page names it: its role, then its name in quotes.
    let name = what.trim().split_once(' ').map_or("", |(_, n)| n.trim());
    let named = !name.is_empty() && name != "\"\"";
    let (click, submit) = (
        op["op"] == "click",
        op["op"] == "type" && op["submit"] == true,
    );
    if op["op"] == "press" {
        let key = keys(op);
        return match sensitive {
            "credentials" => format!("Press {key} beside your password on {site}?"),
            "action" if named => format!("Press {key} in {name} on {site}?"),
            "action" => format!("Press {key} on {site}?"),
            _ => format!(
                "{} (pressing {key})",
                question(&json!({"op": "click"}), sensitive, what, url)
            ),
        };
    }
    match sensitive {
        "pay" => format!("Pay on {site}?"),
        "send" => format!("Send something in your name on {site}?"),
        "signIn" => format!("Sign in to {site}?"),
        "delete" => format!("Delete something on {site}?"),
        "credentials" if click && named => format!("Press {name} beside your password?"),
        "credentials" if click => "Press this button beside your password?".into(),
        "credentials" if submit && named => format!("Press Enter in {name} beside your password?"),
        "credentials" if submit => "Press Enter in this field beside your password?".into(),
        "credentials" => format!("Use your password on {site}?"),
        "card" => format!("Enter a payment card on {site}?"),
        "oneTimeCode" => format!("Enter a one-time code on {site}?"),
        "action" if click && named => format!("Click {name} on {site}?"),
        "action" if click => format!("Click this on {site}?"),
        "action" if named => format!("Type in {name} on {site}?"),
        "action" => format!("Type on {site}?"),
        _ => format!("Run this script on {site}?"),
    }
}

/// What the agent would do, for its card: never a password, card or code it types.
fn details(op: &Value, sensitive: &str, what: &str, url: &str) -> String {
    let s = |k: &str| op[k].as_str().unwrap_or("").trim().to_string();
    let what = what.trim();
    let doing = match op["op"].as_str() {
        Some("eval") => {
            return format!(
                "On {url}. It can do anything this page can, including read what its fields hold and send it elsewhere. Passwords are scrubbed from its answer only as written.\n\n{}",
                s("script")
            );
        }
        Some("click") if op["confirm"] == true => {
            format!("Clicks {what}, and answers OK when the page asks to confirm.")
        }
        Some("click") => format!("Clicks {what}."),
        Some("press") => format!("Presses {} in {what}.", keys(op)),
        Some("type") => {
            let then = if op["submit"] == true {
                ", then presses Enter"
            } else {
                ""
            };
            match matches!(sensitive, "credentials" | "card" | "oneTimeCode") {
                true => format!("Types into {what}{then}."),
                false => format!("Types \u{201c}{}\u{201d} into {what}{then}.", s("text")),
            }
        }
        _ => String::new(),
    };
    format!("{doing}\nOn {url}")
}

/// The user's reason for a no, when they gave one.
fn said(reason: &str) -> String {
    match reason.trim() {
        "" => String::new(),
        r => format!(" They said: {r}"),
    }
}

/// Asks the user about an action on a card in session `me`'s thread and waits for the answer.
/// Ok on a yes, the yes kept for the call, or given back for the retry alone when a yes for the
/// session covers it; else what the agent hears.
pub(super) fn ask(
    data: &Path,
    me: &str,
    op: &Value,
    asked: &Value,
    key: Option<(String, String, String)>,
    before: Option<Value>,
    here: &dyn Fn() -> bool,
) -> Result<Option<Value>, Value> {
    let (url, what) = (
        asked["url"].as_str().unwrap_or(""),
        asked["what"].as_str().unwrap_or(""),
    );
    let sensitive = asked["sensitive"].as_str().unwrap_or("script");
    let of = |v: &Value, k: &str| v[k].as_array().cloned().unwrap_or_default();
    let before = before.filter(|b| b["url"] == url && b["generation"] == asked["generation"]);
    // A yes for the session covers scripts, clicks, typing, keys, delete and send on its site;
    // never money or identity (pay, card, password, code, sign-in).
    let site = COVERED.contains(&sensitive).then(|| site(url));
    let granted = site.and_then(|s| lock(&HUB.grants).get(&site_key(me, s)).cloned());
    if granted.is_some_and(|b| !b.is_null() && b == born(data, me)) {
        // `covered`: the page lets it through for these kinds only, should it turn out to pay. This
        // call's own yes before it on this page keeps what it was for, still this call's alone.
        let mut yes = json!({"generation": asked["generation"], "url": url});
        match before.filter(|b| b["for"].is_array()) {
            Some(b) => {
                yes["for"] = [of(&b, "for"), COVERED.map(Value::from).into()]
                    .concat()
                    .into()
            }
            None => yes["covered"] = true.into(),
        }
        return Ok(Some(yes));
    }
    let question = question(op, sensitive, what, url);
    let id = format!("browser-{}", &core_uuid()[..8]);
    let grant = site.map(|s| json!({"scope": "site", "pattern": s}));
    let request = json!({"id": id, "action": "browser", "reason": question, "body": details(op, sensitive, what, url), "grant": grant});
    let (to, answer) = mpsc::channel();
    // What the yes is for: all the control asked for, and what this call's yes before it on this page was.
    let mut approved = json!({"generation": asked["generation"], "url": url});
    let mut reasons = of(asked, "reasons");
    if let Some(b) = before {
        reasons.extend(of(&b, "for"));
        // One for the session before it was for these, and lets nothing more through.
        if b["covered"] == true {
            reasons.extend(COVERED.map(Value::from));
        }
    }
    approved["for"] = Value::Array(reasons);
    lock(&CARDS).insert(
        id.clone(),
        Card {
            session: me.into(),
            key,
            site: site.map(String::from),
            approved,
            question: question.clone(),
            tab: asked["tab"].as_str().unwrap_or("").into(),
            waiter: Some(to),
        },
    );
    let note =
        json!({"event": "browser", "item": {"kind": "approval", "id": id, "request": request}});
    if let Err(e) = owner::call(data, me, json!({"op": "note", "data": note})) {
        lock(&CARDS).remove(&id);
        return Err(refuse(&format!("The user couldn't be asked: {e}")));
    }
    let until = Instant::now() + ANSWER_WAIT;
    while here() && Instant::now() < until {
        match answer.recv_timeout(Duration::from_millis(500)) {
            Ok((true, _)) => return Ok(None),
            Ok((false, why)) => {
                return Err(
                    json!({"ok": true, "text": format!("The user said no: {question}{} Nothing was done. Don't do it, or anything else that does the same.", said(&why))}),
                );
            }
            Err(_) => {}
        }
    }
    // Its answer still counts: it comes as a message.
    if let Some(card) = lock(&CARDS).get_mut(&id) {
        card.waiter = None;
    }
    Err(
        json!({"ok": true, "text": format!("No answer yet: {question} Nothing was done. Their answer comes as a message; on a yes, make this same call again (the yes holds on this page only, for this call).")}),
    )
}

fn core_uuid() -> String {
    brigadier_core::adapters::uuid()
}

/// The answer on browser card `request` of session `id`, the user's or a worker's parent's: its
/// card settles, and the call that asked goes on, or hears it as a message if it stopped waiting.
pub(crate) fn answered(
    data: &Path,
    id: &str,
    request: &str,
    control: &Value,
) -> std::io::Result<Value> {
    let allow = matches!(control["decision"].as_str(), Some("allow" | "allowSession"));
    let reason = control["reason"].as_str().unwrap_or("");
    let decision = if allow { "approved" } else { "denied" };
    let note = json!({"event": "browser", "item": {"kind": "resolved", "id": request, "decision": decision}});
    owner::call(data, id, json!({"op": "note", "data": note}))?;
    let Some(card) = lock(&CARDS).remove(request).filter(|c| c.session == id) else {
        return Ok(json!({"ok": true}));
    };
    if allow && let Some(key) = card.key.clone() {
        lock(&HUB.grants).insert(key, card.approved.clone());
    }
    let site = (card.site.as_deref()).filter(|_| control["decision"] == "allowSession");
    if let Some(s) = site {
        lock(&HUB.grants).insert(site_key(id, s), born(data, id));
    }
    if let Some(waiter) = &card.waiter
        && waiter.send((allow, reason.to_string())).is_ok()
    {
        return Ok(json!({"ok": true}));
    }
    let text = match allow {
        true => format!(
            "[decision] The user said yes: {} Make the same browser call on {} again now; the yes holds on that page, for {}.",
            card.question,
            card.tab,
            site.map_or("that call only".into(), |s| format!(
                "that call and the rest of this job on {s}, but paying, cards, passwords, codes and sign-in"
            ))
        ),
        false => format!(
            "[decision] The user said no: {}{} Don't do it, or anything else that does the same.",
            card.question,
            said(reason)
        ),
    };
    // A turn that ended refuses it: the card went with that turn anyway.
    let _ = crate::control::steer_as(data, id, &text, &Value::Null, None, "system", false);
    Ok(json!({"ok": true}))
}
