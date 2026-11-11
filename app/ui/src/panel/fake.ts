import type { Branch, Pr, SourceFile, SourceState, Step } from "./types";

/* Fake data for the gallery's summary card and git confirms; the app reads Rust's [D388]. */

const NOW = Date.now();
const MIN = 60_000;

const file = (path: string, status: SourceFile["status"], added = 0, removed = 0, oldPath: string | null = null): SourceFile => ({ path, status, oldPath, added, removed });

export const BRANCH = "brigadier/912a9469/session";

const CLEAN: SourceState = {
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

const CHANGES: SourceState = {
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

export const STEPS = {
  merge: { kind: "merge", base: "main", ready: 3, moved: 0, blocked: null },
} satisfies Record<string, Step>;
