import { useMemo, useSyncExternalStore } from "react";

import { TooltipIconButton } from "../components/icon-button";
import { TitlebarTips } from "../components/tooltip";
import { threadSource, useThread } from "../daemon";
import { X } from "../icons";
import type { Item, Progress, Turn } from "../thread/item";
import type { Worker, WorkerStateKind } from "./chip";
import { Opens, TeamCard } from "./live";
import { type Lifecycle, TeamSentence } from "./sentence";
import { WorkerHeader, WorkerThread } from "./view";

/*
 * The agent CLI's own subagents [D78, D115]: in the thread only "‹name› started working", then
 * "finished", "failed" or "stopped", each with its glyph; their steps live in the side panel, which the name opens; the
 * card counts them. They draw with the workers' parts, as workers that can't be paused or ended from here.
 */

export const SUBAGENTS_LABEL = "Subagents";

type Agent = Extract<Item, { kind: "childAgent" }>;

const STATES: Record<Progress, [WorkerStateKind, string, Lifecycle]> = {
  pending: ["working", "Waiting", "waiting"],
  running: ["working", "Working", "started"],
  done: ["done", "Done", "finished"],
  failed: ["failed", "Failed", "failed"],
  cancelled: ["stopped", "Stopped", "stopped"],
};

/** A subagent's row as a worker: its row's id (its glyph never changes as its own id comes in), its task as its name. */
export function asSubagent(item: Agent): Worker {
  const [kind, word] = STATES[item.progress];
  return { id: item.id, name: item.title || "A subagent", kind, word, startedAt: item.startedAt ?? 0, lastAt: item.endedAt ?? undefined };
}

const NONE: readonly Item[] = [];

/**
 * The open thread's subagent rows, when it's `owner`'s.
 * shortcut: only the rows the view holds (the newest 2000 and any paged in); have Rust send the session's list if older ones must count.
 */
export function useAgents(owner: string): Agent[] {
  const session = useSyncExternalStore(threadSource.subscribe, threadSource.get);
  const items = session?.id === owner ? session.items : NONE;
  return useMemo(() => items.filter((item): item is Agent => item.kind === "childAgent"), [items]);
}

/** Its row in the thread: "Find the parser started working", its name opening it in the side panel. */
export function SubagentRow({ item }: { item: Agent }) {
  const owner = useThread()?.id ?? "";
  return (
    <Opens owner={owner} tab={SUBAGENTS_LABEL}>
      <TeamSentence keep={item.id} word={STATES[item.progress][2]} workers={[asSubagent(item)]} />
    </Opens>
  );
}

/** The card's Subagents section: a line each while a few work, else their glyphs with "N working · N done". */
export function SubagentsCard({ owner }: { owner: string }) {
  const agents = useAgents(owner);
  const workers = useMemo(() => agents.map(asSubagent), [agents]);
  return <TeamCard owner={owner} title={SUBAGENTS_LABEL} workers={workers} tab={SUBAGENTS_LABEL} />;
}

const NO_TURNS: readonly Turn[] = [];

/** One subagent in the side panel: its header, its steps as they come, and its answer once it's in. */
export function SubagentView({ item, onBack, onClose }: { item: Agent; onBack: () => void; onClose: () => void }) {
  const worker = asSubagent(item);
  const items = useMemo<Item[]>(
    () => [...(item.log ?? []), ...(item.answer ? [{ id: `${item.id}:answer`, turnId: item.turnId, kind: "message" as const, role: "assistant" as const, text: item.answer, streaming: false }] : [])],
    [item],
  );
  return (
    <section aria-label={`Subagent: ${worker.name}`} className="flex min-h-0 min-w-0 flex-1 flex-col">
      <WorkerHeader
        worker={worker}
        list={SUBAGENTS_LABEL}
        onBack={onBack}
        actions={
          <TitlebarTips>
            <TooltipIconButton look="toolbar" tooltip="Close right panel" onClick={onClose}>
              <X />
            </TooltipIconButton>
          </TitlebarTips>
        }
      />
      <WorkerThread worker={worker} items={items} turns={NO_TURNS} />
    </section>
  );
}
