import type { Chip } from "../chips";
import type { Draft } from "../draft";
import type { Runner } from "./run";

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

const NONE: readonly Going[] = [];

/** The value after `name` in a message's command, among its options: after `send <id> <text>`, `queue <id> add <text>` or `start <id>`, so its words are never read as one. */
export function flagOf(op: readonly string[], name: string): string | undefined {
  const opts = op.slice(op[0] === "queue" ? 4 : op[0] === "start" ? 2 : 3);
  // A start's words are `--text`'s value: stepped over, as Rust does (book/args.rs).
  for (let i = 0; i < opts.length; i += opts[i] === "--text" && name !== "--text" ? 2 : 1) if (opts[i] === name) return opts[i + 1];
  return undefined;
}

/** Why one Rust's book holds isn't on its way: no reply said where it is. */
export const UNCONFIRMED = "it couldn't be confirmed";
/** A start Rust answers is in its session's log already, or settled: the session's own row takes over [D54]. */
export const went = (reply: Record<string, any>): boolean => Boolean(reply.went) || reply.result === "went" || reply.result === "settled";

/** What came of a start or recover, by Rust's reply, in the desktop's order; never by the session merely existing. */
export function startOutcome(reply: Record<string, any>): "unknown" | "back" | "went" | "delivered" | "logged" | "refused" {
  if (reply.error === "disconnected") return "unknown";
  if (reply.given_back) return "back";
  if (went(reply)) return "went";
  // A fork answers with its session once it holds all it needs [D35].
  const result = reply.result ?? (reply.ok && reply.session ? "delivered" : undefined);
  return result === "delivered" || result === "logged" ? result : "refused";
}
/**
 * Rust's book has the start now, or what came of it: the app's copy goes. An error before the book took it (its lock,
 * its write) says neither: the copy stays for Try again, as a session's send keeps its own.
 */
export const owned = (reply: Record<string, any>): boolean => Boolean(reply.ok || reply.given_back || reply.unsettled === true || reply.logged !== undefined || went(reply));
export const loggedWhy = (reply: Record<string, any>) => (reply.error ? String(reply.error) : "It reached the log, but not the agent.");

/**
 * One Mac's messages on their way, kept under `prefix` [D58]: the desktop's one Mac `brigadier.uncertain.`, a phone's
 * each paired Mac its own, so one Mac's records are never read, pruned or sent to another.
 */
export function uncertainState(prefix: string) {
  const key = (session: string) => prefix + session;
  const all = new Map<string, readonly Going[]>();
  const listeners = new Set<() => void>();
  // The chip store's, set by it [D363].
  let chipsBack: (id: string, chips: readonly Chip[], ids?: readonly string[]) => void = () => {};

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

  const keepGoing = (session: string, entry: Going) => (put(session, [...of(session).filter((each) => each.cid !== entry.cid), entry]), entry);
  const keptOf = (session: string, cid: string) => of(session).find((each) => each.cid === cid);
  const forget = (session: string, cid: string) => of(session).some((each) => each.cid === cid) && put(session, of(session).filter((each) => each.cid !== cid));
  const markGoing = (session: string, cid: string, change: Partial<Going>) => put(session, of(session).map((each) => (each.cid === cid ? { ...each, ...change } : each)));

  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };

  /** The chips messages on their way here carry: a read of Rust's doesn't show them waiting meanwhile. */
  const heldChips = (session: string) => new Set(of(session).flatMap((each) => flagOf(each.op, "--chips")?.split(",") ?? []));

  /** Message `kept`, kept here, Rust gave back: its chips wait again, Rust's `given` or the app's copy, and any a chip read held back for it. */
  const keptChipsBack = (id: string, kept: Going | undefined, given?: readonly Chip[]) =>
    chipsBack(id, given?.length ? given : (kept?.chips ?? []), (kept && flagOf(kept.op, "--chips")?.split(",")) || []);

  /** Rust's book as the draft's read shows it: each there is Rust's now, and one not kept here yet comes in. */
  function fromBook(session: string, going: readonly (Pick<Going, "cid" | "kind" | "op" | "draft" | "reached" | "left"> & { error?: string | null })[]): void {
    const theirs = new Map(going.map((each) => [each.cid, each]));
    const now = of(session).map((each) => (theirs.has(each.cid) ? { ...each, booked: true, reached: theirs.get(each.cid)!.reached } : each));
    // A start stays with why Rust refused it, its session kept [C65].
    const fresh = going.filter((each) => !now.some((one) => one.cid === each.cid)).map(({ error, ...each }): Going => ({ ...each, booked: true, stuck: error || UNCONFIRMED }));
    put(session, [...now, ...fresh]);
  }

  /** A session gone from Rust's list takes what was kept for it [D35]; Home's drafts, no session's, keep theirs. */
  function pruneUncertain(ids: ReadonlySet<string>): void {
    for (const at of Object.keys(localStorage).filter((each) => each.startsWith(prefix) && !each.startsWith(`${prefix}@home`) && !ids.has(each.slice(prefix.length)))) {
      localStorage.removeItem(at);
      all.delete(at.slice(prefix.length));
    }
  }

  const telling = new Map<string, Promise<void>>();
  /**
   * Tells Rust each Delete in session `id` it hasn't heard (`drop`), before its draft is read or saved, so a message
   * Rust gave back for one never comes in, and words typed since stay [D363]. Gone, its chips wait again.
   */
  function tellDrops(run: Runner, id: string): Promise<unknown> {
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
  return { keepGoing, keptOf, forget, markGoing, subscribe, goingOf: of, heldChips, fromBook, pruneUncertain, tellDrops, keptChipsBack, onChipsBack: (back: typeof chipsBack) => void (chipsBack = back), giveChips: (id: string, chips: readonly Chip[]) => chipsBack(id, chips) };
}

export type Uncertain = ReturnType<typeof uncertainState>;
