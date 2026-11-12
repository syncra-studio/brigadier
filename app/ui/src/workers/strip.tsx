import { type FC, useCallback, useContext, useState } from "react";

import { RailItem } from "../components/composer/rail";
import { Button } from "../components/button";
import { cx } from "../components/cx";
import { ErrorLine } from "../components/error-line";
import { TooltipIconButton } from "../components/icon-button";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/tooltip";
import { ChevronRight, PauseCircle, PlayCircle, X } from "../icons";
import { WorkerGlyph } from "../icons/worker-glyphs";
import { Counts } from "../panel/source/rows";
import { duration, useSecond } from "../thread/words";
import { finished, onHand, type Worker, WorkersPanel, waiting } from "./chip";

/*
 * The Workers strip above the composer, never under it [D388], as the old app's WorkersStrip, StripRow, StopWorker
 * and RowTime: while workers run or wait, those only; finished ones leave it. A lone worker is its own row; more,
 * folded, are counted; open, one row each, and Pause all [D3010, D3041].
 */

/** The user's End, Pause or Resume of workers: Rust's `workers <id> stop|pause|resume`, rejecting with its error. */
export type Act = (how: "stop" | "pause" | "resume", ids: readonly string[]) => Promise<unknown>;

/** Runs a daemon request from a button and keeps its error to show next to it, as the old app's useAction. */
function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback((action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    action()
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setBusy(false));
  }, []);
  return { busy, error, run };
}

// The old 24px controls kept the toolbar buttons' 10px corner.
const BUTTON = "shrink-0 rounded-icon-button text-row-foreground hover:text-foreground";

/** "4m ago": how long since a finished worker's CLI last said anything. */
function ago(at: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - at) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}

/** How long a worker has been at it, ticking; once finished, how long ago it last spoke with `ago`, else nothing. */
export function RowTime({ worker, ago: since = false, className }: { worker: Worker; ago?: boolean; className?: string }) {
  const done = finished(worker);
  const shown = !done || (since && worker.lastAt !== undefined);
  const now = useSecond(shown);
  if (!shown) return null;
  return (
    <span className={cx("shrink-0 text-faint-foreground tabular-nums", className)}>
      {done ? ago(worker.lastAt ?? now, now) : duration(now - worker.startedAt)}
    </span>
  );
}

/** The user's End for one worker while it works, waits or is paused: no confirm, its work stays on its branch. */
export function StopWorker({ worker, act }: { worker: Worker; act: Act }) {
  const stop = useAction();
  if (!onHand(worker)) return null;
  return (
    <>
      <TooltipIconButton
        tooltip="End worker · its work stays on its branch"
        aria-label={`End ${worker.name}`}
        data-slot="worker-stop"
        disabled={stop.busy}
        onClick={(event) => {
          event.stopPropagation();
          stop.run(() => act("stop", [worker.id]));
        }}
        className={BUTTON}
      >
        <X />
      </TooltipIconButton>
      <ErrorLine error={stop.error} className="shrink-0" />
    </>
  );
}

/** The user's pause/resume toggle for one worker [D3041]: one "Paused …" or "Resumed …" line in the thread. */
export function PauseWorker({ worker, act }: { worker: Worker; act: Act }) {
  const toggle = useAction();
  if (!onHand(worker)) return null;
  const paused = worker.kind === "paused";
  return (
    <>
      <TooltipIconButton
        tooltip={paused ? "Resume worker" : "Pause worker"}
        aria-label={`${paused ? "Resume" : "Pause"} ${worker.name}`}
        data-slot="worker-pause"
        data-state={paused ? "paused" : "running"}
        disabled={toggle.busy}
        onClick={(event) => {
          event.stopPropagation();
          toggle.run(() => act(paused ? "resume" : "pause", [worker.id]));
        }}
        className={BUTTON}
      >
        {paused ? <PlayCircle /> : <PauseCircle />}
      </TooltipIconButton>
      <ErrorLine error={toggle.error} className="shrink-0" />
    </>
  );
}

/** A worker's pause/resume toggle and its End, side by side. */
export function WorkerControls({ worker, act }: { worker: Worker; act: Act }) {
  return (
    <span data-slot="worker-controls" className="flex shrink-0 items-center">
      <PauseWorker worker={worker} act={act} />
      <StopWorker worker={worker} act={act} />
    </span>
  );
}

/** A lone row's quiet hover: its words turn white under the pointer or the keyboard's focus. */
const BRIGHTENS = "group-hover/strip-row:text-foreground group-focus-visible/strip-row:text-foreground";

/**
 * One worker: `[g] Name · what it does · 1m 2s · +12 −3`: while it works its call at work, shimmering, else its
 * state. Opens its thread. A `lone` row has no hover fill: its words brighten instead, as a thread row's do.
 */
export const StripRow: FC<{ worker: Worker; lone?: boolean; act: Act }> = ({ worker, lone = false, act }) => {
  const { open } = useContext(WorkersPanel);
  const working = worker.kind === "working";
  return (
    <li>
      <div className="flex min-w-0 items-start">
        <button
          type="button"
          data-slot="workers-strip-row"
          data-worker-state={worker.kind}
          onClick={() => open(worker.id)}
          className={cx("group/strip-row flex min-w-0 flex-1 cursor-pointer flex-col items-stretch rounded-control px-2 text-start text-sm focus-visible:focus-ring", !lone && "hover:bg-fill-subtle")}
        >
          <span className="flex min-h-8 min-w-0 items-center gap-1.5">
            <WorkerGlyph id={worker.id} className="size-4 shrink-0" />
            <span className={cx("max-w-1/3 shrink-0 truncate text-tool-box-text", lone && BRIGHTENS)}>{worker.name}</span>
            <span aria-hidden className="text-row-object">·</span>
            <span className={cx("min-w-0 flex-1 truncate", working ? "shimmer" : cx("text-row-foreground", lone && BRIGHTENS))}>
              {working ? (worker.now ?? worker.word) : worker.word}
            </span>
            <RowTime worker={worker} />
            {(worker.added ?? 0) + (worker.removed ?? 0) > 0 && <Counts added={worker.added ?? 0} removed={worker.removed ?? 0} />}
          </span>
        </button>
        {/* Level with the first line, however many lines the row has. */}
        <span className="flex h-8 shrink-0 items-center">
          <WorkerControls worker={worker} act={act} />
        </span>
      </div>
    </li>
  );
};

/** "2 workers working · 1 waiting · 1 paused": the first count names them, zeros are left out. */
export function stripWords(workers: readonly Worker[]): string {
  const held = workers.filter(waiting).length;
  const paused = workers.filter((worker) => worker.kind === "paused").length;
  const counts = [
    [workers.length - held - paused, "working"],
    [held, "waiting"],
    [paused, "paused"],
  ] as const;
  return counts
    .filter(([count]) => count > 0)
    .map(([count, word], index) => (index === 0 ? `${count} ${count === 1 ? "worker" : "workers"} ${word}` : `${count} ${word}`))
    .join(" · ");
}

/**
 * The strip, from the session's workers: those still at work or waiting, oldest first; nothing when none are. A card
 * of the composer rail, as the old ComposerStatusSlot's.
 */
export const WorkersStrip: FC<{ workers: readonly Worker[]; act: Act; initiallyOpen?: boolean }> = (props) => {
  if (!props.workers.some(onHand)) return null;
  return (
    <RailItem label="Live work">
      <div data-slot="composer-status-slot">
        <Strip {...props} />
      </div>
    </RailItem>
  );
};

const Strip: FC<{ workers: readonly Worker[]; act: Act; initiallyOpen?: boolean }> = ({ workers, act, initiallyOpen = false }) => {
  const [open, setOpen] = useState(initiallyOpen);
  const pause = useAction();
  const live = workers.filter(onHand).toSorted((a, b) => a.startedAt - b.startedAt);
  // Pause all pauses those at work or waiting.
  const pausable = live.filter((worker) => worker.kind !== "paused").map((worker) => worker.id);
  // One worker shows as itself: its name, what it does, its End; two or more fold into a count.
  if (live.length === 1) {
    return (
      <ul data-slot="workers-strip" className="flex flex-col px-1 py-1">
        <StripRow worker={live[0]!} lone act={act} />
      </ul>
    );
  }
  return (
    <div data-slot="workers-strip" data-state={open ? "open" : "closed"} className="group flex flex-col px-1 py-1">
      <div className="flex min-h-8 items-center gap-1">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="group/toggle flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-control px-2 py-1 text-start text-sm text-row-foreground hover:text-foreground focus-visible:focus-ring"
        >
          <span className="flex shrink-0 items-center gap-1">
            {live.slice(0, 4).map((worker) => (
              <WorkerGlyph key={worker.id} id={worker.id} className="size-4" />
            ))}
          </span>
          {/* Its chevron right after the words, in a 24px box: right while closed, down open. */}
          <span className="flex min-w-0 items-center">
            <span className="min-w-0 truncate">{stripWords(live)}</span>
            <span aria-hidden className="flex size-icon-button-sm shrink-0 items-center justify-center">
              <ChevronRight
                data-slot="workers-strip-chevron"
                className="size-icon-sm text-row-object chevron-motion group-hover/toggle:text-foreground group-focus-visible/toggle:text-foreground group-aria-expanded/toggle:rotate-90"
              />
            </span>
          </span>
        </button>
        {pausable.length > 0 && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="xs"
                  variant="ghost"
                  data-slot="workers-pause-all"
                  disabled={pause.busy}
                  onClick={() => pause.run(() => Promise.all(pausable.map((id) => act("pause", [id]))))}
                  className="text-row-foreground hover:text-foreground"
                />
              }
            >
              <PauseCircle />
              Pause all
            </TooltipTrigger>
            <TooltipContent side="top">Pause every worker running or waiting to run</TooltipContent>
          </Tooltip>
        )}
      </div>
      <ErrorLine error={pause.error} className="px-2" />
      {open && (
        <ul className="flex max-h-queue-max flex-col overflow-y-auto">
          {live.map((worker) => (
            <StripRow key={worker.id} worker={worker} act={act} />
          ))}
        </ul>
      )}
    </div>
  );
};
