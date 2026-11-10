import { useSyncExternalStore } from "react";

import type { Branch, Commit, PanelHint, Pr, PrWatch, SourceFile, SourceState, Step } from "./types";

/*
 * Fake data for the right panel while it's unwired [D388]: the app and the gallery draw from it. It goes when the
 * wiring steps (2.15 on) bring Rust's.
 */

const NOW = Date.now();
const MIN = 60_000;

export const file = (path: string, status: SourceFile["status"], added = 0, removed = 0, oldPath: string | null = null): SourceFile => ({ path, status, oldPath, added, removed });

export const BRANCH = "brigadier/912a9469/session";

export const COMMITS: Commit[] = [
  { sha: "4f19a0b", subject: "Cap the retry wait and skip 4xx errors", atMs: NOW - 12 * MIN, added: 10, removed: 2 },
  { sha: "e6c7d22", subject: "Test the retry backoff", atMs: NOW - 60 * MIN, added: 42, removed: 0 },
  { sha: "b81e04d", subject: "Show upload progress in the tray", atMs: NOW - 120 * MIN, added: 31, removed: 4 },
  { sha: "3f2a91c", subject: "Retry a failed upload three times", atMs: NOW - 180 * MIN, added: 82, removed: 7 },
];

export const CLEAN: SourceState = {
  checkout: "worktree",
  branch: BRANCH,
  remote: "origin",
  upstream: `origin/${BRANCH}`,
  ahead: 0,
  behind: 0,
  staged: [],
  changes: [],
  merging: null,
  rebasing: null,
  commits: [],
  sinceBase: [],
};

export const CHANGES: SourceState = {
  ...CLEAN,
  ahead: 2,
  changes: [file("src/upload/retry.ts", "modified", 62, 8), file("src/upload/client.ts", "modified", 21, 3), file("src/tray/Progress.tsx", "added", 58)],
  commits: COMMITS,
};

export const STAGED: SourceState = {
  ...CHANGES,
  staged: [file("src/upload/retry.ts", "added", 62), file("src/upload/client.ts", "modified", 21, 3)],
  changes: [file("src/tray/Progress.tsx", "modified", 58), file("README.md", "modified", 14)],
};

/** Everything committed: what the branch changed since main. */
export const COMMITTED: SourceState = {
  ...CLEAN,
  ahead: 4,
  commits: COMMITS,
  sinceBase: [...STAGED.staged, ...STAGED.changes, file("src/upload/retry.test.ts", "added", 42)],
};

/** Every letter Source draws. */
export const LETTERED: SourceState = {
  ...CLEAN,
  changes: [
    file("src/upload/retry.ts", "modified", 12, 4),
    file("src/upload/backoff.ts", "added", 30),
    file("src/upload/legacy.ts", "deleted", 0, 88),
    file("src/tray/Progress.tsx", "renamed", 2, 2, "src/tray/Bar.tsx"),
    file("src/tray/Icon.tsx", "copied", 0, 0, "src/tray/Badge.tsx"),
    file("scripts/run", "typeChanged"),
    file("notes/todo.md", "untracked", 9),
  ],
};

export const MERGING: SourceState = {
  ...CLEAN,
  merging: { incoming: "main", message: "Merge branch 'main' into brigadier/912a9469/session" },
  ahead: 2,
  commits: COMMITS,
  staged: [file("src/tray/Progress.tsx", "modified", 6, 1)],
  changes: [file("src/upload/retry.ts", "conflicted"), file("src/upload/client.ts", "conflicted")],
};

export const REBASING: SourceState = {
  ...CLEAN,
  branch: null,
  rebasing: { branch: BRANCH, onto: "main", message: "Show upload progress in the tray" },
  commits: COMMITS,
  changes: [file("src/tray/Progress.tsx", "conflicted")],
};

/** The user's own folder: a Local checkout session or the project folder. */
export const FOLDER: SourceState = {
  ...CLEAN,
  checkout: "folder",
  branch: "main",
  upstream: "origin/main",
  ahead: 2,
  behind: 1,
  staged: [file("src/upload/retry.ts", "modified", 9, 2)],
  changes: [file("src/tray/Progress.tsx", "added", 58), file("README.md", "modified", 14)],
};

export const BRANCHES: Branch[] = [
  { name: "main", remote: false, atMs: NOW - 60 * MIN, author: "You", subject: "Bump the tray icon" },
  { name: "fix/login", remote: false, atMs: NOW - 24 * 60 * MIN, author: "You", subject: "Keep the email on a failed sign-in" },
  { name: "origin/main", remote: true, atMs: NOW - 30 * MIN, author: "sam-k", subject: "Merge #11: faster cold start" },
  { name: "origin/release/2.4", remote: true, atMs: NOW - 5 * 24 * 60 * MIN, author: "sam-k", subject: "Release 2.4.0" },
];

export const GIT_RUNS = [
  { atMs: NOW - 9 * MIN, command: "git fetch origin", output: "", ok: true },
  { atMs: NOW - 8 * MIN, command: "git pull --ff-only", output: "Already up to date.", ok: true },
  { atMs: NOW - 2 * MIN, command: "git push", output: "! [rejected] HEAD -> brigadier/912a9469/session (fetch first)\nerror: failed to push some refs", ok: false },
];

/** The branch's pull requests: #12 open with a failing check, #11 merged. */
export const PRS: Pr[] = [
  { number: 12, title: "Retry failed uploads", state: "open", health: "failed", failed: 1 },
  { number: 11, title: "Show upload progress in the tray", state: "merged", health: "ready", failed: 0 },
];

export const WATCH: PrWatch = {
  checkedAtMs: NOW - MIN,
  events: [
    { atMs: NOW - 18 * MIN, pr: 12, kind: "checksFailed", detail: "test (ubuntu-latest)" },
    { atMs: NOW - 30 * MIN, pr: 12, kind: "opened", detail: "by the agent" },
    { atMs: NOW - 52 * MIN, pr: 11, kind: "merged", detail: "by you" },
  ],
};

/** The message drafted for the work so far (2.20), the field's grey text. */
export const DRAFT = "Retry failed uploads and show progress in the tray";

/** The host the fake branch publishes to; the UI names none of its own [D1030]. */
export const HOST = "GitHub";

export const STEPS = {
  commit: { kind: "commit", base: "main", waiting: 0, clean: true },
  commitWaiting: { kind: "commit", base: "main", waiting: COMMITS.length, clean: true },
  merge: { kind: "merge", base: "main", ready: 3, moved: 0, busy: null },
  mergeMoved: { kind: "merge", base: "main", ready: 3, moved: 4, busy: null },
  catchUp: { kind: "catchUp", base: "main", conflicts: ["src/upload/retry.ts", "src/upload/client.ts"] },
  continue: { kind: "continue", base: "main", left: 2 },
  busy: { kind: "merge", base: "main", ready: 3, moved: 0, busy: ["src/upload/client.ts"] },
  landed: { kind: "landed", base: "main", atMs: NOW - 2 * MIN },
  pushPr: { kind: "pushPr", base: "main", pr: 12, ahead: 2, host: HOST },
  fixPr: { kind: "fixPr", base: "main", pr: 12, why: "checks", detail: "test (ubuntu-latest)" },
  fixPrChanges: { kind: "fixPr", base: "main", pr: 12, why: "changes", detail: "by sam-k" },
  mergePr: { kind: "mergePr", base: "main", pr: 12, checks: { passed: 6, failed: 0, running: 0, approved: true } },
  folderCommit: { kind: "folderCommit", branch: "main", behind: 1, ahead: 1 },
  sync: { kind: "sync", branch: "main", remote: "origin", behind: 1, ahead: 2 },
  publish: { kind: "publish", branch: "fix/login", remote: "origin" },
} satisfies Record<string, Step>;

/** One fake per session or chat, picked by its id, so a few sessions show every dot and tip [D1025]. */
const FAKES: { source: SourceState; step: Step; hint: PanelHint | null; prs?: Pr[] }[] = [
  { source: STAGED, step: STEPS.commitWaiting, hint: { tone: "changes", count: 4 }, prs: PRS },
  { source: { ...COMMITTED, commits: COMMITS.slice(0, 3) }, step: STEPS.merge, hint: { tone: "ready", base: "main" } },
  { source: { ...COMMITTED, commits: COMMITS.slice(0, 3) }, step: STEPS.catchUp, hint: { tone: "conflict", base: "main" } },
  { source: COMMITTED, step: STEPS.fixPr, hint: { tone: "failed", pr: 12, why: "checks" }, prs: PRS },
  { source: CLEAN, step: STEPS.landed, hint: null },
];

const FOLDER_FAKE = { source: FOLDER, step: STEPS.folderCommit as Step, hint: { tone: "changes", count: 3 } as PanelHint | null, prs: undefined };

/** `folder`: a project chat, on the project's folder [D1039]. */
export function fakeFor(owner: string, folder: boolean) {
  if (folder) return FOLDER_FAKE;
  let hash = 0;
  for (const char of owner) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return FAKES[hash % FAKES.length]!;
}

/** The fake's moves (stage, discard, commit) per session, so the toggle and the Source badge follow them. */
const moved = new Map<string, SourceState>();
const listeners = new Set<() => void>();

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export function setFakeSource(owner: string, source: SourceState) {
  moved.set(owner, source);
  for (const listener of listeners) listener();
}

/** `fakeFor` as moved so far, with the files left to commit counted once each. */
export function useFake(owner: string, folder: boolean) {
  const fake = fakeFor(owner, folder);
  const source = useSyncExternalStore(subscribe, () => moved.get(owner) ?? fake.source);
  const count = new Set([...source.staged, ...source.changes].map((each) => each.path)).size;
  const hint: PanelHint | null = fake.hint?.tone === "changes" ? (count > 0 ? { tone: "changes", count } : null) : fake.hint;
  return { ...fake, source, hint, count };
}
