import { useEffect, useSyncExternalStore } from "react";

import { laidOver, sessionActions } from "../../../shared/session/actions";
import { showToast } from "../components/toast";
import { ask } from "../daemon";
import type { SessionRow } from "./words";

/* Pin, label, rename, seen, archive and restore, shown at once and settled by Rust, as the phone's [D30, D40, D58]. */
const actions = sessionActions(
  (args) => new Promise((done) => ask({ op: "run", args }, done)),
  (words, error) => showToast(words, error ? { tone: "error" } : undefined),
);
export const { pin, label, archive, restore, rename, seen } = actions;

/** The rows as they show: Rust's, with each action still going laid over in order. */
export function useShown(list: SessionRow[] | undefined): SessionRow[] | undefined {
  const pending = useSyncExternalStore(actions.queues.subscribe, actions.queues.get);
  useEffect(() => actions.caught(list), [list]);
  return laidOver(list, pending);
}
