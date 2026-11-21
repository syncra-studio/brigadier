import { useEffect, useLayoutEffect, useState, useSyncExternalStore } from "react";

import { ask, type Row, setGitHandler, useDaemon } from "../daemon";
import { useHomeProject, useStart } from "../home/start";
import type { ComposerRow } from "../session/composer";
import { store } from "../onboarding/api";
import { HOME } from "../shell/tab-store";
import type { FileRead } from "../files/types";
import type { FileStatus } from "./status";
import type { SourceFile, SourceState } from "./types";

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
/** The base against its own upstream, from Rust [D1187, D1193]: `behind` null where it can't count; `fetchedAtMs` null when unknown. */
export type Freshness = { name: string; upstream: string | null; behind: number | null; fetchedAtMs: number | null };

/**
 * What the checkout really is, from Rust (2.37) [D1187]: its folder gone (and whether Restore can bring it back), a
 * detached HEAD's short id, the branch it's on against the one the session's record holds, and the base's freshness.
 */
export type Truth = { missing: boolean; restorable: boolean; branch: string | null; head: string | null; detached: string | null; recordedBranch: string | null; mismatch: boolean; base: Freshness | null };

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
  /** When the watch last read the checkout: Live's tip, and Offline's time [D1205, D1206]. */
  readAtMs: number | null;
  truth: Truth | null;
  /** Restore is under way, or how it was refused. */
  restoring: boolean;
  restoreError: string | null;
};

let git: Git = { key: null, target: null, head: null, files: new Map(), counts: new Map(), error: null, version: 0, readAtMs: null, truth: null, restoring: false, restoreError: null };
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

/** Rust's uncommitted review as the card keeps it: each file's lines. */
function countsOf(review: Record<string, any>): Pick<Git, "counts"> {
  const files: any[] = review.files;
  return { counts: new Map(files.map((file) => [file.path, { insertions: file.insertions, deletions: file.deletions }])) };
}

/** Each file's lines added and removed, read after the status: a file's row shows them. */
function count(): void {
  const target = git.target;
  if (!target) return;
  if (counting) return void (recount = true);
  counting = true;
  ask({ op: "run", args: sourceArgs(target, "review", "uncommitted") }, (reply) => {
    counting = false;
    // Another checkout's answer is dropped, but a count asked for meanwhile still runs.
    if (reply.ok && git.target === target) set(countsOf(reply.review));
    if (recount) {
      recount = false;
      count();
    }
  });
}

function landed(): void {
  set({ version: git.version + 1, error: null });
  count();
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
  });
}

function watch(target: Target, tries = 0): void {
  n = 0;
  const mine = (re = ask({ op: "git", ...target }, (reply) => {
    if (git.target !== target) return;
    if (!reply.ok) {
      readTruth();
      // A checkout never read may still be in the making (a fork's worktree): it's asked again for a few seconds before
      // that's an error, so its first read needs no Try again. A gone one shows its row from its truth meanwhile.
      if (reply.error !== "disconnected" && !git.head && tries < 10) return void setTimeout(() => re === mine && git.target === target && watch(target, tries + 1), 1000);
      return set({ error: reply.error === "disconnected" ? git.error : String(reply.error) });
    }
    n = reply.n;
    set({ head: reply.git.head, files: new Map(reply.git.files.map((each: Entry) => [each.path, each])), readAtMs: Date.now() });
    landed();
  }));
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

/** A folder chat's repo the panel reads, by session: Files, Review and the watch follow it [D494]. */
const repoPicks = store<Record<string, string>>({});
export const useRepoPick = (owner: string) => repoPicks.use()[owner] ?? null;
export const pickRepo = (owner: string, repo: string) => repoPicks.set({ ...repoPicks.get(), [owner]: repo });

/** Follows `owner`'s checkout while it's on screen: a session's, or Home's project's [D1039]. */
export function useGitWatch(owner: string | null): void {
  const { daemon, rows } = useDaemon();
  const repo = useRepoPick(owner ?? "");
  const project = useHomeProject();
  // A Local or existing checkout is there once Rust has the session: no wait for its agent to start [D85].
  const start = useStart(owner ?? "");
  const starting = start?.asking === true && !(start.args.includes("--local") && rows?.some((each) => each.id === owner));
  const target: Target | null = owner === null ? null : owner !== HOME ? { session: repo ? `${owner}@${repo}` : owner } : project ? { project: project.id } : null;
  const key = target && JSON.stringify(target);
  // Before the paint, so a switch never shows the last checkout's read or an empty one for a frame [D1258].
  useLayoutEffect(() => {
    if (key !== git.key) {
      re = 0;
      // A Local start works in its project's folder: that folder's last read draws until its own, so its card is whole from the first frame [D85].
      const local = start?.project && start.args.includes("--local") ? kept.get(JSON.stringify({ project: start.project })) : undefined;
      const last = key ? (kept.get(key) ?? local) : undefined;
      set({ key, target, head: last?.head ?? null, files: last?.files ?? new Map(), counts: last?.counts ?? new Map(), error: null, readAtMs: last?.readAtMs ?? null, truth: last?.truth ?? null, restoring: false, restoreError: null });
    }
    // New sessions open before Rust has made their checkout.
    if (daemon && target && !starting) watch(git.target!);
  }, [key, daemon, starting]);
  const row = owner !== null && owner !== HOME ? rows?.find((each) => each.id === owner) : undefined;
  // The 8 most recent open sessions in a project are read ahead [D1307].
  const recent = (rows ?? []).filter((each) => each.project && !each.archived).sort((a, b) => b.updated - a.updated).slice(0, 8).map((each) => each.id).join(" ");
  useEffect(() => void (daemon && warm(recent.split(" ").filter(Boolean))), [daemon, recent]);
  const working = isWorking(row);
  // A turn's start or end changes Review's brief (its last run) even when no file changed [D1199].
  useEffect(() => void (daemon && git.target && count()), [row?.finished, working]);
  useEffect(() => {
    // On focus the checkout is read again [D48].
    const refresh = () => {
      ask({ op: "git_refresh" });
      readTruth();
    };
    addEventListener("focus", refresh);
    return () => removeEventListener("focus", refresh);
  }, []);
}

export const retryGit = () => git.target && watch(git.target);

// The sessions to read ahead, newest first; one read at a time; ones whose read failed, not asked again.
let wanted: string[] = [];
let warming = false;
const tried = new Set<string>();

/**
 * Reads each of `ids` that isn't kept once, in the background and one after another, so a first visit draws its last
 * known state in the first frame as a return does; its watch then reads it again [D1305, D1307]. Only into room the
 * cache has, as its oldest, so nothing seen is pushed out.
 */
function warm(ids: string[]): void {
  wanted = ids;
  if (warming || kept.size >= 8) return;
  const id = wanted.find((each) => !tried.has(each) && !kept.has(JSON.stringify({ session: each })) && JSON.stringify({ session: each }) !== git.key);
  if (!id) return;
  warming = true;
  const target: Target = { session: id };
  const key = JSON.stringify(target);
  const asks = [sourceArgs(target, "status"), sourceArgs(target, "truth"), sourceArgs(target, "review", "uncommitted")];
  const replies: Record<string, any>[] = [];
  const next = () => {
    if (replies.length < asks.length) return ask({ op: "run", args: asks[replies.length]! }, (reply) => (replies.push(reply), next()));
    warming = false;
    const [read, truth, review] = replies as [Record<string, any>, Record<string, any>, Record<string, any>];
    if (replies.some((reply) => reply.error === "disconnected")) return;
    if (!read.ok) tried.add(id);
    else if (!kept.has(key) && git.key !== key && kept.size < 8) {
      const entry: Git = { key, target, head: read.git.head, files: new Map(read.git.files.map((each: Entry) => [each.path, each])), counts: new Map(), ...(review.ok && countsOf(review.review)), error: null, version: 0, readAtMs: Date.now(), truth: truth.ok ? truth.truth : null, restoring: false, restoreError: null };
      const seen = [...kept];
      kept.clear();
      kept.set(key, entry);
      for (const [k, v] of seen) kept.set(k, v);
    }
    warm(wanted);
  };
  next();
}

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

/** The on-screen checkout: its state. */
export function useGit(): { source: SourceState | null; error: string | null; version: number; target: Target | null; readAtMs: number | null; truth: Truth | null; restoring: boolean; restoreError: string | null } {
  const now = useSyncExternalStore(subscribe, () => git);
  if (shown?.from !== now) shown = { from: now, source: sourceOf(now) };
  return { source: shown.source, error: now.error, version: now.version, target: now.target, readAtMs: now.readAtMs, truth: now.truth, restoring: now.restoring, restoreError: now.restoreError };
}

// The last files read, by checkout and path (the last 8, as `kept`): one opened again shows at once, then is read
// again [D1310].
const files = new Map<string, FileRead>();

/** A checkout file as the viewer shows it, read again on each watch read that changed something [D1002]. */
export function useFileRead(path: string): FileRead {
  const { target: watched, version, error } = useSyncExternalStore(subscribe, () => git);
  // A folder chat's files are read from the chat, `<repo>/<path>`, whichever repo its watch follows [D776].
  const target = watched && "session" in watched ? { session: watched.session.split("@")[0]! } : watched;
  const key = target && `${JSON.stringify(target)}\0${path}`;
  const [read, setRead] = useState<FileRead>(() => (key && files.get(key)) || { state: "loading" });
  // Another file in the same view: its own last read, not the one before's [D1310].
  const [shownKey, setShownKey] = useState(key);
  if (shownKey !== key) {
    setShownKey(key);
    setRead((key && files.get(key)) || { state: "loading" });
  }
  const [tick, setTick] = useState(0);
  // shortcut: the watch leaves ignored files out, so an ignored file's tab reads it again every few seconds while the
  // window shows; a watch of the file itself would be instant.
  // Kept once seen, so a file a build deletes and writes again is still followed.
  const [ignored, setIgnored] = useState(false);
  // A folder chat's watch follows one repo, or none (it fails): its tabs look again themselves too [D776].
  const unwatched = ignored || (watched !== null && "session" in watched && (watched.session.includes("@") || error !== null));
  useEffect(() => {
    if (!unwatched) return;
    const timer = setInterval(() => document.visibilityState === "visible" && setTick((n) => n + 1), 3000);
    return () => clearInterval(timer);
  }, [unwatched]);
  useEffect(() => {
    if (!target) return;
    let live = true;
    ask({ op: "run", args: sourceArgs(target, "file", path) }, (reply) => {
      if (!live || reply.error === "disconnected") return;
      if (!reply.ok) return setRead({ state: "failed", error: String(reply.error) });
      if (reply.file.ignored) setIgnored(true);
      const next: FileRead = reply.file.gone ? { state: "gone", carried: false } : { state: "read", file: reply.file };
      if (key) keep(files, key, next);
      // The same read keeps its object, so the viewer doesn't draw it again.
      setRead((last) => (JSON.stringify(last) === JSON.stringify(next) ? last : next));
    });
    return () => void (live = false);
  }, [key, version, tick]);
  return read;
}
