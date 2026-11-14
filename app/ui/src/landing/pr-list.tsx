import { useEffect, useState } from "react";
import { EmptyState } from "../components/empty-state";
import { ask, useDaemon } from "../daemon";
import { Branch, CheckCircle } from "../icons";
import { openPr } from "../panel/open";
import { Note } from "../panel/source/rows";
import type { Pr } from "../panel/types";
import { useSecond } from "../thread/words";
import { Clock, PullRequestClosed, PullRequestDraft, PullRequestMerged, PullRequestOpen, XCircle } from "./icons";
import { CheckAgain } from "./pr-parts";
import { ago, FRESH_MS } from "./pr-words";

function StateIcon({ pr }: { pr: Pr }) {
  if (pr.state === "merged") return <PullRequestMerged className="size-icon-md text-pr-purple" />;
  if (pr.state === "closed") return <PullRequestClosed className="size-icon-md text-destructive" />;
  if (pr.draft) return <PullRequestDraft className="size-icon-md text-muted-foreground" />;
  return <PullRequestOpen className="size-icon-md text-success" />;
}

/** The checks' mark beside an open PR's title, as GitHub's list; none while the host's read can't say. */
function ChecksIcon({ pr }: { pr: Pr }) {
  if (pr.state !== "open" || pr.health === "unknown") return null;
  if (pr.failed) return <XCircle aria-label="Checks failed" className="size-icon-sm shrink-0 text-destructive" />;
  if (pr.running) return <Clock aria-label="Checks running" className="size-icon-sm shrink-0 text-pr-yellow" />;
  return <CheckCircle aria-label="Checks passed" className="size-icon-sm shrink-0 text-success" />;
}

/** Its review and failing checks, at the row's end. */
function Standing({ pr }: { pr: Pr }) {
  if (pr.state !== "open") return null;
  return (
    <span className="flex shrink-0 items-center gap-2 pt-0.5 text-xs text-muted-foreground">
      {pr.health === "changes" ? <span className="text-pr-yellow">Changes requested</span> : pr.approved ? <span className="text-success">Approved</span> : pr.approved === false && <span>Review required</span>}
      {!!pr.failed && <span className="text-destructive">{pr.failed} failing</span>}
    </span>
  );
}

/**
 * The session's pull requests, when it has several [D206]: GitHub's list across the tab, open ones first, each opening
 * its PR [D175]. Straight from the watch's last read, with its age and, when the last read failed, why [D1009]; read
 * again on open when older than the watch's quickest pace, and on Check again [D207, D208].
 */
export function PrList({ owner }: { owner: string }) {
  const { daemon, rows } = useDaemon();
  const kept = rows?.find((row) => row.id === owner)?.prs;
  const now = useSecond(true);
  const [busy, setBusy] = useState(false);
  // A failed read needs nothing here: prs.json keeps the last PRs with why, which the Note shows.
  const check = () => {
    setBusy(true);
    ask({ op: "run", args: ["host", owner, "list"] }, () => setBusy(false));
  };
  const loaded = rows !== undefined;
  useEffect(() => {
    if (daemon && loaded && Date.now() - (kept?.okAt ?? 0) > FRESH_MS) check();
  }, [daemon, owner, loaded]);
  // Rust keeps them open first, then by recency [D256].
  const prs = kept?.prs ?? [];
  const open = prs.filter((pr) => pr.state === "open").length;
  return (
    <div data-slot="pr-list" className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-5">
      <header className="flex items-baseline gap-3">
        <h2 className="min-w-0 flex-1 font-display text-base font-medium">Pull requests</h2>
        {loaded || !daemon ? (
          <CheckAgain at={kept?.okAt ?? null} busy={busy} offline={!daemon} onClick={check} />
        ) : (
          <span className="text-xs text-muted-foreground">Loading…</span>
        )}
      </header>
      {kept?.error && <Note warn text={`Couldn't check · ${kept.error.split("\n")[0]}`} />}
      {rows !== undefined && prs.length === 0 ? (
        <EmptyState variant="centered" icon={PullRequestOpen} title="No pull requests yet" detail="The ones this session opens or works on show here" />
      ) : (
        <ul className="flex flex-col overflow-clip rounded-surface border border-border">
          <li className="flex items-center gap-4 border-b border-border bg-fill-subtle px-4 py-2 text-sm">
            <span className="flex items-center gap-1.5 font-medium text-foreground">
              <PullRequestOpen className="size-icon-sm" /> {open} Open
            </span>
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <CheckCircle className="size-icon-sm" /> {prs.length - open} Closed
            </span>
          </li>
          {prs.map((pr) => {
            const at = pr.state === "merged" ? "merged" : pr.state === "closed" ? "closed" : "updated";
            return (
              <li key={`${pr.repo ?? ""}#${pr.number}`} className="border-b border-border last:border-b-0">
                <button
                  type="button"
                  onClick={() => openPr(owner, pr)}
                  className="flex w-full cursor-pointer items-start gap-3 px-4 py-3 text-start hover:bg-fill-subtle focus-visible:focus-ring"
                >
                  <span className="flex pt-0.5">
                    <StateIcon pr={pr} />
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="truncate text-sm font-medium text-foreground">{pr.title}</span>
                      <ChecksIcon pr={pr} />
                    </span>
                    <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
                      {/* One from another repository says which, short, as on the card [D213]. */}
                      {pr.repo && `${pr.repo.slice(pr.repo.indexOf("/") + 1)} `}#{pr.number}
                      {pr.branch && (
                        <>
                          {" · "}
                          <Branch className="size-icon-xs shrink-0" />
                          <span className="truncate font-mono">{pr.branch}</span>
                          {pr.base && <span className="shrink-0"> into <span className="font-mono">{pr.base}</span></span>}
                        </>
                      )}
                      {pr.updatedAtMs && <span className="shrink-0"> · {at} {ago(pr.updatedAtMs, now)}</span>}
                    </span>
                  </span>
                  <Standing pr={pr} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
