import type { ReactNode } from "react";

import { Button } from "../components/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../components/collapsible";
import { cx } from "../components/cx";
import { TooltipIconButton } from "../components/icon-button";
import { Timeline } from "../components/timeline";
import { ArrowUpRight, Check, CheckCircle, ChevronRight, Comment, Warning } from "../icons";
import { Clock, PullRequestClosed, PullRequestDraft, PullRequestMerged, PullRequestOpen, Sparkles, XCircle } from "./icons";
import { blockerWords, clock, duration, eventWords, TONES, type Tone } from "./pr-words";
import { type PrCheck, type PrComment, type PrSend, type PrState, type PullRequest, sendKey } from "./pull-requests";

/** What every PR part shares: the time to measure from, what's already above the composer, and how to add more. */
export type Sends = {
  now: number;
  offline: boolean;
  /** Sends already waiting as chips, by `sendKey`: their buttons read Added. */
  added: ReadonlySet<string>;
  onSend: (send: PrSend) => void;
  onOpen: (url: "pr" | { check: string } | { comment: string }) => void;
};

const PR_ICONS = { open: PullRequestOpen, draft: PullRequestDraft, merged: PullRequestMerged, closed: PullRequestClosed };

export function PrIcon({ state, tone }: { state: PrState; tone: Tone }) {
  const Icon = PR_ICONS[state];
  return (
    <span className={cx("flex", TONES[tone])}>
      <Icon className="size-icon-sm" />
    </span>
  );
}

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

export function Heading({ children, end }: { children: ReactNode; end?: ReactNode }) {
  return (
    <h3 className="flex items-center gap-2 px-2 text-xs font-semibold tracking-wide text-muted-foreground">
      {children}
      {end}
    </h3>
  );
}

export function Quiet({ children }: { children: ReactNode }) {
  return <p className="px-2 py-1.5 text-sm text-muted-foreground">{children}</p>;
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

export function CommentRow({ comment, sends }: { comment: PrComment; sends: Sends }) {
  const where = comment.path && (comment.line === null ? comment.path : `${comment.path}:${comment.line}`);
  return (
    <div className="flex items-start gap-2 px-2 py-1.5 text-sm">
      <Comment aria-hidden className="mt-0.5 size-icon-sm shrink-0 text-muted-foreground" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span>
          <span className="text-foreground">{comment.author}</span>{" "}
          {where && <span className="font-mono text-xs text-muted-foreground">{where}</span>}
        </span>
        <span className="whitespace-pre-wrap text-muted-foreground">{comment.body}</span>
      </span>
      <SendButton send={{ kind: "comment", id: comment.id }} sends={sends} />
    </div>
  );
}

/** Overview: failing checks first with the log's tail, the reviews, then why it can't merge yet [D1017]. */
export function Overview({ pr, sends }: { pr: PullRequest; sends: Sends }) {
  const failed = pr.checks.filter((check) => check.state === "failed");
  const order = [...failed, ...pr.checks.filter((check) => check.state !== "failed")];
  const blocked = blockerWords(pr);
  return (
    <>
      <section className="flex flex-col gap-1">
        <Heading>CHECKS</Heading>
        {order.length === 0 ? (
          <Quiet>No checks on this pull request</Quiet>
        ) : (
          <ul className="flex flex-col">
            {order.map((check) => (
              <CheckRow key={check.id} check={check} host={pr.host} sends={sends} log={check.id === failed[0]?.id} />
            ))}
          </ul>
        )}
      </section>
      <section className="flex flex-col gap-1">
        <Heading end={(pr.blockers?.changesBy.length ?? 0) > 0 && <span className="font-normal tracking-normal text-pr-yellow">changes requested</span>}>REVIEWS</Heading>
        {pr.comments.length === 0 ? <Quiet>No comments yet</Quiet> : <CommentList comments={pr.comments} sends={sends} />}
      </section>
      {blocked && (
        <section className="flex items-center gap-3 rounded-control bg-pr-blocker px-3 py-2.5 text-sm">
          <Warning aria-hidden className="size-icon-sm shrink-0 text-destructive" />
          <span className="min-w-0 flex-1">{blocked}</span>
          <SendButton send={{ kind: "fix" }} label="Send all to agent" sends={sends} />
        </section>
      )}
    </>
  );
}

export function Checks({ pr, sends }: { pr: PullRequest; sends: Sends }) {
  if (pr.checks.length === 0) return <Quiet>No checks on this pull request</Quiet>;
  return (
    <ul className="flex flex-col gap-1">
      {pr.checks.map((check) => (
        <CheckRow key={check.id} check={check} host={pr.host} sends={sends} log />
      ))}
    </ul>
  );
}

export function Comments({ pr, sends }: { pr: PullRequest; sends: Sends }) {
  if (pr.comments.length === 0) return <Quiet>No comments yet</Quiet>;
  return (
    <div className="flex flex-col">
      <CommentList comments={pr.comments} sends={sends} />
    </div>
  );
}

/** People's comments in order, then the bots' folded under one row, so the human ones stand out [D1230]. */
function CommentList({ comments, sends }: { comments: PrComment[]; sends: Sends }) {
  const bots = comments.filter((comment) => comment.bot);
  return (
    <>
      {comments.map((comment) => !comment.bot && <CommentRow key={comment.id} comment={comment} sends={sends} />)}
      {bots.length > 0 && (
        <Collapsible>
          <CollapsibleTrigger className="group flex cursor-pointer items-center gap-1 rounded-control py-1 text-sm text-muted-foreground hover:text-foreground focus-visible:focus-ring">
            <ChevronRight aria-hidden className="size-icon-xs transition-transform group-data-panel-open:rotate-90" />
            {bots.length === 1 ? "1 comment from a bot" : `${bots.length} comments from bots`}
          </CollapsibleTrigger>
          <CollapsibleContent>
            {bots.map((comment) => (
              <CommentRow key={comment.id} comment={comment} sends={sends} />
            ))}
          </CollapsibleContent>
        </Collapsible>
      )}
    </>
  );
}

// Events the agent can act on: a failure, a request for changes, a comment.
const SENDABLE = new Set(["checks_failed", "changes_requested", "commented"]);

/** Who did what, newest first, the old pull request history [D48]; what needs work has Send to agent [D1017]. */
export function History({ pr, sends }: { pr: PullRequest; sends: Sends }) {
  if (pr.events.length === 0) return <Quiet>No pull request history yet</Quiet>;
  return (
    <Timeline
      className="px-2"
      events={pr.events.map((event, index) => ({
        id: event.id,
        when: index === 0 && pr.state === "open" ? "now" : "past",
        time: clock(event.atMs),
        title: `#${pr.number} · ${eventWords(event)}`,
        detail: [event.actor, event.detail].filter(Boolean).join(" · "),
        failed: event.kind === "checks_failed",
        more: SENDABLE.has(event.kind) && (
          <span className="pt-1">
            <SendButton send={event.check ? { kind: "check", id: event.check } : { kind: "event", id: event.id }} sends={sends} />
          </span>
        ),
      }))}
    />
  );
}
