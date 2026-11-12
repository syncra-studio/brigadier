import { type ReactNode, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";

import { TooltipIconButton } from "../components/icon-button";
import { Body } from "../components/thread/body";
import { TitlebarTips } from "../components/tooltip";
import { ask, type Row, useDaemon, useThread } from "../daemon";
import { X } from "../icons";
import { cx } from "../components/cx";
import { showToast } from "../components/toast";
import { errorText, run } from "../onboarding/api";
import { setPanelOpen, usePanelMemory } from "../panel/memory";
import { px, ResizeHandle, useHasPanel } from "../shell/right-panel";
import type { Item, Turn } from "../thread/item";
import { finished, type Worker, type WorkerStateKind, WorkersPanel } from "./chip";
import { PanelTabs, WORKERS_LABEL, WorkerList } from "./list";
import { StillRunningRow, TeamSentence, TeamStepRow } from "./sentence";
import { WorkersStrip } from "./strip";
import { WorkerHeader, WorkerThread } from "./view";

/*
 * 4.2's drawn parts on Rust's rows [D3010, D3012, D3013, D3018]: a worker's row carries `worker`, which Rust folds
 * (its state word, times, receipt); this only maps it and wires Stop to Rust's `workers <id> stop`.
 */

/** A worker's row facts, as Rust's `workers::row` writes them. */
export type WorkerRow = {
  parent: string;
  root: string;
  depth: number;
  brief: string;
  started: number;
  kind: WorkerStateKind;
  word: string;
  ended?: number | null;
  model: string;
  receipt: string;
  added?: number | null;
  removed?: number | null;
};

const asWorker = (row: Row & { worker: WorkerRow }): Worker => ({
  id: row.id,
  name: row.title,
  kind: row.worker.kind,
  word: row.worker.word,
  startedAt: row.worker.started,
  lastAt: row.worker.ended ?? undefined,
  model: row.worker.model,
  brief: row.worker.brief,
  receipt: row.worker.receipt,
  added: row.worker.added ?? undefined,
  removed: row.worker.removed ?? undefined,
});

/** A session's own workers, oldest first; a worker of theirs is in its own parent's [G]. */
export function useWorkers(parent: string): Worker[] {
  const rows = useDaemon().rows ?? [];
  return rows.filter((row): row is Row & { worker: WorkerRow } => row.worker?.parent === parent).map(asWorker).toSorted((a, b) => a.startedAt - b.startedAt);
}

/** Workers named by id, a gone one as "a worker". */
function useNamed(ids: readonly string[]): Worker[] {
  const rows = useDaemon().rows ?? [];
  return ids.map((id) => {
    const row = rows.find((each) => each.id === id);
    return row?.worker ? asWorker(row as Row & { worker: WorkerRow }) : { id, name: "a worker", kind: "done", word: "Done", startedAt: 0 };
  });
}

/** The user's End, Pause and Resume: Rust does each and logs "You ended …", "Paused …" or "Resumed …" in the parent [D3011, D3041]. */
const act = (parent: string) => (how: "stop" | "pause" | "resume", ids: readonly string[]) => run(["workers", parent, how, ...ids]);

/** The user's Stop them: as End, its failure a toast. */
const stop = (parent: string, ids: readonly string[]) =>
  act(parent)("stop", ids).then(() => true).catch((cause) => {
    showToast(`Couldn't stop ${ids.length === 1 ? "the worker" : "the workers"}: ${errorText(cause)}`, { tone: "error" });
    return false;
  });

/** Whether each session's Workers panel is open and which worker it shows (null: the list), as the old app's. */
type Shown = { open: boolean; worker: string | null };
let shown: Record<string, Shown> = {};
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => (listeners.add(listener), () => listeners.delete(listener));
function show(owner: string, next: Shown) {
  shown = { ...shown, [owner]: next };
  for (const listener of listeners) listener();
}
const CLOSED: Shown = { open: false, worker: null };
const useShown = (owner: string) => useSyncExternalStore(subscribe, () => shown[owner]) ?? CLOSED;
// shortcut: the panel's dragged width lasts until the app quits; keep it in Rust's panel memory if the owner wants it kept.
let width: number | null = null;

/** A worker named anywhere opens it in its parent's Workers panel; null opens the list. */
function Opens({ owner, children }: { owner: string; children: ReactNode }) {
  const open = (worker: string | null) => show(owner, { open: true, worker });
  return <WorkersPanel.Provider value={{ open }}>{children}</WorkersPanel.Provider>;
}

/** The parent's thread rows Rust builds from its notes and results [D3009, D3010]. */
export type TeamItem = Extract<Item, { kind: "team" | "team_step" | "team_still" }>;

export function TeamRow({ item }: { item: TeamItem }) {
  const owner = useThread()?.id ?? "";
  const workers = useNamed(item.workers);
  const row =
    item.kind === "team" ? (
      <TeamSentence keep={item.id} word={item.word} workers={workers} />
    ) : item.kind === "team_step" ? (
      <TeamStepRow keep={item.id} step={item.type === "stopped" ? { type: "stopped", byUser: item.byUser, workers } : { type: item.type, workers }} />
    ) : (
      <StillRows owner={owner} workers={workers} />
    );
  return <Opens owner={owner}>{row}</Opens>;
}

/** "2 workers still running · Stop them", while any of them still runs. */
function StillRows({ owner, workers }: { owner: string; workers: Worker[] }) {
  const [pending, setPending] = useState<readonly string[]>([]);
  const live = workers.filter((worker) => !finished(worker));
  const stopping = live.some((worker) => pending.includes(worker.id));
  if (pending.length > 0 && !stopping) setPending([]);
  if (live.length === 0) return null;
  return (
    <StillRunningRow
      workers={live}
      stopping={stopping}
      onStop={() => {
        if (stopping) return;
        const ids = live.map((worker) => worker.id);
        setPending(ids);
        void stop(owner, ids).then((ok) => { if (!ok) setPending([]); });
      }}
    />
  );
}

/** The strip over the composer: the session's workers still at work or waiting [D3010]. */
export function SessionWorkersStrip({ id }: { id: string }) {
  const workers = useWorkers(id);
  return (
    <Opens owner={id}>
      <WorkersStrip workers={workers} act={act(id)} />
    </Opens>
  );
}

/** "1 done · 1 stopped": the Workers tab's tip after its name, as the old app's outcomeWords. */
function finishedWords(workers: readonly Worker[]): string {
  const counts = { done: 0, stopped: 0, failed: 0 };
  for (const { kind } of workers) {
    if (kind === "done" || kind === "merged" || kind === "doneNotMerged") counts.done += 1;
    else if (kind === "stopped" || kind === "failed") counts[kind] += 1;
  }
  return Object.entries(counts).filter(([, count]) => count > 0).map(([word, count]) => `${count} ${word}`).join(" · ");
}

/** A right column's chosen width, not its rendered one; one never resized counts at its default. */
const chosen = (dragged: number | null) => dragged ?? px("--spacing-sidebar");

/**
 * The Workers panel, as the old app's RightSidebar [D3012, D3013]: its own column between the chat and Files, opened
 * from a worker named anywhere, its tab and close in a row at its top, or a worker's header in their place. It slides
 * as Files does; where the window can't hold the chat beside both, the one opened last stays and the other closes.
 */
export function WorkersPanelSlot({ owner, onShown }: { owner: string; onShown: (width: number) => void }) {
  const workers = useWorkers(owner);
  const { open, worker } = useShown(owner);
  const files = usePanelMemory();
  const filesOpen = useHasPanel(owner) && files.open;
  const [resizing, setResizing] = useState(false);
  const content = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(open);
  if (open && !mounted) setMounted(true);
  const close = () => show(owner, { open: false, worker });

  // Files leaves room for this column's full width while it's open, as this one leaves Files its least width.
  useLayoutEffect(() => {
    const element = content.current;
    if (!open || !element) return;
    const measure = () => onShown(Math.round(element.getBoundingClientRect().width));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      observer.disconnect();
      onShown(0);
    };
  }, [open, onShown]);

  const was = useRef({ files: filesOpen, workers: open });
  useLayoutEffect(() => {
    const opened = { files: filesOpen && !was.current.files, workers: open && !was.current.workers };
    was.current = { files: filesOpen, workers: open };
    const left = document.querySelector('[data-slot="sidebar-panel"]')?.getBoundingClientRect().width ?? 0;
    if (!filesOpen || !open || innerWidth >= left + px("--spacing-sidebar-thread-min") + chosen(width) + chosen(files.width)) return;
    if (opened.files) show(owner, { open: false, worker });
    else if (opened.workers) setPanelOpen(false);
  }, [filesOpen, open, files.width, owner, worker]);

  const opened = workers.find((each) => each.id === worker);
  return (
    <div
      data-slot="workers-panel"
      data-state={open ? "expanded" : "collapsed"}
      data-width={width ?? undefined}
      data-beside={filesOpen ? px("--spacing-sidebar-min") : undefined}
      className={cx("right-panel-width-source start-hairline relative flex h-full shrink-0 before:transition-opacity before:duration-300 before:ease-sidebar motion-reduce:before:transition-none", !open && "before:opacity-0")}
    >
      <div inert={!open} data-resizing={resizing || undefined} className={cx("sidebar-motion h-full overflow-clip", open ? "right-panel-width" : "w-0")}>
        <div ref={content} className="right-panel-width flex h-full flex-col">
          <Opens owner={owner}>
            {!opened && <PanelTabs active={WORKERS_LABEL} tabs={[WORKERS_LABEL]} finishedWords={finishedWords(workers)} onSelect={() => {}} onClose={close} />}
            <div
              id="workers-panel-content"
              className={cx("flex min-h-0 flex-1 flex-col overflow-clip bg-background transition-opacity duration-150 motion-reduce:transition-none", open ? "opacity-100" : "opacity-0")}
            >
              {mounted &&
                (opened ? (
                  <WorkerView key={opened.id} worker={opened} onBack={() => show(owner, { open: true, worker: null })} onClose={close} />
                ) : (
                  <WorkerList workers={workers.toReversed()} act={act(owner)} />
                ))}
            </div>
          </Opens>
        </div>
      </div>
      {open && (
        <ResizeHandle
          label="Resize Workers"
          resizing={resizing}
          setResizing={setResizing}
          onWidth={(next) => (width = next)}
          onClose={close}
        />
      )}
    </div>
  );
}

/** A worker opened: its header, brief and thread, Rust's snapshot of it, asked again as its row changes [D3013]. */
function WorkerView({ worker, onBack, onClose }: { worker: Worker; onBack: () => void; onClose: () => void }) {
  const updated = useDaemon().rows?.find((row) => row.id === worker.id)?.updated;
  const [{ items, turns }, setSnapshot] = useState<{ items: Item[]; turns: Turn[] }>({ items: [], turns: [] });
  useEffect(() => {
    let live = true;
    ask({ op: "peek", session: worker.id }, (reply) => live && reply.ok && setSnapshot({ items: reply.session.items, turns: reply.session.turns ?? [] }));
    return () => {
      live = false;
    };
  }, [worker.id, updated]);
  // Its first message is the brief, which the view shows above.
  const brief = items.find((item) => item.kind === "message" && item.role === "user");
  return (
    <>
      <WorkerHeader
        worker={worker}
        onBack={onBack}
        actions={
          <TitlebarTips>
            <TooltipIconButton look="toolbar" tooltip="Close right panel" onClick={onClose}>
              <X />
            </TooltipIconButton>
          </TitlebarTips>
        }
      />
      <WorkerThread worker={worker}>
        {items
          .filter((item) => item !== brief)
          .map((item) => (
            <Body key={item.id} item={item} turn={turns.find((turn) => turn.id === item.turnId)} step={item.kind === "tool"} />
          ))}
      </WorkerThread>
    </>
  );
}
