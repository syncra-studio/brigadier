import { useSyncExternalStore } from "react";

import { showToast } from "../../components/toast";
import { ask } from "../../daemon";
import { sourceArgs, type Target } from "../git";
import { gitDone, gitFailed } from "../notice";
import type { Branch } from "../types";

/*
 * The branch item's moves on Rust's git [D1020, D1021]: each shows at once (the sync item spins, the new name shows on
 * the item) and Rust's answer settles it, the watch's next read showing the counts and the name [D30, D1143].
 */

/** What the quick pick lists, as Rust reads it when it opens. `page`: the branch on its host, once published. */
export type BranchRead = { branches: Branch[]; base: string | null; host: string | null; page: string | null; working: boolean; prs?: number[] | null };

type Op = { syncing: boolean; naming: string | null };
const NONE: Op = { syncing: false, naming: null };
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

/** Sync (pull then push) or Publish: the sync item spins until Rust answers. */
export function sync(target: Target, verb: "sync" | "publish", branch: string): void {
  if (opOf(target).syncing) return;
  put(target, { syncing: true });
  run(target, [verb], (reply) => {
    put(target, { syncing: false });
    if (!reply.ok) return failed(target, reply);
    gitDone(target);
    showToast(verb === "publish" ? `Published ${branch}` : `Synced ${branch}`, { tone: "success" });
  });
}

/** Rename, switch or create: the item shows `name` at once, until the watch reads it or Rust says no. `done`: after it's made. */
export function name(target: Target, args: string[], name: string, done?: () => void): void {
  put(target, { naming: name });
  run(target, args, (reply) => {
    if (reply.ok) done?.();
    // A read that never shows it (git took another name) doesn't hold it.
    if (reply.ok) return void setTimeout(() => opOf(target).naming === name && put(target, { naming: null }), 3000);
    put(target, { naming: null });
    failed(target, reply);
  });
}

/** The watch read the branch `name` showed: it's settled. */
export const named = (target: Target) => put(target, { naming: null });

/** Changes what the session lands into; `done` reads again what follows the base [D1143]. */
export function setBase(target: Target, base: string, done: () => void): void {
  run(target, ["base", base], (reply) => {
    if (!reply.ok) return failed(target, reply);
    done();
    showToast(`Lands into ${base} now`, { tone: "success" });
  });
}

/** The quick pick's list, read as it opens; null when Rust couldn't read it, after saying why. */
export function readBranches(target: Target, done: (read: BranchRead | null) => void): void {
  run(target, ["branches"], (reply) => {
    if (!reply.ok) failed(target, reply);
    done(reply.ok ? reply.branches : null);
  });
}
