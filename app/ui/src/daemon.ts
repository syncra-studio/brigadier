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
// Chunks come after `bytes`; `held` counts both.
let chunks: Uint8Array[] = [];
let held = 0;
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
// After find went to an island far up, the `n` of the first newer row not held, or null when the rows held reach the
// newest; those come a page at a time as the view scrolls down to them [D503].
let after: number | null = null;
// Bumped when the rows held start over (a snapshot, an island), so a page asked for before then is dropped.
let rowsRun = 0;
let newerAsked = false;
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

/**
 * A page or an island put with the rows held: where they touch, one run of rows by `n`, the page's copies winning (it
 * was read after them); where they don't, the island alone, and the rows newer than it come as the view gets there.
 */
function merge(frame: Record<string, any>): void {
  if (!thread || !session) return;
  const got = frame.items as Item[];
  const [first, end] = [session.items[0]?.n ?? Infinity, after ?? Infinity];
  const [from, to] = [got[0]?.n ?? Infinity, (frame.after as number | null) ?? Infinity];
  const touch = from <= end && to >= first;
  const above = from < first;
  if (!touch) rowsRun++;
  const byId = new Map(touch ? session.items.map((item) => [item.id, item]) : []);
  for (const item of got) byId.set(item.id, item);
  const items = touch && got.length === 0 ? session.items : [...byId.values()].sort((a, b) => (a.n ?? 0) - (b.n ?? 0));
  if (!touch || above) before = frame.before;
  if (!touch) after = frame.after;
  else if (frame.after === null || after === null) after = null;
  else after = Math.max(after, frame.after);
  const join = <T,>(have: readonly T[], come: readonly T[], key: (each: T) => string): T[] => {
    if (!touch) return [...come];
    const fresh = new Map(come.map((each) => [key(each), each]));
    const kept = new Set(have.map(key));
    const extra = come.filter((each) => !kept.has(key(each)));
    const now = have.map((each) => fresh.get(key(each)) ?? each);
    return above ? [...extra, ...now] : [...now, ...extra];
  };
  itemAt = new Map(items.map((item, at) => [item.id, at]));
  paged = true;
  setThread(thread, {
    ...session,
    before,
    after,
    items,
    turns: join(session.turns, frame.turns as Turn[], (turn) => turn.id),
    work: join(session.work ?? [], frame.work as Work[], (each) => each.turnId),
  });
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
    // A row older than the pages held, or newer than an island's, comes with its page.
    if (at === undefined && before !== null && item.n !== undefined && item.n < before) continue;
    if (at === undefined && after !== null && item.n !== undefined && item.n >= after) continue;
    if (at === undefined) itemAt.set(item.id, items.push(item) - 1);
    else items[at] = item;
  }
  let turns = session.turns;
  for (const turn of frame.turns as Turn[]) {
    const at = turns.findIndex((each) => each.id === turn.id);
    // Under an island a new turn comes with the page that reaches it, so the turns stay in order.
    if (at < 0 && after !== null) continue;
    turns = at < 0 ? [...turns, turn] : turns.with(at, turn);
  }
  const work = after === null ? (frame.work as Work[]) : (frame.work as Work[]).filter((each) => turns.some((turn) => turn.id === each.turnId));
  setThread(thread, {
    ...session, items, turns, work: work.length ? [...(session.work ?? []), ...work] : session.work,
    setup: "setup" in frame ? frame.setup : session.setup,
    approvals: frame.approvals ?? session.approvals,
    questions: frame.questions ?? session.questions,
    rewind: frame.rewind ?? session.rewind,
    notices: frame.notices ?? session.notices,
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
    after = null;
    rowsRun++;
    paged = false;
    setThread({ id: thread.id, status: "ready" }, next);
  } else if (thread && session && olderRe && frame.re === olderRe) {
    if (!frame.ok) return paging({ ok: false, error: frame.error });
    merge(frame);
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

/** `bytes` with the chunks after it, in one buffer. */
function join(): void {
  const all = new Uint8Array(held);
  all.set(bytes);
  let at = bytes.length;
  for (const chunk of chunks) {
    all.set(chunk, at);
    at += chunk.length;
  }
  bytes = all;
  chunks = [];
}

// A page of older history comes in many chunks: they're joined once its frame is whole, not as each comes.
function receive(chunk: Uint8Array): void {
  chunks.push(chunk);
  held += chunk.length;
  while (held >= 4) {
    if (bytes.length < 4) join();
    const end = 4 + new DataView(bytes.buffer, bytes.byteOffset).getUint32(0);
    if (held < end) return;
    if (bytes.length < end) join();
    onFrame(JSON.parse(new TextDecoder().decode(bytes.subarray(4, end))));
    bytes = bytes.subarray(end);
    held -= end;
  }
}

/** How long after the page loads a daemon that hasn't answered yet counts as still starting. */
const STARTING_MS = 5000;

// At module level, not in an effect: main posts the port once the page has loaded, maybe before React's first effect.
window.addEventListener("message", (event) => {
  if (event.source !== window || event.data !== "daemon-port") return;
  [port] = event.ports;
  [bytes, chunks, held] = [new Uint8Array(), [], 0];
  port.onmessage = ({ data }: MessageEvent<Uint8Array | null>) => {
    if (data) return receive(data);
    [bytes, chunks, held] = [new Uint8Array(), [], 0];
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

/** Asks for a page or an island of the open thread; its answer is dropped once the rows held start over. */
function page(request: object, done: (result: Paged) => void): void {
  const [id, re, run] = [thread?.id, threadRe, rowsRun];
  if (!id || !session || threadN === undefined) return done({ ok: false, error: "loading" });
  ask({ session: id, ...request }, (frame) => {
    if (thread?.id !== id || threadRe !== re || rowsRun !== run) return done({ ok: false, error: "stale" });
    if (!frame.ok) return done({ ok: false, error: frame.error });
    merge(frame);
    done({ ok: true, before });
  });
}

/** The open thread as the view's source: null while it loads. */
export const threadSource: Omit<Source, "older"> & {
  older(): Promise<Paged>;
  /** The rows held after find went to an island far up: the page under them, or the newest again [D503]. */
  newer(): void;
  latest(): void;
  /** Find going to row `n`, not held: the turns around it, the rows between left to load as the view gets there. */
  jump(n: number): Promise<Paged>;
  findOlder(query: string, limit: number): Promise<Older>;
} = {
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
  newer() {
    if (after === null || newerAsked) return;
    newerAsked = true;
    page({ op: "thread_older", after }, () => (newerAsked = false));
  },
  latest() {
    if (after === null) return;
    // The island goes at once, so a message sent from it shows under the rows while the newest come.
    after = null;
    if (thread && session) setThread(thread, { ...session, after: null });
    watch();
  },
  jump(n) {
    // An older page on its way would start from rows no longer held.
    if (olderRe) paging({ ok: false, error: "stale" });
    return new Promise((done) => page({ op: "thread_around", n }, done));
  },
  findOlder(query, limit) {
    // Bound to this session's watch: an answer after it changed (another session, a reconnect) is dropped.
    const id = thread?.id;
    const re = threadRe;
    return new Promise((done) => {
      if (!id || !session || threadN === undefined) return done({ ok: false, error: "loading" });
      if (before === null && after === null) return done({ ok: true, matches: [], more: false });
      // Every row's, so an answer stays whole while the rows held move (an island, a page): the view counts its own.
      ask({ op: "thread_find", session: id, before: Number.MAX_SAFE_INTEGER, query, limit }, (frame) => {
        if (thread?.id !== id || threadRe !== re) return done({ ok: false, error: "stale" });
        done(frame.ok ? { ok: true, matches: frame.matches, more: frame.more } : { ok: false, error: frame.error });
      });
    });
  },
};

export const useThread = (): ThreadState | undefined => useSyncExternalStore(threadSource.subscribe, () => thread);
