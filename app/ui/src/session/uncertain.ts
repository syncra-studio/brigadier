import { useSyncExternalStore } from "react";

import type { Draft } from "../components/composer/draft";
import type { Chip } from "../panel/chips";
import type { Runner } from "./composer";
import { keptChipsBack } from "./draft";

/*
 * Messages on their way, sends and queue adds [D54, C58], and Home's new chats (`start`, kept under the Home draft's key) [C65]. Each is kept in the renderer's own store, which outlives a
 * reload, from before the field empties until Rust says its book has it (the command's own reply, the draft's read, or
 * `draft <id> adopt` on a later connection) or what came of it: an empty book is no answer. Rust's then: its bubble or
 * queue row comes from Rust's book (`draft <id>`'s `going`), with Try again or Add again, Discard or Delete, and Edit.
 * A Delete Rust hasn't heard yet is kept too (`removing`), and told before the draft is read or saved, so what Rust
 * gave back for it never comes into the draft. Only this file names what the app keeps; Rust decides the rest.
 * PROPOSED: "May have been sent" / "May not have been added"; "Not sent" / "Not added" for one no host was asked.
 */
export type Going = {
  cid: string;
  /** A start is Home's draft's new chat [C65]. */
  kind: "send" | "queue" | "start";
  /** Its command as it goes, its chips (`--chips`) named; empty for one from an older book. */
  op: string[];
  /** The field's draft it was sent from, without its chips' words. */
  draft: Draft;
  /** The field's revision it went from, which Rust's book needs to know a save of its words as its own; none for one not the field's. */
  rev?: number | null;
  /** When it was sent here; none for one only Rust's book told of, whose time it doesn't keep. */
  at?: number;
  chips?: readonly Chip[];
  /** Rust's book has it, or settled it: kept in memory only. */
  booked?: boolean;
  /** An attempt may have reached a host; false for one only adopted. */
  reached?: boolean;
  /** Why it isn't on its way, shown with its actions; none while it goes. */
  stuck?: string;
  removing?: boolean;
  /** A start whose session couldn't go: only Discard goes on with it. */
  left?: boolean;
  /** Another session's brief tried again: never Rust's book's, so never given back as the user's words [D2034]. */
  peer?: boolean;
};

const PREFIX = "brigadier.uncertain.";
const key = (session: string) => PREFIX + session;
const all = new Map<string, readonly Going[]>();
const listeners = new Set<() => void>();
const NONE: readonly Going[] = [];

function of(session: string): readonly Going[] {
  if (!all.has(session)) {
    let kept: Going[] = [];
    try {
      kept = JSON.parse(localStorage.getItem(key(session)) ?? "[]");
    } catch {
      // Not ours to read: nothing is kept.
    }
    // Kept before sends were: a queue add whose reply never came, its command made again.
    type Old = { qid: string; text: string; parts?: string; chips?: readonly Chip[] };
    const op = (old: Old) => ["queue", session, "add", old.text, "--qid", old.qid, ...(old.parts ? ["--parts", old.parts] : []), ...(old.chips?.length ? ["--chips", old.chips.map((chip) => chip.id).join(",")] : [])];
    kept = kept.map((each) => (Array.isArray(each.op) ? each : { ...each, cid: (each as unknown as Old).qid, kind: "queue", op: op(each as unknown as Old) }));
    all.set(session, kept.length > 0 ? kept : NONE);
  }
  return all.get(session)!;
}

function put(session: string, next: readonly Going[]): void {
  all.set(session, next.length > 0 ? next : NONE);
  const mine = next.filter((each) => !each.booked || each.removing);
  if (mine.length > 0) localStorage.setItem(key(session), JSON.stringify(mine));
  else localStorage.removeItem(key(session));
  for (const listener of listeners) listener();
}

export const keepGoing = (session: string, entry: Going) => (put(session, [...of(session).filter((each) => each.cid !== entry.cid), entry]), entry);
export const keptOf = (session: string, cid: string) => of(session).find((each) => each.cid === cid);
export const forget = (session: string, cid: string) => of(session).some((each) => each.cid === cid) && put(session, of(session).filter((each) => each.cid !== cid));
export const markGoing = (session: string, cid: string, change: Partial<Going>) => put(session, of(session).map((each) => (each.cid === cid ? { ...each, ...change } : each)));

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
export const useGoingOf = (session: string) => useSyncExternalStore(subscribe, () => of(session));
export const goingOf = of;

/** The value after `name` in a message's command, among its options: after `send <id> <text>`, `queue <id> add <text>` or `start <id>`, so its words are never read as one. */
export function flagOf(op: readonly string[], name: string): string | undefined {
  const opts = op.slice(op[0] === "queue" ? 4 : op[0] === "start" ? 2 : 3);
  // A start's words are `--text`'s value: stepped over, as Rust does (book/args.rs).
  for (let i = 0; i < opts.length; i += opts[i] === "--text" && name !== "--text" ? 2 : 1) if (opts[i] === name) return opts[i + 1];
  return undefined;
}

/** The chips messages on their way here carry: a read of Rust's doesn't show them waiting meanwhile. */
export const heldChips = (session: string) => new Set(of(session).flatMap((each) => flagOf(each.op, "--chips")?.split(",") ?? []));

/** Why one Rust's book holds isn't on its way: no reply said where it is. */
export const UNCONFIRMED = "it couldn't be confirmed";

/** Rust's book as the draft's read shows it: each there is Rust's now, and one not kept here yet comes in. */
export function fromBook(session: string, going: readonly (Pick<Going, "cid" | "kind" | "op" | "draft" | "reached" | "left"> & { error?: string | null })[]): void {
  const theirs = new Map(going.map((each) => [each.cid, each]));
  const now = of(session).map((each) => (theirs.has(each.cid) ? { ...each, booked: true, reached: theirs.get(each.cid)!.reached } : each));
  // A start stays with why Rust refused it, its session kept [C65].
  const fresh = going.filter((each) => !now.some((one) => one.cid === each.cid)).map(({ error, ...each }): Going => ({ ...each, booked: true, stuck: error || UNCONFIRMED }));
  put(session, [...now, ...fresh]);
}

/** A session gone from Rust's list takes what was kept for it [D35]; Home's drafts, no session's, keep theirs. */
export function pruneUncertain(ids: ReadonlySet<string>): void {
  for (const at of Object.keys(localStorage).filter((each) => each.startsWith(PREFIX) && !each.startsWith(`${PREFIX}@home`) && !ids.has(each.slice(PREFIX.length)))) {
    localStorage.removeItem(at);
    all.delete(at.slice(PREFIX.length));
  }
}

const telling = new Map<string, Promise<void>>();
/**
 * Tells Rust each Delete in session `id` it hasn't heard (`drop`), before its draft is read or saved, so a message
 * Rust gave back for one never comes in, and words typed since stay [D363]. Gone, its chips wait again.
 */
export function tellDrops(run: Runner, id: string): Promise<unknown> {
  const tell = (each: Going) => {
    const job = run(["draft", id, "drop", each.cid]).then((reply) => {
      telling.delete(each.cid);
      // In the log already, the thread shows it.
      if (reply.ok || reply.logged) forget(id, each.cid);
      // It may have reached its agent: it stays, with Try again only [C75].
      if (reply.maybe) markGoing(id, each.cid, { removing: false, reached: true });
      // Back already (a drop whose reply was lost), Rust names none: the ones a chip read held back for it show.
      if (reply.ok) keptChipsBack(id, each, reply.chips);
    });
    telling.set(each.cid, job);
    return job;
  };
  return Promise.all(of(id).filter((each) => each.removing).map((each) => telling.get(each.cid) ?? tell(each)));
}
