import { useEffect, useState, useSyncExternalStore } from "react";

import { showToast } from "../components/toast";
import { ask, setGitHandler, useDaemon } from "../daemon";
import { refreshHistory } from "../history/store";
import { useHomeProject, useStart } from "../home/start";
import { HOME } from "../shell/tab-store";
import type { FileRead } from "../files/types";
import type { FileStatus } from "./status";
import type { MergeStyle, PanelHint, SourceFile, SourceState, Step, When } from "./types";

/*
 * The on-screen checkout's git, from Rust [D30, D71]: its status as the watch pushes it, each file's counts read
 * after it, and the moves Source and Review make, shown at once and settled by path. One watch per connection, so
 * one owner at a time: the one on screen. Disconnected, the last read stays, read-only; reconnecting asks again
 * [D1062]. Window focus reads it again now, as the old app did [D48].
 */

type Entry = { path: string; old: string | null; staged: FileStatus | null; changes: FileStatus | null };
type Head = {
  branch: string | null;
  head: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  hint: PanelHint | null;
  /** Rust's: a session's own worktree or a folder of the user's, and the remote it syncs or would publish to [D1020, D1021]. */
  checkout: "worktree" | "folder";
  remote: string | null;
};
type Counts = Map<string, { insertions: number; deletions: number }>;
/** A move sent and not yet seen in a read. `done`: Rust answered, the next read settles it. */
type Pending = { paths: string[]; to: "staged" | "changes" | "dropped" | "gone"; done?: boolean };

/**
 * Rust's next step for the checkout [D1015, D1152]: the step, the toolbar's dot [D1025], how the project lands
 * [D1028], and the commits it was worked out on, which a landing pins [D1049].
 */
/** The base against its own upstream, from Rust [D1187, D1193]: `behind` null where it can't count; `fetchedAtMs` null when unknown. */
export type Freshness = { name: string; upstream: string | null; behind: number | null; fetchedAtMs: number | null };

/** `when`: the session's "When it's done" rule (2.44); `ran`: its last run's end, so the brief is read again when only a run changed [D1199, D1201]. */
type StepRead = { step: Step | null; hint: PanelHint | null; merge: MergeStyle | null; at: StepAt | null; freshness?: Freshness | null; when?: When | null; ran?: number | null };

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

let git: Git = { key: null, target: null, head: null, files: new Map(), counts: new Map(), error: null, step: null, version: 0, readAtMs: null, truth: null, restoring: false, restoreError: null };
let stepAsk = 0;
let re = 0;
let n = 0;
let pending: Pending[] = [];
let counting = false;
let recount = false;
const listeners = new Set<() => void>();

function set(next: Partial<Git>): void {
  git = { ...git, ...next };
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
    if (reply.ok && git.target === target) set({ counts: new Map(reply.review.files.map((file: any) => [file.path, { insertions: file.insertions, deletions: file.deletions }])) });
    if (recount) {
      recount = false;
      count();
    }
  });
}

function landed(): void {
  pending = pending.filter((each) => !each.done);
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
    refreshStep(true);
    refreshHistory(target.session);
  });
}

/**
 * Asks Rust for the step again: after every read, each action and on focus, and every few seconds, since the base
 * moving or its checkout changing isn't this checkout's watch. Only the newest answer for this checkout counts.
 * `fresh`: the branch's PRs are read again too, as after a push or a new PR. `then`: once it's answered.
 */
export function refreshStep(fresh = false, then?: () => void): void {
  const target = git.target;
  if (!target) return then?.();
  const mine = ++stepAsk;
  ask({ op: "run", args: sourceArgs(target, "step", ...(fresh ? ["--fresh"] : [])) }, (reply) => {
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
export function landBranch(style: MergeStyle, message: string | null, at: StepAt | null, done: (error: string | null) => void): void {
  const target = git.target;
  if (!target || !at) return done("Nothing to merge yet.");
  ask({ op: "run", args: sourceArgs(target, "land", style, at.head, at.base ?? "-", ...(message === null ? [] : ["--message", message])) }, (reply) => {
    // A landing stays pending until the step it led to shows [D30].
    if (reply.ok) return refreshStep(true, () => done(null));
    done(reply.error === "disconnected" ? "Brigadier isn't connected." : String(reply.error));
    refreshStep(true);
  });
}

/** Remembers how the project lands, shown at once [D1028, D30]. */
export function setMergeStyle(style: MergeStyle): void {
  const target = git.target;
  if (!target) return;
  if (git.step) set({ step: { ...git.step, merge: style } });
  ask({ op: "run", args: sourceArgs(target, "style", style) }, () => refreshStep());
}

/** What squashing at `at` takes in, from Rust: its commits and a first message. */
export function squashOf(at: StepAt, done: (squash: { message: string; commits: { sha: string; subject: string }[] } | null) => void): void {
  const target = git.target;
  if (!target) return done(null);
  ask({ op: "run", args: sourceArgs(target, "squash", at.head, at.base ?? "-") }, (reply) => done(reply.ok ? reply.squash : null));
}

/** A new commit, or the first read after a (re)subscribe: History reads again (2.29) [D1041, D1130]. */
function moved(head: Head): void {
  if (git.target && "session" in git.target && head.head !== git.head?.head) refreshHistory(git.target.session);
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
    moved(reply.git.head);
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
  moved(frame.head);
  set({ head: frame.head, files, readAtMs: Date.now() });
  landed();
});

/** Follows `owner`'s checkout while it's on screen: a session's, or Home's project's [D1039]. */
export function useGitWatch(owner: string | null): void {
  const { daemon, rows } = useDaemon();
  const project = useHomeProject();
  const starting = useStart(owner ?? "")?.asking === true;
  const target: Target | null = owner === null ? null : owner !== HOME ? { session: owner } : project ? { project: project.id } : null;
  const key = target && JSON.stringify(target);
  useEffect(() => {
    if (key !== git.key) {
      re = 0;
      pending = [];
      set({ key, target, head: null, files: new Map(), counts: new Map(), error: null, step: null, readAtMs: null, truth: null, restoring: false, restoreError: null });
    }
    // New sessions open before Rust has made their checkout.
    if (daemon && target && !starting) watch(git.target!);
  }, [key, daemon, starting]);
  // The background draft: a while after each read that changed something, while the session's agent is idle [D1212].
  const row = owner !== null && owner !== HOME ? rows?.find((each) => each.id === owner) : undefined;
  const working = row?.works === true;
  // A turn's start or end moves the step and "When it's done" even when no file changed [D1201].
  useEffect(() => void (daemon && git.target && refreshStep()), [row?.finished, working]);
  const version = useSyncExternalStore(subscribe, () => git.version);
  useEffect(() => {
    const target = git.target;
    if (!daemon || working || !target || git.files.size === 0) return;
    const soon = setTimeout(() => ask({ op: "run", args: sourceArgs(target, "draft", "--all") }, () => {}), 3000);
    return () => clearTimeout(soon);
  }, [version, working, daemon]);
  useEffect(() => {
    // On focus the PRs are read again too, so one made elsewhere shows [D1143].
    const refresh = () => {
      ask({ op: "git_refresh" });
      refreshStep(true);
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

/** The checkout as Source draws it, with the moves still out on top; null until the first read. */
function sourceOf(now: Git): SourceState | null {
  if (!now.head) return null;
  const staged: SourceFile[] = [];
  const changes: SourceFile[] = [];
  for (const entry of now.files.values()) {
    if (entry.staged) staged.push(file(entry, entry.staged, now.counts, true));
    if (entry.changes) changes.push(file(entry, entry.changes, now.counts, !entry.staged));
  }
  let state: SourceState = {
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
    commits: [],
    sinceBase: [],
  };
  for (const move of pending) {
    const moving = (list: SourceFile[]) => list.filter((each) => move.paths.includes(each.path));
    const left = (list: SourceFile[]) => list.filter((each) => !move.paths.includes(each.path));
    const joined = (list: SourceFile[], into: SourceFile[]) => [...left(into), ...list.map((each) => ({ ...each, ...sum(each, into.find((other) => other.path === each.path)) }))];
    if (move.to === "dropped") state = { ...state, changes: left(state.changes) };
    else if (move.to === "gone") state = { ...state, staged: left(state.staged), changes: left(state.changes) };
    else if (move.to === "staged") state = { ...state, staged: joined(moving(state.changes), state.staged), changes: left(state.changes) };
    else state = { ...state, changes: joined(moving(state.staged), state.changes), staged: left(state.staged) };
  }
  return state;
}

const sum = (file: SourceFile, other?: SourceFile) => ({ added: file.added + (other?.added ?? 0), removed: file.removed + (other?.removed ?? 0) });

let shown: { from: Git; pending: Pending[]; source: SourceState | null } | null = null;

/** The on-screen checkout for Source: its state, Rust's dot, the count, and the paths still moving. */
export function useGit(): { source: SourceState | null; step: StepRead | null; hint: PanelHint | null; error: string | null; pending: string[]; version: number; target: Target | null; readAtMs: number | null; truth: Truth | null; restoring: boolean; restoreError: string | null } {
  const now = useSyncExternalStore(subscribe, () => git);
  if (shown?.from !== now || shown.pending !== pending) shown = { from: now, pending, source: sourceOf(now) };
  // Rust's step says the dot once it's read; until then the status's count does [D1025].
  const hint = now.step ? now.step.hint : (now.head?.hint ?? null);
  return { source: shown.source, step: now.step, hint, error: now.error, pending: pending.flatMap((each) => each.paths), version: now.version, target: now.target, readAtMs: now.readAtMs, truth: now.truth, restoring: now.restoring, restoreError: now.restoreError };
}

/** The file moves Source and Review share [D1043, D1103]: Rust's own, under the checkout's lock. */
export function moveFiles(verb: "stage" | "unstage" | "discard", scope: "uncommitted" | "staged" | "unstaged", paths: string[]): void {
  const target = git.target;
  if (!target || paths.length === 0) return;
  const move: Pending = { paths, to: verb === "stage" ? "staged" : verb === "unstage" ? "changes" : scope === "unstaged" ? "dropped" : "gone" };
  pending = [...pending, move];
  set({});
  ask({ op: "run", args: sourceArgs(target, verb, scope, ...paths) }, (reply) => {
    if (reply.ok) {
      move.done = true;
      // A move that changed nothing brings no read: it settles on its own.
      setTimeout(() => pending.includes(move) && settle(move), 1500);
      return;
    }
    settle(move);
    showToast(reply.error === "disconnected" ? "Not connected. Try again when it's back." : String(reply.error), { tone: "error" });
  });
}

function settle(move: Pending): void {
  pending = pending.filter((each) => each !== move);
  set({});
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
 * Source's commit [D1029, D1107]: Rust commits the index, or with `all` every change, with `message`; a blank one is
 * written first for exactly what's committed. False with no checkout on screen. The watch shows the commit landing.
 */
export function commitFiles(all: boolean, message: string, onReply: (reply: Record<string, any>) => void): boolean {
  const target = git.target;
  if (!target) return false;
  ask({ op: "run", args: sourceArgs(target, "make-commit", ...(all ? ["--all"] : []), ...(message ? ["--message", message] : [])) }, onReply);
  return true;
}

/**
 * The background draft (2.20) for exactly what every change would commit now: Rust keys it [D1212]. Its ready text
 * goes to `onText`; a pending one is read again, an empty or stale one written, while `wanted()` [T-contract]. One
 * just written is read once more through the cached check, so files changed meanwhile never fill in an old message.
 */
export function readDraft(onText: (text: string) => void, wanted: () => boolean, mode: "read" | "write" | "check" = "read"): void {
  const target = git.target;
  if (!target || !wanted()) return;
  ask({ op: "run", args: sourceArgs(target, "draft", "--all", ...(mode === "write" ? [] : ["--cached"])) }, (reply) => {
    const state = reply.draft?.state;
    if (git.target !== target || !wanted()) return;
    if (state === "ready") return mode === "write" ? readDraft(onText, wanted, "check") : onText(reply.draft.text);
    if (state === "pending") setTimeout(() => readDraft(onText, wanted), 2000);
    else if (mode === "read" && (state === "empty" || state === "stale")) readDraft(onText, wanted, "write");
  });
}

/** The message writer [D1029]: a commit message for the index (or every change), or a squash's, nothing committed. */
export function writeMessage(what: "commit" | "squash", all: boolean, onReply: (reply: Record<string, any>) => void): boolean {
  const target = git.target;
  if (!target) return false;
  ask({ op: "run", args: sourceArgs(target, "write", what, ...(all ? ["--all"] : [])) }, onReply);
  return true;
}
