import { type ComponentType, type ReactNode, useRef } from "react";

import { ExclamationMarkCircle, Chat, Commit, Dock, Globe, Info, Key, PencilSquare, QuestionMarkCircle, Sparkle, Spinner, TextShorterConcise, Tools, Warning } from "../../icons";
import type { IconProps } from "../../icons";
import type { ApprovalAction, Item, Progress, StepKind } from "../../thread/item";
import type { PendingQuestion, QuestionItem } from "../composer/question";
import { duration, hhmm, useSecond } from "../../thread/words";
import { Button } from "../button";
import { cx } from "../cx";
import { LabeledDivider } from "../labeled-divider";
import { Tooltip, TooltipContent, TooltipTrigger } from "../tooltip";
import { OpeningRow, ROW, StepIcon, Words } from "./activity-row";
import { InfoTip, WithTip } from "./tip";
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

/** An answer as the row shows it: a recommended pick says so, each one of a multi-select too; a skipped one says that. */
function answerWords(item: QuestionItem | undefined, answer: string | null): string {
  if (!answer?.trim()) return "No answer provided";
  const recommended = item?.recommended == null ? undefined : item.options[item.recommended]?.label;
  const mark = (label: string) => (label === recommended ? `${label} (Recommended)` : label);
  const labels = new Set(item?.options.map((option) => option.label));
  const picks = item?.multiSelect && !labels.has(answer) ? answer.split(", ") : [answer];
  return picks.every((pick) => labels.has(pick)) ? picks.map(mark).join(", ") : answer;
}

/**
 * A question, or a round of them, the agent asked. While it `waiting`s: "Asking a question · waiting" or
 * "Asking questions · waiting" (the card to answer sits on the composer's rail). Answered: "Asked a question" or
 * "Asked 3 questions", with the round's title after it, opening to each question and its answer; unanswered once
 * the turn has moved on, it was withdrawn.
 */
export function QuestionRow({
  keep,
  question,
  answer,
  waiting,
  round,
  answers,
}: {
  keep: string;
  question: string;
  answer: string | null;
  waiting: boolean;
  /** The round as it was asked; without it, the one `question`. */
  round?: PendingQuestion;
  /** One answer per question of the round, null for a skipped one. */
  answers?: (string | null)[];
}) {
  const icon = <StepIcon icon={QuestionMarkCircle} />;
  const items = round?.items ?? [];
  const count = Math.max(items.length, 1);
  const title = round?.title ? ` · ${round.title}` : "";
  const asked = `Asked ${count === 1 ? "a question" : `${count} questions`}${title}`;
  if (answer === null) {
    return (
      <p className={ROW}>
        {icon}
        <Words verb={waiting ? `${count === 1 ? "Asking a question" : "Asking questions"} · waiting` : `${asked} · ${WITHDRAWN}`} live={waiting} />
      </p>
    );
  }
  const pairs = items.length > 0 ? items.map((item, at) => ({ text: item.text, given: answerWords(item, answers ? (answers[at] ?? null) : at === 0 ? answer : null) })) : [{ text: question, given: answer }];
  return (
    <OpeningRow
      keep={keep}
      detail={
        <dl className="flex flex-col gap-3 pt-2 pb-1 text-sm select-text">
          {pairs.map((pair, at) => (
            <div key={at} className="flex flex-col gap-1">
              <dt className="whitespace-pre-wrap wrap-anywhere text-row-foreground">{pair.text}</dt>
              <dd className="whitespace-pre-wrap wrap-anywhere text-live-text-quiet">{pair.given}</dd>
            </div>
          ))}

        </dl>
      }
    >
      {icon}
      <Words verb={asked} />
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
  // Its last step's words stay until the next one's, so the line under it never comes and goes between steps [D85].
  const held = useRef(current);
  if (current) held.current = current;
  if (running) {
    const doing = current ?? held.current;
    return (
      <div className="flex min-w-0 flex-col">
        <p className={cx(ROW, "text-foreground")}>
          {/* Clipped: its turning corners would make an opened group's steps scroll, and their edge fade blink [D85]. */}
          <span className="flex shrink-0 overflow-clip">
            <Spinner className="size-4 motion-safe:animate-spin" />
          </span>
          <span className="min-w-0 truncate">
            Running a subagent: <span className="font-medium">{title}</span>
          </span>
          {startedAt !== undefined && <span className="shrink-0 text-muted-foreground tabular-nums">{duration(now - startedAt)}</span>}
        </p>
        {doing && (
          <p className={cx(HANGING, "py-0.5")}>
            {/* Keyed by its words: each new step starts the sweep again. */}
            <span key={`${doing.step}${doing.input}`} className="block truncate text-sm leading-5.25 shimmer">
              {VERBS[doing.step][0]} {doing.input}
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

const COMPACTION: Record<Exclude<Progress, "pending">, string> = {
  running: "Optimizing conversation…",
  done: "Conversation optimized",
  failed: "Couldn’t optimize conversation · Nothing changed",
  cancelled: "Couldn’t optimize conversation · Nothing changed",
};

/** The agent shortening its context, as a divider across the column. */
export function CompactionDivider({ progress: reported = "done" }: { progress?: Progress }) {
  // Never a line saying it's waiting (D186): one not yet started reads as under way.
  const progress = reported === "pending" ? "running" : reported;
  return (
    <LabeledDivider>
      <TextShorterConcise className="size-icon-sm shrink-0" />
      <span key={progress} className={cx("min-w-0 text-center", progress === "running" && "shimmer")}>
        {COMPACTION[progress]}
      </span>
    </LabeledDivider>
  );
}

/** Something the app or agent wants seen, centred after its icon; an error in red, announced as it comes. */
export function NoticeRow({ level, text, link }: { level: "info" | "warning" | "error"; text: string; link?: ReactNode }) {
  const error = level === "error";
  return (
    // Centred, wrapped lines too (D150). The icon is inline before the first word, so it stays beside the words,
    // centred on its capitals (D151).
    <p role={error ? "alert" : undefined} className={cx("text-center text-sm leading-5.25 wrap-anywhere", error ? "whitespace-pre-wrap text-destructive" : "text-row-foreground")}>
      <span className="me-1.5 w-4 cap-box">
        {error ? <ExclamationMarkCircle className="size-4" /> : level === "warning" ? <Warning className="size-4 text-warning" /> : <Info className="size-4" />}
      </span>
      {text}
      {link}
    </p>
  );
}

type Switch = Extract<Item, { kind: "switch" }>;
const SWITCH_STATES = ["limit", "switching", "switched", "failed", "over"] as const;

/** One state's line of a switch divider. */
function switchLine(change: Switch, state: Switch["state"], from: string, actions: ReactNode, onRetry: (() => void) | undefined): ReactNode {
  const to = change.model ? `${change.to} · ${change.model}` : (change.to ?? "");
  const refused = change.reason === "unresumable";
  const hit = refused ? `${from} couldn’t resume this conversation` : change.reason === "credits" ? `Out of credits on ${from}` : `Usage limit on ${from}`;
  // When it comes back, as its CLI said; a reset already past, or none said, is "later" [D74, D379].
  const back = change.reason !== "usage-limit" ? "" : change.resets && change.resets > Date.now() ? ` · try again at ${hhmm(change.resets)}` : " · try again later";
  // At the limit it reads as a status that may wrap, its icon first (D487).
  const status = (
    <>
      <Warning className="size-icon-sm shrink-0" />
      <span>{hit + back}</span>
    </>
  );
  switch (state) {
    case "limit":
      return (
        <>
          {status}
          {actions}
        </>
      );
    case "switching":
      // Under way, it shimmers as compaction's running line does (D59).
      return <span className="shimmer">{refused ? `Starting a new conversation on ${to}` : `Switching to ${to}`}</span>;
    case "switched":
      // A switch logged before the shape has only Rust's sentence.
      if (!change.to) return <span>{change.text}</span>;
      // Picked, not forced: no limit to explain.
      if (change.reason === "picked") return <span>Switched to {to}</span>;
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
      return status;
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
