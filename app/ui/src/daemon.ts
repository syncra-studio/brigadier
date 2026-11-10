import { useSyncExternalStore } from "react";

import type { Mark } from "./sidebar/words";
import type { Item, Session, Turn, Work } from "./thread/item";
import type { Source } from "./thread/thread";

export type Daemon = { pid: number; version: string };
/** A project as Rust keeps it [D165, D171]: `trusted` is null until the owner answers; `include` (paths to copy into worktrees) and `setup` are Project settings' [D178, D202]; `removing` while Remove project runs [D172]. */
export type Project = { id: string; name: string; folder: string; trusted: boolean | null; setup: string; include: string[]; added: number; removing?: boolean };
/** A session's row; `mark` and the facts behind it (reason, resets, sent, finished) are Rust's [D173]. */
export type Row = {
  id: string;
  title: string;
  state: string;
  reason: unknown;
  mark: Mark;
  resets: number | null;
  sent: number;
  finished: number;
  project: string | null;
  /** When it was pinned (ms), or null [D185]. */
  pinned?: number | null;
  /** When it was archived (ms), or null; and an archive, restore or delete under way, or a delete that left something [D180]. */
  archived?: number | null;
  lifecycle?: { op: "archive" | "restore" | "delete"; left?: string[] } | null;
  /** When its folder last changed (ms): how far Rust's row has caught up with an action. */
  touched?: number;
  backend: string;
  updated: number;
  items: number;
  error: string | null;
  /** An agent is working in it now: what keeps the computer awake "while agents work". */
  works?: boolean;
};

export type View = {
  /** undefined until the first answer, then the running daemon or null. */
  daemon: Daemon | null | undefined;
  refused?: string;
  /** undefined until the first list; kept while disconnected, so it never flashes empty. */
  rows?: Row[];
  /** The same for the projects, which come with the rows [D40, D71]. */
  projects?: Project[];
};

let view: View = { daemon: undefined };
let port: MessagePort | undefined;
let bytes = new Uint8Array();
let nextId = 0;
let listId = 0;
// The list at N, then each update N+1, N+2… in order [D40]. A gap asks for a fresh list.
let rows = new Map<string, Row>();
let projects = new Map<string, Project>();
let n: number | undefined;
const listeners = new Set<() => void>();
// One-off replies by request id (a command, the terminal's stream), and where terminal frames go.
const replies = new Map<number, (frame: Record<string, any>) => void>();
let onTerm: ((frame: Record<string, any>) => void) | undefined;

/** The open thread's request: what the view shows beside the rows (loading, not found, an error). */
export type ThreadState = { id: string; status: "loading" | "ready" | "missing" | "error"; error?: string };
// One open thread: its snapshot at N, then updates N+1, N+2… that replace rows by id [D40, D64].
let thread: ThreadState | undefined;
let session: Session | null = null;
let threadRe = 0;
let threadN: number | undefined;
let itemAt = new Map<string, number>();
// The `n` of the first row held, or null once the whole history is in; the older page asked for, if any [D97].
let before: number | null = null;
let olderRe = 0;
// The older page's answer, for whoever asked; and whether pages older than the snapshot came.
let olderDone: ((result: Paged) => void)[] = [];
let paged = false;
const threadListeners = new Set<() => void>();
// The sessions last left, as Rust last sent them: one opened again paints at once, and its snapshot then replaces the
// rows by id [D30].
const KEPT_THREADS = 10;
const left = new Map<string, Session>();

function set(next: Partial<View>): void {
  view = { ...view, ...next };
  for (const listener of listeners) listener();
}

/** Sends a request to the daemon; `onReply` gets its answer, or a disconnected error. */
export function ask(request: object, onReply?: (frame: Record<string, any>) => void): number {
  if (!view.daemon) {
    onReply?.({ ok: false, error: "disconnected" });
    return 0;
  }
  const id = send(request);
  if (onReply) replies.set(id, onReply);
  return id;
}

/** Where a sign-in terminal's pushed frames go: one at a time [D45]. */
export function setTermHandler(handler: typeof onTerm): void {
  onTerm = handler;
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

/** An older page came (`before`: the new first row's `n`, null once the whole history is in), or why not. */
export type Paged = { ok: true; before: number | null } | { ok: false; error: string };
/** Find in the conversation's matches in the rows not loaded: each row's `n` and how many [D470]. */
export type Older = { ok: true; matches: { n: number; count: number }[]; more: boolean } | { ok: false; error: string };

function paging(result: Paged): void {
  olderRe = 0;
  const waiting = olderDone;
  olderDone = [];
  for (const done of waiting) done(result);
}

function watch(): void {
  threadN = undefined;
  if (olderRe) paging({ ok: false, error: "stale" });
  if (thread && view.daemon) threadRe = send({ op: "thread", session: thread.id });
}

function keep(id: string, kept: Session): void {
  left.delete(id);
  left.set(id, kept);
  if (left.size > KEPT_THREADS) left.delete(left.keys().next().value!);
}

/** When each session was last peeked at (0 while a peek is on its way). */
const peeked = new Map<string, number>();
/**
 * The pointer or focus is on a session: Rust's snapshot of it, unfollowed, into the kept threads, so opening it
 * paints its rows at once instead of an empty column until the watch's snapshot comes [D477].
 */
export function peekThread(id: string): void {
  const at = peeked.get(id);
  if (thread?.id === id || at === 0 || (at !== undefined && performance.now() - at < 2000)) return;
  peeked.set(id, 0);
  ask({ op: "peek", session: id }, (reply) => {
    peeked.set(id, performance.now());
    if (!reply.ok || (thread?.id === id && thread.status === "ready")) return;
    keep(id, reply.session);
    // Opened while it was on its way: it paints now, and the watch's snapshot replaces it.
    if (thread?.id === id && !session) setThread(thread, reply.session);
  });
}

/** Opens a session's thread; the last one's rows go at once, so no other session flashes in. */
export function openThread(id: string): void {
  if (thread?.id === id && (thread.status === "loading" || thread.status === "ready")) return;
  // Older pages aren't kept: the snapshot starts at the newest page, so it would take those rows away under the view.
  if (thread?.status === "ready" && session && !paged) keep(thread.id, session);
  setThread({ id, status: "loading" }, left.get(id) ?? null);
  watch();
}

function applyThread(frame: Record<string, any>): void {
  if (!thread || frame.watch !== threadRe) return;
  // The session was made again under the same id: start over from a fresh snapshot.
  if (frame.reset) return watch();
  if (frame.error) return setThread({ id: thread.id, status: frame.error === "not_found" ? "missing" : "error", error: frame.error });
  if (!session || threadN === undefined) return;
  if (frame.n !== threadN + 1) return watch();
  threadN = frame.n;
  const items = frame.items.length ? session.items.slice() : session.items;
  for (const item of frame.items as Item[]) {
    const at = itemAt.get(item.id);
    // A row older than the pages held comes with its page.
    if (at === undefined && before !== null && item.n !== undefined && item.n < before) continue;
    if (at === undefined) itemAt.set(item.id, items.push(item) - 1);
    else items[at] = item;
  }
  let turns = session.turns;
  for (const turn of frame.turns as Turn[]) {
    const at = turns.findIndex((each) => each.id === turn.id);
    turns = at < 0 ? [...turns, turn] : turns.with(at, turn);
  }
  setThread(thread, {
    ...session, items, turns, work: frame.work.length ? [...(session.work ?? []), ...frame.work] : session.work,
    setup: "setup" in frame ? frame.setup : session.setup,
    approvals: frame.approvals ?? session.approvals,
    questions: frame.questions ?? session.questions,
    rewind: frame.rewind ?? session.rewind,
  });
}

function subscribe(): void {
  n = undefined;
  listId = send({ op: "subscribe" });
}

function onFrame(frame: Record<string, any>): void {
  const reply = replies.get(frame.re);
  if (reply) {
    replies.delete(frame.re);
    return reply(frame);
  }
  if (frame.term !== undefined) return onTerm?.(frame);
  if (frame.status === "running") {
    set({ daemon: { pid: frame.pid, version: frame.version }, refused: undefined });
    subscribe();
    watch();
  } else if (frame.status === "refused") {
    set({ daemon: null, refused: frame.error });
  } else if (frame.re === listId) {
    rows = new Map(frame.rows.map((row: Row) => [row.id, row]));
    projects = new Map(frame.projects.map((project: Project) => [project.id, project]));
    n = frame.n;
    set({ rows: [...rows.values()], projects: [...projects.values()] });
  } else if (thread && frame.re === threadRe) {
    if (!frame.ok) return setThread({ id: thread.id, status: frame.error === "not_found" ? "missing" : "error", error: frame.error });
    const next: Session = frame.session;
    itemAt = new Map(next.items.map((item, at) => [item.id, at]));
    threadN = frame.n;
    before = frame.session.before;
    paged = false;
    setThread({ id: thread.id, status: "ready" }, next);
  } else if (thread && session && olderRe && frame.re === olderRe) {
    if (!frame.ok) return paging({ ok: false, error: frame.error });
    const turns = new Set(session.turns.map((turn) => turn.id));
    const work = new Set(session.work?.map((each) => each.turnId));
    const items = [...(frame.items as Item[]), ...session.items];
    itemAt = new Map(items.map((item, at) => [item.id, at]));
    before = frame.before;
    paged = true;
    setThread(thread, {
      ...session,
      before,
      items,
      turns: [...(frame.turns as Turn[]).filter((turn) => !turns.has(turn.id)), ...session.turns],
      work: [...(frame.work as Work[]).filter((each) => !work.has(each.turnId)), ...(session.work ?? [])],
    });
    paging({ ok: true, before });
  } else if (frame.thread !== undefined) {
    applyThread(frame);
  } else if (frame.re === undefined && typeof frame.n === "number" && n !== undefined) {
    if (frame.n !== n + 1) return subscribe();
    n = frame.n;
    for (const row of frame.rows as Row[]) rows.set(row.id, row);
    for (const id of frame.gone as string[]) rows.delete(id);
    for (const project of (frame.projects ?? []) as Project[]) projects.set(project.id, project);
    for (const id of (frame.projects_gone ?? []) as string[]) projects.delete(id);
    set({ rows: [...rows.values()], projects: [...projects.values()] });
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

/** How long after the page loads a daemon that hasn't answered yet counts as still starting. */
const STARTING_MS = 5000;

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
    const waiting = [...replies.values()];
    replies.clear();
    if (olderRe) paging({ ok: false, error: "disconnected" });
    // Before the first connection a failed try is the daemon main just launched still starting: connecting, not
    // disconnected. The socket tries every 250ms, so one that never comes up says so once this has passed [D476].
    if (view.daemon !== undefined || performance.now() > STARTING_MS) set({ daemon: null });
    for (const reply of waiting) reply({ ok: false, error: "disconnected" });
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
export const threadSource: Omit<Source, "older"> & { older(): Promise<Paged>; findOlder(query: string, limit: number): Promise<Older> } = {
  subscribe(listener) {
    threadListeners.add(listener);
    return () => threadListeners.delete(listener);
  },
  get: () => session,
  older() {
    // `before` is only this session's once its snapshot is in.
    if (!thread || !session || threadN === undefined) return Promise.resolve({ ok: false, error: "loading" });
    if (before === null) return Promise.resolve({ ok: true, before: null });
    if (!olderRe && !view.daemon) return Promise.resolve({ ok: false, error: "disconnected" });
    if (!olderRe) olderRe = send({ op: "thread_older", session: thread.id, before });
    return new Promise((done) => olderDone.push(done));
  },
  findOlder(query, limit) {
    // Bound to this session's watch: an answer after it changed (another session, a reconnect) is dropped.
    const id = thread?.id;
    const re = threadRe;
    return new Promise((done) => {
      if (!id || !session || threadN === undefined) return done({ ok: false, error: "loading" });
      if (before === null) return done({ ok: true, matches: [], more: false });
      ask({ op: "thread_find", session: id, before, query, limit }, (frame) => {
        if (thread?.id !== id || threadRe !== re) return done({ ok: false, error: "stale" });
        done(frame.ok ? { ok: true, matches: frame.matches, more: frame.more } : { ok: false, error: frame.error });
      });
    });
  },
};

export const useThread = (): ThreadState | undefined => useSyncExternalStore(threadSource.subscribe, () => thread);
