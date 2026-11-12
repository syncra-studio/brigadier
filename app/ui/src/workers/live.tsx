import { type ReactNode, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { TooltipIconButton } from "../components/icon-button";
import { Body } from "../components/thread/body";
import { doingWords } from "../components/thread/tool";
import { ParentName } from "../components/thread/cards";
import { TitlebarTips } from "../components/tooltip";
import { ask, type Row, useDaemon, useThread } from "../daemon";
import { X } from "../icons";
import { WorkerGlyph } from "../icons/worker-glyphs";
import { CardSection } from "../panel/card";
import { Counts, Line } from "../panel/source/rows";
import { cx } from "../components/cx";
import { showToast } from "../components/toast";
import { errorText, run } from "../onboarding/api";
import { setPanelOpen, usePanelMemory } from "../panel/memory";
import { px, ResizeHandle, useHasPanel } from "../shell/right-panel";
import type { Item, Setup, StepKind, Turn } from "../thread/item";
import { finished, lowerFirst, onHand, type Worker, WorkerChip, type WorkerStateKind, WorkersPanel } from "./chip";
import { PanelTabs, WORKERS_LABEL, WorkerList } from "./list";
import { StillRunningRow, TeamSentence, TeamStepRow } from "./sentence";
import { type Act, WorkerControls, WorkersStrip } from "./strip";
import { asSubagent, SUBAGENTS_LABEL, SubagentView, useAgents } from "./subagents";
import { WorkerDetails, WorkerHeader, WorkerThread } from "./view";

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
  /** Its newest call at work, while it works [D143]. */
  now?: { step: StepKind; name: string; input: string } | null;
};

/** The old strip's words for a call: a command with shell bits reads "Running a command" (its D195). */
const nowOf = ({ step, name, input }: { step: StepKind; name: string; input: string }) =>
  step === "run" && /[;&|<>`$(]/.test(input) ? "Running a command" : doingWords(step, name, input);

const asWorker = (row: Row & { worker: WorkerRow }): Worker => ({
  id: row.id,
  name: row.title,
  kind: row.worker.kind,
  word: row.worker.word,
  startedAt: row.worker.started,
  // When it last said anything: its last turn's end, else its row's last change (a paused one).
  lastAt: row.worker.ended ?? row.updated,
  model: row.worker.model,
  brief: row.worker.brief,
  receipt: row.worker.receipt,
  added: row.worker.added ?? undefined,
  removed: row.worker.removed ?? undefined,
  now: row.worker.now ? nowOf(row.worker.now) : undefined,
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

/** Whether each session's Workers panel is open, which worker or subagent it shows (null: the list), and which list. */
type Shown = { open: boolean; worker: string | null; tab?: string };
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

/** Opens a worker of `owner` in its Workers panel: its chip in a message, or a message just sent to it. */
export const openWorker = (owner: string, worker: string) => show(owner, { open: true, worker });

/** A worker named anywhere opens it in its parent's Workers panel; null opens the list, `tab`'s. */
export function Opens({ owner, tab, children }: { owner: string; tab?: string; children: ReactNode }) {
  const open = (worker: string | null) => show(owner, { open: true, worker, tab });
  return <WorkersPanel.Provider value={{ open }}>{children}</WorkersPanel.Provider>;
}

/** A worker the user @-mentioned, in their sent message: its chip, as the old app's Mentions' TaskByNumber. */
export function SentWorker({ owner, id }: { owner: string; id: string }) {
  const row = (useDaemon().rows ?? []).find((each) => each.id === id);
  return <Opens owner={owner}><WorkerChip worker={row?.worker ? asWorker(row as Row & { worker: WorkerRow }) : null} /></Opens>;
}

/** The parent's thread rows Rust builds from its notes and results [D3009, D3010]. */
export type TeamItem = Extract<Item, { kind: "team" | "team_step" | "team_still" }>;

export function TeamRow({ item }: { item: TeamItem }) {
  const owner = useThread()?.id ?? "";
  const workers = useNamed(item.workers);
  const row =
    item.kind === "team" ? (
      <TeamSentence keep={item.id} word={item.word} workers={workers} merge={item.merge} />
    ) : item.kind === "team_step" ? (
      <TeamStepRow
        keep={item.id}
        step={
          item.type === "stopped"
            ? { type: "stopped", byUser: item.byUser, workers }
            : item.type === "messaged"
              ? { type: "messaged", byUser: item.byUser, worker: workers[0]!, text: item.text }
              : { type: item.type, workers }
        }
      />
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

/** "1 done · 1 paused · 1 stopped": the Workers tab's tip after its name, as the old app's outcomeWords. */
function finishedWords(workers: readonly Worker[]): string {
  const counts = { done: 0, paused: 0, stopped: 0, failed: 0 };
  for (const { kind } of workers) {
    if (kind === "done" || kind === "merged" || kind === "doneNotMerged") counts.done += 1;
    else if (kind === "paused" || kind === "stopped" || kind === "failed") counts[kind] += 1;
  }
  return Object.entries(counts).filter(([, count]) => count > 0).map(([word, count]) => `${count} ${word}`).join(" · ");
}

/** A right column's chosen width, not its rendered one; one never resized counts at its default. */
const chosen = (dragged: number | null) => dragged ?? px("--spacing-sidebar");

/** Whether the Workers column folds, as the old app's rightSidebarFolds: below the narrow window plus the open left column. */
const folds = () => {
  const left = document.querySelector('[data-slot="sidebar-panel"]');
  return innerWidth < px("--spacing-narrow-window") + (left?.getAttribute("data-state") === "expanded" ? left.getBoundingClientRect().width : 0);
};
function subscribeFold(onChange: () => void) {
  const left = document.querySelector('[data-slot="sidebar-panel"]');
  const observer = new ResizeObserver(onChange);
  if (left) observer.observe(left);
  addEventListener("resize", onChange);
  return () => {
    observer.disconnect();
    removeEventListener("resize", onChange);
  };
}

/**
 * The Workers panel, as the old app's RightSidebar [D3012, D3013]: its own column between the chat and Files, opened
 * from a worker named anywhere, its tab and close in a row at its top, or a worker's header in their place. It slides
 * as Files does; where the window can't hold the chat beside both, the one opened last stays and the other closes.
 */
export function WorkersPanelSlot({ owner, onShown }: { owner: string; onShown: (width: number) => void }) {
  const workers = useWorkers(owner);
  const agents = useAgents(owner);
  const shown = useShown(owner);
  // Folded, it shows only once opened there, and each fold change closes it; the wide choice stays, as the old useSidebarChoice's.
  const fold = useSyncExternalStore(subscribeFold, folds);
  const [hidden, setHidden] = useState(fold);
  const [wide, setWide] = useState(fold ? shown.open : null);
  const [seen, setSeen] = useState({ fold, shown });
  if (seen.fold !== fold || seen.shown !== shown) {
    setSeen({ fold, shown });
    setHidden(seen.fold !== fold && fold);
    if (seen.fold !== fold && fold) setWide(shown.open);
  }
  // Unfolded, the choice made while wide comes back.
  useLayoutEffect(() => {
    if (fold || wide === null) return;
    setWide(null);
    if (shown.open !== wide) show(owner, { open: wide, worker: shown.worker });
  }, [fold, wide, shown, owner]);
  const open = shown.open && !hidden;
  const { worker } = shown;
  const files = usePanelMemory();
  const filesOpen = useHasPanel(owner) && files.open;
  const [resizing, setResizing] = useState(false);
  const content = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(open);
  if (open && !mounted) setMounted(true);
  const close = () => (fold ? setHidden(true) : show(owner, { open: false, worker }));

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
    if (opened.files) close();
    else if (opened.workers) setPanelOpen(false);
  }, [filesOpen, open, files.width, owner, worker, fold]);

  const opened = workers.find((each) => each.id === worker);
  const agent = opened ? undefined : agents.find((each) => each.id === worker);
  // Workers, and the CLI's own subagents once it has any, each a list of its own.
  const tabs = [...(workers.length > 0 || agents.length === 0 ? [WORKERS_LABEL] : []), ...(agents.length > 0 ? [SUBAGENTS_LABEL] : [])];
  const tab = shown.tab && tabs.includes(shown.tab) ? shown.tab : tabs[0]!;
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
            {!opened && !agent && <PanelTabs active={tab} tabs={tabs} finishedWords={finishedWords(workers)} onSelect={(next) => show(owner, { ...shown, tab: next })} onClose={close} />}
            <div
              id="workers-panel-content"
              className={cx("flex min-h-0 flex-1 flex-col overflow-clip bg-background transition-opacity duration-150 motion-reduce:transition-none", open ? "opacity-100" : "opacity-0")}
            >
              {mounted &&
                (opened ? (
                  <WorkerView key={opened.id} worker={opened} owner={owner} onBack={() => show(owner, { open: true, worker: null })} onClose={close} />
                ) : agent ? (
                  <SubagentView key={agent.id} item={agent} onBack={() => show(owner, { open: true, worker: null, tab: SUBAGENTS_LABEL })} onClose={close} />
                ) : tab === SUBAGENTS_LABEL ? (
                  <WorkerList workers={agents.map(asSubagent).toReversed()} label={SUBAGENTS_LABEL} />
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

/** A worker opened: its header, and its thread or its details, Rust's snapshot of it, asked again as its row changes [D3013]. */
function WorkerView({ worker, owner, onBack, onClose }: { worker: Worker; owner: string; onBack: () => void; onClose: () => void }) {
  const rows = useDaemon().rows;
  const updated = rows?.find((row) => row.id === worker.id)?.updated;
  // Its asks name the session that answers them [D131].
  const parent = rows?.find((row) => row.id === owner)?.title || "Its parent";
  const [{ items, turns, setup }, setSnapshot] = useState<{ items: Item[]; turns: Turn[]; setup?: Setup | null }>({ items: [], turns: [] });
  const [details, setDetails] = useState(false);
  useEffect(() => {
    let live = true;
    ask({ op: "peek", session: worker.id }, (reply) => live && reply.ok && setSnapshot({ items: reply.session.items, turns: reply.session.turns ?? [], setup: reply.session.setup }));
    return () => {
      live = false;
    };
  }, [worker.id, updated]);
  // Its first message is the brief, which the view shows above.
  const brief = items.find((item) => item.kind === "message" && item.role === "user");
  const rest = useMemo(() => items.filter((item) => item !== brief), [items, brief]);
  return (
    <section aria-label={`Worker: ${worker.name}`} className="flex min-h-0 min-w-0 flex-1 flex-col">
      <WorkerHeader
        worker={worker}
        details={details}
        onBack={() => (details ? setDetails(false) : onBack())}
        onToggleDetails={() => setDetails(!details)}
        actions={
          <TitlebarTips>
            <TooltipIconButton look="toolbar" tooltip="Close right panel" onClick={onClose}>
              <X />
            </TooltipIconButton>
          </TitlebarTips>
        }
      />
      <ParentName value={parent}>{details ? <WorkerDetails worker={worker} /> : <WorkerThread worker={worker} items={rest} turns={turns} setup={setup} />}</ParentName>
    </section>
  );
}

/** How many workers at work still get a line each; more read as one row. */
const WORKER_LINES = 3;

const DONE: ReadonlySet<WorkerStateKind> = new Set(["done", "merged", "doneNotMerged"]);

/** "1 done · 2 ended": the finished ones, as the old card's finishedWords. */
function doneWords(workers: readonly Worker[]): string {
  const gone = workers.filter((worker) => !onHand(worker));
  const done = gone.filter((worker) => DONE.has(worker.kind)).length;
  return [done > 0 && `${done} done`, gone.length > done && `${gone.length - done} ended`].filter(Boolean).join(" · ");
}

/**
 * A worker at work, as the old card's WorkerLineRow: its glyph, its name, its state in a soft word ("working",
 * shimmering; "paused") and its +N −N, under its pause/resume and End on hover [D3045]. The row opens its panel.
 */
function WorkerLine({ worker, act }: { worker: Worker; act?: Act }) {
  const { open } = useContext(WorkersPanel);
  const here = onHand(worker);
  const controls = here && act;
  // A finished one reads only done or ended here; a paused one, paused.
  const word = here ? lowerFirst(worker.kind === "working" ? (worker.now ?? worker.word) : worker.word) : DONE.has(worker.kind) ? "done" : "ended";
  const changed = (worker.added ?? 0) + (worker.removed ?? 0) > 0;
  return (
    <div data-slot="workers-summary-worker" data-worker-state={worker.kind} className="group/row relative min-w-0">
      <Line
        onClick={() => open(worker.id)}
        // The pointer on its controls is still on the row: the wash stays.
        className={cx(controls && "group-hover/row:before:bg-muted group-has-focus-visible/row:before:bg-muted")}
        icon={<WorkerGlyph id={worker.id} className="size-4" />}
        end={changed && <span className={cx("text-2xs", controls && "group-hover/row:invisible group-has-focus-visible/row:invisible")}><Counts added={worker.added ?? 0} removed={worker.removed ?? 0} /></span>}
      >
        {worker.name}
        <span className={cx("text-muted-foreground", worker.kind === "working" && "shimmer")}> {word}</span>
      </Line>
      {controls && (
        <span
          data-slot="summary-row-action"
          className="row-backing row-backing-washed pointer-events-none absolute inset-y-0 end-0 flex items-center ps-4 opacity-0 transition-opacity group-hover/row:pointer-events-auto group-hover/row:opacity-100 group-has-focus-visible/row:pointer-events-auto group-has-focus-visible/row:opacity-100"
        >
          <WorkerControls worker={worker} act={act} />
        </span>
      )}
    </div>
  );
}

/**
 * The session's workers in the summary card, as the old card's WorkersSummary [D3045]: while a few work, a line each
 * (then what finished, muted); else one row of glyphs with "N working" or "1 done · 2 ended". A row opens the
 * Workers panel, or the worker's own.
 */
export function WorkersCard({ owner }: { owner: string }) {
  return <TeamCard owner={owner} title={WORKERS_LABEL} workers={useWorkers(owner)} act={act(owner)} />;
}

/** The card's section for a session's workers or its CLI's own subagents, oldest first; with no `act`, no controls. */
export function TeamCard({ owner, title, workers: all, act, tab }: { owner: string; title: string; workers: readonly Worker[]; act?: Act; tab?: string }) {
  const workers = all.toReversed();
  if (workers.length === 0) return null;
  const active = workers.filter(onHand);
  const ended = doneWords(workers);
  // A few at work get a line each; so does a lone worker that finished.
  const lined = active.length > 0 && active.length <= WORKER_LINES ? active : workers.length === 1 ? workers : [];
  return (
    <Opens owner={owner} tab={tab}>
      <CardSection title={title}>
        <WorkersRows workers={workers} active={active} lined={lined} ended={ended} act={act} />
      </CardSection>
    </Opens>
  );
}

function WorkersRows({ workers, active, lined, ended, act }: { workers: Worker[]; active: Worker[]; lined: Worker[]; ended: string; act?: Act }) {
  const { open } = useContext(WorkersPanel);
  if (lined.length > 0) {
    const first = workers.find((worker) => !onHand(worker));
    return (
      <>
        {lined.map((worker) => <WorkerLine key={worker.id} worker={worker} act={act} />)}
        {ended && lined === active && first && (
          <Line onClick={() => open(null)} icon={<WorkerGlyph id={first.id} className="size-4" />}>
            <span className="text-muted-foreground">{ended}</span>
          </Line>
        )}
      </>
    );
  }
  const glyphs = (active.length > 0 ? active : workers).slice(0, 4);
  return (
    <Line
      onClick={() => open(null)}
      icon={<span className="flex items-center gap-1.5">{glyphs.map((worker) => <WorkerGlyph key={worker.id} id={worker.id} className="size-4" />)}</span>}
      end={active.length > 0 && ended ? ended : undefined}
    >
      {active.length > 0 ? `${active.length} working` : ended}
    </Line>
  );
}
