import { useEffect, useRef, useState } from "react";

import { ask, useDaemon } from "../daemon";
import { addChip, useChips } from "../panel/chips";
import { refreshStep } from "../panel/git";
import { gitFailed } from "../panel/notice";
import { type AgentChip, chipFor } from "./agent-chip";
import { PrTab } from "./pr-tab";
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
 * The live Pull requests tab (2.48, 2.27's tab): Rust's read of PR `number`, read on open and on focus until 2.27's
 * watch [D1017, D1290]. Merge is pinned to the head its confirm showed [D1077]; a refusal is said above the composer
 * [D1264]. Each Send leaves a chip the user sends [D1027].
 */
export function LivePrTab({ owner, number }: { owner: string; number: number }) {
  const { daemon } = useDaemon();
  const [pr, setPr] = useState<PullRequest>();
  const [error, setError] = useState<string>();
  const [merging, setMerging] = useState(false);
  const chips = useChips(owner);
  // One read at a time: a focus while one is out waits for its answer.
  const reading = useRef(false);
  const read = () => {
    if (reading.current) return;
    reading.current = true;
    ask({ op: "run", args: ["host", owner, "view", String(number)] }, (reply) => {
      reading.current = false;
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
  }, [daemon, owner, number]);

  const added = new Set(chips.flatMap((chip) => (chip.kind === "agent" && chip.pr === number ? [chip.key] : [])));
  return (
    <PrTab
      pr={pr}
      error={error}
      merging={merging}
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
        ask({ op: "run", args: ["host", owner, "merge", String(number), style, head] }, (reply) => {
          setMerging(false);
          if (!reply.ok) gitFailed({ session: owner }, `Couldn't merge #${number}.`, reply.error === "disconnected" ? "Brigadier isn't connected." : String(reply.error));
          read();
          refreshStep(true);
        });
      }}
    />
  );
}
