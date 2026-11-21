import { useMemo, useState, useSyncExternalStore } from "react";

import { threadSource, useThread } from "../daemon";
import type { Item, Progress, Turn } from "../thread/item";
import type { Worker, WorkerStateKind } from "./chip";
import { Opens, TeamCard } from "./live";
import { BatchRow } from "./sentence";
import { WorkerDetails, WorkerHeader, WorkerThread } from "./view";

/*
 * The agent CLI's own subagents [D78, D115]: in the thread one row per batch, "‹A› and ‹B› started working", then
 * "finished" [D103]; their steps live in the Subagents tab, which each one's row in the opened batch opens; the
 * card counts them. They draw with the workers' parts, as workers that can't be paused or ended from here.
 */

export const SUBAGENTS_LABEL = "Subagents";

type Agent = Extract<Item, { kind: "childAgent" }>;

const STATES: Record<Progress, [WorkerStateKind, string]> = {
  pending: ["working", "Waiting"],
  running: ["working", "Working"],
  done: ["done", "Done"],
  failed: ["failed", "Failed"],
  cancelled: ["stopped", "Stopped"],
};

/** A subagent's row as a worker: its row's id (its glyph never changes as its own id comes in), its task as its name. */
export function asSubagent(item: Agent): Worker {
  const [kind, word] = STATES[item.progress];
  return { id: item.id, name: item.title || "A subagent", kind, word, startedAt: item.startedAt ?? 0, lastAt: item.endedAt ?? undefined };
}

const NONE: readonly Item[] = [];

/**
 * The open thread's shown subagent rows (not a moved one's old row), when it's `owner`'s.
 * shortcut: only the rows the view holds (the newest 2000 and any paged in); have Rust send the session's list if older ones must count.
 */
export function useAgents(owner: string): Agent[] {
  const session = useSyncExternalStore(threadSource.subscribe, threadSource.get);
  const items = session?.id === owner ? session.items : NONE;
  return useMemo(() => items.filter((item): item is Agent => item.kind === "childAgent" && !item.hidden), [items]);
}

/** A batch's row in the thread: "Find the parser and Count lines started working", each opening in the Subagents tab [D81, D103]. */
export function SubagentRow({ items }: { items: readonly Agent[] }) {
  const owner = useThread()?.id ?? "";
  return (
    <Opens owner={owner} tab="subagents">
      <BatchRow keep={items[0]!.id} workers={items.map(asSubagent)} />
    </Opens>
  );
}

/** The card's Subagents section: a line each while a few work, else their glyphs with "N working · N done". */
export function SubagentsCard({ owner }: { owner: string }) {
  const agents = useAgents(owner);
  const workers = useMemo(() => agents.map(asSubagent), [agents]);
  return <TeamCard owner={owner} title={SUBAGENTS_LABEL} workers={workers} tab="subagents" />;
}

const NO_TURNS: readonly Turn[] = [];

/** One subagent in its tab: its header, its steps as they come, and its answer once it's in. */
export function SubagentView({ item, onBack }: { item: Agent; onBack: () => void }) {
  const worker = asSubagent(item);
  const [details, setDetails] = useState(false);
  const items = useMemo<Item[]>(
    () => [...(item.log ?? []), ...(item.answer ? [{ id: `${item.id}:answer`, turnId: item.turnId, kind: "message" as const, role: "assistant" as const, text: item.answer, streaming: false }] : [])],
    [item],
  );
  return (
    <section aria-label={`Subagent: ${worker.name}`} className="flex min-h-0 min-w-0 flex-1 flex-col">
      <WorkerHeader
        worker={worker}
        list={SUBAGENTS_LABEL}
        details={details}
        onBack={() => (details ? setDetails(false) : onBack())}
        onToggleDetails={() => setDetails(!details)}
      />
      {details ? <WorkerDetails worker={worker} /> : <WorkerThread worker={worker} items={items} turns={NO_TURNS} />}
    </section>
  );
}
