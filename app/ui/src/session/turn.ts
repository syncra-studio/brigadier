import { useSyncExternalStore } from "react";

import type { Source } from "../thread/thread";
import type { ComposerRow } from "./composer";

/**
 * The session's turn as its thread shows it, so the send button changes in the same frame as the thread's Thinking:
 * Rust's row only until the thread is this session's and holds its newest turns. A message on its way runs already.
 */
export function useTurn(id: string, row: ComposerRow | undefined, source: Source, sending: boolean) {
  const thread = useSyncExternalStore(source.subscribe, source.get);
  const turn = thread?.id === id && thread.after === null ? thread.turns.at(-1) : undefined;
  const running = turn ? turn.status === "running" : row?.running === true;
  // Only after a stopped turn; stopped in the thread before Rust's row says so (it still runs there), Resume at once.
  const resumable = !sending && (turn ? turn.status === "cancelled" && (row?.resumable === true || row?.running === true) : row?.resumable === true);
  return { running, busy: running || sending, resumable };
}
