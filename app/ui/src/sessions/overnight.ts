import { useEffect, useSyncExternalStore } from "react";

import { showToast } from "../components/toast";
import type { Row } from "../daemon";
import { errorText, run } from "../onboarding/api";
import { newId } from "../session/store";
import type { SlashCommand } from "../components/composer/menus";

export type { Overnight } from "../../../shared/rows";
import type { Overnight } from "../../../shared/rows";
import { nightActs as asked, type NightAct as Act, nightShown, OVERNIGHT_WORDS, putNightAct as put } from "../../../shared/session/composer";

export const OVERNIGHT: SlashCommand = { id: "overnight", kind: "command", ...OVERNIGHT_WORDS, instant: true };

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
  const mine = useSyncExternalStore(asked.subscribe, asked.get).get(id);
  const landed = mine !== undefined && row?.overnight_op === mine.op;
  useEffect(() => {
    if (landed) put(id, null);
  }, [landed, id]);
  return nightShown(row?.overnight ?? null, mine, landed);
}
