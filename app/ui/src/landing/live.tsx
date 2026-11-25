import { useEffect, useRef, useState } from "react";

import { openLink } from "../browser/links";
import { ask, useDaemon } from "../daemon";
import { errorText } from "../onboarding/api";
import { ASK } from "../pull-requests/review";
import { liveReviewChat } from "../pull-requests/route";
import { HOME, isRef } from "../shell/tab-store";
import { askInChat } from "./ask-in-chat";
import { useHost } from "./host";
import { PrTab } from "./pr-tab";
import { FRESH_MS } from "./pr-words";
import type { PullRequest } from "./pull-requests";

/**
 * The live Pull requests tab [D204, D207]: PR `number`'s last read, kept in the session's folder, painted at once, then
 * read again only when it's older than the watch's pace, on focus likewise, and on Check again [D208]. The watch reads
 * it while the tab is open, and its row says so, which brings the kept read in again. Review, Fix and Add to chat ask in the
 * chat beside it, nothing sent [D162 D165 D174]; every write reads it again.
 */
export function LivePrTab({ owner, target }: { owner: string; target: string }) {
  const host = useHost(owner);
  // `n`, or `owner/name#n` for another repository's PR [D213].
  const hash = target.lastIndexOf("#");
  // A full name's host goes: rows name their repository `owner/name`.
  const repo = hash < 0 ? null : target.slice(0, hash).split("/").slice(-2).join("/");
  const number = Number(target.slice(hash + 1));
  // In a chat's own tab it's read as on the Pull Requests page, but the chat doesn't know which PR that is.
  const named = isRef(target) && owner !== HOME && owner !== liveReviewChat(target);
  const { daemon, rows } = useDaemon();
  const row = rows?.find((each) => each.id === owner)?.prs?.prs.find((each) => each.number === number && (each.repo ?? null) === repo);
  const [pr, setPr] = useState<PullRequest>();
  const [error, setError] = useState<string>();
  const [checking, setChecking] = useState(false);
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
    ask({ op: "run", args: ["host", host, "view", target] }, (reply) => {
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
    ask({ op: "run", args: ["host", host, "view", target, "kept"] }, (reply) => {
      if (reply.ok && reply.pr) land(reply.pr);
      latest.current = reply.ok && reply.pr && (!latest.current || reply.pr.checkedAtMs > (latest.current.checkedAtMs ?? 0)) ? reply.pr : latest.current;
      if (stale()) read();
    });
  }, [daemon, host, target, row?.viewedAtMs, row?.updatedAtMs, row?.health]);
  useEffect(() => {
    if (!daemon) return;
    const focus = () => stale() && read();
    addEventListener("focus", focus);
    return () => removeEventListener("focus", focus);
  }, [daemon, host, target]);
  return (
    <PrTab
      owner={owner}
      target={target}
      pr={pr}
      row={row}
      error={error}
      checking={checking}
      onCheck={read}
      onReview={(instructions) => void askInChat(owner, null, { text: [ASK, instructions, named && pr?.url].filter(Boolean).join("\n\n") })}
      onFix={(focus, check) => pr && askInChat(owner, check ? { ...pr, checks: pr.checks.filter((each) => each.id === check) } : pr, { focus }).catch((cause) => setError(errorText(cause)))}
      onAddToChat={(c) => void askInChat(owner, null, { text: `${c.author}${c.path ? ` on ${c.path}${c.line === null ? "" : `:${c.line}`}` : ""} (${c.url ?? pr?.url}):\n${c.body.split("\n").map((line) => `> ${line}`).join("\n")}\n\n` })}
      sends={{
        now: Date.now(),
        offline: !daemon,
        onChanged: () => {
          read();
          // A named PR's read leaves the chat's card as it was: its watch reads it now.
          if (named) ask({ op: "git_refresh", session: owner });
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
          if (url) openLink(url);
        },
      }}
    />
  );
}
