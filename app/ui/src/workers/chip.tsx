import { createContext, type FC, useContext } from "react";

import { cx } from "../components/cx";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/tooltip";
import { WorkerGlyph } from "../icons/worker-glyphs";

/*
 * A worker named anywhere in the conversation, as the old app's WorkerChip, WorkerName and Glyphs: its chip (glyph
 * and name in a pill, which opens it in the Workers panel), its name as a button, and a sentence's glyphs [D3010].
 * Drawn only: Rust will hand each worker's state word, its live line and its times [D3029].
 */

/** A worker's state, first match wins in Rust, as the old `workerStateOf`; the ones wave 4 has a cause for [D3029]. */
export type WorkerStateKind = "needsYou" | "limit" | "paused" | "cliEnded" | "freshContext" | "working" | "failed" | "stopped" | "merged" | "doneNotMerged" | "done";

/** One worker as the UI draws it. `word` is its state in a word or two ("Needs you", "Limit until 15:10"). */
export type Worker = {
  id: string;
  name: string;
  kind: WorkerStateKind;
  word: string;
  /** What it does right now while it works ("Running pnpm build", "Thinking…"), else its state word. */
  now?: string;
  startedAt: number;
  /** When its CLI last said anything, for a finished one's "4m ago". */
  lastAt?: number;
  added?: number;
  removed?: number;
  model?: string;
  brief?: string;
  /** What routing picked for it [D3018]. */
  receipt?: string;
  /** What its parent asked for, where that isn't what ran [D2037]. */
  asked?: string;
};

const FINISHED: ReadonlySet<WorkerStateKind> = new Set(["paused", "failed", "stopped", "merged", "doneNotMerged", "done"]);

/** Whether it's finished: the Done section's, not the strip's. */
export const finished = (worker: Worker) => FINISHED.has(worker.kind);

/** Whether the strip and End hold it: at work, waiting, or paused, its toggle resuming it. */
export const onHand = (worker: Worker) => worker.kind === "paused" || !finished(worker);

/** Whether it waits rather than works: for the user, a limit to reset, or the message that continues it. */
export const waiting = (worker: Worker) => worker.kind === "needsYou" || worker.kind === "limit" || worker.kind === "cliEnded";

/** A state word inside a line: "Needs you" reads "needs you". */
export const lowerFirst = (word: string) => word.charAt(0).toLowerCase() + word.slice(1);

/** Which worker the Workers tab shows: `null` for the list. */
export const WorkersPanel = createContext<{ open: (id: string | null) => void }>({ open: () => {} });

/**
 * A worker named in a line: its glyph and name in a pill that truncates a long name, shows it whole with its
 * state on hover, and opens it in the panel. An unknown worker reads "a worker".
 */
export function WorkerChip({ worker, label, className }: {
  worker: Worker | null;
  label?: string;
  className?: string;
}) {
  const { open } = useContext(WorkersPanel);
  if (!worker) return <span className="shrink-0">a worker</span>;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            data-slot="worker-chip"
            onClick={() => open(worker.id)}
            className={cx(
              "inline-flex h-control-xs max-w-56 min-w-0 shrink cursor-pointer items-center gap-1.5 rounded-capsule border border-border bg-worker-chip ps-2 pe-2.5 align-middle text-sm leading-normal text-foreground transition-colors hover:bg-muted focus-visible:focus-ring",
              className,
            )}
          />
        }
      >
        <WorkerGlyph id={worker.id} className="size-icon-sm animate-glyph-in motion-reduce:animate-none" />
        <span className="min-w-0 truncate">{label ?? worker.name}</span>
      </TooltipTrigger>
      <WorkerTip worker={worker} />
    </Tooltip>
  );
}

/** The chip's tip: its whole name over its state, small and muted. */
function WorkerTip({ worker }: { worker: Worker }) {
  return (
    <TooltipContent side="top">
      <span className="flex flex-col gap-0.5">
        <span className="wrap-break-word">{worker.name}</span>
        <span className="text-xs text-muted-foreground">{worker.word}</span>
      </span>
    </TooltipContent>
  );
}

/**
 * A worker's name as a button that opens its thread, with its glyph unless the sentence shows the glyphs up front.
 * The one way a worker is named in the thread, the live line and the strip.
 */
export const WorkerName: FC<{ worker: Worker | null; glyph?: boolean }> = ({ worker, glyph = true }) => {
  const { open } = useContext(WorkersPanel);
  if (!worker) return <span className="shrink-0">a worker</span>;
  return (
    <button
      type="button"
      data-slot="worker-name"
      onClick={(event) => {
        event.stopPropagation();
        open(worker.id);
      }}
      title={`Open ${worker.name}`}
      className="inline-flex max-w-full min-w-0 cursor-pointer items-center gap-1 rounded-control align-bottom text-strip-foreground hover:text-foreground focus-visible:focus-ring"
    >
      {glyph && <WorkerGlyph id={worker.id} className="size-icon-xs shrink-0" />}
      <span className="min-w-0 truncate">{worker.name}</span>
    </button>
  );
};

/** The glyphs of a sentence's workers, up front: one each, the first four. */
export const Glyphs: FC<{ workers: readonly Worker[] }> = ({ workers }) => (
  <span aria-hidden className="inline-flex shrink-0 items-center gap-1.5">
    {workers.slice(0, 4).map((worker) => (
      <WorkerGlyph key={worker.id} id={worker.id} className="size-4" />
    ))}
  </span>
);
