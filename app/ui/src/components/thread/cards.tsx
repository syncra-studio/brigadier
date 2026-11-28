import { type ComponentType, createContext, type ReactNode, useContext } from "react";

import { ExclamationMarkCircle, Chat, Commit, Cursor, Dock, Globe, Info, Key, PencilSquare, QuestionMarkCircle, Sparkle, TextShorterConcise, Tools, Warning } from "../../icons";
import type { IconProps } from "../../icons";
import type { ApprovalAction, Item, Progress, SentFile } from "../../thread/item";
import { SessionOfThread } from "../../accounts/limit";
import { openAttachment } from "../../shell/tab-store";
import { SentAttachments } from "../composer/attachments";
import type { PendingQuestion } from "../composer/question";
import type { Reset } from "../../sidebar/words";
import { Button } from "../button";
import { cx } from "../cx";
import { LabeledDivider } from "../labeled-divider";
import { Tooltip, TooltipContent, TooltipTrigger } from "../tooltip";
import { OpeningRow, ROW, StepIcon, Words } from "./activity-row";
import { InfoTip, WithTip } from "./tip";
import { ToolBox } from "./tool";
import { COMPACTION, switchWords, UNKNOWN_STEP } from "../../../../shared/words";
import { answerWords, approvalWords, PARENT, questionWords } from "../../../../shared/cards";

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
  computer: Cursor,
  other: Tools,
};

/** The session that started the worker whose thread shows: a request it answers names it [D131]. */
export const ParentName = createContext(PARENT);

/**
 * An approval, read like a question: "Asking for approval · waiting" while it waits (the card to decide sits
 * in the composer's place), then "Asked for approval · allowed" or "· denied", which opens to what was asked. A plan
 * denied was sent back, by the review or with a reply: "· sent back by review", "· sent back" [D394].
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
  byReview,
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
  /** The review answered it: a plan it sent back with findings [D394]. */
  byReview?: boolean;
}) {
  const icon = <StepIcon icon={ACTIONS[action]} />;
  const parent = useContext(ParentName);
  const verb = approvalWords(decision, action, waiting, toParent ? parent : undefined, byReview);
  if (decision === null || decision === "withdrawn") {
    return (
      <p className={ROW}>
        {icon}
        <Words verb={verb} object={subject} live={waiting && decision === null} />
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
      <Words verb={verb} object={subject} />
    </OpeningRow>
  );
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
  files,
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
  /** Each answer's files. */
  files?: (SentFile[] | null)[] | null;
  /** A worker's, which only its parent answers: "Asking ‹parent›", then "‹parent› answered" [D121, D131]. */
  toParent?: boolean;
}) {
  const icon = <StepIcon icon={QuestionMarkCircle} />;
  const parent = useContext(ParentName);
  const session = useContext(SessionOfThread)?.id;
  const items = round?.items ?? [];
  const count = Math.max(items.length, 1);
  const verb = questionWords(answer !== null, waiting, count, round?.title, toParent ? parent : undefined);
  if (answer === null) {
    return (
      <p className={ROW}>
        {icon}
        <Words verb={verb} live={waiting} />
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
              {session && files?.[at] && <dd><SentAttachments start files={files[at].filter((file) => !file.pasted).map((file) => ({ ...file, url: `/attachment/${session}/${file.id}` }))} onOpen={(file) => openAttachment(session, file.id, file.name)} /></dd>}
            </div>
          ))}

        </dl>
      }
    >
      {icon}
      <Words verb={verb} />
    </OpeningRow>
  );
}


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

/** Something the app or agent wants seen after its icon, a row [D120]; an error in red, announced as it comes. */
export function NoticeRow({ level, text, link }: { level: "info" | "warning" | "error"; text: string; link?: ReactNode }) {
  const error = level === "error";
  return (
    // The icon is inline before the first word, so it stays beside the words, centred on its capitals (D151).
    <p role={error ? "alert" : undefined} className={cx("text-sm leading-5.25 wrap-anywhere", error ? "whitespace-pre-wrap text-destructive" : "text-row-foreground")}>
      <span className="me-2 w-4 cap-box">
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
function switchLine(change: Switch, state: Switch["state"], from: string, actions: ReactNode, onRetry: (() => void) | undefined, carries?: Reset | null): ReactNode {
  const { status, words = "", tip } = switchWords(change, state, from, carries);
  // At the limit it reads as a status that may wrap, its icon first (D487).
  const limit = status !== undefined && (
    <>
      <Warning className="size-icon-sm shrink-0" />
      <span>{status}</span>
    </>
  );
  const retry = onRetry && (
    <Button variant="link-blue" size={null} onClick={onRetry}>
      Try again
    </Button>
  );
  switch (state) {
    case "limit":
      return (
        <>
          {limit}
          {actions}
        </>
      );
    case "switching":
      // Under way till the new model runs, it shimmers as compaction's running line does (D59, D241).
      return <span className="shimmer">{words}</span>;
    case "switched":
      return tip === undefined ? <span>{words}</span> : <WithTip words={words} tip={tip} />;
    case "failed":
      if (change.automatic)
        return (
          <>
            {limit}
            <WithTip words={words} tip={tip ?? ""} />
            {retry}
            {actions}
          </>
        );
      return (
        <>
          {tip ? <WithTip words={words} tip={tip} /> : <span>{words}</span>}
          {retry}
        </>
      );
    case "over":
      return limit;
  }
}

/**
 * A usage limit, or a refused resume, and the switch past it: one divider whose state changes in place, like
 * compaction's (D132, D134). Every state's divider sits in the same grid cell and only the current one shows, so
 * the row keeps the height of its tallest state and nothing below it moves. `from` names the side that hit it while Rust
 * hasn't yet (at the limit); `actions` follow the limit's words (its links, a short note): pass them in every state,
 * so they keep their room after the row moves on. `onRetry` is the failed switch's Try again.
 */
export function SwitchDivider({ change, from, actions, onRetry, carries }: { change: Switch; from?: string; actions?: ReactNode; onRetry?: () => void; carries?: Reset | null }) {
  const side = change.from || from || (change.reason === "unresumable" ? "The agent" : "this account");
  return (
    <div role="status" className="grid">
      {SWITCH_STATES.map((state) => (
        <LabeledDivider key={state} className={cx("col-start-1 row-start-1", state !== change.state && "invisible")}>
          <span className="flex min-w-0 flex-wrap items-center justify-center gap-x-1.5 text-center wrap-break-word">
            {switchLine(change, state, side, actions, onRetry, carries)}
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
      <Words verb={UNKNOWN_STEP} />
    </OpeningRow>
  );
}
