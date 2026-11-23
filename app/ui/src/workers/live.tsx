import { type ReactNode, useContext, useEffect, useMemo, useState } from "react";

import { type PendingQuestion, QuestionCard } from "../components/composer/question";
import { doingWords, VERBS } from "../components/thread/tool";
import { ParentName } from "../components/thread/cards";
import { ask, type Row, useDaemon, useThread } from "../daemon";
import { WorkerGlyph } from "../icons/worker-glyphs";
import { CardSection } from "../panel/card";
import { Line } from "../panel/source/rows";
import { showToast } from "../components/toast";
import { errorText, run } from "../onboarding/api";
import { openTab } from "../shell/tab-store";
import type { Item, Setup, StepKind, Turn } from "../thread/item";
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
