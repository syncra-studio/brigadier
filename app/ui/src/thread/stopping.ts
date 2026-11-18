import type { Item, Session } from "./item";

// The user's Stop, drawn at once: the open thread's running turn and its live rows read stopped till Rust's own end of
// the turn comes, or Rust refuses the Stop [D30, D693].
let stopping: { id: string; turn: string; at: number } | null = null;
let stopped: { from: Session; view: Session } | null = null;

const stoppedOf = (held: Session, turn: string, at: number): Session => ({
  ...held,
  turns: held.turns.map((each) => (each.id === turn ? { ...each, status: "cancelled", endedAt: at, stopping: true } : each)),
  items: held.items.map((item) =>
    item.turnId !== turn
      ? item
      : "progress" in item && (item.progress === "running" || item.progress === "pending")
        ? ({ ...item, progress: "cancelled", endedAt: at } as Item)
        : "streaming" in item && item.streaming
          ? { ...item, streaming: false }
          : item,
  ),
});

/** Session `id`'s rows as drawn: Rust's, or its stopped turn's while Rust still runs it. */
export function asStopped(id: string | undefined, held: Session | null): Session | null {
  const live = stopping && stopping.id === id && held?.turns.find((each) => each.id === stopping!.turn)?.status === "running";
  if (!live || !held || !stopping) return held;
  if (stopped?.from !== held) stopped = { from: held, view: stoppedOf(held, stopping.turn, stopping.at) };
  return stopped.view;
}

/** Shows session `id`'s running turn in `held` stopped at once; what it returns takes whether Rust's Stop went. */
export function markStop(id: string, held: Session | null, redraw: () => void): (ok: boolean) => void {
  const turn = held?.turns.at(-1);
  if (turn?.status !== "running") return () => {};
  const mine = (stopping = { id, turn: turn.id, at: Date.now() });
  redraw();
  const drop = () => stopping === mine && ((stopping = null), redraw());
  // shortcut: a turn Rust still runs after its Stop went (a block held open) shows running again 1s on, by when its
  // end would have come; a per-turn answer from Rust would end it exactly.
  return (ok) => (ok ? setTimeout(drop, 1000) : drop());
}
