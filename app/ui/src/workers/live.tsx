import { type ReactNode, useEffect, useState, useSyncExternalStore } from "react";

import { TooltipIconButton } from "../components/icon-button";
import { Body } from "../components/thread/body";
import { TitlebarTips } from "../components/tooltip";
import { ask, type Row, useDaemon, useThread } from "../daemon";
import { X } from "../icons";
import { run } from "../onboarding/api";
import { setPanelOpen } from "../panel/memory";
import type { Item } from "../thread/item";
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

/** The user's Stop them and End: Rust stops each and logs "You ended …" in the parent [D3011]. */
const stop = (parent: string, ids: readonly string[]) => void run(["workers", parent, "stop", ...ids]).catch(() => {});

/** Which worker each session's panel shows (null: the list) and its tab. */
let shown: Record<string, { tab: string; open: string | null }> = {};
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => (listeners.add(listener), () => listeners.delete(listener));
function show(owner: string, next: { tab: string; open: string | null }) {
  shown = { ...shown, [owner]: next };
  for (const listener of listeners) listener();
}
const useShown = (owner: string) => useSyncExternalStore(subscribe, () => shown[owner]) ?? { tab: "Files", open: null };

/** A worker named anywhere opens it in its parent's Workers tab. */
function Opens({ owner, children }: { owner: string; children: ReactNode }) {
  const open = (id: string | null) => {
    show(owner, { tab: WORKERS_LABEL, open: id });
    setPanelOpen(true);
  };
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
      <TeamStepRow keep={item.id} step={{ type: "stopped", byUser: item.byUser, workers }} />
    ) : (
      <StillRows owner={owner} workers={workers} />
    );
  return <Opens owner={owner}>{row}</Opens>;
}

/** "2 workers still running · Stop them", while any of them still runs. */
function StillRows({ owner, workers }: { owner: string; workers: Worker[] }) {
  const live = workers.filter((worker) => !finished(worker));
  if (live.length === 0) return null;
  return (
    <StillRunningRow
      workers={live}
      onStop={() =>
        stop(
          owner,
          live.map((worker) => worker.id),
        )
      }
    />
  );
}

/** The strip over the composer: the session's workers still at work or waiting [D3010]. */
export function SessionWorkersStrip({ id }: { id: string }) {
  const workers = useWorkers(id);
  return (
    <Opens owner={id}>
      <WorkersStrip workers={workers} onStop={(wid) => stop(id, [wid])} />
    </Opens>
  );
}

/** The right panel: Files alone until the session has workers, then Files · Workers [D3012]. */
export function PanelBody({ owner, files }: { owner: string; files: ReactNode }) {
  const workers = useWorkers(owner);
  const { tab, open } = useShown(owner);
  if (workers.length === 0) return files;
  const opened = workers.find((each) => each.id === open);
  const close = () => setPanelOpen(false);
  return (
    <Opens owner={owner}>
      {opened ? (
        <WorkerView worker={opened} onBack={() => show(owner, { tab, open: null })} onClose={close} />
      ) : (
        <>
          <PanelTabs active={tab} tabs={["Files", WORKERS_LABEL]} onSelect={(next) => show(owner, { tab: next, open: null })} onClose={close} />
          {tab === WORKERS_LABEL ? <WorkerList workers={workers} onStop={(wid) => stop(owner, [wid])} /> : files}
        </>
      )}
    </Opens>
  );
}

/** A worker opened: its header, brief and thread, Rust's snapshot of it, asked again as its row changes [D3013]. */
function WorkerView({ worker, onBack, onClose }: { worker: Worker; onBack: () => void; onClose: () => void }) {
  const updated = useDaemon().rows?.find((row) => row.id === worker.id)?.updated;
  const [items, setItems] = useState<Item[]>([]);
  useEffect(() => {
    ask({ op: "peek", session: worker.id }, (reply) => reply.ok && setItems(reply.session.items));
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
            <Body key={item.id} item={item} turn={undefined} step={item.kind === "tool"} />
          ))}
      </WorkerThread>
    </>
  );
}
