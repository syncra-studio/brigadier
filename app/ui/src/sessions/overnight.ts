import { useEffect } from "react";

import { showToast } from "../components/toast";
import type { Row } from "../daemon";
import { errorText, run, store } from "../onboarding/api";
import { newId } from "../session/store";
import type { SlashCommand } from "../components/composer/menus";

export type { Overnight } from "../../../shared/rows";
import type { Overnight } from "../../../shared/rows";

type Act = "on" | "start" | "off";

export const OVERNIGHT: SlashCommand = { id: "overnight", kind: "command", label: "/overnight", description: "Finish the job while you’re away", instant: true };

const asked = store<ReadonlyMap<string, { op: string; act: Act; at: number }>>(new Map());
function put(id: string, entry: { op: string; act: Act; at: number } | null): void {
  const next = new Map(asked.get());
  if (entry) next.set(id, entry);
  else next.delete(id);
  asked.set(next);
}

/** Turns it on or off, or starts the night; shown at once, Rust's refusal in a toast [D30]. `first`: what goes before it; refused, this isn't asked. */
export function overnight(id: string, act: Act, first: Promise<boolean> = Promise.resolve(true)): void {
  const op = newId();
  put(id, { op, act, at: Date.now() });
  const ask = async () => {
    const went = await first;
    // Another act took its place meanwhile.
    if (asked.get().get(id)?.op !== op) return;
    if (went) return run(["overnight", id, act, "--op", op]);
    put(id, null);
  };
  ask().catch((cause) => {
    if (asked.get().get(id)?.op !== op) return;
    put(id, null);
    showToast(errorText(cause), { tone: "error" });
  });
}

/** What the session's overnight is, null off: the user's last act until the row has it. */
export function useOvernight(id: string, row: Row | undefined): Overnight | null {
  const mine = asked.use().get(id);
  const landed = mine !== undefined && row?.overnight_op === mine.op;
  useEffect(() => {
    if (landed) put(id, null);
  }, [landed, id]);
  const now = row?.overnight ?? null;
  if (!mine || landed) return now;
  if (mine.act === "off") return null;
  if (mine.act === "start") return { ...now, state: "night", since: mine.at };
  return { ...now, state: "asking" };
}
