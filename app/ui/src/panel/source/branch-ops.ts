import { useSyncExternalStore } from "react";

import { showToast } from "../../components/toast";
import { ask } from "../../daemon";
import { keep, sourceArgs, type Target } from "../git";
import { gitDone, gitFailed } from "../notice";
import type { Branch } from "../types";

/*
 * The branch item's moves on Rust's git [D1020, D1021]: each shows at once (the sync item spins, the new name shows on
 * the item) and Rust's answer settles it, the watch's next read showing the counts and the name [D30, D1143].
 */

/** What the folder's quick pick lists, as Rust reads it when it opens. */
export type BranchRead = { branches: Branch[]; working: boolean };

type Op = { naming: string | null };
const NONE: Op = { naming: null };
const ops = new Map<string, Op>();
const listeners = new Set<() => void>();
const keyOf = (target: Target) => JSON.stringify(target);
const opOf = (target: Target | null) => (target && ops.get(keyOf(target))) || NONE;
const put = (target: Target, next: Partial<Op>) => {
  ops.set(keyOf(target), { ...opOf(target), ...next });
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** The branch moves' state for `target`'s checkout. */
export const useBranchOp = (target: Target | null): Op => useSyncExternalStore(subscribe, () => opOf(target));

/** Rust's error: a plain sentence, then (after a blank line) what git itself said, for Details. */
const split = (error: string): [string, string] => {
  const at = error.indexOf("\n\n");
  return at < 0 ? [error, ""] : [error.slice(0, at), error.slice(at + 2)];
};

// A move changes refs the watch may not follow (a new upstream), so it reads git again after each.
function run(target: Target, args: string[], onReply: (reply: Record<string, any>) => void) {
  ask({ op: "run", args: sourceArgs(target, ...args) }, (reply) => {
    if (args[0] !== "branches") ask({ op: "git_refresh" });
    onReply(reply);
  });
}

/** A failed move's notice, on the checkout that asked for it [D1264]. */
export function failed(target: Target, reply: Record<string, any>): void {
  if (reply.error === "disconnected") return gitFailed(target, "Brigadier isn't connected.");
  const [said, details] = split(String(reply.error));
  gitFailed(target, said, details);
}

/** Switch or create: the item shows `name` at once, until the watch reads it or Rust says no. */
export function name(target: Target, args: string[], name: string): void {
  put(target, { naming: name });
  run(target, args, (reply) => {
    // A read that never shows it (git took another name) doesn't hold it.
    if (reply.ok) return void setTimeout(() => opOf(target).naming === name && put(target, { naming: null }), 3000);
    put(target, { naming: null });
    failed(target, reply);
  });
}

/** The watch read the branch `name` showed: it's settled. */
export const named = (target: Target) => put(target, { naming: null });

// Each checkout's last list (the last 8): the quick pick opens on it at once, the new read replacing it quietly [D462].
const kept = new Map<string, BranchRead>();

/** The quick pick's list: the kept one at once, then Rust's new read; null when Rust couldn't read it and none is kept. */
export function readBranches(target: Target, done: (read: BranchRead | null) => void): void {
  const key = keyOf(target);
  const last = kept.get(key);
  if (last) done(last);
  run(target, ["branches"], (reply) => {
    if (reply.ok) keep(kept, key, reply.branches);
    else failed(target, reply);
    if (reply.ok || !last) done(reply.ok ? reply.branches : null);
  });
}
