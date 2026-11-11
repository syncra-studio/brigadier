import { useEffect, useSyncExternalStore } from "react";

import { ask, useDaemon } from "../daemon";
import type { LineRange } from "../review/diff-view";
import type { DiffComment } from "../review/types";
import { HOME } from "../shell/tab-store";

/*
 * What waits above a session's composer for the agent, sent with the next message and never on its own [D1019,
 * D1040]: for now the diff's comments. Kept in the session's folder by Rust, with the comment being written, so an app
 * restart drops neither [D35, D1195]. A send hands its chips to its message in Rust before it goes, so a crash neither
 * loses them nor sends them twice [D1174].
 */

/** `on`: the diff it was made on (the Review tab, or a commit's), which alone draws it. */
export type Chip = { kind: "comment"; id: string; on: string; comment: DiffComment };

/** The comment box being written: the diff it's on, its lines and its words so far. */
export type CommentDraft = { on: string; path: string; side: "additions" | "deletions"; start: number; end: number; text: string };

const NONE: readonly Chip[] = [];
const chips = new Map<string, readonly Chip[]>();
const drafts = new Map<string, CommentDraft | null>();
const listeners = new Set<() => void>();
// Chips removed or handed to a message while the app runs: a read from Rust doesn't bring them back.
const gone = new Set<string>();
// The connection each session's chips were last read on: a new one reads them again.
const loaded = new Map<string, unknown>();
// One change at a time per session, in order: the daemon runs each on its own thread.
const chains = new Map<string, Promise<Record<string, any>>>();

function set(session: string, next: readonly Chip[]): void {
  chips.set(session, next);
  for (const listener of listeners) listener();
}

function tell(session: string, args: string[]): Promise<Record<string, any>> {
  const next = (chains.get(session) ?? Promise.resolve({})).then(
    () => new Promise<Record<string, any>>((resolve) => ask({ op: "run", args: ["chips", session, ...args] }, resolve)),
  );
  chains.set(session, next);
  return next;
}

/** Rust's chips, which settles any a send was handing off, with what was added here meanwhile. */
function load(session: string): void {
  void tell(session, []).then((reply) => {
    if (!reply.ok) return;
    const now = chips.get(session) ?? NONE;
    const kept = (reply.chips as Chip[]).filter((chip) => !gone.has(chip.id) && !now.some((each) => each.id === chip.id));
    if (!drafts.has(session)) drafts.set(session, reply.draft ?? null);
    set(session, [...kept, ...now]);
  });
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export function useChips(session: string): readonly Chip[] {
  const { daemon } = useDaemon();
  useEffect(() => {
    // Home's composer starts a session and carries no chips.
    if (!daemon || session === HOME || loaded.get(session) === daemon) return;
    loaded.set(session, daemon);
    load(session);
  }, [daemon, session]);
  return useSyncExternalStore(subscribe, () => chips.get(session) ?? NONE);
}

export const addChip = (session: string, chip: Chip) => {
  set(session, [...(chips.get(session) ?? NONE), chip]);
  void tell(session, ["add", JSON.stringify(chip)]);
};

/** Takes chips away by hand. */
export const dropChips = (session: string, ids: readonly string[]) => {
  for (const id of ids) gone.add(id);
  set(session, (chips.get(session) ?? NONE).filter((chip) => !ids.includes(chip.id)));
  void tell(session, ["drop", ...ids]);
};

/**
 * Hands `sent` to message `msg` (going to session `into`) in Rust, then runs `go`; with none, `go` runs at once. If
 * Rust couldn't take them nothing is sent, and `refused` says why.
 */
export function handOff(session: string, sent: readonly Chip[], msg: string, go: () => void, refused: (reply: Record<string, any>) => void, into = session): void {
  if (sent.length === 0) return go();
  void tell(session, ["take", msg, ...(into === session ? [] : ["--in", into]), ...sent.map((chip) => chip.id)]).then((reply) => (reply.ok ? go() : refused(reply)));
}

/** Chips a message took leave the composer. */
export const leaveChips = (session: string, sent: readonly Chip[]) => {
  for (const chip of sent) gone.add(chip.id);
  set(session, (chips.get(session) ?? NONE).filter((chip) => !sent.some((each) => each.id === chip.id)));
};

/** Puts back chips a send couldn't take, before any added since. */
export const restoreChips = (session: string, msg: string, back: readonly Chip[]) => {
  for (const chip of back) gone.delete(chip.id);
  set(session, [...back, ...(chips.get(session) ?? NONE).filter((chip) => !back.some((each) => each.id === chip.id))]);
  void tell(session, ["back", msg]);
};

/** The comment being written on a session's diff `on`, as Rust kept it, and where its changes go: a Review tab's props. */
export function useCommentDraft(session: string, on: string) {
  const draft = useSyncExternalStore(subscribe, () => drafts.get(session) ?? null);
  return {
    draft: draft?.on === on ? { path: draft.path, range: { start: draft.start, end: draft.end, side: draft.side }, text: draft.text } : null,
    onDraft: (next: { path: string; range: LineRange; text: string } | null) =>
      setCommentDraft(session, next && { on, path: next.path, side: next.range.side ?? "additions", start: next.range.start, end: next.range.end, text: next.text }),
  };
}

const saving = new Map<string, ReturnType<typeof setTimeout>>();
/** Keeps the comment being written; null once it's a chip or cancelled. Typing is saved a moment after it pauses. */
export function setCommentDraft(session: string, draft: CommentDraft | null): void {
  const was = drafts.get(session);
  drafts.set(session, draft);
  // Where it is changed, not only its words: what shows it draws again.
  const place = (each: CommentDraft | null | undefined) => each && `${each.on}:${each.path}:${each.side}:${each.start}:${each.end}`;
  if (place(was) !== place(draft)) for (const listener of listeners) listener();
  clearTimeout(saving.get(session));
  const save = () => void tell(session, ["draft", draft ? JSON.stringify(draft) : "-"]);
  if (draft?.text) saving.set(session, setTimeout(save, 400));
  else save();
}

/**
 * The chips as the agent reads them, after the user's own words: each comment's place (on a removed line, the old
 * file's; on a commit's diff, that commit's), the lines it's on, quoted, then what it says after a blank line, so it
 * isn't read as part of the quote.
 */
export function withChips(message: string, sent: readonly Chip[]): string {
  const blocks = sent.map(({ on, comment }) => {
    const lines = comment.start === comment.end ? `${comment.start}` : `${comment.start}-${comment.end}`;
    const where = [on !== "review" && `in commit ${on.slice(0, 12)}`, comment.side === "deletions" && "before the change"].filter(Boolean).join(", ");
    return `${comment.path}:${lines}${where ? ` (${where})` : ""}\n${comment.excerpt.split("\n").map((line) => `> ${line}`).join("\n")}\n\n${comment.text}`;
  });
  return [message.trim(), ...blocks].filter(Boolean).join("\n\n");
}
