import type { ComponentType } from "react";

import { Chat, Check, Commit, Dock, Globe, Info, Key, PencilSquare, QuestionMarkCircle, Sparkle, TextShorterConcise, Tools, Warning, X } from "../../icons";
import type { IconProps } from "../../icons";
import type { ApprovalAction, Progress } from "../../thread/item";
import { cx } from "../cx";
import { LabeledDivider } from "../labeled-divider";
import { OpeningRow, ROW, StepIcon, Words } from "./activity-row";
import { ToolBox } from "./tool";

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
 * An approval. Waiting: "Awaiting approval", quietly live (the card to decide sits in the composer's
 * place). Decided: a card with what was asked and "Allowed" or "Denied".
 */
export function ApprovalRow({
  title,
  detail,
  decision,
  action = "other",
}: {
  title: string;
  detail: string;
  decision: "approved" | "denied" | null;
  action?: ApprovalAction;
}) {
  const Icon = ACTIONS[action];
  if (decision === null) {
    return (
      <p className="flex min-h-7 min-w-0 items-center gap-2 text-sm text-muted-foreground">
        <Icon className="size-icon-md shrink-0" />
        <span className="min-w-0 truncate shimmer-quiet">Awaiting approval</span>
      </p>
    );
  }
  return (
    <div className="flex w-full flex-col rounded-thread border border-border bg-card text-foreground">
      <div className="flex min-w-0 items-start gap-2 px-4 pt-3.5 pb-2.5">
        <span className="flex h-5 shrink-0 items-center text-quiet-foreground">
          <Icon className="size-4.5" />
        </span>
        <p className="min-w-0 text-sm leading-5 font-medium wrap-anywhere">{title}</p>
      </div>
      {detail && (
        <div className="flex flex-col gap-2 px-4">
          <ToolBox>{detail}</ToolBox>
        </div>
      )}
      <p className="flex items-center justify-end gap-1 px-4 pt-2.5 pb-3.5 text-xs text-muted-foreground">
        {decision === "approved" ? <Check className="size-icon-sm text-success" /> : <X className="size-icon-sm text-destructive" />}
        {decision === "approved" ? "Allowed" : "Denied"}
      </p>
    </div>
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
        <Words verb={waiting ? "Asking a question · waiting" : "Asked a question · withdrawn"} live={waiting} />
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

/** A subagent the agent started: "Running a subagent", then "Ran a subagent: Find the parser". */
export function ChildAgentRow({ title, progress }: { title: string; progress: Progress }) {
  const running = progress === "running" || progress === "pending";
  return (
    <p className={ROW}>
      <StepIcon kind="agent" />
      {progress === "cancelled" ? (
        <Words verb="Stopped a subagent:" object={title} />
      ) : (
        <Words verb={running ? "Running a subagent" : "Ran a subagent:"} object={running ? undefined : progress === "failed" ? `${title} — failed` : title} live={progress === "running"} />
      )}
    </p>
  );
}

const COMPACTION: Record<Progress, string> = {
  pending: "Refreshing context",
  running: "Refreshing context",
  done: "Context refreshed · nothing was lost",
  failed: "Couldn’t compact context",
  cancelled: "Couldn’t compact context",
};

/** The agent shortening its context, as a divider across the column. */
export function CompactionDivider({ progress = "done" }: { progress?: Progress }) {
  const live = progress === "running" || progress === "pending";
  return (
    <LabeledDivider>
      <TextShorterConcise className="size-icon-sm shrink-0" />
      <span key={progress} className={cx("min-w-0 text-center", live && "shimmer")}>
        {COMPACTION[progress]}
      </span>
    </LabeledDivider>
  );
}

/** Something the app or agent wants seen: an error's sentence in red; a warning or note with its icon. */
export function NoticeRow({ level, text }: { level: "info" | "warning" | "error"; text: string }) {
  return (
    <p role={level === "error" ? "alert" : undefined} className={cx(ROW, "flex-wrap")}>
      {level === "warning" && <Warning className="size-4 shrink-0 text-warning" />}
      {level === "info" && <Info className="size-4 shrink-0" />}
      <span className={cx("min-w-0 wrap-anywhere", level === "error" && "text-destructive")}>{text}</span>
    </p>
  );
}

/** An event the app can't draw yet: it opens to the event as it came. */
export function UnknownRow({ keep, raw }: { keep: string; raw: unknown }) {
  return (
    <OpeningRow keep={keep} detail={<ToolBox title="Event">{JSON.stringify(raw, null, 2)}</ToolBox>}>
      <StepIcon icon={Info} />
      <Words verb="Can’t show this event yet" />
    </OpeningRow>
  );
}
