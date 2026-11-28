import { useSyncExternalStore } from "react";

import { applyListFrame, type Daemon, type Project, type Row } from "../../shared/rows";
import { client } from "../../shared/client";
import type { Session } from "./thread/item";
import { applyThreadFrame, mergePage } from "../../shared/thread";
import { pruneUncertain } from "./session/uncertain";
import { asStopped, markStop } from "./thread/stopping";
import type { Source } from "./thread/thread";

export type { Daemon, Project, Row } from "../../shared/rows";

export type View = {
  /** undefined until the first answer, then the running daemon or null. */
  daemon: Daemon | null | undefined;
  refused?: string;
  /** undefined until the first list; kept while disconnected, so it never flashes empty. */
  rows?: Row[];
  /** The same for the projects, which come with the rows [D40, D71]. */
  projects?: Project[]; /** Keep awake's lid, which comes with them. */ lid?: import("./settings/api").LidHold;
};

export let view: View = { daemon: undefined };
let port: MessagePort | undefined;
const wire = client((frame) => port?.postMessage(frame), onFrame);
const send = wire.send;
let listId = 0;
// The list at N, then each update N+1, N+2… in order [D40]. A gap asks for a fresh list.
let rows = new Map<string, Row>();
let projects = new Map<string, Project>();
let n: number | undefined;
const listeners = new Set<() => void>();
/** Every open terminal's handler, each taking only its own stream's frames, by its watch id [D315]. */
export const termHandlers = new Set<(frame: Record<string, any>) => void>();
let onGit: ((frame: Record<string, any>) => void) | undefined;
let onBrowser: ((call: Record<string, any>) => void) | undefined;

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
// Newer rows asked for before the snapshot came: asked again once it has, as the row that asked stays drawn.
let newerLater = false;
// The older page's answer, for whoever asked.
let olderDone: ((result: Paged) => void)[] = [];
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
  return wire.ask(request, onReply);
}

/** Where the git watch's pushed frames go: one watch per connection [D71]. */
export function setGitHandler(handler: typeof onGit): void {
  onGit = handler;
}

/** Where agents' browser calls go: this window runs them once the daemon is told so, on each connect [D516]. */
export function setBrowserHandler(handler: typeof onBrowser): void {
  onBrowser = handler;
  if (view.daemon) send({ op: "browser" });
}

function setThread(next: ThreadState | undefined, nextSession = session): void {
  thread = next;
  session = nextSession;
  for (const listener of threadListeners) listener();
}

/** A page or an island put with the rows held (app/shared/thread.ts). */
function merge(frame: Record<string, any>): void {
  if (!thread || !session) return;
  const { session: next, touch } = mergePage(session, frame, before, after);
  if (!touch) rowsRun++;
  [before, after] = [next.before as number | null, next.after as number | null];
  itemAt = new Map(next.items.map((item, at) => [item.id, at]));
  setThread(thread, next);
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

/** The rows a session holds, for its snapshot to reach: from its first (1 once its whole history is in) to its end [D516]. */
const reachOf = (held: Session | null | undefined): { from?: number; to?: number } =>
  held ? { from: held.before ?? 1, to: held.after ?? undefined } : {};

function watch(reach: { from?: number; to?: number } = {}): void {
  threadN = undefined;
  if (olderRe) paging({ ok: false, error: "stale" });
  if (thread && view.daemon) threadRe = send({ op: "thread", session: thread.id, ...reach });
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
  ask({ op: "peek", session: id, ...reachOf(left.get(id)) }, (reply) => {
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
  // Older pages and an island are kept too, and the snapshot reaches the same rows, so the place left comes back [D516].
  if (thread?.status === "ready" && session) keep(thread.id, session);
  const kept = left.get(id) ?? null;
  // The kept rows' own, so a send before the snapshot leaves an island (`latest`).
  [before, after, newerLater] = [kept?.before ?? null, kept?.after ?? null, false];
  setThread({ id, status: "loading" }, kept);
  watch(reachOf(kept));
}

function applyThread(frame: Record<string, any>): void {
  if (!thread || frame.watch !== threadRe) return;
  // The session was made again under the same id: start over from a fresh snapshot.
  if (frame.reset) return watch();
  if (frame.error) return setThread({ id: thread.id, status: frame.error === "not_found" ? "missing" : "error", error: frame.error });
  if (!session || threadN === undefined) return;
  if (frame.n !== threadN + 1) return watch(reachOf(session));
  threadN = frame.n;
  setThread(thread, applyThreadFrame(session, frame, before, after, itemAt));
}

function subscribe(): void {
  n = undefined;
  listId = send({ op: "subscribe" });
}

function onFrame(frame: Record<string, any>): void {
  if (frame.term !== undefined) return termHandlers.forEach((handler) => handler(frame));
  if (frame.git !== undefined && frame.re === undefined) return onGit?.(frame);
  if (frame.browser !== undefined && frame.re === undefined) return onBrowser?.(frame.browser);
  if (frame.status === "running") {
    set({ daemon: { pid: frame.pid, version: frame.version, build: frame.build }, refused: undefined });
    subscribe();
    if (onBrowser) send({ op: "browser" });
    // The open thread's snapshot reaches the rows it still shows, so a place far up stays put [D537].
    watch(reachOf(session));
  } else if (frame.status === "refused" || (frame.re === listId && frame.ok === false)) {
    set({ daemon: null, refused: frame.error }); // an app a session's agent opened: told by the list's answer, with no rows then
  } else if (frame.re === listId) {
    rows = new Map(frame.rows.map((row: Row) => [row.id, row]));
    pruneUncertain(new Set(rows.keys()));
    projects = new Map(frame.projects.map((project: Project) => [project.id, project]));
    n = frame.n;
    set({ rows: [...rows.values()], projects: [...projects.values()], lid: frame.lid });
  } else if (thread && frame.re === threadRe) {
    if (!frame.ok) return setThread({ id: thread.id, status: frame.error === "not_found" ? "missing" : "error", error: frame.error });
    const next: Session = frame.session;
    itemAt = new Map(next.items.map((item, at) => [item.id, at]));
    threadN = frame.n;
    before = frame.session.before;
    after = next.after ?? null;
    rowsRun++;
    setThread({ id: thread.id, status: "ready" }, next);
    if (newerLater) {
      newerLater = false;
      threadSource.newer();
    }
  } else if (thread && session && olderRe && frame.re === olderRe) {
    if (!frame.ok) return paging({ ok: false, error: frame.error });
    merge(frame);
    paging({ ok: true, before });
  } else if (frame.thread !== undefined) {
    applyThread(frame);
  } else if (frame.re === undefined && typeof frame.n === "number" && n !== undefined) {
    if (frame.n !== n + 1) return subscribe();
    n = frame.n;
    applyListFrame(frame, rows, projects);
    if ((frame.gone as string[]).length > 0) pruneUncertain(new Set(rows.keys()));
    set({ rows: [...rows.values()], projects: [...projects.values()], lid: frame.lid });
  }
}

/** How long after the page loads a daemon that hasn't answered yet counts as still starting. */
const STARTING_MS = 5000;

// At module level, not in an effect: main posts the port once the page has loaded, maybe before React's first effect.
window.addEventListener("message", (event) => {
  if (event.source !== window || event.data !== "daemon-port") return;
  [port] = event.ports;
  wire.reset();
  port.onmessage = ({ data }: MessageEvent<Uint8Array | null>) => {
    if (data) return wire.receive(data);
    wire.reset();
    n = undefined;
    // The open thread keeps its rows while disconnected; reconnecting asks for a fresh snapshot.
    threadN = undefined;
    const waiting = wire.drop();
    if (olderRe) paging({ ok: false, error: "disconnected" });
    // Before the first connection a failed try is the daemon main just launched still starting: connecting, not
    // disconnected. The socket tries every 250ms, so one that never comes up says so once this has passed [D476].
    if (view.daemon !== undefined || performance.now() > STARTING_MS) set({ daemon: null });
    for (const reply of waiting) reply({ ok: false, error: "disconnected" });
  };
});

/** Resolves once the daemon has said hello: a folder Finder opens the app with reaches the page before it does. */
export const connected = (): Promise<void> =>
  new Promise((done) => {
    const check = () => void (view.daemon && (listeners.delete(check), done()));
    listeners.add(check);
    check();
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

export const showStop = (id: string) => markStop(id, thread?.id === id ? session : null, () => setThread(thread, session));
/** The open thread as the view's source, a Stop on its way drawn: null while it loads. */
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
  get: () => asStopped(thread?.id, session),
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
    if (threadN === undefined) return void (newerLater = true);
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

/** Whether a session is a chat on a folder of repos [D494]. */
export function useFolderChat(id: string | undefined): boolean {
  const { rows, projects } = useDaemon();
  const project = rows?.find((row) => row.id === id)?.project;
  return Boolean(project) && projects?.find((each) => each.id === project)?.kind === "folder";
}
