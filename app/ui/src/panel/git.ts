import { useEffect, useLayoutEffect, useState, useSyncExternalStore } from "react";

import { ask, type Row, setGitHandler, useDaemon } from "../daemon";
import { useHomeProject, useStart } from "../home/start";
import type { ComposerRow } from "../session/composer";
import { HOME } from "../shell/tab-store";
import type { FileRead } from "../files/types";
import type { FileStatus } from "./status";
import type { FileFlag, LastRun } from "../review/types";
import type { SourceFile, SourceState, Step } from "./types";

/*
 * The on-screen checkout's git, from Rust [D30, D71]: its status as the watch pushes it, and each file's counts read
 * after it. One watch per connection, so one owner at a time: the one on screen. Disconnected, the last read stays,
 * read-only; reconnecting asks again [D1062]. Window focus reads it again now, as the old app did [D48].
 */

type Entry = { path: string; old: string | null; staged: FileStatus | null; changes: FileStatus | null };
type Head = {
  branch: string | null;
  head: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  /** Rust's: a session's own worktree or a folder of the user's, and the remote it syncs or would publish to [D1020, D1021]. */
  checkout: "worktree" | "folder";
  remote: string | null;
};
type Counts = Map<string, { insertions: number; deletions: number }>;
/** The uncommitted review's brief, Review's own (2.38) [D1188, D1199]: the last run, risky files' flags, and in your own folder the agent's files. */
export type Brief = { run?: LastRun | null; flags: Record<string, FileFlag>; agent: string[] | null };

/** The base against its own upstream, from Rust [D1187, D1193]: `behind` null where it can't count; `fetchedAtMs` null when unknown. */
export type Freshness = { name: string; upstream: string | null; behind: number | null; fetchedAtMs: number | null };

/**
 * Rust's next step for the checkout [D1015, D1152]: the step and the commits it was worked out on, which a landing
 * pins [D1049]. `ran`: its last run's end, so the brief is read again when only a run changed [D1199].
 */
type StepRead = { step: Step | null; at: StepAt | null; freshness?: Freshness | null; ran?: number | null };

/**
 * What the checkout really is, from Rust (2.37) [D1187]: its folder gone (and whether Restore can bring it back), a
 * detached HEAD's short id, the branch it's on against the one the session's record holds, and the base's freshness.
 */
export type Truth = { missing: boolean; restorable: boolean; branch: string | null; head: string | null; detached: string | null; recordedBranch: string | null; mismatch: boolean; base: Freshness | null };

/** The session's HEAD and its base's commit a step was worked out on. */
export type StepAt = { head: string; base: string | null };

/** Whose checkout, as Rust's commands name it: a session's, or a project's folder. */
export type Target = { session: string } | { project: string };

type Git = {
  key: string | null;
  target: Target | null;
  head: Head | null;
  files: Map<string, Entry>;
  counts: Counts;
  brief: Brief | null;
  error: string | null;
  step: StepRead | null;
  /** Bumped by every read that changed something: Review reads again on it. */
  version: number;
  /** When the watch last read the checkout: Live's tip, and Offline's time [D1205, D1206]. */
  readAtMs: number | null;
  truth: Truth | null;
  /** Restore is under way, or how it was refused. */
  restoring: boolean;
  restoreError: string | null;
};

let git: Git = { key: null, target: null, head: null, files: new Map(), counts: new Map(), brief: null, error: null, step: null, version: 0, readAtMs: null, truth: null, restoring: false, restoreError: null };
let stepAsk = 0;
let re = 0;
let n = 0;
let counting = false;
let recount = false;
const listeners = new Set<() => void>();
// Each checkout's last read, shown at once on coming back to it while the watch reads it again: the old app's kept
// entries, the last 8 checkouts (CHECKOUTS_KEPT) [D1258].
const kept = new Map<string, Git>();
/** Keeps `value` as `key`'s last read, dropping the longest unvisited past the old app's 8. */
export function keep<T>(map: Map<string, T>, key: string, value: T): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > 8) map.delete(map.keys().next().value!);
}

function set(next: Partial<Git>): void {
  git = { ...git, ...next };
  if (git.key) keep(kept, git.key, git);
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** Rust's command line for `target`. */
export const sourceArgs = (target: Target, ...rest: string[]) => ["source", ...("session" in target ? [target.session] : ["--project", target.project]), ...rest];

/** Each file's lines added and removed, read after the status: a file's row shows them. */
function count(): void {
  const target = git.target;
  if (!target) return;
  if (counting) return void (recount = true);
  counting = true;
  ask({ op: "run", args: sourceArgs(target, "review", "uncommitted") }, (reply) => {
    counting = false;
    // Another checkout's answer is dropped, but a count asked for meanwhile still runs.
    if (reply.ok && git.target === target) {
      const files: any[] = reply.review.files;
      const flags = Object.fromEntries(files.filter((file) => file.flag).map((file) => [file.path, file.flag]));
      set({ counts: new Map(files.map((file) => [file.path, { insertions: file.insertions, deletions: file.deletions }])), brief: { run: reply.review.run, flags, agent: reply.review.agent ?? null } });
    }
    if (recount) {
      recount = false;
      count();
    }
  });
}

function landed(): void {
  set({ version: git.version + 1, error: null });
  count();
  refreshStep();
  readTruth();
}

/** Reads the checkout's truth again: on open, every read and git error, focus, and after Restore [D1187]. */
function readTruth(): void {
  const target = git.target;
  if (!target) return;
  ask({ op: "run", args: sourceArgs(target, "truth") }, (reply) => {
    if (git.target === target && reply.ok) set({ truth: reply.truth });
  });
}

/** Restore: re-creates a session's gone folder from its branch, then follows it again [D180, D1187]. */
export function restoreCheckout(): void {
  const target = git.target;
  if (!target || !("session" in target) || git.restoring) return;
  set({ restoring: true, restoreError: null });
  ask({ op: "run", args: sourceArgs(target, "restore-checkout") }, (reply) => {
    if (git.target !== target) return;
    set({ restoring: false, restoreError: reply.ok ? null : reply.error === "disconnected" ? "Brigadier isn't connected." : String(reply.error) });
    if (!reply.ok) return;
    watch(target);
    readTruth();
    refreshStep();
  });
}

/**
 * Asks Rust for the step again: after every read, each action and on focus, and every few seconds, since the base
 * moving or its checkout changing isn't this checkout's watch. Only the newest answer for this checkout counts.
 * `then`: once it's answered.
 */
export function refreshStep(then?: () => void): void {
  const target = git.target;
  if (!target) return then?.();
  const mine = ++stepAsk;
  ask({ op: "run", args: sourceArgs(target, "step") }, (reply) => {
    // A failed read keeps the last step: the next read tries again.
    if (mine === stepAsk && git.target === target && reply.ok) {
      const ran = git.step?.ran;
      set({ step: reply.step });
      // A run that ended without changing a file still changes the brief [D1199].
      if (ran !== undefined && reply.step.ran !== ran) count();
    }
    then?.();
  });
}

/** Lands the session's branch into its base, pinned to the commits `at` the user saw [D1028, D1049]: `done` gets Rust's refusal, or null. */
export function landBranch(at: StepAt | null, done: (error: string | null) => void): void {
  const target = git.target;
  if (!target || !at) return done("Nothing to merge yet.");
  ask({ op: "run", args: sourceArgs(target, "land", at.head, at.base ?? "-") }, (reply) => {
    // A landing stays pending until the step it led to shows [D30].
    if (reply.ok) return refreshStep(() => done(null));
    done(reply.error === "disconnected" ? "Brigadier isn't connected." : String(reply.error));
    refreshStep();
  });
}

function watch(target: Target): void {
  n = 0;
  re = ask({ op: "git", ...target }, (reply) => {
    if (git.target !== target) return;
    if (!reply.ok) {
      readTruth();
      return set({ error: reply.error === "disconnected" ? git.error : String(reply.error) });
    }
    n = reply.n;
    set({ head: reply.git.head, files: new Map(reply.git.files.map((each: Entry) => [each.path, each])), readAtMs: Date.now() });
    landed();
  });
}

setGitHandler((frame) => {
  if (frame.watch !== re || !git.target) return;
  if (frame.error) {
    readTruth();
    return set({ error: String(frame.error) });
  }
  if (frame.n !== n + 1) return watch(git.target);
  n = frame.n;
  const files = new Map(git.files);
  for (const each of frame.files as Entry[]) files.set(each.path, each);
  for (const path of frame.gone as string[]) files.delete(path);
  set({ head: frame.head, files, readAtMs: Date.now() });
  landed();
});

/** The session's agent is at work: a turn open, stalled or not, or its background jobs still running [D1208, D1252]. */
export const isWorking = (row: Row | undefined) => (row as ComposerRow | undefined)?.running === true || row?.works === true;

/** Follows `owner`'s checkout while it's on screen: a session's, or Home's project's [D1039]. */
export function useGitWatch(owner: string | null): void {
  const { daemon, rows } = useDaemon();
  const project = useHomeProject();
  const starting = useStart(owner ?? "")?.asking === true;
  const target: Target | null = owner === null ? null : owner !== HOME ? { session: owner } : project ? { project: project.id } : null;
  const key = target && JSON.stringify(target);
  // Before the paint, so a switch never shows the last checkout's read or an empty one for a frame [D1258].
  useLayoutEffect(() => {
    if (key !== git.key) {
      re = 0;
      const last = key ? kept.get(key) : undefined;
      set({ key, target, head: last?.head ?? null, files: last?.files ?? new Map(), counts: last?.counts ?? new Map(), brief: last?.brief ?? null, error: null, step: last?.step ?? null, readAtMs: last?.readAtMs ?? null, truth: last?.truth ?? null, restoring: false, restoreError: null });
    }
    // New sessions open before Rust has made their checkout.
    if (daemon && target && !starting) watch(git.target!);
  }, [key, daemon, starting]);
  const row = owner !== null && owner !== HOME ? rows?.find((each) => each.id === owner) : undefined;
  const working = isWorking(row);
  // A turn's start or end moves the step even when no file changed [D1208].
  useEffect(() => void (daemon && git.target && refreshStep()), [row?.finished, working]);
  useEffect(() => {
    // On focus the step is read again too [D1143].
    const refresh = () => {
      ask({ op: "git_refresh" });
      refreshStep();
      readTruth();
    };
    addEventListener("focus", refresh);
    // shortcut: the base moving shows within this; a watch on the base checkout would show it at once.
    const every = setInterval(refreshStep, 10_000);
    return () => {
      removeEventListener("focus", refresh);
      clearInterval(every);
    };
  }, []);
}

export const retryGit = () => git.target && watch(git.target);

const file = (entry: Entry, status: FileStatus, counts: Counts, whole: boolean): SourceFile => {
  const lines = counts.get(entry.path);
  // A partly staged file's lines count once, on its staged side.
  return { path: entry.path, status, oldPath: entry.old, added: whole ? (lines?.insertions ?? 0) : 0, removed: whole ? (lines?.deletions ?? 0) : 0 };
};

/** The checkout as the card draws it; null until the first read. */
function sourceOf(now: Git): SourceState | null {
  if (!now.head) return null;
  const staged: SourceFile[] = [];
  const changes: SourceFile[] = [];
  for (const entry of now.files.values()) {
    if (entry.staged) staged.push(file(entry, entry.staged, now.counts, true));
    if (entry.changes) changes.push(file(entry, entry.changes, now.counts, !entry.staged));
  }
  return {
    checkout: now.head.checkout,
    branch: now.head.branch,
    remote: now.head.remote,
    upstream: now.head.upstream,
    ahead: now.head.ahead,
    behind: now.head.behind,
    staged,
    changes,
    merging: null,
    rebasing: null,
    sinceBase: [],
  };
}

let shown: { from: Git; source: SourceState | null } | null = null;

/** The on-screen checkout: its state and Rust's step. */
export function useGit(): { source: SourceState | null; step: StepRead | null; error: string | null; version: number; brief: Brief | null; target: Target | null; readAtMs: number | null; truth: Truth | null; restoring: boolean; restoreError: string | null } {
  const now = useSyncExternalStore(subscribe, () => git);
  if (shown?.from !== now) shown = { from: now, source: sourceOf(now) };
  return { source: shown.source, step: now.step, error: now.error, version: now.version, brief: now.brief, target: now.target, readAtMs: now.readAtMs, truth: now.truth, restoring: now.restoring, restoreError: now.restoreError };
}

/** A checkout file as the viewer shows it, read again on each watch read that changed something [D1002]. */
export function useFileRead(path: string): FileRead {
  const { target, version } = useSyncExternalStore(subscribe, () => git);
  const [read, setRead] = useState<FileRead>({ state: "loading" });
  const [tick, setTick] = useState(0);
  // shortcut: the watch leaves ignored files out, so an ignored file's tab reads it again every few seconds while the
  // window shows; a watch of the file itself would be instant.
  // Kept once seen, so a file a build deletes and writes again is still followed.
  const [ignored, setIgnored] = useState(false);
  useEffect(() => {
    if (!ignored) return;
    const timer = setInterval(() => document.visibilityState === "visible" && setTick((n) => n + 1), 3000);
    return () => clearInterval(timer);
  }, [ignored]);
  useEffect(() => {
    if (!target) return;
    let live = true;
    ask({ op: "run", args: sourceArgs(target, "file", path) }, (reply) => {
      if (!live || reply.error === "disconnected") return;
      if (!reply.ok) return setRead({ state: "failed", error: String(reply.error) });
      if (reply.file.ignored) setIgnored(true);
      const next: FileRead = reply.file.gone ? { state: "gone", carried: false } : { state: "read", file: reply.file };
      // The same read keeps its object, so the viewer doesn't draw it again.
      setRead((last) => (JSON.stringify(last) === JSON.stringify(next) ? last : next));
    });
    return () => void (live = false);
  }, [target, path, version, tick]);
  return read;
}

/**
 * The card's commit [D1029, D1107]: Rust commits the index, or with `all` every change, with `message`; a blank one is
 * written first for exactly what's committed. False with no checkout on screen. The watch shows the commit landing.
 */
export function commitFiles(all: boolean, message: string, onReply: (reply: Record<string, any>) => void): boolean {
  const target = git.target;
  if (!target) return false;
  ask({ op: "run", args: sourceArgs(target, "make-commit", ...(all ? ["--all"] : []), ...(message ? ["--message", message] : [])) }, onReply);
  return true;
}
