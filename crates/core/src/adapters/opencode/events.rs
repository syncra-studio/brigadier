//! OpenCode's lines as events: its server's events through the helper [D159], and the shapes its
//! `run` gives a turn.

use super::super::{Done, Event, Tool, change, classify, counts, question, s, shell_step};
use serde_json::{Value, json};

/// An error of its API as an event, by the whole error, telling the user its message, not its JSON.
pub fn refusal(error: &Value) -> Option<Event> {
    let said = (error["message"]
        .as_str()
        .or(error["data"]["message"].as_str()))
    .map_or_else(|| error.to_string(), String::from);
    Some(match classify(&error.to_string())? {
        Event::Limited(_, resets) => Event::Limited(said, resets),
        Event::SignIn(_) => Event::SignIn(said),
        e => e,
    })
}

/// A line from the helper: the server's event, or the result of a request it sent. None: a line
/// of `run`.
pub fn server(v: &Value) -> Option<Vec<Event>> {
    let (kind, d) = (s(v, &["type"]), &v["data"]);
    let id = |k: &str| s(d, &[k]).to_string();
    Some(match kind {
        "brigadier.reply" => vec![Event::Reply {
            id: id("id"),
            error: d["error"].as_str().map(String::from),
            level: None,
        }],
        "brigadier.gone" | "form.cancelled" => vec![Event::Resolved(id("id"))],
        // A command's output file: the server is this session's alone, so its shells are too.
        "shell.created" => vec![Event::External(s(d, &["info", "file"]).into())],
        "permission.asked" => vec![approval(d)],
        "permission.replied" => vec![Event::Decided(
            id("requestID"),
            s(d, &["reply"]) != "reject",
        )],
        "form.created" => vec![form(&d["form"])],
        "form.replied" => {
            let answer = d["answer"]
                .as_object()
                .into_iter()
                .flatten()
                .map(|(_, a)| match a {
                    Value::Array(a) => a
                        .iter()
                        .filter_map(Value::as_str)
                        .collect::<Vec<_>>()
                        .join(", "),
                    Value::String(a) => a.clone(),
                    a => a.to_string(),
                });
            vec![Event::Answer(
                id("id"),
                Some(answer.collect::<Vec<_>>().join("\n")),
            )]
        }
        "session.execution.started" => vec![Event::Resume(id("sessionID")), Event::TurnStart],
        "session.execution.succeeded" => vec![Event::TurnEnd(true)],
        "session.execution.interrupted" => vec![Event::TurnEnd(false)],
        "session.execution.failed" => {
            let said = match refusal(&d["error"]) {
                // A reset OpenCode names, never a guessed one [D74].
                Some(Event::Limited(m, _)) => {
                    let after = d["error"]["retryAfterMs"].as_u64();
                    Event::Limited(m, after.zip(v["created"].as_u64()).map(|(a, at)| at + a))
                }
                Some(e) => e,
                None => Event::Unknown(v.to_string()),
            };
            vec![said, Event::TurnEnd(false)]
        }
        "session.text.ended" => vec![Event::Text(id("text"))],
        "session.reasoning.ended" if !id("text").is_empty() => vec![Event::Reasoning(id("text"))],
        "session.tool.called" | "session.tool.success" | "session.tool.failed" => {
            if s(d, &["name"]) == "question" {
                return Some(vec![]);
            }
            let content = d["content"].as_array().into_iter().flatten();
            let output: Vec<&str> = content.filter_map(|p| p["text"].as_str()).collect();
            let (status, at) = match kind {
                "session.tool.called" => ("running", "start"),
                "session.tool.success" => ("completed", "end"),
                _ => ("error", "end"),
            };
            let part = json!({"callID": d["id"], "tool": d["name"], "state": {
                "status": status, "input": d["input"], "output": output.join("\n"),
                "error": d["error"]["message"], "metadata": d["metadata"], "time": {at: v["created"]}}});
            let events = tool_use(&part);
            // The start came with `called`: an end brings only its end.
            match kind {
                "session.tool.called" => events,
                _ => events
                    .into_iter()
                    .filter(|e| matches!(e, Event::ToolEnd(_)))
                    .collect(),
            }
        }
        k if k.contains('.') => vec![],
        _ => return None,
    })
}

/// A permission ask as D177's PendingApproval. Its grant is the ask's own `save` patterns, kept
/// in the helper's memory for this session only [D193]; none for an action D177 has no scope for
/// (proposed). What the answer needs rides along.
fn approval(d: &Value) -> Event {
    let action = s(d, &["action"]);
    let resources: Vec<&str> = (d["resources"].as_array().into_iter().flatten())
        .filter_map(Value::as_str)
        .collect();
    let save: Vec<&str> = (d["save"].as_array().into_iter().flatten())
        .filter_map(Value::as_str)
        .collect();
    let mut a = json!({"id": d["id"], "action": "other", "reason": d["message"],
                       "cli": {"session": d["sessionID"], "action": action, "save": save}});
    let source = &d["source"];
    if source["type"] == "tool" {
        a["tool"] = format!(
            "{}/{}/{}",
            s(d, &["sessionID"]),
            s(source, &["messageID"]),
            s(source, &["id"])
        )
        .into();
    }
    let scope = match action {
        "shell" => {
            a["action"] = "command".into();
            a["command"] = resources.join("\n").into();
            "command"
        }
        "edit" => {
            a["action"] = "edit".into();
            a["paths"] = json!(resources);
            "edits"
        }
        "webfetch" => {
            a["action"] = "network".into();
            a["host"] = resources.join(" ").into();
            "network"
        }
        _ => {
            a["input"] = format!("{action} {}", resources.join(" ")).into();
            ""
        }
    };
    if !scope.is_empty() && !save.is_empty() {
        let pattern = if scope == "command" {
            save.iter()
                .map(|p| p.strip_suffix(" *").unwrap_or(p))
                .collect::<Vec<_>>()
                .join(", ")
        } else {
            save.join(", ")
        };
        a["grant"] = json!({"scope": scope, "pattern": pattern});
    }
    Event::Approval(a)
}

/// The question tool's form as D177's PendingQuestion: one item per field, keyed `q0…`.
fn form(f: &Value) -> Event {
    if f["metadata"]["kind"] != "question" {
        return Event::Unknown(f.to_string());
    }
    let fields = f["fields"].as_array().cloned().unwrap_or_default();
    let items: Vec<Value> = (fields.iter())
        .map(|q| {
            let options: Vec<Value> = (q["options"].as_array().into_iter().flatten())
                .map(|o| json!({"label": o["label"], "description": o["description"]}))
                .collect();
            let text = [s(q, &["description"]), s(q, &["title"])]
                .into_iter()
                .find(|t| !t.is_empty());
            json!({"text": text.unwrap_or(""), "options": options, "recommended": null,
                   "multiSelect": q["type"] == "multiselect"})
        })
        .collect();
    Event::Question(json!({"id": f["id"], "title": null, "items": items,
                           "cli": {"session": f["sessionID"], "fields": fields}}))
}

/// A tool part as a step, by OpenCode's tool names [D48, D65]. It comes once it ended, with its
/// own start and end times; there is no running state to show.
pub fn tool_use(part: &Value) -> Vec<Event> {
    let id = [s(part, &["callID"]), s(part, &["id"])]
        .into_iter()
        .find(|i| !i.is_empty())
        .unwrap_or("")
        .to_string();
    let (name, state) = (s(part, &["tool"]), &part["state"]);
    // 2.2 nests the tool's own metadata one level down.
    let meta = match &state["metadata"]["metadata"] {
        Value::Object(_) => &state["metadata"]["metadata"],
        _ => &state["metadata"],
    };
    let input = &state["input"];
    let status = s(state, &["status"]);
    let finished = matches!(status, "completed" | "error");
    let field = |keys: &[&str]| {
        keys.iter()
            .map(|k| s(input, &[k]))
            .find(|v| !v.is_empty())
            .unwrap_or("")
            .to_string()
    };
    if name == "question" {
        let questions = input["questions"].as_array().cloned().unwrap_or_default();
        let mut events = vec![];
        for (k, q) in questions.iter().enumerate() {
            let options = q["options"].as_array().into_iter().flatten();
            let qid = format!("{id}:{k}");
            let options: Vec<String> = options.map(|o| s(o, &["label"]).to_string()).collect();
            events.push(question(&qid, s(q, &["question"]), &options));
            if finished {
                let answer = meta["answers"][k].as_array().map(|a| {
                    let labels: Vec<&str> = a.iter().filter_map(Value::as_str).collect();
                    labels.join(", ")
                });
                events.push(Event::Answer(qid, answer));
            }
        }
        return events;
    }
    let path = field(&["filePath", "path"]);
    let (step, what) = match name {
        "read" => ("read", path.clone()),
        "edit" | "write" | "patch" | "multiedit" | "apply_patch" => ("edit", path.clone()),
        "grep" | "glob" => ("search", field(&["pattern"])),
        "list" => ("search", path.clone()),
        "bash" | "shell" => shell_step(&field(&["command"])),
        "webfetch" => ("web", field(&["url"])),
        "websearch" | "codesearch" => ("web", field(&["query"])),
        "task" | "subagent" => ("agent", field(&["description"])),
        _ => ("other", input.to_string()),
    };
    let changes: Vec<Value> = match meta["files"].as_array() {
        Some(files) => files
            .iter()
            .map(|f| {
                let patch = s(f, &["patch"]);
                let (added, removed) = match (f["additions"].as_u64(), f["deletions"].as_u64()) {
                    (Some(a), Some(d)) => (a, d),
                    _ => counts(patch),
                };
                let how = match s(f, &["status"]) {
                    "added" | "created" => "added",
                    "deleted" => "deleted",
                    _ => "modified",
                };
                let path = [s(f, &["file"]), s(f, &["filePath"])]
                    .into_iter()
                    .find(|p| !p.is_empty());
                let diff = (!patch.is_empty()).then(|| patch.to_string());
                change(path.unwrap_or(""), how, diff, Some(added), Some(removed))
            })
            .collect(),
        None if step == "edit" => {
            let how = match meta["exists"].as_bool() {
                Some(false) => "added",
                _ => "modified",
            };
            vec![change(&path, how, None, None, None)]
        }
        None => vec![],
    };
    let mut events = vec![Event::ToolStart(Tool {
        id: id.clone(),
        name: name.into(),
        step,
        input: what,
        at: state["time"]["start"].as_u64(),
        ..Default::default()
    })];
    if finished {
        let mut output = s(state, &["output"]).to_string();
        if status == "error" {
            output = s(state, &["error"]).into();
        }
        let child = meta["sessionID"].as_str().map(String::from);
        if child.is_some() {
            // `<subagent sessionID=… state=…>\nanswer\n</subagent>`: the answer alone.
            let inner = output.split_once('\n').map_or("", |(_, rest)| rest);
            output = inner
                .trim_end()
                .trim_end_matches("</subagent>")
                .trim_end()
                .to_string();
        }
        events.push(Event::ToolEnd(Done {
            id,
            output,
            ok: status == "completed" && meta["exit"].as_i64().is_none_or(|c| c == 0),
            exit: meta["exit"].as_i64(),
            changes,
            child,
            parent: None,
            at: state["time"]["end"].as_u64(),
        }));
    }
    events
}
