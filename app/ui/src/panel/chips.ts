import { useEffect, useSyncExternalStore } from "react";

import { ask, useDaemon } from "../daemon";
import type { LineRange } from "../review/diff-view";
import type { AgentChip } from "../landing/agent-chip";
import type { DiffComment } from "../review/types";
import { onChipsBack } from "../session/draft";
import { heldChips } from "../session/uncertain";
import { HOME } from "../shell/tab-store";

/*
 * What waits above a session's composer for the agent, sent with the next message and never on its own [D1019,
 * D1040]: for now the diff's comments. Kept in the session's folder by Rust, with the comment being written, so an app
 * restart drops neither [D35, D1195]. A send takes its chips for its message in Rust as it goes (`--chips`), so a crash
 * neither loses them nor sends them twice [D1174].
 */

export type { Chip } from "../../../shared/chips";
import type { Chip } from "../../../shared/chips";

/** The comment box being written: the diff it's on, its lines and its words so far. */
export type CommentDraft = { on: string; path: string; side: "additions" | "deletions"; start: number; end: number; text: string };

const NONE: readonly Chip[] = [];
const chips = new Map<string, readonly Chip[]>();
const drafts = new Map<string, CommentDraft | null>();
const listeners = new Set<() => void>();
// Chips removed or handed to a message while the app runs: a read from Rust doesn't bring them back.
const gone = new Set<string>();
// Of those, the ones removed by hand: a read that still finds one tells Rust again.
const dropped = new Set<string>();
// The connection each session's chips were last read on: a new one reads them again.
const loaded = new Map<string, unknown>();
// Rust's chips a read held back for a message kept here (uncertain.ts): they wait again if Rust gave it back.
const withheld = new Map<string, readonly Chip[]>();
// Each session's handover under way, which a later message waits for.
const handing = new Map<string, Promise<void>>();
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

/** Once this session's chip writes so far are in: a message goes after them, as its chips' take did, so none it names is missing [D237, D1174]. */
export const chipsWritten = (session: string) => chains.get(session) ?? Promise.resolve({});

/** Rust's chips, which settles any a send was handing off, with what was added here meanwhile. */
function load(session: string): void {
  void tell(session, []).then((reply) => {
    if (!reply.ok) return;
    const now = chips.get(session) ?? NONE;
    // A tool pill saved before tools became chips in the text (kind "tool") goes.
    const saved = reply.chips as (Chip | { kind: "tool"; id: string })[];
    const theirs = saved.filter((chip): chip is Chip => chip.kind !== "tool");
    // One a message kept here carries (uncertain.ts) is its own, though Rust may not have it yet.
    const held = heldChips(session);
    const kept = theirs.filter((chip) => !gone.has(chip.id) && !held.has(chip.id) && !now.some((each) => each.id === chip.id));
    withheld.set(session, theirs.filter((chip) => held.has(chip.id)));
    // The comment being written as it is here reaches Rust again, a save made while it was away included.
    const mine = drafts.get(session);
    if (drafts.has(session)) void tell(session, ["draft", mine ? JSON.stringify(mine) : "-"]);
    else drafts.set(session, reply.draft ?? null);
    set(session, [...kept, ...now]);
    // What changed here while Rust was away reaches it now, by id.
    for (const chip of now) if (!theirs.some((each) => each.id === chip.id)) void tell(session, ["add", JSON.stringify(chip)]);
    const stale = saved.filter((chip) => chip.kind === "tool" || dropped.has(chip.id)).map((chip) => chip.id);
    if (stale.length > 0) void tell(session, ["drop", ...stale]);
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
  for (const id of ids) {
    gone.add(id);
    dropped.add(id);
  }
  set(session, (chips.get(session) ?? NONE).filter((chip) => !ids.includes(chip.id)));
  void tell(session, ["drop", ...ids]);
};

/**
 * Hands `sent` to message `msg` going to session `into` (Send as new) in Rust, then runs `go`; with none, `go` runs at
 * once. If Rust couldn't take them nothing is sent, and `refused` says why.
 */
export function handOff(session: string, sent: readonly Chip[], msg: string, go: () => void, refused: (reply: Record<string, any>) => void, into = session): void {
  const before = handing.get(session);
  // Messages go in the order they were sent [D237]: one without chips waits for an earlier one's handover.
  if (sent.length === 0 && !before) return go();
  const next = (before ?? Promise.resolve()).then(() =>
    sent.length === 0 ? go() : tell(session, ["take", msg, ...(into === session ? [] : ["--in", into]), ...sent.map((chip) => chip.id)]).then((reply) => (reply.ok ? go() : refused(reply))),
  );
  handing.set(session, next);
  void next.finally(() => handing.get(session) === next && handing.delete(session));
}

/** Chips a message took leave the composer. */
export const leaveChips = (session: string, sent: readonly Chip[]) => {
  for (const chip of sent) gone.add(chip.id);
  set(session, (chips.get(session) ?? NONE).filter((chip) => !sent.some((each) => each.id === chip.id)));
};

/** Chips waiting again, before any added since: Rust has them back already; `ids`, a given-back message's chips a read held back. */
const chipsBack = (session: string, given: readonly Chip[], ids: readonly string[] = []) => {
  const back = [...given, ...(withheld.get(session) ?? NONE).filter((chip) => ids.includes(chip.id) && !given.some((each) => each.id === chip.id))];
  if (back.length === 0) return;
  for (const chip of back) gone.delete(chip.id);
  set(session, [...back, ...(chips.get(session) ?? NONE).filter((chip) => !back.some((each) => each.id === chip.id))]);
};
onChipsBack(chipsBack);

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
 * The session's chips and the comment being written, saved now, after the writes on their way: a refused new chat's
 * Discard takes them from Rust [C80]. Each chip shown here is added again (one Rust has is no change), so a write
 * that failed fails here; a failed read (a session not made yet) isn't one. Resolves with a failed write's reply, if any.
 */
export async function flushChips(session: string): Promise<Record<string, any>> {
  clearTimeout(saving.get(session));
  const draft = drafts.get(session);
  await chipsWritten(session);
  const writes = (chips.get(session) ?? NONE).map((chip) => tell(session, ["add", JSON.stringify(chip)]));
  if (draft?.text) writes.push(tell(session, ["draft", JSON.stringify(draft)]));
  return (await Promise.all(writes)).find((reply) => reply.ok === false) ?? {};
}

/**
 * The chips as the agent reads them, after the user's own words: each comment's place (on a removed line, the old
 * file's; on a commit's diff, that commit's), the lines it's on, quoted, then what it says after a blank line, so it
 * isn't read as part of the quote.
 */
export function withChips(message: string, sent: readonly Chip[]): string {
  const blocks = sent.map((chip) => {
    if (chip.kind === "agent") return chip.text;
    const { on, comment } = chip;
    const lines = comment.start === comment.end ? `${comment.start}` : `${comment.start}-${comment.end}`;
    const where = [on !== "review" && `in commit ${on.slice(0, 12)}`, comment.side === "deletions" && "before the change"].filter(Boolean).join(", ");
    return `${comment.path}:${lines}${where ? ` (${where})` : ""}\n${comment.excerpt.split("\n").map((line) => `> ${line}`).join("\n")}\n\n${comment.text}`;
  });
  return [message.trim(), ...blocks].filter(Boolean).join("\n\n");
}
