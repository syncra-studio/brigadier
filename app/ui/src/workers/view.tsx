import { type ReactNode, useLayoutEffect, useRef, useState } from "react";

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../components/collapsible";
import { cx } from "../components/cx";
import { TooltipIconButton } from "../components/icon-button";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/tooltip";
import { ArrowLeft, ChevronRight } from "../icons";
import { WorkerGlyph } from "../icons/worker-glyphs";
import { Markdown } from "../thread/markdown";
import { duration, useSecond } from "../thread/words";
import { finished, type Worker } from "./chip";
import { WORKERS_LABEL } from "./list";

/*
 * One worker in the right panel, as the old app's WorkerDetail, WorkerHeader, WorkerThread and WorkerBrief [D3013]:
 * back, its glyph and name, "‹model› · ‹state›"; below, its brief as the thread's first bubble, what routing picked
 * for it [D3018], how long it worked, and its thread, read only. The user talks to it from the parent's composer.
 */

/** Its header: back, its glyph and name, its model and state, and the panel's own actions; no End here. */
export function WorkerHeader({ worker, onBack, actions }: { worker: Worker; onBack: () => void; actions?: ReactNode }) {
  return (
    <header data-slot="worker-header" className="flex h-11.5 min-w-0 shrink-0 items-center gap-2 border-b border-border px-2">
      <TooltipIconButton tooltip={`Back to ${WORKERS_LABEL.toLowerCase()}`} onClick={onBack}>
        <ArrowLeft />
      </TooltipIconButton>
      <WorkerGlyph id={worker.id} className="size-6" />
      <h2 className="min-w-8 truncate text-label font-medium" title={worker.name}>
        {worker.name}
      </h2>
      {/* Its model at the end; where the header is short it gives way first, the model before its state. */}
      <Tooltip>
        <TooltipTrigger
          render={<span data-slot="worker-header-model" className="ms-auto flex min-w-0 shrink-1000 text-label text-muted-foreground" />}
        >
          <span className="min-w-0 shrink-1000 truncate">{worker.model}</span>
          <span className="min-w-0 truncate">{" · "}{worker.word}</span>
        </TooltipTrigger>
        <TooltipContent>
          {worker.model} · {worker.word}
        </TooltipContent>
      </Tooltip>
      {actions}
    </header>
  );
}

/** The brief, as the thread's first bubble: three lines, then "Show brief" for the rest. */
export function WorkerBrief({ id, text }: { id: string; text: string }) {
  const [open, setOpen] = useState(false);
  const [long, setLong] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = body.current;
    if (!element || open) return;
    const measure = () => setLong(text.length > 0 && element.scrollHeight > element.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [open, text]);
  return (
    <div data-slot="worker-brief" className="flex max-w-full min-w-0 flex-col gap-1 self-end rounded-thread bg-muted px-3 py-2 text-sm">
      <div ref={body} data-slot="worker-instructions" className={cx("min-w-0 leading-relaxed wrap-anywhere", !open && "line-clamp-3")}>
        <Markdown text={text} keep={`brief:${id}`} />
      </div>
      {(long || open) && (
        <button type="button" onClick={() => setOpen(!open)} className="cursor-pointer self-start rounded-control text-xs text-row-foreground hover:text-foreground focus-visible:focus-ring">
          {open ? "Show less" : "Show brief"}
        </button>
      )}
    </div>
  );
}

/** "Working for 1m 2s" while it works, "Worked for 3m 10s" once finished, "Ended after 3m 10s" when ended. */
function WorkHeader({ worker, workedMs }: { worker: Worker; workedMs: number }) {
  const done = finished(worker);
  const now = useSecond(!done);
  const took = duration(done ? workedMs : now - worker.startedAt);
  return (
    <div data-slot="worker-work-header" className="border-b border-border pb-2 text-sm text-faint-foreground tabular-nums">
      {worker.kind === "stopped" ? `Ended after ${took}` : done ? `Worked for ${took}` : `Working for ${took}`}
    </div>
  );
}

/**
 * Its thread: the brief, the receipt, how long it worked, its earlier work folded once it's over ("4 previous
 * messages"), its recent rows, the live line while it works, and what it waits for.
 */
export function WorkerThread({ worker, workedMs = 0, previous = [], live, children }: {
  worker: Worker;
  workedMs?: number;
  /** Its history, folded under "N previous messages" once it's over. */
  previous?: readonly ReactNode[];
  /** What it does right now, when no row of its says it ("Thinking"). */
  live?: string;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div data-slot="worker-thread" className="min-h-0 min-w-0 flex-1 overflow-y-auto px-4 pb-6 wrap-anywhere">
      <div className="mx-auto flex max-w-reading min-w-0 flex-col gap-4 pt-5">
        {worker.brief && <WorkerBrief id={worker.id} text={worker.brief} />}
        {worker.receipt && <p data-slot="worker-picked" className="text-sm text-muted-foreground">{worker.receipt}</p>}
        <WorkHeader worker={worker} workedMs={workedMs} />
        {previous.length > 0 && (
          <Collapsible open={open} onOpenChange={setOpen}>
            <CollapsibleTrigger className="flex min-h-7 w-full cursor-pointer items-center gap-1 border-b border-border text-start text-sm text-faint-foreground hover:text-foreground focus-visible:focus-ring">
              {previous.length} previous {previous.length === 1 ? "message" : "messages"}
              <ChevronRight aria-hidden className={cx("size-3", open ? "-rotate-90" : "rotate-90")} />
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="flex flex-col gap-4 py-4">{previous}</div>
            </CollapsibleContent>
          </Collapsible>
        )}
        {children}
        {live && worker.kind === "working" && <div className="shimmer truncate text-sm motion-reduce:animate-none">{live}</div>}
        {/* What it waits for: the user, or a limit's reset. */}
        {(worker.kind === "needsYou" || worker.kind === "limit") && <p data-slot="worker-waits" className="text-sm text-quiet-foreground">{worker.word}</p>}
      </div>
    </div>
  );
}
