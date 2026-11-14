import { type ReactNode, useLayoutEffect, useMemo, useRef, useState } from "react";

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../components/collapsible";
import { cx } from "../components/cx";
import { Section } from "../components/section";
import { TooltipIconButton } from "../components/icon-button";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/tooltip";
import { ArrowLeft, ChevronRight } from "../icons";
import { WorkerGlyph } from "../icons/worker-glyphs";
import { Body } from "../components/thread/body";
import { SetupRow } from "../components/thread/setup";
import type { Item, Setup, Turn, Work } from "../thread/item";
import { type Line, lineMaker } from "../thread/lines";
import { Markdown } from "../thread/markdown";
import { GroupLine } from "../components/thread/body";
import { px } from "../shell/right-panel";
import { duration, useSecond } from "../thread/words";
import { finished, type Worker } from "./chip";
import { WORKERS_LABEL } from "./list";

/*
 * One worker in the right panel, as the old app's WorkerDetail, WorkerHeader, WorkerThread and WorkerBrief [D3013]:
 * back, its glyph and name, "‹model› · ‹state›"; below, its brief as the thread's first bubble, what routing picked
 * for it [D3018], how long it worked, and its thread, read only. The user talks to it from the parent's composer.
 */

/** Its header: back, its glyph and name, its model and state (a click shows its details) and the panel's own actions; no End here. */
export function WorkerHeader({ worker, details = false, onBack, onToggleDetails, actions, list = WORKERS_LABEL }: {
  worker: Worker;
  /** The list Back goes to. */
  list?: string;
  details?: boolean;
  onBack: () => void;
  /** Absent for one with no details to show (a CLI's own subagent): its state stands as words. */
  onToggleDetails?: () => void;
  actions?: ReactNode;
}) {
  return (
    <header data-slot="worker-header" className="flex h-11.5 min-w-0 shrink-0 items-center gap-2 border-b border-border px-2">
      <TooltipIconButton tooltip={details ? "Back to worker" : `Back to ${list.toLowerCase()}`} onClick={onBack} className="rounded-icon-button">
        <ArrowLeft />
      </TooltipIconButton>
      <WorkerGlyph id={worker.id} className="size-6" />
      <h2 className="min-w-8 truncate text-label font-medium" title={worker.name}>
        {worker.name}
      </h2>
      {/* Its model and state at the end; a click shows its details. Where the header is short the model gives way
          first, then the name, never the state: the model sizes as nothing (contain-inline-size) and takes the room left. */}
      {!onToggleDetails ? (
        <span className="ms-auto shrink-0 whitespace-nowrap text-label text-muted-foreground">{worker.word}</span>
      ) : (
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label={`Worker details: ${worker.model} · ${worker.word}`}
              aria-pressed={details}
              data-slot="worker-header-model"
              onClick={onToggleDetails}
              className="flex grow cursor-pointer rounded-control text-label text-muted-foreground transition-colors hover:text-foreground focus-visible:focus-ring aria-pressed:text-foreground"
            />
          }
        >
          <span className="grow truncate text-end contain-inline-size">{worker.model}</span>
          <span className="whitespace-nowrap">{"\u00a0· "}{worker.word}</span>
        </TooltipTrigger>
        <TooltipContent>
          Worker details · {worker.model} · {worker.word}
        </TooltipContent>
      </Tooltip>
      )}
      {actions}
    </header>
  );
}

/** Its details page, as the old WorkerDetails: why this model, and the instructions it was started with. */
export function WorkerDetails({ worker }: { worker: Worker }) {
  return (
    <div data-slot="worker-details" className="min-h-0 min-w-0 flex-1 overflow-y-auto px-4 py-5 wrap-anywhere">
      <div className="flex flex-col gap-4">
        <h3 className="text-sm font-medium">Details</h3>
        <Section title="Why this model">
          <p className="text-sm">{worker.model}</p>
          {worker.receipt && <p className="text-xs text-muted-foreground">{worker.receipt}</p>}
          {worker.asked && <p className="text-xs text-muted-foreground">{worker.asked}</p>}
        </Section>
        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">Instructions</h3>
          <div className="text-sm leading-relaxed">
            <Markdown text={worker.brief ?? ""} keep={`instructions:${worker.id}`} />
          </div>
        </section>
      </div>
    </div>
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

/** "Working for 1m 2s" while it works, "Worked for 3m 10s" once finished, "Ended after 3m 10s" when ended, over a hairline. */
function WorkHeader({ worker, turns }: { worker: Worker; turns: readonly Turn[] }) {
  const done = finished(worker);
  const now = useSecond(!done);
  // Its turns' time, so the waits between its messages don't count; from its start while it has none.
  const ms = turns.length === 0 ? (done ? (worker.lastAt ?? now) : now) - worker.startedAt : turns.reduce((sum, turn) => sum + Math.max(0, (turn.endedAt ?? now) - turn.startedAt), 0);
  const took = duration(ms);
  return (
    <div data-slot="worker-work-header" className="border-b border-border pb-2 text-sm text-faint-foreground tabular-nums">
      {worker.kind === "stopped" ? `Ended after ${took}` : done ? `Worked for ${took}` : `Working for ${took}`}
    </div>
  );
}

const NO_WORK: ReadonlyMap<string, Work> = new Map();

/** One row of its thread: a group, a reply with no actions, a message it was sent as a bubble, or the thread's own row. */
function Row({ line, onToggle }: { line: Shown; onToggle: (id: string) => void }) {
  if (line.type === "group") return <GroupLine {...line} onToggle={onToggle} />;
  const { item } = line;
  if (item.kind === "message" && item.origin !== "system") {
    // A reply still streaming shows from its first word.
    if (item.streaming && !item.text.trim()) return null;
    return item.role === "user" ? (
      <div data-slot="worker-received" className="max-w-full min-w-0 self-end rounded-thread bg-muted px-3 py-2 text-sm whitespace-pre-wrap">
        {item.text}
      </div>
    ) : (
      <div className="min-w-0 leading-relaxed wrap-anywhere text-foreground">
        <Markdown text={item.text} keep={item.id} streaming={item.streaming} />
      </div>
    );
  }
  return <Body item={item} turn={line.turn} step={false} />;
}

type Shown = Extract<Line, { type: "item" | "group" }>;

/**
 * What it does right now as the thread's last line, when its last row doesn't say it: the turn's latest run (its live
 * step or its own Thinking line), a running or waiting step, thinking, or a reply begun, does.
 */
function thinking(rows: readonly Shown[]): boolean {
  // A reply not yet begun draws nothing: the row above it says what it does.
  const last = rows.findLast((line) => !(line.type === "item" && line.item.kind === "message" && line.item.streaming && !line.item.text.trim()));
  if (last?.type === "group") return !last.item.run;
  const item = last?.item;
  if ((item?.kind === "tool" || item?.kind === "fileChange" || item?.kind === "childAgent") && (item.progress === "running" || item.progress === "pending")) return false;
  if (item?.kind === "reasoning" && item.streaming) return false;
  return !(item?.kind === "message" && item.streaming);
}

/**
 * Its thread, read only, as the old WorkerTranscript: the brief, the receipt, how long it worked, its earlier rows
 * folded once it's over ("4 previous messages"), its last three, the live line while it works, and what it waits for.
 */
export function WorkerThread({ worker, items, turns, setup }: { worker: Worker; items: readonly Item[]; turns: readonly Turn[]; setup?: Setup | null }) {
  const [open, setOpen] = useState(false);
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = (id: string) =>
    setOpened((was) => {
      const next = new Set(was);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const lines = useMemo(lineMaker, []);
  const byId = useMemo(() => new Map(turns.map((turn) => [turn.id, turn])), [turns]);
  // Rust's groups, without the thread's turn headers and answer actions: the panel has one header of its own.
  const rows = useMemo(() => lines(items, byId, NO_WORK, opened).filter((line): line is Shown => line.type === "item" || line.type === "group"), [lines, items, byId, opened]);
  const working = worker.kind === "working";
  // All of it in view while it works (or was ended), its history folded once it's over, so no row moves into the fold while watched.
  const previous = working || worker.kind === "stopped" ? [] : rows.slice(0, Math.max(0, rows.length - 3));
  const count = previous.reduce((sum, line) => sum + (line.type === "group" ? line.item.steps.reduce((n, step) => n + step.n, 0) : 1), 0);

  // A live one follows new output while the view is scrolled to the bottom.
  const scroll = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  useLayoutEffect(() => {
    const element = scroll.current;
    if (element && pinned.current) element.scrollTop = element.scrollHeight;
  }, [rows]);
  return (
    <div
      ref={scroll}
      data-slot="worker-thread"
      className="min-h-0 min-w-0 flex-1 overflow-y-auto px-4 pb-6 text-sm wrap-anywhere"
      onScroll={(event) => {
        const element = event.currentTarget;
        pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < px("--spacing-row");
      }}
    >
      <div className="mx-auto flex max-w-reading min-w-0 flex-col gap-4 pt-5">
        {worker.brief && <WorkerBrief id={worker.id} text={worker.brief} />}
        {worker.receipt && <p data-slot="worker-picked" className="text-sm text-muted-foreground">{worker.receipt}</p>}
        <WorkHeader worker={worker} turns={turns} />
        {/* Its worktree, first in its work as in the thread [D70]. */}
        {setup && <SetupRow keep={`${worker.id}:setup`} setup={setup} />}
        {count > 0 && (
          <Collapsible open={open} onOpenChange={setOpen}>
            <CollapsibleTrigger className="flex min-h-7 w-full cursor-pointer items-center gap-1 border-b border-border text-start text-sm text-faint-foreground hover:text-foreground focus-visible:focus-ring">
              {count} previous {count === 1 ? "message" : "messages"}
              <ChevronRight aria-hidden className={cx("size-3", open ? "-rotate-90" : "rotate-90")} />
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="flex flex-col gap-4 py-4">
                {previous.map((line) => <Row key={line.id} line={line} onToggle={toggle} />)}
              </div>
            </CollapsibleContent>
          </Collapsible>
        )}
        {rows.slice(previous.length).map((line) => <Row key={line.id} line={line} onToggle={toggle} />)}
        {working && thinking(rows) && <div className="shimmer truncate text-sm motion-reduce:animate-none">Thinking</div>}
        {/* What it waits for: the user, or a limit's reset. */}
        {(worker.kind === "needsYou" || worker.kind === "limit") && <p data-slot="worker-waits" className="text-sm text-quiet-foreground">{worker.word}</p>}
      </div>
    </div>
  );
}
