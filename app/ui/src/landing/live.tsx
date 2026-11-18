import { useEffect, useRef, useState } from "react";

import { openLink } from "../browser/links";
import { ask, useDaemon } from "../daemon";
import { errorText } from "../onboarding/api";
import { bring } from "./bring";
import { useHost } from "./host";
import { PrTab } from "./pr-tab";
import { FRESH_MS } from "./pr-words";
import type { PullRequest } from "./pull-requests";

/**
 * The live Pull requests tab [D204, D207]: PR `number`'s last read, kept in the session's folder, painted at once, then
 * read again only when it's older than the watch's pace, on focus likewise, and on Check again [D208]. The watch reads
 * it while the tab is open, and its row says so, which brings the kept read in again. Bring to agent opens a session on
 * the PR's branch with the PR in its composer [D674, D675].
 */
export function LivePrTab({ owner, target }: { owner: string; target: string }) {
  const host = useHost(owner);
  // `n`, or `owner/name#n` for another repository's PR [D213].
  const hash = target.lastIndexOf("#");
  const repo = hash < 0 ? null : target.slice(0, hash);
  const number = Number(target.slice(hash + 1));
  const { daemon, rows, projects } = useDaemon();
  const row = rows?.find((each) => each.id === owner)?.prs?.prs.find((each) => each.number === number && (each.repo ?? null) === repo);
  const [pr, setPr] = useState<PullRequest>();
  const [error, setError] = useState<string>();
  const [checking, setChecking] = useState(false);
  const [bringing, setBringing] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
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
  }, [daemon, host, target, row?.viewedAtMs]);
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
      bringing={bringing}
      failed={failed}
      onCheck={read}
      sends={{
        now: Date.now(),
        offline: !daemon,
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
      onBring={() => {
        if (!pr || bringing) return;
        setFailed(null);
        setBringing("Bring to agent");
        bring(pr, host, target, rows ?? [], projects ?? [], setBringing)
          .catch((cause) => setFailed(`Couldn't bring #${number} to the agent: ${errorText(cause)}`))
          .finally(() => setBringing(null));
      }}
    />
  );
}
