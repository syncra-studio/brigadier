import { type ComponentType, createContext, type ReactNode, useContext } from "react";

import { ExclamationMarkCircle, Chat, Commit, Dock, Globe, Info, Key, PencilSquare, QuestionMarkCircle, Sparkle, TextShorterConcise, Tools, Warning } from "../../icons";
import type { IconProps } from "../../icons";
import type { ApprovalAction, Item, Progress } from "../../thread/item";
import type { PendingQuestion, QuestionItem } from "../composer/question";
import { hhmm } from "../../thread/words";
import { Button } from "../button";
import { cx } from "../cx";
import { LabeledDivider } from "../labeled-divider";
import { Tooltip, TooltipContent, TooltipTrigger } from "../tooltip";
import { OpeningRow, ROW, StepIcon, Words } from "./activity-row";
import { InfoTip, WithTip } from "./tip";
import { ToolBox } from "./tool";

const WITHDRAWN = "withdrawn";

/** Hangs under a row's words on a hairline, from its icon. */

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

/** The session that started the worker whose thread shows: a request it answers names it [D131]. */
export const ParentName = createContext("Its parent");

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
  subject,
  toParent,
}: {
  keep: string;
  title: string;
  detail?: string;
  body?: ReactNode;
  decision: "approved" | "denied" | "withdrawn" | null;
  action?: ApprovalAction;
  /** Its turn still runs, so an undecided approval waits rather than being withdrawn. */
  waiting: boolean;
  /** What it asked for in a line: the command, site, files or tool. */
  subject?: string;
  /** A worker's, which only its parent answers: a quiet step, "‹parent› allowed: npm test" [D121, D131]. */
  toParent?: boolean;
}) {
  const icon = <StepIcon icon={ACTIONS[action]} />;
  const parent = useContext(ParentName);
  if (decision === null || decision === "withdrawn") {
    waiting = waiting && decision === null;
    const asking = toParent ? `Asking ${parent}` : "Asking for approval";
    const asked = toParent ? `Asked ${parent}` : "Asked for approval";
    return (
      <p className={ROW}>
        {icon}
        <Words verb={waiting ? `${asking} · waiting` : `${asked} · ${WITHDRAWN}`} object={subject} live={waiting} />
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
      {toParent ? (
        <Words verb={`${parent} ${decision === "approved" ? "allowed" : "denied"}:`} object={subject} />
      ) : (
        <Words verb={decision === "approved" ? "Asked for approval · allowed" : "Asked for approval · denied"} object={subject} />
      )}
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
  toParent,
}: {
  keep: string;
  question: string;
  answer: string | null;
  waiting: boolean;
  /** The round as it was asked; without it, the one `question`. */
  round?: PendingQuestion;
  /** One answer per question of the round, null for a skipped one. */
  answers?: (string | null)[];
  /** A worker's, which only its parent answers: "Asking ‹parent›", then "‹parent› answered" [D121, D131]. */
  toParent?: boolean;
}) {
  const icon = <StepIcon icon={QuestionMarkCircle} />;
  const parent = useContext(ParentName);
  const items = round?.items ?? [];
  const count = Math.max(items.length, 1);
  const title = round?.title ? ` · ${round.title}` : "";
  const asked = toParent ? `${parent} answered${title}` : `Asked ${count === 1 ? "a question" : `${count} questions`}${title}`;
  if (answer === null) {
    const asking = toParent ? `Asking ${parent}` : count === 1 ? "Asking a question" : "Asking questions";
    return (
      <p className={ROW}>
        {icon}
        <Words verb={waiting ? `${asking} · waiting` : `${toParent ? `Asked ${parent}${title}` : asked} · ${WITHDRAWN}`} live={waiting} />
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

const COMPACTION: Record<Exclude<Progress, "pending">, string> = {
  running: "Optimizing context…",
  done: "Context optimized",
  failed: "Couldn’t optimize context · Nothing changed",
  cancelled: "Couldn’t optimize context · Nothing changed",
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
      // Under way till the new model runs, it shimmers as compaction's running line does (D59, D241).
      return <span className="shimmer">{refused ? `Starting a new conversation on ${to}…` : to ? `Switching to ${to}…` : "Switching…"}</span>;
    case "switched":
      // A switch logged before the shape has only Rust's sentence.
      if (!change.to) return <span>{change.text}</span>;
      // Picked, not forced: no limit to explain.
      if (change.reason === "picked") return <span>Switched to {to}</span>;
      if (change.moved) return <WithTip words={change.moved} tip={hit} />;
      return <WithTip words={refused ? `Continued in a new conversation on ${to}` : `Switched ${change.automatic ? "automatically " : ""}to ${to}`} tip={hit} />;
    case "failed":
      // An automatic one keeps the limit's words: nothing was clicked that the line could name.
      if (change.automatic)
        return (
          <>
            {status}
            <WithTip words={to ? `· couldn’t switch to ${to}` : "· couldn’t switch automatically"} tip={change.error ?? ""} />
            {onRetry && (
              <Button variant="link-blue" size={null} onClick={onRetry}>
                Try again
              </Button>
            )}
            {actions}
          </>
        );
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
