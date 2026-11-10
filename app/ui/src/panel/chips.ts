import { useSyncExternalStore } from "react";

import type { DiffComment } from "../review/types";

/*
 * What waits above a session's composer for the agent, sent with the next message and never on its own [D1019,
 * D1040]: for now the diff's comments. Nothing is stored: they last while the app runs, and a send takes the ones it
 * carried.
 */

/** `on`: the diff it was made on (the Review tab, or a commit's), which alone draws it. */
export type Chip = { kind: "comment"; id: string; on: string; comment: DiffComment };

const NONE: readonly Chip[] = [];
const chips = new Map<string, readonly Chip[]>();
const listeners = new Set<() => void>();

function set(session: string, next: readonly Chip[]): void {
  chips.set(session, next);
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const useChips = (session: string): readonly Chip[] => useSyncExternalStore(subscribe, () => chips.get(session) ?? NONE);

export const addChip = (session: string, chip: Chip) => set(session, [...(chips.get(session) ?? NONE), chip]);

/** Takes chips away: removed by hand, or sent. */
export const dropChips = (session: string, ids: readonly string[]) => set(session, (chips.get(session) ?? NONE).filter((chip) => !ids.includes(chip.id)));

/** Puts back chips a send couldn't take, before any added since. */
export const restoreChips = (session: string, back: readonly Chip[]) =>
  set(session, [...back, ...(chips.get(session) ?? NONE).filter((chip) => !back.some((each) => each.id === chip.id))]);

/** The chips as the agent reads them, after the user's own words: each comment's place, its first line and what it says. */
export function withChips(message: string, sent: readonly Chip[]): string {
  const blocks = sent.map(({ comment }) => {
    const lines = comment.start === comment.end ? `${comment.start}` : `${comment.start}-${comment.end}`;
    return `${comment.path}:${lines}\n> ${comment.excerpt}\n${comment.text}`;
  });
  return [message.trim(), ...blocks].filter(Boolean).join("\n\n");
}
