import { useEffect, useSyncExternalStore } from "react";

import { showToast } from "../components/toast";
import { ask } from "../daemon";
import type { SessionRow } from "./words";

/*
 * Pin, rename, Mark as unread and seen, shown at once and settled by Rust [D30, D40]. Each session's
 * actions go one at a time, in order, so two never cross. One is sent by its request id; it holds
 * its change on the row until its reply is ok and Rust's row has caught up with it (`touched`, the
 * session folder's time, at least the time its reply gave). A refusal takes the change back and says why.
 */

type Change = { pinned?: number | null; title?: string; unread?: true };
type Action = { args: string[]; change: Change; failed: string; sent?: boolean; at?: number };

let queues = new Map<string, Action[]>();
let rows = new Map<string, SessionRow>();
/** Sessions marked unread while open: a reply finishing meanwhile doesn't read them [D185]. */
const held = new Set<string>();
const listeners = new Set<() => void>();

function emit(): void {
  queues = new Map(queues);
  for (const listener of listeners) listener();
}

function sendFirst(id: string): void {
  const action = queues.get(id)?.[0];
  if (!action || action.sent) return;
  action.sent = true;
  ask({ op: "run", args: action.args }, (reply) => {
    const queue = queues.get(id);
    if (queue?.[0] !== action) return;
    if (reply.ok) {
      action.at = reply.at ?? 0;
      return settle(id);
    }
    queue.shift();
    if (action.failed) showToast(`${action.failed}: ${reply.error === "disconnected" ? "Brigadier isn't running" : reply.error}`, { tone: "error" });
    emit();
    sendFirst(id);
  });
}

// Drops the first action once Rust's row shows it, then sends the next.
function settle(id: string): void {
  const action = queues.get(id)?.[0];
  const row = rows.get(id);
  if (action?.at === undefined || (row?.touched ?? 0) < action.at) return;
  queues.get(id)!.shift();
  emit();
  sendFirst(id);
}

function run(id: string, args: string[], change: Change, failed: string): void {
  queues.set(id, [...(queues.get(id) ?? []), { args, change, failed }]);
  emit();
  sendFirst(id);
}

export const pin = (row: SessionRow, on: boolean) =>
  run(row.id, on ? ["pin", row.id] : ["pin", row.id, "--off"], { pinned: on ? Date.now() : null }, on ? "Couldn't pin" : "Couldn't unpin");

export const markUnread = (row: SessionRow, open: boolean) => {
  if (open) held.add(row.id);
  run(row.id, ["unread", row.id], { unread: true }, "Couldn't mark as unread");
};

export const rename = (row: SessionRow, title: string) => run(row.id, ["rename", row.id, title], { title }, "Couldn't rename");

/** Read up to `finished`, behind any action still going; no change to show, as the open row draws no dot. */
export const seen = (id: string, finished: number) => run(id, ["seen", id, String(finished)], {}, "");

export const isHeld = (id: string) => held.has(id);
export const release = (id: string) => held.delete(id);

/** The rows as they show: Rust's, with each action still going laid over in order. */
export function useShown(list: SessionRow[] | undefined): SessionRow[] | undefined {
  const pending = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => queues,
  );
  useEffect(() => {
    rows = new Map(list?.map((row) => [row.id, row]));
    for (const id of queues.keys()) settle(id);
  }, [list]);
  return list?.map((row) => {
    const actions = pending.get(row.id);
    if (!actions?.length) return row;
    return actions.reduce<SessionRow>(
      (shown, { change }) => ({
        ...shown,
        ...(change.pinned !== undefined && { pinned: change.pinned }),
        ...(change.title !== undefined && { title: change.title }),
        ...(change.unread && { mark: shown.mark ?? "unread" }),
      }),
      row,
    );
  });
}
