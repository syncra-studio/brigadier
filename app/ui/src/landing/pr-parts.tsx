import type { ReactNode } from "react";

import { Badge } from "../components/badge";
import { Button } from "../components/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../components/collapsible";
import { cx } from "../components/cx";
import { EmptyState } from "../components/empty-state";
import { TooltipIconButton } from "../components/icon-button";
import { ArrowUpRight, Check, CheckCircle, ChevronRight, Reload } from "../icons";
import { useSecond } from "../thread/words";
import { Clock, PullRequestClosed, PullRequestDraft, PullRequestMerged, PullRequestOpen, Sparkles, XCircle } from "./icons";
import { ago, duration, STATE_WORDS } from "./pr-words";
import { type PrCheck, type PrSend, type PrState, type PullRequest, sendKey } from "./pull-requests";

/** What every PR part shares: the time to measure from, what's already above the composer, and how to add more. */
export type Sends = {
  now: number;
  offline: boolean;
  /** Sends already waiting as chips, by `sendKey`: their buttons read Added. */
  added: ReadonlySet<string>;
  onSend: (send: PrSend) => void;
  onOpen: (url: "pr" | { check: string } | { comment: string } | { url: string }) => void;
};

const PR_ICONS = { open: PullRequestOpen, draft: PullRequestDraft, merged: PullRequestMerged, closed: PullRequestClosed };

/** A Send to agent button: it leaves a chip above the composer and sends nothing [D1019, D1027]; once it has, it reads Added. */
export function SendButton({ send, label = "Send to agent", sends }: { send: PrSend; label?: string; sends: Sends }) {
  const added = sends.added.has(sendKey(send));
  return (
    <Button variant="soft" size="xs" disabled={added || sends.offline} onClick={() => sends.onSend(send)}>
      {added ? <Check /> : <Sparkles />}
      {added ? "Added" : label}
    </Button>
  );
}

/**
 * When the host was last read, and Check again: it reads it now, the icon turning until it answers [D208]. It ticks on
 * its own, so the page under it isn't drawn again each second.
 */
export function CheckAgain({ at, busy, offline, onClick }: { at: number | null; busy: boolean; offline: boolean; onClick: () => void }) {
  const now = useSecond(at !== null);
  return (
    <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
      {offline ? "Reconnecting…" : at !== null ? `Checked ${ago(at, now)}` : busy ? "Checking…" : "Not checked yet"}
      <TooltipIconButton tooltip="Check again" size="icon-sm" disabled={offline || busy} onClick={onClick}>
        <Reload className={cx(busy && "animate-spin motion-reduce:animate-none")} />
      </TooltipIconButton>
    </span>
  );
}

const BADGES = {
  open: { variant: "success", tint: "" },
  draft: { variant: "secondary", tint: "text-muted-foreground" },
  merged: { variant: "secondary", tint: "text-pr-purple" },
  closed: { variant: "destructive", tint: "" },
} as const;

/** Open, Draft, Merged or Closed, GitHub's state label from the kit's badges. */
export function StateBadge({ state }: { state: PrState }) {
  const { variant, tint } = BADGES[state];
  const Icon = PR_ICONS[state];
  return (
    <Badge variant={variant} className={cx("h-6 px-2.5 text-sm", tint)}>
      <Icon />
      {STATE_WORDS[state]}
    </Badge>
  );
}

const CHECK_WORDS = { failed: "Failed", passed: "Passed", running: "Running" };

/** One check: its state, name and time, Send log to agent on a failure, and a link to it on the host. */
export function CheckRow({ check, host, sends, log = false }: { check: PrCheck; host: string; sends: Sends; log?: boolean }) {
  return (
    <li className="flex flex-col gap-1">
      <div className="flex h-control-md items-center gap-2 px-2 text-sm">
        <span role="img" aria-label={CHECK_WORDS[check.state]} className="flex">
          {check.state === "failed" ? (
            <XCircle className="size-icon-sm text-destructive" />
          ) : check.state === "passed" ? (
            <CheckCircle className="size-icon-sm text-success" />
          ) : (
            <Clock className="size-icon-sm text-pr-yellow" />
          )}
        </span>
        <span className="min-w-0 flex-1 truncate">{check.name}</span>
        {check.durationMs !== null && <span className="text-xs text-muted-foreground tabular-nums">{duration(check.durationMs)}</span>}
        {check.state === "failed" && <SendButton send={{ kind: "check", id: check.id }} label="Send log to agent" sends={sends} />}
        <TooltipIconButton tooltip={`Open on ${host}`} size="icon-xs" onClick={() => sends.onOpen({ check: check.id })}>
          <ArrowUpRight />
        </TooltipIconButton>
      </div>
      {log && check.logTail && <LogTail text={check.logTail} />}
    </li>
  );
}

export function LogTail({ text }: { text: string }) {
  return (
    <pre className="mx-2 overflow-x-auto rounded-control bg-feedback-field px-3 py-2 font-mono text-xs leading-5 text-muted-foreground">{text}</pre>
  );
}

const ORDER = { failed: 0, running: 1, passed: 2 };
/** Failing first, then running, then passed, each by name, as GitHub's checks. */
export const ordered = (checks: readonly PrCheck[]) => checks.toSorted((a, b) => ORDER[a.state] - ORDER[b.state] || a.name.localeCompare(b.name));

// —— The merge box at the end of Conversation: review, checks folded to their sum, conflicts, then Merge [D204].

function BoxRow({ icon, title, detail, end, children }: { icon: ReactNode; title: string; detail?: ReactNode; end?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex flex-col gap-2 px-4 py-3">
      <div className="flex items-start gap-3">
        <span className="flex pt-0.5">{icon}</span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-sm font-medium text-foreground">{title}</span>
          {detail && <span className="text-xs text-muted-foreground">{detail}</span>}
        </span>
        {end}
      </div>
      {children}
    </div>
  );
}

const GOOD = <CheckCircle className="size-icon-md text-success" />;
const BAD = <XCircle className="size-icon-md text-destructive" />;
const WAIT = <Clock className="size-icon-md text-pr-yellow" />;

export function MergeBox({ pr, sends, merge }: { pr: PullRequest; sends: Sends; merge: ReactNode }) {
  const count = (state: PrCheck["state"]) => pr.checks.filter((check) => check.state === state).length;
  const [failed, running, passed] = [count("failed"), count("running"), count("passed")];
  const changes = pr.reviewers.filter((r) => r.state === "changes");
  const approved = pr.reviewers.filter((r) => r.state === "approved");
  const sum = [failed && `${failed} failing`, running && `${running} pending`, passed && `${passed} successful`].filter(Boolean).join(", ");
  const checks = ordered(pr.checks);
  return (
    <section data-slot="merge-box" className="flex flex-col divide-y divide-border overflow-clip rounded-surface border border-border">
      {changes.length > 0 ? (
        <BoxRow icon={BAD} title="Changes requested" detail={`${changes.map((r) => r.login).join(", ")} asked for changes`} end={<SendButton send={{ kind: "fix" }} sends={sends} />} />
      ) : approved.length > 0 ? (
        <BoxRow icon={GOOD} title="Changes approved" detail={`${approved.map((r) => r.login).join(", ")} approved`} />
      ) : (
        pr.state === "open" && <BoxRow icon={WAIT} title="Review required" detail="At least one approving review is needed" />
      )}
      {pr.checks.length === 0 ? (
        <BoxRow icon={<CheckCircle className="size-icon-md text-muted-foreground" />} title="No checks" detail="Nothing runs on this pull request" />
      ) : (
        <Collapsible>
          <BoxRow
            icon={failed ? BAD : running ? WAIT : GOOD}
            title={failed ? "Some checks were not successful" : running ? "Some checks haven't completed yet" : "All checks have passed"}
            detail={sum}
            end={
              <CollapsibleTrigger className="group flex cursor-pointer items-center gap-1 rounded-control px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground focus-visible:focus-ring">
                <span className="group-data-panel-open:hidden">Show all</span>
                <span className="hidden group-data-panel-open:inline">Hide all</span>
                <ChevronRight className="size-icon-xs transition-transform group-data-panel-open:rotate-90" />
              </CollapsibleTrigger>
            }
          >
            {/* Failing ones show even folded, with their log's tail: what the user acts on. */}
            {failed > 0 && (
              <ul className="-mx-2 flex flex-col">
                {checks.filter((check) => check.state === "failed").map((check) => (
                  <CheckRow key={check.id} check={check} host={pr.host} sends={sends} log />
                ))}
              </ul>
            )}
            <CollapsibleContent>
              <ul className="-mx-2 flex max-h-80 flex-col overflow-y-auto">
                {checks.filter((check) => check.state !== "failed").map((check) => (
                  <CheckRow key={check.id} check={check} host={pr.host} sends={sends} />
                ))}
              </ul>
            </CollapsibleContent>
          </BoxRow>
        </Collapsible>
      )}
      {pr.state === "open" &&
        (pr.blockers?.conflicts ? (
          <BoxRow icon={BAD} title="This branch has conflicts that must be resolved" detail={`It conflicts with ${pr.base}`} end={<SendButton send={{ kind: "fix" }} sends={sends} />} />
        ) : pr.mergeState === "behind" ? (
          <BoxRow icon={WAIT} title="This branch is out-of-date with the base branch" detail={`Merge the latest changes from ${pr.base} into it`} />
        ) : (
          <BoxRow icon={GOOD} title="No conflicts with base branch" detail="Merging can be performed automatically" />
        ))}
      {merge && <div className="flex items-center gap-3 bg-fill-subtle px-4 py-3">{merge}</div>}
    </section>
  );
}

export function Commits({ pr, sends }: { pr: PullRequest; sends: Sends }) {
  if (pr.commits.length === 0) return <EmptyState title="No commits yet" />;
  return (
    <ul className="flex flex-col divide-y divide-border overflow-clip rounded-surface border border-border">
      {pr.commits.toReversed().map((commit) => (
        <li key={commit.sha} className="flex items-center gap-3 px-4 py-2.5 text-sm">
          <span className="min-w-0 flex-1 truncate text-foreground">{commit.message}</span>
          <span className="shrink-0 text-xs text-muted-foreground">
            {[commit.author, commit.atMs !== null && ago(commit.atMs, sends.now)].filter(Boolean).join(" · ")}
          </span>
          <span className="shrink-0 font-mono text-xs text-muted-foreground">{commit.sha.slice(0, 7)}</span>
        </li>
      ))}
    </ul>
  );
}

export function Checks({ pr, sends }: { pr: PullRequest; sends: Sends }) {
  if (pr.checks.length === 0) return <EmptyState title="No checks on this pull request" />;
  return (
    <ul className="flex flex-col">
      {ordered(pr.checks).map((check) => (
        <CheckRow key={check.id} check={check} host={pr.host} sends={sends} log />
      ))}
    </ul>
  );
}
