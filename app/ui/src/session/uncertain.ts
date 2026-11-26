import { useEffect, useSyncExternalStore } from "react";

import type { Draft } from "../components/composer/draft";
import type { QueuedMessage } from "../components/composer/queue";
import type { Runner } from "./composer";

/*
 * A queue add whose reply never came (Brigadier went away): Rust may have it or not [D54]. It waits in the renderer's
 * own store, which outlives a reload, until Rust's queue, its thread or its draft says which; only where Rust can't be
 * reached does the app keep anything itself. It's never put in the draft, so it can't be sent by accident.
 * PROPOSED: "May not have been added"; once Rust answers without it, "Not added" with Add again and Edit.
 */
export type Uncertain = { qid: string; text: string; draft: Draft; parts?: string; at: number; unadded?: boolean; removing?: boolean };

const PREFIX = "brigadier.uncertain.";
const key = (session: string) => PREFIX + session;
const all = new Map<string, readonly Uncertain[]>();
const listeners = new Set<() => void>();
const NONE: readonly Uncertain[] = [];
// The connection each add was lost on, or last asked about, this run: only a later one asks again.
const lostOn = new Map<string, unknown>();

function of(session: string): readonly Uncertain[] {
  if (!all.has(session)) {
    let kept: Uncertain[] = [];
    try {
      kept = JSON.parse(localStorage.getItem(key(session)) ?? "[]");
    } catch {
      // Not ours to read: nothing is kept.
    }
    all.set(session, kept.length > 0 ? kept : NONE);
  }
  return all.get(session)!;
}

function put(session: string, next: readonly Uncertain[]): void {
  all.set(session, next.length > 0 ? next : NONE);
  if (next.length > 0) localStorage.setItem(key(session), JSON.stringify(next));
  else localStorage.removeItem(key(session));
  for (const listener of listeners) listener();
}

export function addUncertain(session: string, entry: Uncertain, daemon: unknown): void {
  lostOn.set(entry.qid, daemon);
  put(session, [...of(session).filter((each) => each.qid !== entry.qid), entry]);
}
export const dropUncertain = (session: string, qid: string) => of(session).some((each) => each.qid === qid) && put(session, of(session).filter((each) => each.qid !== qid));
const mark = (session: string, qid: string, change: Partial<Uncertain>) => put(session, of(session).map((each) => (each.qid === qid ? { ...each, ...change } : each)));

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** A session gone from Rust's list takes its uncertain adds with it [D35]. */
export function pruneUncertain(ids: ReadonlySet<string>): void {
  for (const at of Object.keys(localStorage).filter((each) => each.startsWith(PREFIX) && !ids.has(each.slice(PREFIX.length)))) {
    localStorage.removeItem(at);
    all.delete(at.slice(PREFIX.length));
  }
}

/**
 * Session `id`'s uncertain adds as the queue card's rows, each asked about once Rust answers on a new connection: in
 * its queue, an ordinary item (Rust's row shows it); in its log, delivered; in neither, not added. A Delete waits to
 * tell Rust until it answers.
 */
export function useUncertain(id: string, daemon: unknown, run: Runner, remove: (qid: string) => void) {
  const mine = useSyncExternalStore(subscribe, () => of(id));
  const answering = Boolean(daemon);
  useEffect(() => {
    if (!answering) return;
    for (const each of mine.filter((one) => lostOn.get(one.qid) !== daemon)) {
      lostOn.set(each.qid, daemon);
      void run(["queue", id, "has", each.qid]).then((reply) => {
        if (!reply.ok) return;
        if (each.removing && reply.queued) remove(each.qid);
        if (each.removing || reply.queued || reply.logged) dropUncertain(id, each.qid);
        else mark(id, each.qid, { unadded: true });
      });
    }
  });
  const rows: QueuedMessage[] = mine.filter((each) => !each.removing).map((each) => ({ id: each.qid, draft: each.draft, state: each.unadded ? "unadded" : "uncertain" }));
  const find = (qid: string) => mine.find((each) => each.qid === qid);
  const drop = (qid: string) => {
    if (!answering) return mark(id, qid, { removing: true });
    remove(qid);
    dropUncertain(id, qid);
  };
  return { rows, find, drop };
}
