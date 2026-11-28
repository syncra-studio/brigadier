import { type ReactNode, useContext, useEffect, useMemo, useState, useSyncExternalStore } from "react";

import { doingWords, VERBS } from "../components/thread/tool";
import { ParentName } from "../components/thread/cards";
import { ask, type Row, useDaemon, useThread, view } from "../daemon";
import { WorkerGlyph } from "../icons/worker-glyphs";
import { CardSection } from "../panel/card";
import { Line } from "../panel/source/rows";
import { showToast } from "../components/toast";
import { errorText, run } from "../onboarding/api";
import { openTab } from "../shell/tab-store";
import type { Item, Session, StepKind, Turn } from "../thread/item";
import type { Source } from "../thread/thread";
import { SessionOfThread } from "../accounts/limit";
import { ArrivingBubbles, useArriving } from "../peers/live";
import { type ComposerRow, SessionComposer } from "../session/composer";
import { SentBubbles, useSending } from "../session/sent";
import { withAnswers } from "../session/decisions";
import { finished, onHand, type Worker, WorkerChip, type WorkerStateKind, WorkersPanel } from "./chip";
import { WORKERS_LABEL, WorkerList } from "./list";
import { BatchRow, StillRunningRow, TeamStepRow } from "./sentence";
import { WorkersStrip } from "./strip";
import { asSubagent, SUBAGENTS_LABEL, SubagentView, useAgents } from "./subagents";
import { WorkerDetails, WorkerHeader, WorkerThread } from "./view";

/*
 * 4.2's drawn parts on Rust's rows [D3010, D3012, D3013, D3018]: a worker's row carries `worker`, which Rust folds
 * (its state word, times, receipt); this only maps it and wires Stop to Rust's `workers <id> stop`.
 */

export type { WorkerRow } from "../../../shared/rows";
import type { WorkerRow } from "../../../shared/rows";
import { UNKNOWN_WORKER } from "../../../shared/workers";
import { PARENT } from "../../../shared/cards";

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
  review: row.worker.review ?? undefined,
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
  return rows.filter((row): row is Row & { worker: WorkerRow } => row.worker?.parent === parent).map(asWorker).toSorted((a, b) => a.startedAt - b.startedAt);
}

/** The workers under a session, theirs too, oldest first, each with its row. */
export function useFamily(id: string): { worker: Worker; row: Row }[] {
  const rows = useDaemon().rows ?? [];
  const workers = rows.filter((row): row is Row & { worker: WorkerRow } => Boolean(row.worker));
  const under = new Set([id]);
  // A Set's own loop reaches the ones added as it goes: each worker's own workers in turn.
  for (const parent of under) for (const row of workers) if (row.worker.parent === parent) under.add(row.id);
  under.delete(id);
  return workers.filter((row) => under.has(row.id)).map((row) => ({ worker: asWorker(row), row })).toSorted((a, b) => a.worker.startedAt - b.worker.startedAt);
}

/** Workers named by id, a gone one as "a worker" that ended: how it went is gone with it. */
function useNamed(ids: readonly string[]): Worker[] {
  const rows = useDaemon().rows ?? [];
  return ids.map((id) => {
    const row = rows.find((each) => each.id === id);
    return row?.worker ? asWorker(row as Row & { worker: WorkerRow }) : { id, name: UNKNOWN_WORKER, kind: "stopped", word: "Ended", startedAt: 0 };
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

/**
 * Opens a worker in its Workers tab: its chip in a message, or a message just sent to it [D81]. However deep, that's
 * its family's first session's, the tab on screen, since a worker's own view sits in it.
 */
export const openWorker = (owner: string, worker: string) => openTab(view.rows?.find((each) => each.id === worker)?.worker?.root ?? owner, "workers", worker);

/** A worker named anywhere opens it in its parent's Workers tab, `tab`'s; null opens the list [D81]. */
export function Opens({ owner, tab = "workers", children }: { owner: string; tab?: TeamKind; children: ReactNode }) {
  const open = (worker: string | null) => openTab(owner, tab, worker ?? undefined);
  return <WorkersPanel.Provider value={{ open }}>{children}</WorkersPanel.Provider>;
}

/**
 * A worker @-mentioned, in the composer, a sent message or an answer: its pill, as the old app's Mentions'
 * TaskByNumber.
 */
export function MentionedWorker({ id, onOpen }: { id: string; onOpen?: (kind: "worker", id: string) => void }) {
  const row = (useDaemon().rows ?? []).find((each) => each.id === id);
  return (
    <WorkersPanel.Provider value={{ open: () => onOpen?.("worker", id) }}>
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
      <BatchRow keep={item.id} workers={workers} endRows />
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
  const family = useFamily(owner);
  const agents = useAgents(owner);
  // Its list is its own workers; a chip opens any worker under it, theirs too [D81].
  const worker = kind === "workers" ? family.find((each) => each.worker.id === target)?.worker : undefined;
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

const NO_ITEMS: Item[] = [];
const NO_TURNS: Turn[] = [];

/**
 * A worker opened: its header, and its thread or its details, Rust's snapshot of it, asked again as its row changes
 * [D3013]; under its thread the lead's own composer, to message it directly [D293]. Its asks in a turn the user
 * started, and its hold, are answered there [D305, D130].
 */
function WorkerView({ worker, owner, onBack }: { worker: Worker; owner: string; onBack: () => void }) {
  const { rows, daemon } = useDaemon();
  const row = rows?.find((row) => row.id === worker.id) as ComposerRow | undefined;
  const updated = row?.updated;
  // Its asks name the session that answers them [D131].
  const parent = rows?.find((each) => each.id === (row?.worker?.parent ?? owner))?.title || PARENT;
  const source = useMemo(() => {
    let session: Session | null = null;
    const listeners = new Set<() => void>();
    return {
      subscribe: (listener: () => void) => (listeners.add(listener), () => void listeners.delete(listener)),
      get: () => session,
      set(next: Session) {
        session = next;
        for (const listener of listeners) listener();
      },
    } satisfies Source & { set(next: Session): void };
  }, [worker.id]);
  const [details, setDetails] = useState(false);
  useEffect(() => {
    let live = true;
    ask({ op: "peek", session: worker.id }, (reply) => live && reply.ok && source.set(reply.session));
    return () => {
      live = false;
    };
  }, [worker.id, updated, source]);
  // Its asks answered here show answered at once, till its next peek has them [D305].
  const answered = useMemo(() => withAnswers(source), [source]);
  const shown = useSyncExternalStore(answered.subscribe, answered.get);
  const items = shown?.items ?? NO_ITEMS;
  // Its first message is the brief, which the view shows above.
  const brief = items.find((item) => item.kind === "message" && item.role === "user");
  const rest = useMemo(() => items.filter((item) => item !== brief), [items, brief]);
  // A message on its way shows under its thread until Rust's has it, Try again if refused [D108].
  const sending = useSending(worker.id);
  const arriving = useArriving(worker.id, answered);
  return (
    <section aria-label={`Worker: ${worker.name}`} className="flex min-h-0 min-w-0 flex-1 flex-col">
      <WorkerHeader
        worker={worker}
        details={details}
        onBack={() => (details ? setDetails(false) : onBack())}
        onToggleDetails={() => setDetails(!details)}
      />
      <ParentName value={parent}>
        {details ? (
          <WorkerDetails worker={worker} />
        ) : (
          // Its own folder, where its images are kept [D289].
          <SessionOfThread value={{ id: worker.id, offline: daemon === null }}>
            <WorkerThread worker={worker} items={rest} turns={shown?.turns ?? NO_TURNS} setup={shown?.setup} footer={(sending || arriving.length > 0) && <><SentBubbles id={worker.id} source={answered} hover /><ArrivingBubbles list={arriving} /></>} />
          </SessionOfThread>
        )}
      </ParentName>
      {!details && (
        <SessionOfThread value={{ id: worker.id, offline: daemon === null }}>
          <SessionComposer id={worker.id} row={row} offline={daemon === null} source={answered} placeholder={`Message ${worker.name}`} worker />
        </SessionOfThread>
      )}
    </section>
  );
}

/**
 * The card's one row for a session's workers or its CLI's own subagents [D142 D150]: up to 4 glyphs,
 * those at work first, and "2 working", with "1 done" at its end when some finished; else "2 done". It opens their
 * tab on the list; no controls here, they're in the composer strip and the thread.
 */
export function TeamCard({ owner, title, workers, tab }: { owner: string; title: string; workers: readonly Worker[]; tab?: TeamKind }) {
  if (workers.length === 0) return null;
  return (
    <Opens owner={owner} tab={tab}>
      <CardSection title={title} fold={tab ?? "workers"}>
        <TeamLine workers={workers} />
      </CardSection>
    </Opens>
  );
}

function TeamLine({ workers }: { workers: readonly Worker[] }) {
  const { open } = useContext(WorkersPanel);
  const active = workers.filter(onHand);
  const done = workers.length - active.length;
  const glyphs = (active.length > 0 ? active : workers).slice(0, 4);
  return (
    <Line
      onClick={() => open(null)}
      icon={<span className="flex items-center gap-1">{glyphs.map((worker) => <WorkerGlyph key={worker.id} id={worker.id} className="size-4" />)}</span>}
      end={active.length > 0 && done > 0 && `${done} done`}
      className={active.length === 0 ? "text-muted-foreground" : undefined}
    >
      {active.length > 0 ? `${active.length} working` : `${done} done`}
    </Line>
  );
}

/** The session's workers in the summary card [D142]. */
export function WorkersCard({ owner }: { owner: string }) {
  return <TeamCard owner={owner} title={WORKERS_LABEL} workers={useWorkers(owner)} />;
}
