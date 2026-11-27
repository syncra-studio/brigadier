use super::*;
use crate::remote::Host;
use std::collections::BTreeMap;
use std::path::Path;

fn host() -> Host {
    let mut rows = BTreeMap::new();
    rows.insert("s1".to_string(), json!({"id": "s1"}));
    rows.insert(
        "w1".to_string(),
        json!({"id": "w1", "worker": {"parent": "s1"}}),
    );
    Host {
        serve: Box::new(|_, _, _| {}),
        row: Box::new(move |id| rows.get(id).cloned()),
        project: Box::new(|p| p == "p1"),
    }
}

fn args(req: Value) -> Result<Vec<String>, Fail> {
    let host = host();
    let cx = Ctx {
        device: "d",
        host: &host,
        data: Path::new("/nonexistent"),
    };
    let checked = check(&cx, &req)?;
    Ok(serde_json::from_value(checked.value()["args"].clone()).unwrap_or_default())
}

fn run_of(words: &[&str]) -> Result<Vec<String>, Fail> {
    args(json!({"id": 1, "op": "run", "args": words}))
}

#[test]
fn reading_ops_need_a_visible_session_and_known_fields() {
    let host = host();
    let cx = Ctx {
        device: "d",
        host: &host,
        data: Path::new("/nonexistent"),
    };
    assert!(
        check(
            &cx,
            &json!({"id": 1, "op": "thread", "session": "s1", "from": 3})
        )
        .is_ok()
    );
    assert!(check(&cx, &json!({"id": 1, "op": "thread", "session": "other"})).is_err());
    assert!(
        check(
            &cx,
            &json!({"id": 1, "op": "thread", "session": "s1", "extra": 1})
        )
        .is_err()
    );
    assert!(check(&cx, &json!({"id": 1, "op": "git", "project": "p1"})).is_err());
    assert!(check(&cx, &json!({"id": 1, "op": "upstream"})).is_err());
    assert!(check(&cx, &json!({"id": 1, "op": "computer_helper"})).is_err());
    assert!(check(&cx, &json!({"id": "x", "op": "subscribe"})).is_err());
}

#[test]
fn run_rows() {
    let slot = |v: Vec<String>| v.ends_with(&["--slot".into(), "d".into()]);
    assert!(slot(run_of(&["send", "s1", "hi", "--cid", "c1"]).unwrap()));
    assert_eq!(
        run_of(&["send", "s1", "hi", "--cid", "c1", "--slot", "x"]),
        Err(REFUSED)
    );
    assert_eq!(
        run_of(&["send", "s1", "hi", "--cid", "c1", "--backend", "x"]),
        Err(REFUSED)
    );
    assert_eq!(run_of(&["send", "s1", "hi"]), Err(REFUSED));
    assert_eq!(run_of(&["send", "zz", "hi", "--cid", "c1"]), Err(REFUSED));
    // A worker directly, from its own lead, as a steer; never with the slot.
    let direct = run_of(&["send", "w1", "hi", "--cid", "c", "--steer", "--from", "s1"]).unwrap();
    assert!(!slot(direct));
    assert!(run_of(&["send", "w1", "hi", "--cid", "c", "--steer", "--from", "zz"]).is_err());
    let files = json!({"attachmentIds": ["a1"]}).to_string();
    assert!(
        run_of(&[
            "send", "w1", "hi", "--cid", "c", "--steer", "--from", "s1", "--parts", &files
        ])
        .is_err()
    );
    assert!(
        run_of(&[
            "queue", "s1", "add", "ls", "--qid", "q", "--shell", "--to", "w1"
        ])
        .is_err()
    );
    // An answer whose ask can't be found is refused, never taken as one-time.
    assert!(run_of(&["answer", "s1", "r1", "allow"]).is_err());
    assert!(run_of(&["queue", "s1", "add", "x", "--qid", "q", "--to", "w1"]).is_ok());
    assert!(run_of(&["queue", "s1", "add", "x", "--qid", "q", "--from", "s1"]).is_err());
    // Text that is a flag would be read as one by the CLI.
    assert!(run_of(&["queue", "s1", "add", "--shell", "--qid", "q"]).is_err());
    assert!(run_of(&["send", "s1", "--steer", "--cid", "c"]).is_err());
    assert!(run_of(&["draft", "@home:p1"]).is_ok());
    assert!(run_of(&["draft", "@home:nope"]).is_err());
    assert!(run_of(&["draft", "--home"]).is_err());
    assert!(run_of(&["start", "n1", "--project", "p1"]).is_err());
    assert!(run_of(&["remote", "status"]).is_err());
    assert!(run_of(&["level", "s1", "full"]).is_err());
    assert!(run_of(&["level", "s1", "full", "--op", "o1"]).is_ok());
    assert!(run_of(&["models", "--project", "p1", "--fresh"]).is_err());
    assert!(run_of(&["rewind", "s1", "c1", "--preview"]).is_ok());
    assert!(run_of(&["rewind", "s1", "c1", "--preview", "--op", "o"]).is_err());
}

#[test]
fn parts_and_adopt() {
    let parts = |p: Value| run_of(&["send", "s1", "hi", "--cid", "c", "--parts", &p.to_string()]);
    assert!(
        parts(json!({"parts": ["hi", {"kind": "mention", "type": "worker", "id": "w1"}]})).is_ok()
    );
    assert!(
        parts(json!({"parts": [{"kind": "mention", "type": "file", "label": "/etc/passwd"}]}))
            .is_err()
    );
    assert!(parts(json!({"parts": [{"kind": "mention", "type": "chat", "id": "zz"}]})).is_err());
    assert!(parts(json!({"parts": [{"kind": "image", "attachmentId": "../x"}]})).is_err());
    let op = |o: Value| {
        run_of(&[
            "draft",
            "s1",
            "adopt",
            "c",
            "--kind",
            "send",
            "--op",
            &o.to_string(),
            "--draft",
            "{}",
        ])
    };
    assert!(op(json!(["send", "s1", "hi", "--cid", "c"])).is_ok());
    assert!(op(json!(["send", "s1", "hi", "--cid", "c", "--backend", "b"])).is_err());
    assert!(op(json!(["level", "s1", "full"])).is_err());
}
