import { useEffect, useSyncExternalStore } from "react";

import { ask, useDaemon } from "../daemon";
import type { Commit } from "../panel/types";
import { HOME_DRAFT } from "../session/draft";

/*
 * A session's commits since its base, as Rust reads them (`source <id> history`) [D1041]: one read per session shared by
 * Source's History menu and the History tab, so the two agree. Read when either shows, again when the daemon comes
 * back, and when the checkout's head moves (`refreshHistory`, from the git watch) [D30, D71]. A failed read keeps the
 * last list under its error.
 */

/** `base` null: no base to count from (a Local checkout, a project chat), so no commits. */
export type History = { base: string | null; commits: Commit[] };
export type HistoryState = { history: History | null; error: string | null; loading: boolean };

type Slot = HistoryState & { again: boolean };

const NONE: HistoryState = { history: null, error: null, loading: false };
const slots = new Map<string, Slot>();
const listeners = new Set<() => void>();

function set(owner: string, next: Partial<Slot>): void {
  slots.set(owner, { ...(slots.get(owner) ?? { ...NONE, again: false }), ...next });
  for (const listener of listeners) listener();
}

/** Reads `owner`'s history now; one asked meanwhile waits for this one, then reads once more. */
export function refreshHistory(owner: string): void {
  // Home's Source is a project's folder: no session, so no base [D1041].
  if (owner === HOME_DRAFT) return set(owner, { history: { base: null, commits: [] } });
  if (slots.get(owner)?.loading) return set(owner, { again: true });
  set(owner, { loading: true, again: false });
  ask({ op: "run", args: ["source", owner, "history"] }, (reply) => {
    const again = slots.get(owner)?.again ?? false;
    if (reply.ok) set(owner, { history: reply.history, error: null, loading: false });
    // Disconnected: the list stays as it was, and the reconnect reads it again.
    else set(owner, { error: reply.error === "disconnected" ? null : String(reply.error), loading: false });
    if (again) refreshHistory(owner);
  });
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** `owner`'s history, read when this first shows and on each reconnect. */
export function useHistory(owner: string): HistoryState {
  const pid = useDaemon().daemon?.pid;
  useEffect(() => {
    if (pid !== undefined) refreshHistory(owner);
  }, [owner, pid]);
  return useSyncExternalStore(subscribe, () => slots.get(owner) ?? NONE);
}
