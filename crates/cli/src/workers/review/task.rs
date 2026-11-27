//! What a review is of: the task and its commits, in the worker's own worktree or, a folder chat's,
//! in each repository it claimed [D494].

use super::*;

/// The commits to review in one worktree: the repository by its name, "" for the worker's own.
pub(super) struct Span {
    pub repo: String,
    pub base: String,
    pub head: String,
    /// Its worktree's folder.
    pub at: String,
}

/// Each worktree `wid` commits in: its repository's name, its record's folder and its path.
fn trees(data: &Path, wid: &str) -> Vec<(String, std::path::PathBuf, String)> {
    let dir = core::session_dir(data, wid);
    let cwd = core::load(data, wid).map_or(String::new(), |s| s.cwd);
    if core::worktrees::lands(&dir).ok().flatten().is_some() {
        return vec![(String::new(), dir, cwd)];
    }
    (core::folder::claims(&dir).into_iter())
        .filter_map(|(name, rec)| {
            let at = core::worktrees::folder(&rec)?.display().to_string();
            Some((name, rec, at))
        })
        .collect()
}

/// Its commits past where `since` left each worktree (`heads`), or where it began.
pub(super) fn spans(data: &Path, wid: &str, since: &Value) -> Vec<Span> {
    (trees(data, wid).into_iter())
        .filter_map(|(repo, rec, at)| {
            let began = core::worktrees::lands(&rec).ok().flatten()?.base_commit;
            let since = since[repo.as_str()].as_str();
            let base = since.map_or(began, String::from);
            let head = git(&at, &["rev-parse", "HEAD"])?;
            let n = git(&at, &["rev-list", "--count", &format!("{base}..{head}")])?;
            (n != "0").then_some(Span {
                repo,
                base,
                head,
                at,
            })
        })
        .collect()
}

/// Whether the switch reviews `spans` of `wid`'s `turn`, by rule A from the commits
/// [beat-competitors D35, D46, D56]; commits git can't read are reviewed.
pub(super) fn needs(data: &Path, wid: &str, turn: &str, spans: &[Span], f: &Fold) -> Need {
    let read: Option<Vec<_>> = (spans.iter())
        .map(|s| core::git::needs::span(&s.repo, &s.at, &s.base, &s.head))
        .collect();
    let Some(read) = read else {
        return Need::Review("its commits couldn't be read".into());
    };
    let said = last_of_turn(data, wid, turn);
    core::git::needs::needs(&read, f.runs.last.as_ref(), said.as_deref())
}

/// Where each of its worktrees is now, for `spans` after the next ask, and when (ms).
pub(super) fn heads(data: &Path, wid: &str) -> (Value, Value) {
    let heads = trees(data, wid).into_iter().filter_map(|(repo, _, at)| {
        let head = git(&at, &["rev-parse", "HEAD"])?;
        Some((repo, Value::from(head)))
    });
    (
        Value::Object(heads.collect()),
        brigadier_frames::log::now_ms().into(),
    )
}

/// The commits a session is at, by repository as `heads`; without a worktree, its folder's.
pub(crate) fn at(data: &Path, id: &str) -> Value {
    let heads = heads(data, id).0;
    if heads.as_object().is_some_and(|h| !h.is_empty()) {
        return heads;
    }
    let cwd = core::load(data, id).map_or(String::new(), |s| s.cwd);
    json!({"": git(&cwd, &["rev-parse", "HEAD"])})
}

/// Every model a session's work may be by, each `{agent, model}`: its start's and each one an input
/// of its log ran on, so a review is by another company than all of them [bugfix-1112 D399, D32 a].
pub(super) fn authors(spec: &core::Spec) -> Vec<Value> {
    let start = json!({"agent": spec.backend, "model": spec.model.as_deref().unwrap_or("")});
    let mut out = vec![start];
    let _ = core::read(&spec.dir, |i| {
        if i["kind"] != "input" {
            return;
        }
        let agent = i["backend"]
            .as_str()
            .filter(|b| !b.is_empty())
            .unwrap_or(&spec.backend);
        let a = json!({"agent": agent, "model": i["setup"]["model"].as_str().unwrap_or("")});
        if !out.contains(&a) {
            out.push(a);
        }
    });
    out
}

/// What its parent or the user asked it after `since` (ms), or after its brief where that's none.
fn asked_since(data: &Path, wid: &str, l: &Link, since: Option<u64>) -> String {
    let mut asked = vec![];
    let _ = core::read(&core::session_dir(data, wid), |i| {
        let e = core::archive::entry(i, String::new());
        asked.extend(e.filter(|e| e.from == "user" || (e.from == "peer" && e.who == l.parent)));
    });
    let words: Vec<String> = (asked.iter().skip(since.is_none() as usize))
        .filter(|e| since.is_none_or(|at| e.ts > at))
        .map(|e| {
            // Without the line a peer's message opens with.
            let own = e
                .text
                .starts_with("[From session")
                .then(|| e.text.split_once("]\n\n"));
            own.flatten()
                .map_or(e.text.trim(), |x| x.1.trim())
                .to_string()
        })
        .collect();
    match words.is_empty() {
        true => String::new(),
        false => format!(
            "\n\nIt was asked since, and only what it did for this is new:\n{}",
            cut(words.join("\n\n"), 6 << 10)
        ),
    }
}

/// `start --reviewing <id>|session "<brief>"` for session `me` [D3026]: the reviewed task and its
/// done-when, its commits by `base..head`, never its summary or transcript; the agent's brief,
/// then the fixed one. Refusals and the authors of `session` are proposed.
pub(crate) fn plan(
    data: &Path,
    me: &str,
    of: &str,
    given: &str,
    flags: &dyn Fn(&str) -> Option<String>,
) -> Result<Plan, Value> {
    let named = ["--job", "--agent", "--model", "--effort", "--retry"];
    if let Some(f) = named.into_iter().find(|f| flags(f).is_some()) {
        return Err(refuse(&format!(
            "--reviewing takes no {f}: a review runs on your Review job, on another agent and company than the author's."
        )));
    }
    let switch = flags(SWITCH).is_some();
    let mut mark = json!({"of": of, "switch": switch});
    if let Some(id) = flags(plan::PLAN) {
        mark["plan"] = id.into();
        return plan::plan_of(data, me, mark);
    }
    let given = match given.trim() {
        "" => String::new(),
        g => format!("\n\nFrom the session that asked for this review:\n{g}"),
    };
    if of == "session" {
        let spec = core::load(data, me).map_err(|e| refuse(&e.to_string()))?;
        // A night's task is its words and done list as the user agreed them, not the lead's [D3026].
        let o = core::overnight::load(&spec.dir);
        let night = (o.night() && !o.items.is_empty()).then(|| {
            let list = (o.items.iter().enumerate())
                .map(|(i, it)| format!("\n{}. {}", i + 1, it.title))
                .collect::<String>();
            format!("{}\n\nIts done list:{list}", o.words.trim())
        });
        let task = link(data, me).map(|l| l.brief).or(night);
        if task.is_none() && given.is_empty() {
            return Err(refuse(
                "`brigadier start --reviewing session \"<plan>\"` needs the plan or work to review, in quotes: your session has no brief of its own.",
            ));
        }
        // Its authors are every model the session ran [D385, §6, bugfix-1112 D399].
        let authors = authors(&spec);
        let task = task.map_or(String::new(), |t| {
            format!("\n\nIts task, as it was given:\n{}", t.trim_end())
        });
        let brief = format!(
            "Adversarial review of {}'s plan or merged work; your worktree is at its current head.{task}{given}\n\n{BRIEF}",
            core::share::title(&spec)
        );
        let title = "Adversarial review".into();
        mark["heads"] = at(data, me);
        return Ok(Plan {
            brief,
            title,
            base: None,
            authors,
            mark,
        });
    }
    let Some(l) = link(data, of).filter(|l| l.parent == me && moves(l)) else {
        return Err(refuse(
            "--reviewing takes one of your own workers, by its id, or `session`.",
        ));
    };
    let waits = matches!(l.review["state"].as_str(), Some("running" | "glancing"));
    if !switch && (l.last.is_null() || waits) {
        return Err(refuse(&format!(
            "{of} hasn't ended. Wait for its result, then review it."
        )));
    }
    // The agent's own review is of all its work.
    let spans = match switch {
        true => spans(data, of, &l.review["since"]),
        false => spans(data, of, &Value::Null),
    };
    if spans.is_empty() {
        return Err(refuse(&format!("Nothing to review: {of} made no commits.")));
    }
    let mut work = String::new();
    for s in &spans {
        let (base, head) = (&s.base, &s.head);
        work += &match s.repo.as_str() {
            "" => format!(
                "Its work is the commits {base}..{head}; your worktree is checked out at {head}: `git log -p {base}..{head}`."
            ),
            name => {
                let repo = format!("'{}'", name.replace('\'', r"'\''"));
                format!(
                    "In {name}, its work is the commits {base}..{head}: `brigadier repo {repo}`, then there `git checkout --detach {head}` and `git log -p {base}..{head}`.\n"
                )
            }
        };
    }
    // After an earlier review or skip: what came since is what this one is of.
    let later = switch && l.review["asked"].is_u64();
    let since = match later {
        false => String::new(),
        true => asked_since(data, of, &l, l.review["asked"].as_u64()),
    };
    let brief = format!(
        "Adversarial review of {} ({of}). Its task, as it was given:\n{}{since}\n\n{}{given}\n\n{BRIEF}",
        l.title,
        l.brief.trim_end(),
        work.trim_end()
    );
    let authors = match core::load(data, of) {
        Ok(spec) => authors(&spec),
        Err(_) => vec![json!({"agent": l.ran["agent"], "model": l.ran["model"]})],
    };
    let title = format!("Adversarial review of {}", l.title);
    let heads = spans
        .iter()
        .map(|s| (s.repo.clone(), s.head.clone().into()));
    mark["heads"] = Value::Object(heads.collect());
    Ok(Plan {
        brief,
        title,
        // Its own worktree's head; a folder chat's reviewer takes each repository itself.
        base: (spans[0].repo.is_empty()).then(|| spans[0].head.clone()),
        authors,
        mark,
    })
}
