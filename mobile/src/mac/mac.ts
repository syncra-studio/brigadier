// The signed-in Mac's lists and the open thread, as the desktop's daemon.ts keeps them: a snapshot, then numbered
// pushes naming what changed by id; a gap asks for a fresh snapshot.
import type { Frame } from "../../vendor/brigadier-shared/client";
import type { Project, Row } from "../../vendor/brigadier-shared/rows";
import { store } from "../../vendor/brigadier-shared/store";
import type { Item, Session, Turn, Work } from "../../vendor/brigadier-shared/thread";
import { onPush, request } from "../link";

export const lists = store<{ rows: Row[]; projects: Project[]; ready: boolean }>({ rows: [], projects: [], ready: false });

export type Thread =
  | { id: string; status: "loading"; session: Session | null }
  | { id: string; status: "ready"; session: Session }
  | { id: string; status: "missing" | "error"; session: Session | null; error?: string };
export const thread = store<Thread | null>(null);

let n: number | undefined;
let listRe = 0;
let rows = new Map<string, Row>();
let projects = new Map<string, Project>();

let threadRe = 0;
let threadN: number | undefined;
let olderRe = 0;

function send(req: object, onReply: (f: Frame) => void): number {
  try {
    return request(req, onReply);
  } catch {
    // Not connected: the next sign-in starts over.
    return 0;
  }
}

/** Signed in: the lists and the open thread start again from fresh snapshots. */
export function start() {
  onPush(onFrame);
  subscribe();
  const open = thread.get();
  if (open) watch(open.id, open.session);
}

/** The stream ended: what is shown stays, marked not live, until the next sign-in. */
export function stop() {
  onPush(null);
  [n, threadN, olderRe] = [undefined, undefined, 0];
  lists.set({ ...lists.get(), ready: false });
}

function subscribe() {
  n = undefined;
  listRe = send({ op: "subscribe" }, (reply) => {
    if (reply.re !== listRe || reply.ok === false) return;
    rows = new Map((reply.rows as Row[]).map((row) => [row.id, row]));
    projects = new Map((reply.projects as Project[]).map((p) => [p.id, p]));
    n = reply.n;
    lists.set({ rows: [...rows.values()], projects: [...projects.values()], ready: true });
  });
}

/** Opens a session's thread; the Mac follows one thread per connection, so the last one stops. */
export function openThread(id: string) {
  const open = thread.get();
  if (open?.id === id && open.status !== "error") return;
  thread.set({ id, status: "loading", session: null });
  watch(id, null);
}

export function closeThread() {
  thread.set(null);
  threadRe = 0;
}

function watch(id: string, held: Session | null) {
  threadN = undefined;
  olderRe = 0;
  // Reaching back to the rows it already holds (from the first once its whole history is in), so pages stay.
  const reach = held ? { from: held.before ?? 1 } : {};
  const re = send({ op: "thread", session: id, ...reach }, (reply) => {
    if (re !== threadRe || thread.get()?.id !== id) return;
    if (!reply.ok) return thread.set({ id, status: reply.error === "not_found" ? "missing" : "error", session: held, error: reply.error });
    threadN = reply.n;
    thread.set({ id, status: "ready", session: reply.session });
  });
  threadRe = re;
}

/** The page before the first row held; false when there is none or one is on its way. */
export function older(): boolean {
  const open = thread.get();
  if (open?.status !== "ready" || open.session.before == null || olderRe) return false;
  const { id } = open;
  const re = send({ op: "thread_older", session: id, before: open.session.before }, (reply) => {
    if (re !== olderRe) return;
    olderRe = 0;
    const now = thread.get();
    if (!reply.ok || now?.id !== id || now.status !== "ready") return;
    const s = now.session;
    const have = new Set(s.items.map((item) => item.id));
    const turns = new Set(s.turns.map((t) => t.id));
    const work = new Set((s.work ?? []).map((w) => w.turnId));
    thread.set({
      ...now,
      session: {
        ...s,
        before: reply.before,
        items: [...(reply.items as Item[]).filter((item) => !have.has(item.id)), ...s.items],
        turns: [...(reply.turns as Turn[]).filter((t) => !turns.has(t.id)), ...s.turns],
        work: [...(reply.work as Work[]).filter((w) => !work.has(w.turnId)), ...(s.work ?? [])],
      },
    });
  });
  olderRe = re;
  return re !== 0;
}

function onFrame(frame: Frame) {
  if (frame.thread !== undefined) return applyThread(frame);
  if (frame.re !== undefined || typeof frame.n !== "number" || n === undefined) return;
  if (frame.n !== n + 1) return subscribe();
  n = frame.n;
  for (const row of frame.rows as Row[]) rows.set(row.id, row);
  for (const id of frame.gone as string[]) rows.delete(id);
  for (const p of (frame.projects ?? []) as Project[]) projects.set(p.id, p);
  for (const id of (frame.projects_gone ?? []) as string[]) projects.delete(id);
  lists.set({ rows: [...rows.values()], projects: [...projects.values()], ready: true });
}

function applyThread(frame: Frame) {
  const open = thread.get();
  if (!open || frame.watch !== threadRe) return;
  // The session was made again under the same id.
  if (frame.reset) return watch(open.id, null);
  if (frame.error) return thread.set({ id: open.id, status: frame.error === "not_found" ? "missing" : "error", session: open.session, error: frame.error });
  if (open.status !== "ready" || threadN === undefined) return;
  if (frame.n !== threadN + 1) return watch(open.id, open.session);
  threadN = frame.n;
  const s = open.session;
  const before = s.before ?? null;
  const items = s.items.slice();
  const at = new Map(items.map((item, i) => [item.id, i]));
  for (const item of frame.items as Item[]) {
    const i = at.get(item.id);
    // A row older than the pages held comes with its page.
    if (i === undefined && before !== null && item.n !== undefined && item.n < before) continue;
    if (i === undefined) at.set(item.id, items.push(item) - 1);
    else items[i] = item;
  }
  let turns = s.turns;
  for (const turn of frame.turns as Turn[]) {
    const i = turns.findIndex((each) => each.id === turn.id);
    turns = i < 0 ? [...turns, turn] : turns.map((each, j) => (j === i ? turn : each));
  }
  const work = frame.work as Work[];
  thread.set({
    ...open,
    session: {
      ...s,
      items,
      turns,
      work: work.length ? [...(s.work ?? []), ...work] : s.work,
      setup: "setup" in frame ? frame.setup : s.setup,
      approvals: frame.approvals ?? s.approvals,
      questions: frame.questions ?? s.questions,
      rewind: frame.rewind ?? s.rewind,
    },
  });
}

/** The rows the lists show: not archived, not a note's side chat, not a worker (those sit in their lead's thread). */
export const shown = (row: Row) => !row.archived && !row.noteChat && !row.worker;
export const needsYou = (row: Row) => row.mark === "needs" || row.mark === "amber";
