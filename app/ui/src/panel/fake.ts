import type { GitStep } from "./control";
import type { Branch, Pr, SourceFile, SourceState } from "./types";

/* Fake data for the gallery's summary card and git confirms; the app reads Rust's [D388]. */

const NOW = Date.now();
const MIN = 60_000;

const file = (path: string, status: SourceFile["status"], added = 0, removed = 0, oldPath: string | null = null): SourceFile => ({ path, status, oldPath, added, removed });

export const BRANCH = "brigadier/912a9469/session";

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
  sinceBase: [],
};

export const CHANGES: SourceState = {
  ...CLEAN,
  ahead: 2,
  changes: [file("src/upload/retry.ts", "modified", 62, 8), file("src/upload/client.ts", "modified", 21, 3), file("src/tray/Progress.tsx", "added", 58)],
};

export const STAGED: SourceState = {
  ...CHANGES,
  staged: [file("src/upload/retry.ts", "added", 62), file("src/upload/client.ts", "modified", 21, 3)],
  changes: [file("src/tray/Progress.tsx", "modified", 58), file("README.md", "modified", 14)],
};

export const BRANCHES: Branch[] = [
  { name: "main", remote: false, atMs: NOW - 60 * MIN, author: "You", subject: "Bump the tray icon" },
  { name: "fix/login", remote: false, atMs: NOW - 24 * 60 * MIN, author: "You", subject: "Keep the email on a failed sign-in" },
  { name: "origin/main", remote: true, atMs: NOW - 30 * MIN, author: "sam-k", subject: "Merge #11: faster cold start" },
  { name: "origin/release/2.4", remote: true, atMs: NOW - 5 * 24 * 60 * MIN, author: "sam-k", subject: "Release 2.4.0" },
];

/** The branch's pull requests: #12 open with a failing check, #11 merged. */
export const PRS: Pr[] = [
  { number: 12, title: "Retry failed uploads", state: "open", health: "failed", failed: 1 },
  { number: 11, title: "Show upload progress in the tray", state: "merged", health: "ready", failed: 0 },
];

/** The host the fake branch publishes to; the UI names none of its own [D1030]. */
export const HOST = "GitHub";

const step = (over: Partial<GitStep>): GitStep => ({ next: null, off: {}, base: "main", branch: BRANCH, ahead: 0, behind: 0, moved: 0, files: 0, pr: null, sharedWith: null, resolve: null, landedAtMs: null, ...over });
const SETTLED = { commit: "clean", sync: "synced", catchUp: "upToDate" } as const;

/** The control's states as Rust sends them (2.48), the order a session goes through them [D1285, D1286, D1287]. */
export const STEPS = {
  changes: step({ next: "commit", files: 3, off: { sync: "unpublished", push: "commitFirst", createPr: "commitFirst", merge: "commitFirst", catchUp: "commitFirst" } }),
  committed: step({ next: "push", off: { commit: "clean", sync: "unpublished", createPr: "pushFirst", catchUp: "upToDate" } }),
  pushed: step({ next: "createPr", off: { ...SETTLED, push: "pushed" } }),
  prOpen: step({ pr: 12, off: { ...SETTLED, push: "pushed", createPr: "prOpen", merge: "inPrTab" } }),
  sync: step({ next: "sync", ahead: 1, behind: 1, off: { commit: "clean", push: "behind", createPr: "pushFirst", catchUp: "upToDate" } }),
  syncConflicts: step({ next: "resolve", ahead: 1, behind: 1, resolve: { op: "pull", ref: `origin/${BRANCH}`, files: ["src/upload/retry.ts"] }, off: { commit: "clean", sync: "conflicts", push: "behind", createPr: "pushFirst", catchUp: "upToDate" } }),
  moved: step({ next: "catchUp", moved: 3, off: { commit: "clean", sync: "unpublished", push: "moved", createPr: "moved", merge: "moved" } }),
  catchUpConflicts: step({ next: "resolve", moved: 3, resolve: { op: "merge", ref: "main", files: ["src/upload/retry.ts", "src/upload/client.ts"] }, off: { commit: "clean", sync: "unpublished", catchUp: "conflicts", push: "moved", createPr: "moved", merge: "moved" } }),
  noHost: step({ off: { commit: "clean", sync: "unpublished", push: "noRemote", createPr: "pushFirst", catchUp: "upToDate" } }),
  landed: step({ landedAtMs: NOW - 5 * MIN, off: { ...SETTLED, push: "pushed", createPr: "landed", merge: "landed" } }),
  shared: step({ next: "commit", files: 2, sharedWith: "Fix the login form", off: { sync: "unpublished", push: "commitFirst", createPr: "shared", merge: "shared", catchUp: "commitFirst" } }),
  folder: step({ next: "push", base: null, branch: "main", ahead: 2, off: { commit: "clean", sync: "synced", createPr: "noBase", catchUp: "noBase", merge: "noBase" } }),
} satisfies Record<string, GitStep>;
