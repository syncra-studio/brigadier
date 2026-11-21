import { type ReactNode, useContext, useEffect, useMemo, useState } from "react";

import { type PendingQuestion, QuestionCard } from "../components/composer/question";
import { doingWords, VERBS } from "../components/thread/tool";
import { ParentName } from "../components/thread/cards";
import { ask, type Row, useDaemon, useThread } from "../daemon";
import { WorkerGlyph } from "../icons/worker-glyphs";
import { CardSection } from "../panel/card";
import { Counts, Line } from "../panel/source/rows";
import { cx } from "../components/cx";
import { showToast } from "../components/toast";
import { errorText, run } from "../onboarding/api";
import { openTab } from "../shell/tab-store";
import type { Item, Setup, StepKind, Turn } from "../thread/item";
import { finished, lowerFirst, onHand, type Worker, WorkerChip, type WorkerStateKind, WorkersPanel } from "./chip";
import { WORKERS_LABEL, WorkerList } from "./list";
import { BatchRow, StillRunningRow, TeamStepRow } from "./sentence";
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
  asked?: string | null;
  why?: string | null;
  added?: number | null;
  removed?: number | null;
  repos?: string[];
  /** Its newest call at work, while it works [D143]. */
  now?: { step: StepKind; name: string; input: string; description?: string | null } | null;
};

/**
 * The old strip's words for a call: a command reads by what the agent said it does, as its thread row [D214]; one
 * with no description and shell bits, "Running a command" (its D195).
 */
const nowOf = ({ step, name, input, description }: NonNullable<WorkerRow["now"]>) =>
  step === "run" && description
    ? `${VERBS.run[0]}: ${description}`
    : step === "run" && /[;&|<>`$(]/.test(input)
      ? "Running a command"
      : doingWords(step, name, input);

const asWorker = (row: Row & { worker: WorkerRow }): Worker => ({
  id: row.id,
  name: row.title,
  kind: row.worker.kind,
  word: row.worker.word,
  startedAt: row.worker.started,
  // When it last said anything: its last turn's end, else its row's last change (a paused one).
  lastAt: row.worker.ended ?? row.updated,
  heardAt: row.updated,
  model: row.worker.model,
  brief: row.worker.brief,
  receipt: row.worker.receipt,
  asked: row.worker.asked ?? undefined,
  why: row.worker.why ?? undefined,
  added: row.worker.added ?? undefined,
  removed: row.worker.removed ?? undefined,
  repos: row.worker.repos,
  now: row.worker.now ? nowOf(row.worker.now) : undefined,
});

/** A session's own workers, oldest first; a worker of theirs is in its own parent's [G]. */
export function useWorkers(parent: string): Worker[] {
  const rows = useDaemon().rows ?? [];
  // A Brigade's sessions are rows of their own in the sidebar, not its workers [D189].
  return rows.filter((row): row is Row & { worker: WorkerRow } => row.worker?.parent === parent && !row.boss).map(asWorker).toSorted((a, b) => a.startedAt - b.startedAt);
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

/** The Workers tab, the session's own workers, or the Subagents tab, its agent CLI's own [D80]. */
export type TeamKind = "workers" | "subagents";

/** Opens a worker of `owner` in its Workers tab: its chip in a message, or a message just sent to it [D81]. */
export const openWorker = (owner: string, worker: string) => openTab(owner, "workers", worker);

/** A worker named anywhere opens it in its parent's Workers tab, `tab`'s; null opens the list [D81]. */
export function Opens({ owner, tab = "workers", children }: { owner: string; tab?: TeamKind; children: ReactNode }) {
  const rows = useDaemon().rows;
  // A Brigade's session opens as the session it is [D189].
  const session = (id: string | null) => rows?.some((row) => row.id === id && row.boss);
  const open = (worker: string | null) => (session(worker) ? (window.location.hash = `#thread/${encodeURIComponent(worker!)}`) : openTab(owner, tab, worker ?? undefined));
  return <WorkersPanel.Provider value={{ open }}>{children}</WorkersPanel.Provider>;
}

/**
 * A worker @-mentioned, in the composer, a sent message or an answer: its pill, as the old app's Mentions'
 * TaskByNumber; a Brigade's session opens as the session it is [D189].
 */
export function MentionedWorker({ id, onOpen }: { id: string; onOpen?: (kind: "chat" | "worker", id: string) => void }) {
  const row = (useDaemon().rows ?? []).find((each) => each.id === id);
  return (
    <WorkersPanel.Provider value={{ open: () => onOpen?.(row?.boss ? "chat" : "worker", id) }}>
      <WorkerChip worker={row?.worker ? asWorker(row as Row & { worker: WorkerRow }) : null} />
    </WorkersPanel.Provider>
  );
}

/** The parent's thread rows Rust builds from its notes and results [D3009, D3010]. */
export type TeamItem = Extract<Item, { kind: "team" | "team_step" | "team_still" }>;

export function TeamRow({ item }: { item: TeamItem }) {
  const owner = useThread()?.id ?? "";
  const workers = useNamed(item.workers);
  const row =
    item.kind === "team" ? (
      // Only a batch's start draws: how each ended shows in it opened, or in the Workers tab [D103, D175].
      <BatchRow keep={item.id} workers={workers} />
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

/**
 * The Workers or Subagents tab [D80–D83]: their list, newest first, or the one its target
 * names, view only; ← goes back to the list in the same tab. Closing it stops nothing.
 */
export function TeamTab({ owner, kind, target }: { owner: string; kind: TeamKind; target?: string }) {
  const workers = useWorkers(owner);
  const agents = useAgents(owner);
  const worker = kind === "workers" ? workers.find((each) => each.id === target) : undefined;
  const agent = kind === "subagents" ? agents.find((each) => each.id === target) : undefined;
  const back = () => openTab(owner, kind);
  return (
    <Opens owner={owner} tab={kind}>
      {worker ? (
        <WorkerView key={worker.id} worker={worker} owner={owner} onBack={back} />
      ) : agent ? (
        <SubagentView key={agent.id} item={agent} onBack={back} />
      ) : (
        <WorkerList workers={(kind === "workers" ? workers : agents.map(asSubagent)).toReversed()} label={kind === "workers" ? WORKERS_LABEL : SUBAGENTS_LABEL} />
      )}
    </Opens>
  );
}

/** A worker opened: its header, and its thread or its details, Rust's snapshot of it, asked again as its row changes [D3013]. */
function WorkerView({ worker, owner, onBack }: { worker: Worker; owner: string; onBack: () => void }) {
  const rows = useDaemon().rows;
  const updated = rows?.find((row) => row.id === worker.id)?.updated;
  // Its asks name the session that answers them [D131].
  const parent = rows?.find((row) => row.id === owner)?.title || "Its parent";
  const [{ items, turns, setup, questions }, setSnapshot] = useState<{ items: Item[]; turns: Turn[]; setup?: Setup | null; questions?: PendingQuestion[] }>({ items: [], turns: [] });
  const [details, setDetails] = useState(false);
  useEffect(() => {
    let live = true;
    ask({ op: "peek", session: worker.id }, (reply) => live && reply.ok && setSnapshot({ items: reply.session.items, turns: reply.session.turns ?? [], setup: reply.session.setup, questions: reply.session.questions }));
    return () => {
      live = false;
    };
  }, [worker.id, updated]);
  // Its first message is the brief, which the view shows above.
  const brief = items.find((item) => item.kind === "message" && item.role === "user");
  const rest = useMemo(() => items.filter((item) => item !== brief), [items, brief]);
  const hold = questions?.find((question) => question.held);
  return (
    <section aria-label={`Worker: ${worker.name}`} className="flex min-h-0 min-w-0 flex-1 flex-col">
      <WorkerHeader
        worker={worker}
        details={details}
        onBack={() => (details ? setDetails(false) : onBack())}
        onToggleDetails={() => setDetails(!details)}
      />
      <ParentName value={parent}>{details ? <WorkerDetails worker={worker} /> : <WorkerThread worker={worker} items={rest} turns={turns} setup={setup} />}</ParentName>
      {/* Its hold is the user's call, answered here where "Needs you" leads [D2028, D342]; its other asks are its parent's [D119, D131]. */}
      {!details && hold && (
        <div className="mx-2 mb-2 shrink-0 rounded-overlay border border-border bg-rail-glass">
          <QuestionCard key={hold.id} session={worker.id} question={hold} onDismiss={() => {}} onAnswer={(answers) => run(["answer", worker.id, hold.id, "--answers", JSON.stringify(answers)]).then(() => {})} />
        </div>
      )}
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
 * shimmering; "paused") and its +N −N, under its pause/resume and End on hover [D3045]. The row opens it in the Workers tab.
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
        className={cx(controls && "group-hover/row:before:bg-fill group-has-focus-visible/row:before:bg-fill")}
        icon={<WorkerGlyph id={worker.id} className="size-4" />}
        end={
          (changed || Boolean(worker.repos?.length)) && (
            <span className={cx("flex items-center gap-1.5", controls && "group-hover/row:invisible group-has-focus-visible/row:invisible")}>
              {/* A folder chat's worker: the repos it claimed, kept whole as the name truncates [D494]. */}
              {worker.repos?.join(", ")}
              {changed && <span className="text-2xs"><Counts added={worker.added ?? 0} removed={worker.removed ?? 0} /></span>}
            </span>
          )
        }
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
 * Workers tab on the list, or on the worker [D81].
 */
export function WorkersCard({ owner }: { owner: string }) {
  return <TeamCard owner={owner} title={WORKERS_LABEL} workers={useWorkers(owner)} act={act(owner)} />;
}

/** The card's section for a session's workers or its CLI's own subagents, oldest first; with no `act`, no controls. */
export function TeamCard({ owner, title, workers: all, act, tab }: { owner: string; title: string; workers: readonly Worker[]; act?: Act; tab?: TeamKind }) {
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
