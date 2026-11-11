import { type FC, type ReactNode, useContext } from "react";

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../components/collapsible";
import { Chevron, DETAIL, ROW, TOGGLE } from "../components/thread/activity-row";
import { cx } from "../components/cx";
import { useKept } from "../thread/kept";
import { Chat, StopCircle } from "../icons";
import { duration } from "../thread/words";
import { Glyphs, lowerFirst, type Worker, WorkerName, WorkersPanel } from "./chip";

/*
 * How workers show in the thread, as the old app's TeamSentence and Briefs: sentences in the row recipe of the work,
 * never cards [D3010]. What happened to them ("Retry backoff and Progress bar started working") and what the lead
 * did to them ("Messaged Retry backoff", "You ended Retry backoff"); every name opens its worker.
 */

/**
 * A row that opens to its detail, as the thread's OpeningRow, but on a div as the old ThreadActivity was, so the
 * worker and session names inside it stay buttons of their own.
 */
export function OpeningLine({ keep, children, detail }: { keep: string; children: ReactNode; detail: ReactNode }) {
  const [open, setOpen] = useKept(keep);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="flex min-w-0 flex-col">
      <CollapsibleTrigger nativeButton={false} render={<div />} className={cx(ROW, TOGGLE)}>
        {children}
        <Chevron />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className={DETAIL}>{detail}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** What a worker was told or why it stopped, in a quiet box. */
export const QuietBrief: FC<{ children: ReactNode }> = ({ children }) => (
  <div data-slot="tool-card" className="flex flex-col rounded-control bg-code-surface text-tool-box-text">
    <div className="max-h-60 overflow-auto px-3 pt-2 pb-2">
      <div className="text-sm wrap-break-word whitespace-pre-wrap select-text">{children}</div>
    </div>
  </div>
);

/**
 * "A", "A and B", "A, B and C"; past three, "A, B and 4 more", the more opening the Workers list. Names are task
 * titles, so a sentence never makes them possessive.
 */
export const Names: FC<{ workers: readonly Worker[]; glyph?: boolean }> = ({ workers, glyph = false }) => {
  const { open } = useContext(WorkersPanel);
  const named = workers.length > 3 ? workers.slice(0, 2) : workers;
  const more = workers.length - named.length;
  const parts: ReactNode[] = named.map((worker) => <WorkerName key={worker.id} worker={worker} glyph={glyph} />);
  if (more > 0) {
    parts.push(
      <button key="more" type="button" className="cursor-pointer rounded-control hover:text-foreground focus-visible:focus-ring" onClick={() => open(null)}>
        {`${more} more`}
      </button>,
    );
  }
  return (
    <>
      {parts.map((part, index) => (
        <span key={index} className="min-w-0">
          {index > 0 && (index === parts.length - 1 ? " and " : ", ")}
          {part}
        </span>
      ))}
    </>
  );
};

/** A start's detail: each worker's brief, in a quiet box, and what routing picked for it in its place [D3018]. */
export const Briefs: FC<{ workers: readonly Worker[] }> = ({ workers }) => (
  <div className="flex flex-col gap-2">
    {workers.map((worker) => (
      <div key={worker.id} className="flex flex-col gap-1">
        {workers.length > 1 && <WorkerName worker={worker} />}
        <QuietBrief>{worker.brief}</QuietBrief>
        {worker.receipt && <span>{worker.receipt}</span>}
      </div>
    ))}
  </div>
);

export type Lifecycle = "started" | "waiting" | "stopped" | "failed" | "finished";

function verb(word: Lifecycle, workers: readonly Worker[], why: string | undefined): string {
  const many = workers.length > 1;
  switch (word) {
    case "started":
      return "started working";
    case "waiting":
      // A lone worker still waiting says what for ("is waiting for your approval").
      return many ? "are waiting" : why ? `is ${lowerFirst(why)}` : "is waiting";
    case "stopped":
      return "stopped";
    case "failed":
      return "failed";
    case "finished":
      return "finished";
  }
}

/** What happened to workers, as one sentence; "started" opens to their Briefs. `why`: what a lone waiting one waits for. */
export const TeamSentence: FC<{ keep: string; word: Lifecycle; workers: readonly Worker[]; why?: string }> = ({ keep, word, workers, why }) => {
  const line = (
    <>
      <Glyphs workers={workers} />
      {/* One line: a sentence too long for it truncates; its detail names every worker. */}
      <span className="min-w-0 truncate">
        <Names workers={workers} /> {verb(word, workers, why)}
      </span>
    </>
  );
  if (word !== "started") return <div data-slot="task-row" data-kind={word} className={ROW}>{line}</div>;
  return (
    <OpeningLine keep={keep} detail={<Briefs workers={workers} />}>
      {line}
    </OpeningLine>
  );
};

/** A row of the lead managing its team: "Messaged Retry backoff", "You ended Retry backoff after 3m 10s". */
export type TeamStep =
  | { type: "messaged"; byUser: boolean; worker: Worker; text?: string }
  | { type: "stopped"; byUser: boolean; workers: readonly Worker[]; afterMs?: number; reason?: string };

export const TeamStepRow: FC<{ keep: string; step: TeamStep }> = ({ keep, step }) => {
  let icon: ReactNode;
  let line: ReactNode;
  let detail: ReactNode = undefined;
  switch (step.type) {
    case "messaged":
      icon = <Chat aria-hidden className="size-4 shrink-0" />;
      line = <>{step.byUser ? "You messaged" : "Messaged"} <WorkerName worker={step.worker} /></>;
      detail = step.text ? <QuietBrief>{step.text}</QuietBrief> : undefined;
      break;
    case "stopped":
      // The user's own End says so on the row; the lead's says why. Ending reads "Ended" (D199).
      icon = <StopCircle aria-hidden className="size-4 shrink-0" />;
      line = (
        <>
          {step.byUser ? "You ended" : "Ended"} <Names workers={step.workers} glyph />
          {step.afterMs !== undefined && step.afterMs >= 1000 && ` after ${duration(step.afterMs)}`}
        </>
      );
      detail = step.reason && !step.byUser ? <QuietBrief>{step.reason}</QuietBrief> : undefined;
      break;
  }
  const words = <span className="flex min-w-0 items-center gap-1 truncate">{line}</span>;
  if (!detail) {
    return (
      <div data-slot="orchestrator-step" data-kind={step.type} className={ROW}>
        {icon}
        {words}
      </div>
    );
  }
  return (
    <OpeningLine keep={keep} detail={detail}>
      {icon}
      {words}
    </OpeningLine>
  );
};

/** Stop ended the parent's turn only: its workers run on, one click away from ending too [D3009, D3011]. */
export const StillRunningRow: FC<{ workers: readonly Worker[]; onStop: () => void }> = ({ workers, onStop }) => (
  <div data-slot="workers-still-running" className={ROW}>
    <Glyphs workers={workers} />
    <span className="min-w-0 truncate">
      {workers.length} {workers.length === 1 ? "worker" : "workers"} still running
      <span aria-hidden className="text-row-object"> · </span>
      <button type="button" onClick={onStop} className="cursor-pointer rounded-control text-strip-foreground hover:text-foreground focus-visible:focus-ring">
        Stop them
      </button>
    </span>
  </div>
);
