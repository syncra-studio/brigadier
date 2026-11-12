import { useEffect, useRef, useState } from "react";

import { showToast } from "../components/toast";
import { ask, type Row, useDaemon } from "../daemon";
import { addChip, useChips } from "../panel/chips";
import { gitDone, gitFailed } from "../panel/notice";
import { openPr } from "../panel/open";
import { type AgentChip, chipFor } from "./agent-chip";
import { PrTab } from "./pr-tab";
import { ChecksFailedRow } from "./thread-rows";
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

/**
 * The live Pull requests tab (2.48, 2.27's tab): Rust's read of PR `number`, read on open, on focus and on each of the
 * watch's reads, failed ones too [D1017, D1290]. Merge is pinned to the head its confirm showed [D1077]; a refusal is said above the composer
 * [D1264]. Each Send leaves a chip the user sends [D1027].
 */
export function LivePrTab({ owner, number }: { owner: string; number: number }) {
  const { daemon, rows } = useDaemon();
  const kept = rows?.find((row) => row.id === owner)?.prs;
  const [pr, setPr] = useState<PullRequest>();
  const [error, setError] = useState<string>();
  const [merging, setMerging] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const chips = useChips(owner);
  // One read at a time: one asked while another is out runs once that answers, so an action's is never lost.
  const reading = useRef(false);
  const again = useRef(false);
  const read = () => {
    if (reading.current) return void (again.current = true);
    reading.current = true;
    ask({ op: "run", args: ["host", owner, "view", String(number)] }, (reply) => {
      reading.current = false;
      if (again.current) {
        again.current = false;
        return read();
      }
      if (reply.ok) {
        setPr(reply.pr);
        setError(undefined);
      } else if (reply.error !== "disconnected") {
        // A read that fails keeps the last one on screen with why [D1009].
        setError(String(reply.error));
        setPr((last) => last && { ...last, problem: String(reply.error) });
      }
    });
  };
  useEffect(() => {
    if (!daemon) return;
    read();
    addEventListener("focus", read);
    return () => removeEventListener("focus", read);
  }, [daemon, owner, number, JSON.stringify(kept)]);

  const added = new Set(chips.flatMap((chip) => (chip.kind === "agent" && chip.pr === number ? [chip.key] : [])));
  return (
    <PrTab
      pr={pr}
      error={error}
      merging={merging}
      refused={refused}
      sends={{
        now: Date.now(),
        offline: !daemon,
        added,
        onSend: (send) => {
          if (!pr || added.has(sendKey(send))) return;
          const chip = chipFor(pr, send);
          addChip(owner, { kind: "agent", id: crypto.randomUUID(), key: sendKey(send), pr: number, chip, text: textFor(pr, send, chip) });
        },
        onOpen: (what) => {
          const url = what === "pr" ? pr?.url : "check" in what ? pr?.checks.find((c) => c.id === what.check)?.url : pr?.comments.find((c) => c.id === what.comment)?.url;
          if (url) window.brigadier?.openLink(url);
        },
      }}
      onMerge={(style, head) => {
        setMerging(true);
        setRefused(null);
        ask({ op: "run", args: ["host", owner, "merge", String(number), style, head] }, (reply) => {
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

/** The session's open PRs whose checks fail, as Rust's watch last read them [D1017]. */
export const failing = (row: Row | undefined) => row?.prs?.prs.filter((pr) => pr.state === "open" && pr.health === "failed") ?? [];

/**
 * The failing-checks rows at the thread's end, live from Rust's watch and never logged, so each goes once its checks
 * pass [D1017]. Send to agent leaves the PR tab's own Fix chip for the user to send [D1027].
 */
export function ChecksFailedRows({ owner, row }: { owner: string; row: Row | undefined }) {
  const chips = useChips(owner);
  const offline = !useDaemon().daemon;
  return failing(row).map((pr) => {
    const checks = pr.failedChecks ?? [];
    const added = chips.some((chip) => chip.kind === "agent" && chip.pr === pr.number && chip.key === "fix");
    const onSend = () => {
      if (added) return;
      const chip: AgentChip = { id: "fix", kind: "fix", pr: pr.number, reasons: checks.length ? `${checks.join(", ")} failed` : "checks failed" };
      const text = `Fix PR #${pr.number}${pr.url ? ` (${pr.url})` : ""}: its checks failed. Its failed checks: ${checks.join(", ") || "none named"}.`;
      addChip(owner, { kind: "agent", id: crypto.randomUUID(), key: "fix", pr: pr.number, chip, text });
    };
    return <ChecksFailedRow key={pr.number} number={pr.number} checks={checks} added={added} offline={offline} onSend={onSend} onOpen={() => openPr(owner, pr.number)} />;
  });
}
