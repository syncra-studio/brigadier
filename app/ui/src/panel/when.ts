import { useEffect, useState, useSyncExternalStore } from "react";

import { showToast } from "../components/toast";
import { ask } from "../daemon";
import { refreshStep } from "./git";
import type { When, WhenRule } from "./types";

/*
 * "When it's done" (2.44), per session [D1201, D1206]: a pick or a Cancel shows at once and is settled by the step
 * read after Rust's answer [D30]. Rust keeps the rule, checks the gates and lands; this only asks and draws.
 */

type Sent = { rule: WhenRule | "ask" } | { cancel: true };
const sent = new Map<string, Sent>();
const listeners = new Set<() => void>();
const notify = () => {
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

function send(session: string, word: string, what: Sent): void {
  sent.set(session, what);
  notify();
  ask({ op: "run", args: ["source", session, "when", word] }, (reply) => {
    if (!reply.ok) showToast(reply.error === "disconnected" ? "Not connected. Try again when it's back." : String(reply.error), { tone: "error" });
    refreshStep(() => {
      if (sent.get(session) === what) sent.delete(session);
      notify();
    });
  });
}

export const pickWhen = (session: string, rule: WhenRule | "ask") => send(session, rule, { rule });
export const cancelWhen = (session: string) => send(session, "cancel", { cancel: true });

/** Rust's rule for `session` with what's still on its way on top. */
export function useWhen(session: string | null, rust: When | null | undefined): When | null {
  const mine = useSyncExternalStore(subscribe, () => (session ? sent.get(session) : undefined));
  if (!mine) return rust ?? null;
  if ("cancel" in mine) return rust ? { rule: rust.rule, done: "cancelled" } : null;
  return mine.rule === "ask" ? null : rust?.rule === mine.rule ? rust : { rule: mine.rule };
}

/** The clock a countdown is drawn on, each second while it runs; the step is read again as it ends, while it lands, and while the run's proof is taken, so the countdown shows as it starts. */
export function useWhenClock(when: When | null, nowMs: number): number {
  const [now, setNow] = useState(nowMs);
  const counting = when?.at !== undefined;
  const acting = when?.acting === true;
  const checking = when?.stopped?.why === "checking";
  useEffect(() => {
    if (!counting && !acting && !checking) return;
    const every = setInterval(() => {
      setNow(Date.now());
      if (checking) refreshStep();
      else if (acting || (when?.at !== undefined && Date.now() >= when.at)) refreshStep();
    }, 1000);
    return () => clearInterval(every);
  }, [counting, acting, checking, when?.at]);
  return counting ? Math.max(now, nowMs) : nowMs;
}
