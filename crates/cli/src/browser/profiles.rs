//! The old profile registry and inheritance, owned by Rust [D515, D519].

use brigadier_core as core;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::io::{self, Read};
use std::path::Path;
use unicode_normalization::UnicodeNormalization;

const HUES: [u8; 8] = [6, 4, 1, 5, 2, 3, 7, 8];

#[derive(Clone, Serialize, Deserialize)]
pub(super) struct Profile {
    pub id: String,
    name: String,
    hue: u8,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    deleting: bool,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Places {
    pub profiles: Vec<Profile>,
    pub default_id: String,
    pub sessions: BTreeMap<String, String>,
}

pub(crate) fn check_id(id: &str) -> io::Result<()> {
    if (1..=64).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    {
        Ok(())
    } else {
        Err(io::Error::other("Bad profile id"))
    }
}

impl Places {
    pub fn read(data: &Path) -> io::Result<Self> {
        let places: Self = match fs::read(data.join("browser/browser-profiles.json")) {
            Ok(bytes) => serde_json::from_slice(&bytes)?,
            Err(e) if e.kind() == io::ErrorKind::NotFound => Self {
                profiles: vec![Profile {
                    id: "default".into(),
                    name: "Personal".into(),
                    hue: 6,
                    deleting: false,
                }],
                default_id: "default".into(),
                sessions: BTreeMap::new(),
            },
            Err(e) => return Err(e),
        };
        let mut seen = HashSet::new();
        for profile in &places.profiles {
            check_id(&profile.id)?;
            name(&profile.name)?;
            if !HUES.contains(&profile.hue) || !seen.insert(&profile.id) {
                return Err(io::Error::other("Invalid profile registry"));
            }
        }
        places.known(&places.default_id)?;
        Ok(places)
    }

    pub fn write(&self, data: &Path) -> io::Result<()> {
        core::write_atomic(
            &data.join("browser/browser-profiles.json"),
            &serde_json::to_vec(self)?,
        )
    }

    pub fn known(&self, id: &str) -> io::Result<&Profile> {
        check_id(id)?;
        self.profiles
            .iter()
            .find(|p| p.id == id && !p.deleting)
            .ok_or_else(|| io::Error::other("No such browser profile, or it is being deleted"))
    }

    pub fn resolve(&self, data: &Path, session: &str, tab: Option<&str>) -> io::Result<String> {
        if let Some(tab) = tab {
            core::check_id(tab)?;
            if let Some(id) = crate::tabs::profile(data, session, tab) {
                return Ok(if self.known(&id).is_ok() {
                    id
                } else {
                    self.default_id.clone()
                });
            }
        }
        let mut seen = HashSet::new();
        let mut at = Some(session.to_string());
        // The nearest session's project pick, used when no session on the way picked [D769].
        let mut of_project = None;
        while let Some(id) = at.filter(|id| id != "-") {
            if id != crate::HOME_DRAFT {
                core::check_id(&id)?;
            }
            if !seen.insert(id.clone()) {
                break;
            }
            if let Some(picked) = self.sessions.get(&id) {
                return Ok(if self.known(picked).is_ok() {
                    picked.clone()
                } else {
                    self.default_id.clone()
                });
            }
            if id == crate::HOME_DRAFT {
                break;
            }
            if of_project.is_none() {
                of_project = core::load(data, &id)
                    .ok()
                    .and_then(|spec| core::projects::get(data, &spec.project?).ok())
                    .and_then(|project| project.browser_profile)
                    .filter(|picked| self.known(picked).is_ok());
            }
            at = parent(data, &id)?;
        }
        // A deleted profile is Automatic again.
        Ok(of_project.unwrap_or_else(|| self.default_id.clone()))
    }

    pub fn run(&mut self, data: &Path, session: &str, args: &[String]) -> io::Result<Value> {
        let op = args.first().map_or("list", String::as_str);
        let get = |i| crate::arg(args, i);
        let mut result = json!({});
        match op {
            "list" => {}
            "resolve" => {
                return Ok(
                    json!({"ok": true, "profile": self.resolve(data, session, args.get(1).filter(|s| !s.starts_with("--")).map(String::as_str))?}),
                );
            }
            "create" => {
                let name = name(get(1)?)?;
                let hue = match crate::flag(args, "--hue") {
                    Some(h) => hue(h)?,
                    None => HUES
                        .into_iter()
                        .find(|h| !self.profiles.iter().any(|p| p.hue == *h && !p.deleting))
                        .unwrap_or(HUES[0]),
                };
                let id = new_id(&name, &self.profiles)?;
                self.profiles.push(Profile {
                    id: id.clone(),
                    name,
                    hue,
                    deleting: false,
                });
                result["profile"] = id.into();
            }
            "session-pick" => {
                if session == "-" {
                    return Err(io::Error::other("Pick a session first"));
                }
                if session != crate::HOME_DRAFT {
                    core::load(data, session)?;
                }
                let id = get(1)?;
                if id == "-" {
                    self.sessions.remove(session);
                } else {
                    self.known(id)?;
                    self.sessions.insert(session.into(), id.into());
                }
            }
            "tab-pick" => {
                self.known(get(2)?)?;
                return crate::tabs::run(
                    data,
                    &["tabs", session, "profile", get(1)?, get(2)?].map(String::from),
                );
            }
            // Main has cleared its engine data: the entry and the profile's own folder go.
            "forget" => {
                let id = get(1)?;
                check_id(id)?;
                let at = self
                    .profiles
                    .iter()
                    .position(|p| p.id == id && p.deleting)
                    .ok_or_else(|| io::Error::other("The profile isn't marked for deleting"))?;
                match fs::remove_dir_all(data.join("browser").join(id)) {
                    Err(e) if e.kind() != io::ErrorKind::NotFound => return Err(e),
                    _ => {}
                }
                self.profiles.remove(at);
            }
            "rename" | "recolour" | "move" | "make-default" | "delete-mark" => {
                let id = get(1)?;
                self.known(id)?;
                let at = self.profiles.iter().position(|p| p.id == id).unwrap();
                match op {
                    "rename" => self.profiles[at].name = name(get(2)?)?,
                    "recolour" => self.profiles[at].hue = hue(get(2)?)?,
                    "move" => {
                        let to: usize = get(2)?.parse().map_err(io::Error::other)?;
                        let moved = self.profiles.remove(at);
                        self.profiles.insert(to.min(self.profiles.len()), moved);
                    }
                    "make-default" => self.default_id = id.into(),
                    _ => {
                        if id == self.default_id {
                            return Err(io::Error::other("The default profile can't be deleted"));
                        }
                        if self.profiles.iter().filter(|p| !p.deleting).count() <= 1 {
                            return Err(io::Error::other("The last profile can't be deleted"));
                        }
                        self.profiles[at].deleting = true;
                        for profile in self.sessions.values_mut() {
                            if profile == id {
                                *profile = self.default_id.clone();
                            }
                        }
                    }
                }
            }
            _ => return Err(io::Error::other("Unknown browser profiles operation")),
        }
        if op != "list" {
            self.write(data)?;
        }
        let mut out = serde_json::to_value(self)?;
        out["ok"] = true.into();
        if !result["profile"].is_null() {
            out["profile"] = result["profile"].clone();
        }
        Ok(out)
    }
}

fn name(value: &str) -> io::Result<String> {
    let value = value.trim();
    if value.is_empty() || value.contains(char::is_control) {
        return Err(io::Error::other("Give the profile a name"));
    }
    Ok(value.into())
}

fn hue(value: &str) -> io::Result<u8> {
    value
        .parse()
        .ok()
        .filter(|n| HUES.contains(n))
        .ok_or_else(|| io::Error::other("Pick a profile colour from 1 to 8"))
}

fn new_id(name: &str, taken: &[Profile]) -> io::Result<String> {
    let mut slug = String::new();
    for ch in name.to_lowercase().nfkd() {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch);
        } else if !slug.is_empty() && !slug.ends_with('-') {
            slug.push('-');
        }
    }
    let slug = slug.trim_matches('-');
    let slug = if slug.is_empty() {
        "profile"
    } else {
        &slug[..slug.len().min(48)]
    };
    loop {
        let mut random = [0u8; 3];
        fs::File::open("/dev/urandom")?.read_exact(&mut random)?;
        let suffix: String = random.iter().map(|b| format!("{b:02x}")).collect();
        let id = format!("{slug}-{suffix}");
        if !taken.iter().any(|p| p.id == id) {
            return Ok(id);
        }
    }
}

fn parent(data: &Path, id: &str) -> io::Result<Option<String>> {
    if let Some(link) = crate::workers::link(data, id) {
        return Ok(Some(link.parent));
    }
    let spec = match core::load(data, id) {
        Ok(s) => s,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e),
    };
    if let Some(origin) = spec.fork_of {
        return Ok(Some(origin));
    }
    // A note's side chat records its note's exact path, including the owning session [D281].
    let owner = spec
        .opts
        .get("note")
        .and_then(|note| Path::new(note).strip_prefix(data.join("sessions")).ok())
        .and_then(|path| path.components().next())
        .and_then(|part| part.as_os_str().to_str());
    Ok(owner.map(String::from).or_else(|| spec.boss.clone()))
}
