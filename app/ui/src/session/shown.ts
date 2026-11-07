import { useEffect, useState } from "react";

import type { Head, Pending } from "./store";

/** The one vocabulary every screen uses for what it can and can't prove. */
export type State =
  | "loading"
  | "empty"
  | "pending"
  | "error"
  | "disconnected"
  | "reconnecting"
  | "interrupted"
  | "stalled"
  | "unknown";

/** Waiting feedback shows only past this, so a fast answer shows nothing but the result. */
export const SHOW_AFTER_MS = 400;

/** The link's own state, when it isn't live. Connecting before the first snapshot is `loading`'s. */
export function linkState(head: Head): State | null {
  if (head.link === "reconnecting" || head.link === "disconnected") return head.link;
  return null;
}

/** What stands in for the rows: nothing loaded yet, or nothing there. */
export function bodyState(head: Head): State | null {
  if (!head.loaded) return head.link === "disconnected" ? "disconnected" : "loading";
  return head.order.length === 0 ? "empty" : null;
}

/** The run as the backend last said it, unless the link is down: then it can't be proven. */
export function runState(head: Head): State | "working" | "error" | null {
  const { state } = head.run;
  if (state === "idle") return null;
  if (head.link !== "live" && (state === "working" || state === "stalled")) return "unknown";
  return state;
}

/** A row of the user's own still waiting on the backend. */
export function pendingState(pending: Pending<unknown>): State {
  if (pending.status === "failed" || pending.status === "unsent") return "error";
  return pending.status === "unknown" ? "unknown" : "pending";
}

/** True once `active` has held for `ms`; false the moment it stops, so it never outlives the truth. */
export function useAfter(active: boolean, ms = SHOW_AFTER_MS): boolean {
  const [since, setSince] = useState<number | null>(null);
  useEffect(() => {
    if (!active) return;
    const start = Date.now();
    const timer = setTimeout(() => setSince(start), ms);
    return () => {
      clearTimeout(timer);
      setSince(null);
    };
  }, [active, ms]);
  return active && since !== null;
}

/** Re-renders every `ms` while `on`, for "12s ago". */
export function useNow(on: boolean, ms = 1000): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [on, ms]);
  return now;
}
