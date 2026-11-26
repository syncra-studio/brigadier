import { type FC, type ReactNode, useContext } from "react";

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../components/collapsible";
import { Chevron, DETAIL, ROW, STEPS, TOGGLE } from "../components/thread/activity-row";
import { cx } from "../components/cx";
import { useKept } from "../thread/kept";
import { Chat, PauseCircle, PlayCircle, Spinner, StopCircle } from "../icons";
import { WorkerGlyph } from "../icons/worker-glyphs";
import { Glyphs, lowerFirst, onHand, type Worker, WorkerName, WorkersPanel } from "./chip";

/*
 * How workers show in the thread: sentences in the row recipe of the work, never cards [D3010]. One row per batch
 * ("Retry backoff and Progress bar started working" [D103]) and what the lead did to them ("Messaged Retry
 * backoff", "You ended Retry backoff"); every name opens its worker.
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

/** What a worker was told, in a quiet box. */
const QuietBrief: FC<{ children: ReactNode }> = ({ children }) => (
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

/** "A", "A and B", "A, B and C"; past three, "A, B and 4 more": a batch row's words, its list naming each. */
const said = (workers: readonly Worker[]) => {
  const names = workers.map((worker) => worker.name);
  const named = names.length > 3 ? [...names.slice(0, 2), `${names.length - 2} more`] : names;
  return named.length > 1 ? `${named.slice(0, -1).join(", ")} and ${named.at(-1)}` : (named[0] ?? "");
};

const FINISHED_KINDS: ReadonlySet<Worker["kind"]> = new Set(["merged", "doneNotMerged", "done"]);

/**
 * How the batch went: working while any is on hand, else finished, with errors when one failed.
 * Workers whose End has its own "Ended" row (`endRows`) keep their start, so the end reads once, in its place [D328].
 */
export function batchWords(workers: readonly Worker[], endRows = false): string {
  if (workers.some(onHand)) return "started working";
  if (workers.some((worker) => worker.kind === "failed")) return "finished with errors";
  if (workers.some((worker) => FINISHED_KINDS.has(worker.kind))) return "finished";
  return endRows ? "started working" : "stopped";
}

/** One agent's own outcome in the opened batch: a worker's merge said there alone [D175]. */
function outcome(worker: Worker): string {
  switch (worker.kind) {
    case "working":
      return "started working";
    case "merged":
      return `finished · ${worker.word}`;
    case "doneNotMerged":
      return "finished · Not merged";
    case "done":
      return "finished";
    default:
      return lowerFirst(worker.word);
  }
}

/**
 * Workers or subagents started together, one row per batch [D103]: their glyphs and "A and B started working",
 * "… finished" once all are. Opened, a row each with how it went, which opens that one in its tab [D81, D175].
 */
export const BatchRow: FC<{ keep: string; workers: readonly Worker[]; endRows?: boolean }> = ({ keep, workers, endRows = false }) => {
  const [open, setOpen] = useKept(keep);
  const { open: show } = useContext(WorkersPanel);
  return (
    <div data-slot="task-row" className="flex min-w-0 flex-col">
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className={cx(ROW, TOGGLE)}>
        <Glyphs workers={workers} />
        <span className="min-w-0 truncate">
          {said(workers)} {batchWords(workers, endRows)}
        </span>
        <Chevron />
      </button>
      {open && (
        <div className={STEPS}>
          {workers.map((worker) => (
            <button key={worker.id} type="button" title={`Open ${worker.name}`} onClick={() => show(worker.id)} className={cx(ROW, TOGGLE)}>
              <WorkerGlyph id={worker.id} className="size-4 shrink-0" />
              <span className="min-w-0 truncate">
                {worker.name} {outcome(worker)}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

/** A row of the lead managing its team: "Messaged Retry backoff", "You ended Retry backoff". */
export type TeamStep =
  | { type: "messaged"; byUser: boolean; worker: Worker; text?: string }
  | { type: "stopped"; byUser: boolean; workers: readonly Worker[] }
  | { type: "paused" | "resumed"; workers: readonly Worker[] };

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
      // The user's own End says so on the row. Ending reads "Ended" (D199).
      icon = <StopCircle aria-hidden className="size-4 shrink-0" />;
      line = <>{step.byUser ? "You ended" : "Ended"} <Names workers={step.workers} glyph /></>;
      break;
    // The user's Pause and Resume [D3041].
    case "paused":
      icon = <PauseCircle aria-hidden className="size-4 shrink-0" />;
      line = <>Paused <Names workers={step.workers} glyph /></>;
      break;
    case "resumed":
      icon = <PlayCircle aria-hidden className="size-4 shrink-0" />;
      line = <>Resumed <Names workers={step.workers} glyph /></>;
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
export const StillRunningRow: FC<{ workers: readonly Worker[]; stopping?: boolean; onStop: () => void }> = ({ workers, stopping = false, onStop }) => (
  <div data-slot="workers-still-running" aria-busy={stopping || undefined} className={ROW}>
    {stopping ? <Spinner className="size-4 shrink-0 motion-safe:animate-spin" /> : <Glyphs workers={workers} />}
    <span className="min-w-0 truncate">
      {workers.length} {workers.length === 1 ? "worker" : "workers"} still running
      <span aria-hidden className="text-row-object"> · </span>
      <button type="button" onClick={onStop} disabled={stopping} className="cursor-pointer rounded-control text-strip-foreground hover:text-foreground focus-visible:focus-ring disabled:cursor-not-allowed disabled:opacity-disabled">
        {stopping ? "Stopping…" : "Stop them"}
      </button>
    </span>
  </div>
);
