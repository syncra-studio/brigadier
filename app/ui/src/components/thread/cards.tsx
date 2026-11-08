import type { ComponentType, ReactNode } from "react";

import { Chat, Commit, Dock, Globe, Info, Key, PencilSquare, QuestionMarkCircle, Sparkle, Spinner, TextShorterConcise, Tools, Warning } from "../../icons";
import type { IconProps } from "../../icons";
import type { ApprovalAction, Item, Progress, StepKind } from "../../thread/item";
import { duration, useSecond } from "../../thread/words";
import { Button } from "../button";
import { cx } from "../cx";
import { ErrorLine } from "../error-line";
import { LabeledDivider } from "../labeled-divider";
import { Tooltip, TooltipContent, TooltipTrigger } from "../tooltip";
import { OpeningRow, ROW, StepIcon, Words } from "./activity-row";
import { ToolBox, VERBS } from "./tool";

const WITHDRAWN = "withdrawn";

/** Hangs under a row's words on a hairline, from its icon. */
const HANGING = "ms-2 border-s border-divider ps-3.5 text-sm text-row-foreground";

/** What an approval asks to do, as the old app's approval kinds drew it. */
const ACTIONS: Record<ApprovalAction, ComponentType<IconProps>> = {
  command: Dock,
  edit: PencilSquare,
  network: Globe,
  permission: Key,
  plan: Sparkle,
  land: Commit,
  message: Chat,
  browser: Globe,
  other: Tools,
};

/**
 * An approval, read like a question: "Asking for approval · waiting" while it waits (the card to decide sits
 * in the composer's place), then "Asked for approval · allowed" or "· denied", which opens to what was asked.
 * Undecided once the turn has moved on, it was withdrawn. Its icon says what it asked to do.
 */
export function ApprovalRow({
  keep,
  title,
  detail,
  body,
  decision,
  action = "other",
  waiting,
}: {
  keep: string;
  title: string;
  detail?: string;
  body?: ReactNode;
  decision: "approved" | "denied" | "withdrawn" | null;
  action?: ApprovalAction;
  /** Its turn still runs, so an undecided approval waits rather than being withdrawn. */
  waiting: boolean;
}) {
  const icon = <StepIcon icon={ACTIONS[action]} />;
  if (decision === null || decision === "withdrawn") {
    waiting = waiting && decision === null;
    return (
      <p className={ROW}>
        {icon}
        <Words verb={waiting ? "Asking for approval · waiting" : `Asked for approval · ${WITHDRAWN}`} live={waiting} />
      </p>
    );
  }
  return (
    <OpeningRow
      keep={keep}
      detail={
        <div className="flex flex-col gap-1.5 pt-2 pb-1 text-sm">
          <p className="whitespace-pre-wrap wrap-anywhere text-row-foreground">{title}</p>
          {body}
          {detail && <p className="font-mono text-code whitespace-pre-wrap wrap-anywhere text-live-text-quiet">{detail}</p>}
        </div>
      }
    >
      {icon}
      <Words verb={decision === "approved" ? "Asked for approval · allowed" : "Asked for approval · denied"} />
    </OpeningRow>
  );
}

/**
 * A question the agent asked. While it `waiting`s: "Asking a question · waiting" (the card to answer sits
 * in the composer's place). Answered, it opens to the question and the answer; unanswered once the turn
 * has moved on, it was withdrawn.
 */
export function QuestionRow({ keep, question, answer, waiting }: { keep: string; question: string; answer: string | null; waiting: boolean }) {
  const icon = <StepIcon icon={QuestionMarkCircle} />;
  if (answer === null) {
    return (
      <p className={ROW}>
        {icon}
        <Words verb={waiting ? "Asking a question · waiting" : `Asked a question · ${WITHDRAWN}`} live={waiting} />
      </p>
    );
  }
  return (
    <OpeningRow
      keep={keep}
      detail={
        <dl className="flex flex-col gap-3 pt-2 pb-1 text-sm">
          <dt className="whitespace-pre-wrap wrap-anywhere text-row-foreground">{question}</dt>
          <dd className="whitespace-pre-wrap wrap-anywhere text-live-text-quiet">{answer}</dd>
        </dl>
      }
    >
      {icon}
      <Words verb="Asked a question" />
    </OpeningRow>
  );
}

/**
 * A subagent the agent started, hard to miss while it runs and calm once done. Running: a spinning mark,
 * "Running a subagent: Find the parser" in full white, how long it has run, and its current step hanging
 * under it on a hairline. Done: "Ran a subagent: Find the parser", its time and steps quiet after it, opening
 * to its answer. Whatever isn't reported (times, step, count, answer) isn't shown.
 */
export function ChildAgentRow({
  keep,
  title,
  progress,
  startedAt,
  endedAt,
  current,
  steps,
  answer,
}: {
  keep: string;
  title: string;
  progress: Progress;
  startedAt?: number;
  endedAt?: number | null;
  current?: { step: StepKind; input: string } | null;
  steps?: number | null;
  answer?: string | null;
}) {
  const running = progress === "running";
  const now = useSecond(running && startedAt !== undefined);
  if (running) {
    return (
      <div className="flex min-w-0 flex-col">
        <p className={cx(ROW, "text-foreground")}>
          <Spinner className="size-4 shrink-0 motion-safe:animate-spin" />
          <span className="min-w-0 truncate">
            Running a subagent: <span className="font-medium">{title}</span>
          </span>
          {startedAt !== undefined && <span className="shrink-0 text-muted-foreground tabular-nums">{duration(now - startedAt)}</span>}
        </p>
        {current && (
          <p className={cx(HANGING, "py-0.5")}>
            {/* Keyed by its words: each new step starts the sweep again. */}
            <span key={`${current.step}${current.input}`} className="block truncate text-sm leading-5.25 shimmer">
              {VERBS[current.step][0]} {current.input}
            </span>
          </p>
        )}
      </div>
    );
  }
  const head = (
    <>
      <StepIcon kind="agent" />
      {progress === "pending" ? (
        <Words verb="Waiting to run a subagent:" object={title} />
      ) : (
        <Words verb={progress === "cancelled" ? "Stopped a subagent:" : "Ran a subagent:"} object={progress === "failed" ? `${title} — failed` : title} />
      )}
    </>
  );
  const took = startedAt !== undefined && endedAt != null ? duration(endedAt - startedAt) : null;
  const tail = [took, steps != null ? `${steps.toLocaleString()} ${steps === 1 ? "step" : "steps"}` : null].filter(Boolean).join(" · ");
  const trail = tail && <span className="tabular-nums text-row-object">{tail}</span>;
  if (answer == null) {
    return (
      <p className={ROW}>
        {head}
        {trail && <span className="ms-1">{trail}</span>}
      </p>
    );
  }
  return (
    <OpeningRow keep={keep} trail={trail || undefined} detail={<p className={cx(HANGING, "whitespace-pre-wrap wrap-anywhere")}>{answer}</p>}>
      {head}
    </OpeningRow>
  );
}

const COMPACTION: Record<Progress, string> = {
  pending: "Waiting to save context",
  running: "Saving context · nothing will be lost",
  done: "Context saved · the full thread is still here",
  failed: "Couldn’t compact · the conversation is unchanged",
  cancelled: "Couldn’t compact · the conversation is unchanged",
};

/** The agent shortening its context, as a divider across the column. */
export function CompactionDivider({ progress = "done" }: { progress?: Progress }) {
  return (
    <LabeledDivider>
      <TextShorterConcise className="size-icon-sm shrink-0" />
      <span key={progress} className={cx("min-w-0 text-center", progress === "running" && "shimmer")}>
        {COMPACTION[progress]}
      </span>
    </LabeledDivider>
  );
}

/** Something the app or agent wants seen: an error's sentence in red; a warning or note with its icon, centred. */
export function NoticeRow({ level, text }: { level: "info" | "warning" | "error"; text: string }) {
  if (level === "error") return <ErrorLine size="sm" error={text} className="wrap-anywhere" />;
  return (
    // Centred, wrapped lines too (D150). The icon is inline before the first word, so it stays beside the words,
    // centred on its capitals (D151).
    <p className="text-center text-sm leading-5.25 wrap-anywhere text-row-foreground">
      <span className="me-1.5 w-4 cap-box">
        {level === "warning" ? <Warning className="size-4 text-warning" /> : <Info className="size-4" />}
      </span>
      {text}
    </p>
  );
}

type Switch = Extract<Item, { kind: "switch" }>;
const SWITCH_STATES = ["limit", "switching", "switched", "failed", "over"] as const;

/** An ⓘ whose tooltip says the rest, on hover or focus. */
function InfoTip({ text }: { text: string }) {
  return (
    // Centred on the capitals of the line it sits on.
    <span className="ms-1.5 w-icon-sm cap-box">
      <Tooltip>
        <TooltipTrigger
          render={
            <span role="img" tabIndex={0} aria-label={text} className="flex rounded-control hover:text-foreground focus-visible:focus-ring">
              <Info className="size-icon-sm" />
            </span>
          }
        />
        <TooltipContent>{text}</TooltipContent>
      </Tooltip>
    </span>
  );
}

/** Words, then an ⓘ that never wraps onto a line alone: it holds to the last word. */
function WithTip({ words, tip }: { words: string; tip: string }) {
  const cut = words.lastIndexOf(" ") + 1;
  return (
    <span>
      {words.slice(0, cut)}
      <span className="whitespace-nowrap">
        {words.slice(cut)}
        <InfoTip text={tip} />
      </span>
    </span>
  );
}

/** One state's line of a switch divider. */
function switchLine(change: Switch, state: Switch["state"], from: string, actions: ReactNode, onRetry: (() => void) | undefined): ReactNode {
  const to = change.model ? `${change.to} · ${change.model}` : (change.to ?? "");
  const refused = change.reason === "unresumable";
  const hit = refused ? `${from} couldn’t resume this conversation` : `Usage limit on ${from}`;
  switch (state) {
    case "limit":
      return (
        <>
          <span>{hit}</span>
          {actions}
        </>
      );
    case "switching":
      // Under way, it shimmers as compaction's running line does (D59).
      return <span className="shimmer">{refused ? `Starting a new conversation on ${to}` : `Switching to ${to}`}</span>;
    case "switched":
      // A switch logged before the shape has only Rust's sentence.
      if (!change.to) return <span>{change.text}</span>;
      return <WithTip words={refused ? `Continued in a new conversation on ${to}` : `Switched ${change.automatic ? "automatically " : ""}to ${to}`} tip={hit} />;
    case "failed":
      return (
        <>
          {change.error ? <WithTip words={`Couldn’t switch to ${to} · the thread is unchanged`} tip={change.error} /> : <span>Couldn’t switch to {to} · the thread is unchanged</span>}
          {onRetry && (
            <Button variant="link-blue" size={null} onClick={onRetry}>
              Try again
            </Button>
          )}
        </>
      );
    case "over":
      return <span>{hit}</span>;
  }
}

/**
 * A usage limit, or a refused resume, and the switch past it: one divider whose state changes in place, like
 * compaction's (D132, D134). Every state's divider sits in the same grid cell and only the current one shows, so
 * the row keeps the height of its tallest state and nothing below it moves. `from` names the side that hit it while Rust
 * hasn't yet (at the limit); `actions` follow the limit's words (its links, a short note): pass them in every state,
 * so they keep their room after the row moves on. `onRetry` is the failed switch's Try again.
 */
export function SwitchDivider({ change, from, actions, onRetry }: { change: Switch; from?: string; actions?: ReactNode; onRetry?: () => void }) {
  const side = change.from || from || (change.reason === "unresumable" ? "The agent" : "this account");
  return (
    <div role="status" className="grid">
      {SWITCH_STATES.map((state) => (
        <LabeledDivider key={state} className={cx("col-start-1 row-start-1", state !== change.state && "invisible")}>
          <span className="flex min-w-0 flex-wrap items-center justify-center gap-x-1.5 text-center wrap-break-word">
            {switchLine(change, state, side, actions, onRetry)}
          </span>
        </LabeledDivider>
      ))}
    </div>
  );
}

/** An event the app can't draw yet: "This step isn’t shown yet · details inside", opening to the event as it came. */
export function UnknownRow({ keep, raw }: { keep: string; raw: unknown }) {
  return (
    <OpeningRow keep={keep} detail={<ToolBox title="Event">{JSON.stringify(raw, null, 2)}</ToolBox>}>
      <StepIcon icon={Info} />
      <Words verb="This step isn’t shown yet · details inside" />
    </OpeningRow>
  );
}
