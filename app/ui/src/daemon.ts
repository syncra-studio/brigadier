import { useSyncExternalStore } from "react";

import type { Item, Session, Turn } from "./thread/item";
import type { Source } from "./thread/thread";

export type Daemon = { pid: number; version: string };
export type Row = { id: string; title: string; state: string; backend: string; updated: number; items: number; error: string | null };
/** `slow` turns on only once a query has been pending for SLOW_MS, so fast typing never flickers. */
export type Search = { q: string; pending: boolean; slow?: boolean; ids?: string[]; error?: string };

export type View = {
  /** undefined until the first answer, then the running daemon or null. */
  daemon: Daemon | null | undefined;
  refused?: string;
  /** undefined until the first list; kept while disconnected, so it never flashes empty. */
  rows?: Row[];
  search: Search;
};

let view: View = { daemon: undefined, search: { q: "", pending: false } };
let port: MessagePort | undefined;
let bytes = new Uint8Array();
let nextId = 0;
let listId = 0;
let searchId = 0;
const SLOW_MS = 200;
// The list at N, then each update N+1, N+2… in order [D40]. A gap asks for a fresh list.
let rows = new Map<string, Row>();
let n: number | undefined;
const listeners = new Set<() => void>();

/** The open thread's request: what the view shows beside the rows (loading, not found, an error). */
export type ThreadState = { id: string; status: "loading" | "ready" | "missing" | "error"; error?: string };
// One open thread: its snapshot at N, then updates N+1, N+2… that replace rows by id [D40, D64].
let thread: ThreadState | undefined;
let session: Session | null = null;
let threadRe = 0;
let threadN: number | undefined;
let itemAt = new Map<string, number>();
const threadListeners = new Set<() => void>();

function set(next: Partial<View>): void {
  view = { ...view, ...next };
  for (const listener of listeners) listener();
}

function send(request: object): number {
  const id = ++nextId;
  const json = new TextEncoder().encode(JSON.stringify({ id, ...request }));
  const frame = new Uint8Array(4 + json.length);
  new DataView(frame.buffer).setUint32(0, json.length);
  frame.set(json, 4);
  port?.postMessage(frame);
  return id;
}

function setThread(next: ThreadState | undefined, nextSession = session): void {
  thread = next;
  session = nextSession;
  for (const listener of threadListeners) listener();
}

function watch(): void {
  threadN = undefined;
  if (thread && view.daemon) threadRe = send({ op: "thread", session: thread.id });
}

/** Opens a session's thread; the last one's rows go at once, so no other session flashes in. */
export function openThread(id: string): void {
  if (thread?.id === id) return;
  setThread({ id, status: "loading" }, null);
  watch();
}

function applyThread(frame: Record<string, any>): void {
  if (!session || threadN === undefined) return;
  if (frame.error) return setThread({ id: session.id, status: "error", error: frame.error });
  if (frame.n !== threadN + 1) return watch();
  threadN = frame.n;
  const items = session.items.slice();
  for (const item of frame.items as Item[]) {
    const at = itemAt.get(item.id);
    if (at === undefined) itemAt.set(item.id, items.push(item) - 1);
    else items[at] = item;
  }
  let turns = session.turns;
  for (const turn of frame.turns as Turn[]) {
    const at = turns.findIndex((each) => each.id === turn.id);
    turns = at < 0 ? [...turns, turn] : turns.with(at, turn);
  }
  setThread(thread, { ...session, items, turns, work: [...(session.work ?? []), ...frame.work] });
}

function subscribe(): void {
  n = undefined;
  listId = send({ op: "subscribe" });
}

function onFrame(frame: Record<string, any>): void {
  if (frame.status === "running") {
    set({ daemon: { pid: frame.pid, version: frame.version }, refused: undefined });
    subscribe();
    watch();
    if (view.search.q.trim()) search(view.search.q);
  } else if (frame.status === "refused") {
    set({ daemon: null, refused: frame.error });
  } else if (frame.re === listId) {
    rows = new Map(frame.rows.map((row: Row) => [row.id, row]));
    n = frame.n;
    set({ rows: [...rows.values()] });
  } else if (frame.re === searchId) {
    // Only the latest query's reply lands; it swaps the results in place, never backwards.
    const { q, ids } = view.search;
    set({ search: { q, pending: false, ids: frame.ok ? frame.ids : ids, error: frame.ok ? undefined : frame.error } });
  } else if (thread && frame.re === threadRe) {
    if (!frame.ok) return setThread({ id: thread.id, status: frame.error === "not_found" ? "missing" : "error", error: frame.error });
    const next: Session = frame.session;
    itemAt = new Map(next.items.map((item, at) => [item.id, at]));
    threadN = frame.n;
    setThread({ id: thread.id, status: "ready" }, next);
  } else if (frame.thread !== undefined) {
    if (frame.thread === thread?.id) applyThread(frame);
  } else if (frame.re === undefined && typeof frame.n === "number" && n !== undefined) {
    if (frame.n !== n + 1) return subscribe();
    n = frame.n;
    for (const row of frame.rows as Row[]) rows.set(row.id, row);
    for (const id of frame.gone as string[]) rows.delete(id);
    set({ rows: [...rows.values()] });
  }
}

function receive(chunk: Uint8Array): void {
  bytes = new Uint8Array([...bytes, ...chunk]);
  while (bytes.length >= 4) {
    const end = 4 + new DataView(bytes.buffer).getUint32(0);
    if (bytes.length < end) return;
    onFrame(JSON.parse(new TextDecoder().decode(bytes.subarray(4, end))));
    bytes = bytes.slice(end);
  }
}

/** Searches the daemon's index; an empty query shows every session. */
export function search(q: string): void {
  if (!q.trim()) {
    searchId = 0;
    return set({ search: { q, pending: false } });
  }
  if (!view.daemon) return set({ search: { q, pending: false, error: "Daemon not reachable" } });
  // The current results stay on screen until the reply swaps them.
  set({ search: { ...view.search, q, pending: true, slow: false, error: undefined } });
  const id = (searchId = send({ op: "search", q }));
  setTimeout(() => searchId === id && view.search.pending && set({ search: { ...view.search, slow: true } }), SLOW_MS);
}

// At module level, not in an effect: main posts the port once the page has loaded, maybe before React's first effect.
window.addEventListener("message", (event) => {
  if (event.source !== window || event.data !== "daemon-port") return;
  [port] = event.ports;
  bytes = new Uint8Array();
  port.onmessage = ({ data }: MessageEvent<Uint8Array | null>) => {
    if (data) return receive(data);
    bytes = new Uint8Array();
    n = undefined;
    // The open thread keeps its rows while disconnected; reconnecting asks for a fresh snapshot.
    threadN = undefined;
    set({ daemon: null });
  };
});

export const useDaemon = (): View =>
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => view,
  );

/** The open thread as the view's source: null while it loads. */
export const threadSource: Source = {
  subscribe(listener) {
    threadListeners.add(listener);
    return () => threadListeners.delete(listener);
  },
  get: () => session,
};

export const useThread = (): ThreadState | undefined => useSyncExternalStore(threadSource.subscribe, () => thread);
