import { useSyncExternalStore } from "react";

import { threadSource } from "../daemon";
import type { Mark, SessionRow } from "../sidebar/words";
import type { Source } from "../thread/thread";
import type { ComposerRow } from "./composer";
import { useOnItsWay } from "./sent";
import { turnState } from "../../../shared/session/turn";

/** The thread's newest turn when the thread is session `id`'s and holds its newest turns. */
const newest = (id: string, source: Source) => {
  const thread = source.get();
  return thread?.id === id && thread.after === null ? thread.turns.at(-1) : undefined;
};

/** The session's turn as its thread shows it (app/shared/session/turn.ts), its thread followed. */
export function useTurn(id: string, row: ComposerRow | undefined, source: Source, sending: boolean) {
  return turnState(useSyncExternalStore(source.subscribe, () => newest(id, source)), row, sending);
}

/**
 * The mark a row draws [D173]. The open session's (`active`) follows its thread and its sends, so it spins and stops in the
 * same frame as Send, Stop and the fold; waiting on you there, with the card in view, it keeps spinning, and a new reply
 * there is read.
 */
export function useMark(row: SessionRow, active: boolean): Mark {
  // A word, not the turn, so a row redraws only when it changes.
  const turn = useSyncExternalStore(threadSource.subscribe, () => {
    if (!active) return undefined;
    const turn = newest(row.id, threadSource);
    return turn && !turn.quiet ? (turn.status === "running" || turn.held ? "running" : "ended") : undefined;
  });
  const sending = useOnItsWay(row.id);
  if (!active) return row.mark;
  if (sending || turn === "running" || (row.mark === "needs" && row.state === "waiting_answer")) return "working";
  if (row.mark === "needs" || row.mark === "unread") return null;
  // Ended in the thread before Rust's row says so; an automatic switch at a limit spins on its own [D51].
  if (turn === "ended" && row.mark === "working" && !["limited", "out_of_credits", "unresumable"].includes(row.state)) return null;
  return row.mark;
}
