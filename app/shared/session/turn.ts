import type { Turn } from "../thread";

/**
 * The session's turn as its thread shows it, so Send changes in the same frame as the thread's Thinking: `turn` is the
 * thread's newest when the thread holds it, else Rust's row decides. A message on its way runs already. Answered, its
 * block still open on its subagents or workers, it runs on: Stop stays, and a message queues or steers as mid-turn
 * [D118, D151, D521].
 */
export function turnState(turn: Turn | undefined, row: { running?: boolean; holding?: boolean; resumable?: boolean } | undefined, sending: boolean) {
  // Held only by paused workers, Rust's row holds nothing: Send, the block still open [D553]; a row a beat behind still runs.
  const holds = row === undefined || row.holding === true || row.running === true;
  const running = turn ? turn.status === "running" || (turn.held === true && holds) : row?.running === true || row?.holding === true;
  // Only after a stopped turn; stopped in the thread before Rust's row says so (it still runs there), Resume at once.
  const resumable = !sending && (turn ? turn.status === "cancelled" && (row?.resumable === true || row?.running === true) : row?.resumable === true);
  // Stopped in the view while Rust's Stop is on its way: Resume waits for it [D693].
  return { running, busy: running || sending, resumable, stopping: turn?.stopping === true };
}
