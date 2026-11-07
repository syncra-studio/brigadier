import { useSyncExternalStore } from "react";

import type { Backend, Frame, Link, Row, Run } from "./boundary";

/**
 * Where one of the user's own commands stands. `sending`: written, not yet answered. `accepted`:
 * the backend has it. `unknown`: the link dropped before an answer, so whether it arrived isn't
 * proven. `failed`: the backend refused it. `unsent`: the backend proved it never got it.
 */
export type Status = "sending" | "accepted" | "unknown" | "failed" | "unsent";

/** `attempt`: the client id it went out under last; a new one only after a proven refusal. */
export type Pending<C> = { attempt: string; command: C; status: Status; error: string | null };

/** One row as drawn: the backend's item, or the user's own still waiting on it. `key` never changes. */
export type Entry<I, C> = { key: string; item: I; pending: Pending<C> | null };

/** `order`: the rows' keys, the backend's first, then the user's own still waiting. */
export type Head = { link: Link; loaded: boolean; run: Run; order: string[]; downSince: number | null };

export type Session<I extends { id: string }, C> = ReturnType<typeof createSession<I, C>>;

/** A frame past a gap waits this long for the missing one, then the stream starts again. */
const GAP_MS = 1000;

export const newId = (): string => crypto.randomUUID();

/**
 * One session's state in memory: the backend's rows as last sent, plus the user's own commands it
 * hasn't confirmed. It never folds: a frame replaces, adds or drops a row whole.
 */
export function createSession<I extends { id: string }, C>(backend: Backend<I, C>) {
  let head: Head = { link: "connecting", loaded: false, run: { state: "idle" }, order: [], downSince: null };
  let seq = 0;
  const rows = new Map<string, Row<I>>();
  const own = new Map<string, Entry<I, C> & { pending: Pending<C> }>();
  const entries = new Map<string, Entry<I, C>>();
  // A retry's new client id → the key its row had from the start.
  const alias = new Map<string, string>();
  const early = new Map<number, Frame<I>>();
  let gapTimer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  const listeners = new Map<string, Set<() => void>>();
  const changed = new Set<string>();
  const HEAD = "";

  const keyOf = (row: Row<I>): string => (row.clientId ? (alias.get(row.clientId) ?? row.clientId) : row.item.id);
  const ownByAttempt = (clientId: string) => [...own.values()].find((entry) => entry.pending.attempt === clientId);

  function setHead(next: Partial<Head>): void {
    head = { ...head, ...next };
    changed.add(HEAD);
  }
  function setEntry(entry: Entry<I, C>): void {
    entries.set(entry.key, entry);
    changed.add(entry.key);
  }
  function setPending(entry: Entry<I, C> & { pending: Pending<C> }, next: Partial<Pending<C>>): void {
    const updated = { ...entry, pending: { ...entry.pending, ...next } };
    own.set(entry.key, updated);
    setEntry(updated);
  }
  function reorder(): void {
    setHead({ order: [...[...rows.values()].map(keyOf), ...own.keys()] });
  }
  function publish(): void {
    for (const key of changed) for (const listener of listeners.get(key) ?? []) listener();
    changed.clear();
  }

  /** The authoritative row replaces the user's own copy in the same update, under the same key. */
  function put(row: Row<I>): boolean {
    const isNew = !rows.has(row.item.id);
    rows.set(row.item.id, row);
    const mine = row.clientId ? ownByAttempt(row.clientId) : undefined;
    if (mine) own.delete(mine.key);
    setEntry({ key: keyOf(row), item: row.item, pending: null });
    return isNew || mine !== undefined;
  }

  function apply(frame: Frame<I>): void {
    seq = frame.seq;
    if (frame.type === "put") {
      if (put(frame.row)) reorder();
    } else if (frame.type === "drop") {
      const row = rows.get(frame.id);
      if (!row) return;
      rows.delete(frame.id);
      entries.delete(keyOf(row));
      reorder();
    } else if (frame.type === "run") {
      setHead({ run: frame.run });
      const mine = frame.cause ? ownByAttempt(frame.cause) : undefined;
      if (mine && (mine.pending.status === "sending" || mine.pending.status === "unknown")) setPending(mine, { status: "accepted" });
    } else if (frame.type === "rejected") {
      const mine = ownByAttempt(frame.clientId);
      if (mine) setPending(mine, { status: "failed", error: frame.error });
    }
  }

  function snapshot(frame: Extract<Frame<I>, { type: "snapshot" }>): void {
    early.clear();
    clearTimeout(gapTimer);
    gapTimer = undefined;
    seq = frame.seq;
    rows.clear();
    for (const key of [...entries.keys()]) if (!own.has(key)) entries.delete(key);
    for (const row of frame.rows) put(row);
    for (const entry of [...own.values()]) {
      const outcome = frame.outcomes[entry.pending.attempt];
      if (outcome?.kind === "applied") {
        // Applied, yet no row carries its id: the backend has since dropped it.
        own.delete(entry.key);
        entries.delete(entry.key);
      } else if (outcome?.kind === "rejected") setPending(entry, { status: "failed", error: outcome.error });
      else if (outcome?.kind === "unseen") setPending(entry, { status: "unsent", error: null });
      // `pending` or no answer: not terminal, so it stays as it is.
    }
    for (const key of entries.keys()) changed.add(key);
    setHead({ loaded: true, run: frame.run });
    reorder();
  }

  function receive(frame: Frame<I>): void {
    if (closed) return;
    if (frame.type === "beat") {
      // A frame past ours was lost with nothing after it to show the gap.
      if (head.loaded && frame.seq > seq) gapTimer ??= setTimeout(connect, GAP_MS);
      return;
    }
    if (frame.type === "snapshot") snapshot(frame);
    else if (head.loaded && frame.seq > seq) {
      early.set(frame.seq, frame);
      for (let next = early.get(seq + 1); next; next = early.get(seq + 1)) {
        early.delete(next.seq);
        apply(next);
      }
      if (early.size === 0) {
        clearTimeout(gapTimer);
        gapTimer = undefined;
      } else gapTimer ??= setTimeout(connect, GAP_MS);
    }
    publish();
  }

  function onLink(link: Link): void {
    if (closed || link === head.link) return;
    // Written but unanswered when the link went: whether it arrived isn't proven.
    if (link !== "live") for (const entry of own.values()) if (entry.pending.status === "sending") setPending(entry, { status: "unknown" });
    setHead({ link, downSince: link === "live" ? null : (head.downSince ?? Date.now()) });
    publish();
  }

  function ask(): string[] {
    return [...own.values()].filter((entry) => !["failed", "unsent"].includes(entry.pending.status)).map((entry) => entry.pending.attempt);
  }

  function connect(): void {
    gapTimer = undefined;
    if (!closed) backend.connect(ask, receive, onLink);
  }

  // One subscribe function per key and session, so React subscribes again only when either changes.
  const subscribers = new Map<string, (listener: () => void) => () => void>();
  function subscriber(key: string) {
    let subscribe = subscribers.get(key);
    if (!subscribe) {
      subscribe = (listener) => {
        const set = listeners.get(key) ?? new Set();
        listeners.set(key, set.add(listener));
        return () => set.delete(listener);
      };
      subscribers.set(key, subscribe);
    }
    return subscribe;
  }

  return {
    connect,

    /** Stops for good: no resync of a session the window no longer shows. */
    close(): void {
      closed = true;
      clearTimeout(gapTimer);
    },

    /** Shows `preview` at once. A second send under the same `clientId` does nothing. */
    send(clientId: string, command: C, preview: I): void {
      if (own.has(clientId) || entries.has(clientId) || head.link !== "live") return;
      const entry = { key: clientId, item: preview, pending: { attempt: clientId, command, status: "sending" as const, error: null } };
      own.set(clientId, entry);
      setEntry(entry);
      reorder();
      publish();
      backend.send({ clientId, command });
    },

    /** Only after a proven refusal or non-delivery, so a new id can't run it twice. */
    retry(key: string): void {
      const entry = own.get(key);
      if (!entry || !["failed", "unsent"].includes(entry.pending.status) || head.link !== "live") return;
      const attempt = newId();
      alias.set(attempt, key);
      setPending(entry, { attempt, status: "sending", error: null });
      publish();
      backend.send({ clientId: attempt, command: entry.pending.command });
    },

    /** The rollback: the user's refused or unsent row goes. */
    discard(key: string): void {
      const entry = own.get(key);
      if (!entry || !["failed", "unsent"].includes(entry.pending.status)) return;
      own.delete(key);
      entries.delete(key);
      reorder();
      publish();
    },

    useHead: (): Head => useSyncExternalStore(subscriber(HEAD), () => head),

    useEntry: (key: string): Entry<I, C> | undefined => useSyncExternalStore(subscriber(key), () => entries.get(key)),
  };
}
