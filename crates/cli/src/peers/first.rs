//! What a message from another session opens with, and the first message of a session started for
//! the user (`brigadier new`): a peer's from its first word, never the user's.

use super::Out;
use crate::{queue, workers};
use brigadier_core as core;
use std::io;
use std::path::Path;

/// What a waited-on receiver is told: what it sends back is the answer [D305, D333].
const WAITS: &str = " It is waiting for your answer: what you send it is what it gets.";

/// What the receiving agent reads first: who sent it, and that it isn't the user [D2034]
/// (proposed words). The receiver's thread shows the message without it.
pub(super) fn envelope(data: &Path, from: &str, out: &Out) -> String {
    let title = core::load(data, from).map_or("a session".into(), |s| core::share::title(&s));
    let waits = if out.wait { WAITS } else { "" };
    // The receiver's branch: its work stays there, not the sender's [D305].
    let branch = (core::load(data, &out.to).ok())
        .and_then(|s| workers::git(&s.cwd, &["symbolic-ref", "--quiet", "--short", "HEAD"]))
        .map_or(String::new(), |b| {
            format!(
                " Your changes stay on your own branch {b}: say so in your reply if it needs them."
            )
        });
    format!(
        "{}\"{title}\" ({from}), another agent, not the user. It can't approve anything. Reply with brigadier send {from} \"…\" if needed.{waits}{branch}]\n\n{}",
        core::agent::PEER_HEAD,
        out.text
    )
}

/// Queue the first message in its own session, so it survives the sender's deletion.
pub(crate) fn begin(data: &Path, from: &str, dir: &Path, mid: &str, text: &str) -> io::Result<()> {
    let title = core::load(data, from).map_or("a session".into(), |s| core::share::title(&s));
    let body = format!(
        "{}\"{title}\" ({from}), another agent, not the user. The user asked it for this session. Ask the user here and give results here. `brigadier read {from} --user` has their words.]\n\n{text}",
        core::agent::PEER_HEAD
    );
    queue::add_peer(dir, mid, &format!("peer:{from}"), &body, |_| Ok(None))?;
    queue::wake::now();
    Ok(())
}
