import { useSyncExternalStore } from "react";

import { threadSource } from "../daemon";
import type { Mark, SessionRow } from "../sidebar/words";
import type { Source } from "../thread/thread";
import type { ComposerRow } from "./composer";
import { useOnItsWay } from "./composer";

/** The thread's newest turn when the thread is session `id`'s and holds its newest turns. */
const newest = (id: string, source: Source) => {
  const thread = source.get();
  return thread?.id === id && thread.after === null ? thread.turns.at(-1) : undefined;
};

/**
 * The session's turn as its thread shows it, so the send button changes in the same frame as the thread's Thinking:
 * Rust's row only until the thread is this session's and holds its newest turns. A message on its way runs already.
 * Answered, its block still open on its subagents or workers, it runs on: Stop stays, and a message queues or steers
 * as mid-turn [D118, D151, D521].
 */
export function useTurn(id: string, row: (ComposerRow & { holding?: boolean }) | undefined, source: Source, sending: boolean) {
  const turn = useSyncExternalStore(source.subscribe, () => newest(id, source));
  // Held only by paused workers, Rust's row holds nothing: Send, the block still open [D553]; a row a beat behind still runs.
  const holds = row === undefined || row.holding === true || row.running === true;
  const running = turn ? turn.status === "running" || (turn.held === true && holds) : row?.running === true || row?.holding === true;
  // Only after a stopped turn; stopped in the thread before Rust's row says so (it still runs there), Resume at once.
  const resumable = !sending && (turn ? turn.status === "cancelled" && (row?.resumable === true || row?.running === true) : row?.resumable === true);
  return { running, busy: running || sending, resumable };
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
