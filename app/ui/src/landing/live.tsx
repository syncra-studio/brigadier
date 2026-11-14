import { useEffect, useRef, useState } from "react";

import { showToast } from "../components/toast";
import { ask, useDaemon } from "../daemon";
import { addChip, useChips } from "../panel/chips";
import { gitDone, gitFailed } from "../panel/notice";
import { type AgentChip, chipFor } from "./agent-chip";
import type { Posted } from "./pr-conversation";
import { PrTab } from "./pr-tab";
import { FRESH_MS } from "./pr-words";
import { type PrSend, type PullRequest, sendKey } from "./pull-requests";

/** What the agent reads for a Send: the chip's facts, in full. */
function textFor(pr: PullRequest, send: PrSend, chip: AgentChip): string {
  const on = `PR #${pr.number} (${pr.url})`;
  if (send.kind === "fix") return `Fix ${on}: ${chip.kind === "fix" ? chip.reasons : ""}. Its failed checks: ${pr.checks.filter((c) => c.state === "failed").map((c) => c.name).join(", ") || "none"}.`;
  if (send.kind === "check") {
    const check = pr.checks.find((each) => each.id === send.id);
    return `The check "${check?.name}" failed on ${on}.${check?.logTail ? ` Its log ends:\n\`\`\`\n${check.logTail}\n\`\`\`` : ""}`;
  }
  if (send.kind === "comment") {
    const comment = pr.comments.find((each) => each.id === send.id);
    return `${comment?.author} commented on ${on}${comment?.path ? ` at ${comment.path}:${comment.line}` : ""}:\n${(comment?.body ?? "").split("\n").map((line) => `> ${line}`).join("\n")}`;
  }
  return `On ${on}: ${chip.kind === "event" ? `${chip.what}${chip.detail ? ` (${chip.detail})` : ""}` : ""}.`;
}

/** Failed checks' log tails by check id, each read once while the app runs; those asked so far. */
const logs = new Map<string, string | null>();
const asked = new Set<string>();

/**
 * The live Pull requests tab [D204, D207]: PR `number`'s last read, kept in the session's folder, painted at once, then
 * read again only when it's older than the watch's pace, on focus likewise, and on Check again [D208]. The watch reads
 * it while the tab is open, and its row says so, which brings the kept read in again. A failed check's log tail is its
 * own read, after the page shows. Merge is pinned to the head its confirm showed [D1077]; a refusal is said above the
 * composer [D1264]. Each Send leaves a chip the user sends [D1027].
 */
export function LivePrTab({ owner, target }: { owner: string; target: string }) {
  // `n`, or `owner/name#n` for another repository's PR [D213].
  const hash = target.lastIndexOf("#");
  const repo = hash < 0 ? null : target.slice(0, hash);
  const number = Number(target.slice(hash + 1));
  const { daemon, rows } = useDaemon();
  const row = rows?.find((each) => each.id === owner)?.prs?.prs.find((each) => each.number === number && (each.repo ?? null) === repo);
  const [pr, setPr] = useState<PullRequest>();
  const [error, setError] = useState<string>();
  const [checking, setChecking] = useState(false);
  const [merging, setMerging] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const [posted, setPosted] = useState<Posted[]>([]);
  const [, setLogged] = useState(0);
  const chips = useChips(owner);
  const latest = useRef<PullRequest>(undefined);
  latest.current = pr;
  // A newer read never gives way to an older one.
  const land = (next: PullRequest) => setPr((now) => (now && (now.checkedAtMs ?? 0) > (next.checkedAtMs ?? 0) ? now : next));
  // One read at a time: one asked while another is out runs once that answers, so an action's is never lost.
  const reading = useRef(false);
  const again = useRef(false);
  const read = () => {
    if (reading.current) return void (again.current = true);
    reading.current = true;
    setChecking(true);
    ask({ op: "run", args: ["host", owner, "view", target] }, (reply) => {
      reading.current = false;
      if (again.current) {
        again.current = false;
        return read();
      }
      setChecking(false);
      if (reply.ok) {
        land(reply.pr);
        setError(undefined);
      } else if (reply.error !== "disconnected") {
        // A read that fails keeps the last one on screen with why [D1009].
        setError(String(reply.error));
      }
    });
  };
  const stale = () => Date.now() - (latest.current?.checkedAtMs ?? 0) > FRESH_MS;
  // The kept read at once, and again whenever the row says a newer one was kept; a stale one is read afresh.
  useEffect(() => {
    if (!daemon) return;
    ask({ op: "run", args: ["host", owner, "view", target, "kept"] }, (reply) => {
      if (reply.ok && reply.pr) land(reply.pr);
      latest.current = reply.ok && reply.pr && (!latest.current || reply.pr.checkedAtMs > (latest.current.checkedAtMs ?? 0)) ? reply.pr : latest.current;
      if (stale()) read();
    });
  }, [daemon, owner, target, row?.viewedAtMs]);
  useEffect(() => {
    if (!daemon) return;
    const focus = () => stale() && read();
    addEventListener("focus", focus);
    return () => removeEventListener("focus", focus);
  }, [daemon, owner, target]);
  // A posted comment gives way to the read that has it, reconciled by its id [D260].
  useEffect(() => {
    if (pr) setPosted((all) => all.filter((post) => post.id === null || !pr.comments.some((c) => c.id === post.id)));
  }, [pr]);
  // Each failed check's log tail, once the page shows: one read each, at once.
  useEffect(() => {
    if (!daemon || !pr) return;
    for (const check of pr.checks) {
      if (check.state !== "failed" || !check.url || asked.has(check.id)) continue;
      asked.add(check.id);
      ask({ op: "run", args: ["host", owner, "log", check.url] }, (reply) => {
        if (!reply.ok) return void asked.delete(check.id);
        logs.set(check.id, reply.log ?? null);
        setLogged((n) => n + 1);
      });
    }
  }, [daemon, pr]);

  const shown = pr && { ...pr, checks: pr.checks.map((check) => (logs.has(check.id) ? { ...check, logTail: logs.get(check.id) ?? null } : check)) };
  const added = new Set(chips.flatMap((chip) => (chip.kind === "agent" && chip.pr === number ? [chip.key] : [])));
  return (
    <PrTab
      owner={owner}
      target={target}
      pr={shown}
      row={row}
      error={error}
      checking={checking}
      merging={merging}
      refused={refused}
      onCheck={read}
      sends={{
        now: Date.now(),
        offline: !daemon,
        added,
        onSend: (send) => {
          if (!shown || added.has(sendKey(send))) return;
          const chip = chipFor(shown, send);
          addChip(owner, { kind: "agent", id: crypto.randomUUID(), key: sendKey(send), pr: number, chip, text: textFor(shown, send, chip) });
        },
        onOpen: (what) => {
          const url =
            what === "pr"
              ? pr?.url
              : "url" in what
                ? what.url
                : "check" in what
                  ? pr?.checks.find((c) => c.id === what.check)?.url
                  : pr?.comments.find((c) => c.id === what.comment)?.url;
          if (url) window.brigadier?.openLink(url);
        },
      }}
      posted={posted}
      // Shown at once, then kept by the id the host gave it until a read has it; a refusal takes it off and says why.
      onComment={(body) =>
        new Promise((done) => {
          const key = crypto.randomUUID();
          setPosted((all) => [...all, { key, body, id: null }]);
          ask({ op: "run", args: ["host", owner, "comment", target, body] }, (reply) => {
            if (!reply.ok) {
              setPosted((all) => all.filter((post) => post.key !== key));
              return done(reply.error === "disconnected" ? "Brigadier isn't connected." : `Couldn't comment: ${String(reply.error).split("\n")[0]}`);
            }
            setPosted((all) => all.map((post) => (post.key === key ? { ...post, id: String(reply.comment.id) } : post)));
            done(null);
            read();
          });
        })
      }
      onMerge={(style, head) => {
        setMerging(true);
        setRefused(null);
        ask({ op: "run", args: ["host", owner, "merge", target, style, head] }, (reply) => {
          setMerging(false);
          if (!reply.ok) {
            const why = reply.error === "disconnected" ? "Brigadier isn't connected." : String(reply.error);
            gitFailed({ session: owner }, `Couldn't merge #${number}.`, why);
            // Said in the tab too, where Merge was clicked: the host's own first line.
            setRefused(`Couldn't merge #${number}: ${why.split("\n")[0]}`);
          } else {
            gitDone({ session: owner });
            // Merged on the host, as Rust checked (a merge queue only queues it): shown at once, and the read after
            // settles the rest [D30].
            if (reply.merged) {
              setPr((last) => last && { ...last, state: "merged", status: "merged", merge: { ...last.merge, allowed: false } });
              showToast(`Merged #${number}`, { tone: "success" });
            }
          }
          read();
        });
      }}
    />
  );
}
