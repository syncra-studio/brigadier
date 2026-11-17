import { createContext, type FC, useContext } from "react";

import { cx } from "../components/cx";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/tooltip";
import { WorkerGlyph } from "../icons/worker-glyphs";

/*
 * A worker named anywhere in the conversation, as the old app's WorkerChip and Glyphs: its chip (glyph and name in a
 * pill, which opens it in the Workers panel), the one way the thread names a worker [D588], and a sentence's glyphs.
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
  /** When its log last changed: a held block's quiet clock starts again [D552]. */
  heardAt?: number;
  added?: number;
  removed?: number;
  model?: string;
  brief?: string;
  /** What routing picked for it [D3018]. */
  receipt?: string;
  /** What its parent asked for, where that isn't what ran [D2037]. */
  asked?: string;
  /** Why it runs on that, in a line [D2037]. */
  why?: string;
  /** A folder chat's worker: the repos it claimed [D494]. */
  repos?: string[];
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
            onClick={(event) => {
              // Inside a row that opens, the chip opens its worker only.
              event.stopPropagation();
              open(worker.id);
            }}
            className={cx(
              "inline-flex h-control-xs max-w-56 min-w-0 shrink cursor-pointer items-center gap-1.5 rounded-capsule border border-border bg-worker-chip ps-2 pe-2.5 align-baseline text-sm leading-5.5 text-foreground transition-colors hover:bg-muted focus-visible:focus-ring",
              className,
            )}
          />
        }
      >
        <WorkerGlyph id={worker.id} className="size-icon-sm animate-glyph-in motion-reduce:animate-none" />
        {/* The name is the chip's baseline, so it sits on its line's text [D590]. */}
        <span className="min-w-0 self-baseline truncate">{label ?? worker.name}</span>
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

/** The glyphs of a sentence's workers, up front: one each, the first four. */
export const Glyphs: FC<{ workers: readonly Worker[] }> = ({ workers }) => (
  <span aria-hidden className="inline-flex shrink-0 items-center gap-1.5">
    {workers.slice(0, 4).map((worker) => (
      <WorkerGlyph key={worker.id} id={worker.id} className="size-4" />
    ))}
  </span>
);
