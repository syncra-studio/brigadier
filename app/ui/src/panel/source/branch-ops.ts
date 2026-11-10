import { useSyncExternalStore } from "react";

import { showToast, toastManager } from "../../components/toast";
import { ask } from "../../daemon";
import { sourceArgs, type Target } from "../git";
import type { Branch, ForcePush } from "../types";

/*
 * The branch item's moves on Rust's git [D1020, D1021, D1034]: each shows at once (the sync item spins, the new name
 * shows on the item) and Rust's answer settles it, the watch's next read showing the counts and the name [D30,
 * D1143]. A push the remote turned away keeps its lease here, by checkout, for Force Push's confirm [D1049].
 */

/** What the quick pick lists, as Rust reads it when it opens. `page`: the branch on its host, once published. */
export type BranchRead = { branches: Branch[]; base: string | null; host: string | null; page: string | null; working: boolean };

/** Rust's answer for a push turned away: the remote, its ref, and where that ref is; `moved` after a stale lease. */
type Rejected = { branch: string; remote: string; ref: string; oid: string; moved: boolean };

type Op = { syncing: boolean; naming: string | null; rejected: ForcePush | null; forcing: ForcePush | null };
const NONE: Op = { syncing: false, naming: null, rejected: null, forcing: null };
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

const lease = (rejected: Rejected, was: ForcePush | null): ForcePush => ({
  branch: rejected.branch,
  remote: rejected.remote,
  ref: rejected.ref,
  remoteRef: `${rejected.remote}/${rejected.ref.replace(/^refs\/heads\//, "")}`,
  reviewed: rejected.moved && was ? was.reviewed : rejected.oid,
  movedTo: rejected.moved ? rejected.oid : null,
});

/**
 * A failed move's toast: one plain sentence, git's own words behind Details [D1142]. A rejected push keeps its lease
 * and offers Force Push… beside Details (proposed, D1167), as the action menu does once it's there [D1034].
 */
export function failed(target: Target, reply: Record<string, any>): void {
  if (reply.error === "disconnected") return void showToast("Brigadier isn't connected.", { tone: "error" });
  const [said, details] = split(String(reply.error));
  const rejected = keep(target, reply);
  showToast(said, {
    tone: "error",
    actions: [
      ...(details ? [{ label: "Details", run: () => showToast(details, { tone: "error", stays: true }) }] : []),
      ...(rejected ? [{ label: "Force Push…", run: () => askForce(target) }] : []),
    ],
  });
}

/** Keeps a rejected push's lease, from any push (Sync, Publish, Create PR's), so Force Push is offered [D1034]. */
export function keep(target: Target, reply: Record<string, any>): ForcePush | null {
  const rejected = reply.rejected ? lease(reply.rejected, null) : null;
  if (rejected) put(target, { rejected });
  return rejected;
}

/** Opens Force Push's confirm on the lease the last rejected push kept. */
export function askForce(target: Target): void {
  const { rejected } = opOf(target);
  if (rejected) put(target, { forcing: rejected });
}

export const cancelForce = (target: Target) => put(target, { forcing: null });

/** Force push with the lease the user confirmed; if the remote moved since, the confirm asks again [D1049]. */
export function forcePush(target: Target, branch: string): void {
  const force = opOf(target).forcing;
  if (!force) return;
  put(target, { forcing: null });
  const pending = showToast(`Force pushing ${branch}…`, { stays: true });
  run(target, ["force-push", force.branch, force.remote, force.ref, force.movedTo ?? force.reviewed], (reply) => {
    toastManager.close(pending);
    if (reply.ok) {
      put(target, { rejected: null });
      return void showToast(`Force pushed ${branch}`, { tone: "success" });
    }
    if (reply.rejected?.moved) {
      const again = lease(reply.rejected, force);
      return put(target, { rejected: again, forcing: again });
    }
    failed(target, reply);
  });
}

/** Sync (pull then push) or Publish: the sync item spins until Rust answers. */
export function sync(target: Target, verb: "sync" | "publish", branch: string): void {
  if (opOf(target).syncing) return;
  put(target, { syncing: true });
  run(target, [verb], (reply) => {
    put(target, { syncing: false });
    if (!reply.ok) return failed(target, reply);
    put(target, { rejected: null });
    showToast(verb === "publish" ? `Published ${branch}` : `Synced ${branch}`, { tone: "success" });
  });
}

/** Rename, switch or create: the item shows `name` at once, until the watch reads it or Rust says no. */
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

/** The checkout is on another branch: a rejected push of the last one is no longer offered [D1034]. */
export const moved = (target: Target) => put(target, { rejected: null, forcing: null });

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
