import { useEffect, useState, useSyncExternalStore } from "react";

import { showToast } from "../components/toast";
import { ask, setGitHandler, useDaemon } from "../daemon";
import { refreshHistory } from "../history/store";
import { useHomeProject } from "../home/start";
import { HOME } from "../shell/tab-store";
import type { FileRead } from "../files/types";
import type { FileStatus } from "./status";
import type { PanelHint, SourceFile, SourceState } from "./types";

/*
 * The on-screen checkout's git, from Rust [D30, D71]: its status as the watch pushes it, each file's counts read
 * after it, and the moves Source and Review make, shown at once and settled by path. One watch per connection, so
 * one owner at a time: the one on screen. Disconnected, the last read stays, read-only; reconnecting asks again
 * [D1062]. Window focus reads it again now, as the old app did [D48].
 */

type Entry = { path: string; old: string | null; staged: FileStatus | null; changes: FileStatus | null };
type Head = { branch: string | null; head: string | null; upstream: string | null; ahead: number; behind: number; hint: PanelHint | null };
type Counts = Map<string, { insertions: number; deletions: number }>;
/** A move sent and not yet seen in a read. `done`: Rust answered, the next read settles it. */
type Pending = { paths: string[]; to: "staged" | "changes" | "dropped" | "gone"; done?: boolean };

/** Whose checkout, as Rust's commands name it: a session's, or a project's folder. */
export type Target = { session: string } | { project: string };

type Git = {
  key: string | null;
  target: Target | null;
  head: Head | null;
  files: Map<string, Entry>;
  counts: Counts;
  error: string | null;
  /** Bumped by every read that changed something: Review reads again on it. */
  version: number;
};

let git: Git = { key: null, target: null, head: null, files: new Map(), counts: new Map(), error: null, version: 0 };
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
}

/** A new commit, or the first read after a (re)subscribe: History reads again (2.29) [D1041, D1130]. */
function moved(head: Head): void {
  if (git.target && "session" in git.target && head.head !== git.head?.head) refreshHistory(git.target.session);
}

function watch(target: Target): void {
  n = 0;
  re = ask({ op: "git", ...target }, (reply) => {
    if (git.target !== target) return;
    if (!reply.ok) return set({ error: reply.error === "disconnected" ? git.error : String(reply.error) });
    n = reply.n;
    moved(reply.git.head);
    set({ head: reply.git.head, files: new Map(reply.git.files.map((each: Entry) => [each.path, each])) });
    landed();
  });
}

setGitHandler((frame) => {
  if (frame.watch !== re || !git.target) return;
  if (frame.error) return set({ error: String(frame.error) });
  if (frame.n !== n + 1) return watch(git.target);
  n = frame.n;
  const files = new Map(git.files);
  for (const each of frame.files as Entry[]) files.set(each.path, each);
  for (const path of frame.gone as string[]) files.delete(path);
  moved(frame.head);
  set({ head: frame.head, files });
  landed();
});

/** Follows `owner`'s checkout while it's on screen: a session's, or Home's project's [D1039]. */
export function useGitWatch(owner: string | null): void {
  const { daemon } = useDaemon();
  const project = useHomeProject();
  const target: Target | null = owner === null ? null : owner !== HOME ? { session: owner } : project ? { project: project.id } : null;
  const key = target && JSON.stringify(target);
  useEffect(() => {
    if (key !== git.key) {
      pending = [];
      set({ key, target, head: null, files: new Map(), counts: new Map(), error: null });
    }
    if (daemon && target) watch(git.target!);
  }, [key, daemon]);
  useEffect(() => {
    const refresh = () => ask({ op: "git_refresh" });
    addEventListener("focus", refresh);
    return () => removeEventListener("focus", refresh);
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
    checkout: "session" in (now.target ?? {}) ? "worktree" : "folder",
    branch: now.head.branch,
    remote: now.head.upstream?.split("/")[0] ?? null,
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
export function useGit(): { source: SourceState | null; hint: PanelHint | null; error: string | null; pending: string[]; version: number; target: Target | null } {
  const now = useSyncExternalStore(subscribe, () => git);
  if (shown?.from !== now || shown.pending !== pending) shown = { from: now, pending, source: sourceOf(now) };
  return { source: shown.source, hint: now.head?.hint ?? null, error: now.error, pending: pending.flatMap((each) => each.paths), version: now.version, target: now.target };
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
