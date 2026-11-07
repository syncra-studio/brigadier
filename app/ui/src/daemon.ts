import { useSyncExternalStore } from "react";

export type Daemon = { pid: number; version: string };
export type Row = { id: string; title: string; state: string; backend: string; updated: number; items: number; error: string | null };
export type Search = { q: string; pending: boolean; ids?: string[]; error?: string };

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
// The list at N, then each update N+1, N+2… in order [D40]. A gap asks for a fresh list.
let rows = new Map<string, Row>();
let n: number | undefined;
const listeners = new Set<() => void>();

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

function subscribe(): void {
  n = undefined;
  listId = send({ op: "subscribe" });
}

function onFrame(frame: Record<string, any>): void {
  if (frame.status === "running") {
    set({ daemon: { pid: frame.pid, version: frame.version }, refused: undefined });
    subscribe();
    if (view.search.q.trim()) search(view.search.q);
  } else if (frame.status === "refused") {
    set({ daemon: null, refused: frame.error });
  } else if (frame.re === listId) {
    rows = new Map(frame.rows.map((row: Row) => [row.id, row]));
    n = frame.n;
    set({ rows: [...rows.values()] });
  } else if (frame.re === searchId) {
    set({ search: { q: view.search.q, pending: false, ids: frame.ok ? frame.ids : undefined, error: frame.ok ? undefined : frame.error } });
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
  set({ search: { ...view.search, q, pending: true, error: undefined } });
  searchId = send({ op: "search", q });
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
