//! OpenCode's lines as events: its server's events through the helper [D159], and the shapes its
//! `run` gives a turn.

use super::super::{
    Done, Event, Tool, change, classify, counts, question, s, shell_step, under, unwrap_shell,
};
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

/// A failed turn's error, with the cause its type names [D487]; its words, not its JSON.
fn failed(error: &Value) -> Event {
    let cause = match s(error, &["type"]) {
        "provider.internal" => "capacity",
        "provider.transport" => "connection",
        "provider.timeout" => "timeout",
        "provider.no-route" => "model",
        "provider.content-filter" => "blocked",
        _ => "",
    };
    let said = error["message"]
        .as_str()
        .map_or_else(|| error.to_string(), String::from);
    if cause.is_empty() {
        refusal(error).unwrap_or(Event::Failed(cause, said))
    } else {
        Event::Failed(cause, said)
    }
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
        "brigadier.mark" => vec![Event::Mark {
            start: d["start"].as_str().map(String::from),
            end: None,
        }],
        "brigadier.gone" | "form.cancelled" => vec![Event::Resolved(id("id"))],
        "brigadier.commands" => vec![Event::Commands(d.as_array().cloned().unwrap_or_default())],
        "session.compaction.started" => vec![Event::Compaction("running")],
        "session.compaction.ended" | "session.compaction.failed" => {
            vec![Event::Compaction("done")]
        }
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
        "session.inbox.enqueued"
            if d["item"]["payload"]["metadata"]["source"] == super::image::TOOL =>
        {
            vec![super::image::notice(&d["item"]["payload"])]
        }
        "session.execution.started" => vec![Event::Resume(id("sessionID")), Event::TurnStart],
        "session.execution.succeeded" => vec![Event::TurnEnd(true)],
        // What the next request reads: this one's input, cache and output [D88].
        "session.step.ended" => {
            let t = &d["tokens"];
            let n = |v: &Value| v.as_u64().unwrap_or(0);
            let used =
                n(&t["input"]) + n(&t["cache"]["read"]) + n(&t["cache"]["write"]) + n(&t["output"]);
            vec![Event::Context(used, None, false)]
        }
        "session.execution.interrupted" => vec![Event::TurnEnd(false)],
        "session.execution.failed" => {
            let said = match failed(&d["error"]) {
                // A reset OpenCode names, never a guessed one [D74].
                Event::Limited(m, _) => {
                    let after = d["error"]["retryAfterMs"].as_u64();
                    Event::Limited(m, after.zip(v["created"].as_u64()).map(|(a, at)| at + a))
                }
                e => e,
            };
            vec![said, Event::TurnEnd(false)]
        }
        // Its own retry: which try and when the next goes; it says no most [D487].
        "session.retry.scheduled" => vec![Event::Retrying {
            attempt: d["attempt"].as_u64(),
            max: None,
            at: d["at"].as_u64(),
        }],
        "session.text.delta" => vec![Event::TextDelta(id("delta"))],
        "session.text.ended" => vec![Event::Text(id("text"))],
        "session.reasoning.ended" if !id("text").is_empty() => vec![Event::Reasoning(id("text"))],
        "session.tool.called" | "session.tool.success" | "session.tool.failed" => {
            if s(d, &["name"]) == "question" {
                return Some(vec![]);
            }
            if s(d, &["name"]) == super::image::TOOL {
                return Some(super::image::call(kind, d));
            }
            // Its MCP tools run from code (`execute`): Brigadier's own `show_draft` calls are their
            // cards once it ended, the call itself no step [D529].
            // shortcut: code calling other tools beside it loses its row; split it if agents do that.
            if s(d, &["name"]) == "execute" && s(d, &["input", "code"]).contains("tools.brigadier.")
            {
                let calls =
                    (d["metadata"]["toolCalls"].as_array().into_iter().flatten()).filter(|c| {
                        kind == "session.tool.success" && c["tool"] == "brigadier.show_draft"
                    });
                let draft = |(k, c): (usize, &Value)| {
                    Event::ToolStart(Tool {
                        id: format!("{}:{k}", id("id")),
                        name: "show_draft".into(),
                        input: c["input"].to_string(),
                        server: Some("brigadier".into()),
                        ..Default::default()
                    })
                };
                return Some(calls.enumerate().map(draft).collect());
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
            let mut events = tool_use(&part);
            if let Some(call) = d["parent"].as_str() {
                under(&mut events, call);
            }
            // The start came with `called`: an end brings only its end.
            match kind {
                "session.tool.called" => events,
                _ => events
                    .into_iter()
                    .filter(|e| matches!(e, Event::ToolEnd(_)))
                    .collect(),
            }
        }
        // A command it sent to the background: its call ends, its shell runs on under its own id,
        // as Claude's background task does, so its Background row reads as typed and Stop names it.
        "session.tool.progress" if d["input"]["background"] == true => {
            let shell = d["metadata"]["shellID"].as_str();
            (shell.into_iter())
                .flat_map(|sh| {
                    let said = s(d, &["input", "description"]);
                    [
                        Event::Background(sh.into(), said.into()),
                        Event::ToolEnd(Done {
                            id: id("id"),
                            output: String::new(),
                            ok: true,
                            exit: None,
                            cut: true,
                            changes: vec![],
                            child: Some(sh.into()),
                            parent: None,
                            at: v["created"].as_u64(),
                        }),
                    ]
                })
                .collect()
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
    if let Some(call) = d["parent"].as_str() {
        a["parent"] = call.into();
    }
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
            a["command"] = (d["command"].as_str())
                .map_or_else(|| resources.join("\n"), String::from)
                .into();
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
            "tool"
        }
    };
    if !scope.is_empty() && !save.is_empty() {
        let pattern = if scope == "command" {
            save.iter()
                .map(|p| p.strip_suffix(" *").unwrap_or(p))
                .collect::<Vec<_>>()
                .join(", ")
        } else if scope == "tool" {
            format!("{action} {}", save.join(", "))
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
    // Its to-do list is a record, not a step [D104].
    if name == "todowrite" {
        let todos = input["todos"].as_array().into_iter().flatten();
        let steps = todos.map(|t| json!({"text": t["content"], "status": t["status"]}));
        return vec![Event::Plan(steps.collect())];
    }
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
        "list" => ("list", path.clone()),
        "bash" | "shell" => shell_step(&field(&["command"])),
        "webfetch" => ("web", field(&["url"])),
        "websearch" | "codesearch" => ("web", field(&["query"])),
        "task" | "subagent" => ("agent", field(&["description"])),
        // Its row waits for the skill's name, which its pending call doesn't have yet [D211].
        "skill" if field(&["name"]).is_empty() => return vec![],
        "skill" => ("skill", String::new()),
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
        None if step == "edit" && !matches!(name, "bash" | "shell") => {
            let how = match meta["exists"].as_bool() {
                Some(false) => "added",
                _ => "modified",
            };
            vec![change(&path, how, None, None, None)]
        }
        None => vec![],
    };
    // A library server's tool, `b-linear_get_issue`, by its server and own name ("Used Linear") [D176].
    let library = (name.strip_prefix(crate::library::PREFIX)).and_then(|n| n.split_once('_'));
    let mut events = vec![Event::ToolStart(Tool {
        id: id.clone(),
        name: match step {
            "skill" => field(&["name"]),
            _ => library.map_or(name, |(_, tool)| tool).into(),
        },
        step,
        input: what,
        at: state["time"]["start"].as_u64(),
        description: field(&["description"]),
        server: library.map(|(server, _)| crate::library::named(server)),
        command: match name {
            "bash" | "shell" => unwrap_shell(&field(&["command"])),
            _ => String::new(),
        },
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
            cut: false,
            changes,
            child,
            parent: None,
            at: state["time"]["end"].as_u64(),
        }));
    }
    events
}
