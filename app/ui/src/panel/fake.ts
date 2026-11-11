import type { Branch, Commit, Pr, SourceFile, SourceState, Step } from "./types";

/* Fake data for the gallery's summary card and git confirms; the app reads Rust's [D388]. */

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

/** The branch's pull requests: #12 open with a failing check, #11 merged. */
export const PRS: Pr[] = [
  { number: 12, title: "Retry failed uploads", state: "open", health: "failed", failed: 1 },
  { number: 11, title: "Show upload progress in the tray", state: "merged", health: "ready", failed: 0 },
];

/** The message drafted for the work so far (2.20), the field's grey text. */
export const DRAFT = "Retry failed uploads and show progress in the tray";

/** The host the fake branch publishes to; the UI names none of its own [D1030]. */
export const HOST = "GitHub";

export const STEPS = {
  commit: { kind: "commit", base: "main", waiting: 0, clean: true },
  commitWaiting: { kind: "commit", base: "main", waiting: COMMITS.length, clean: true },
  merge: { kind: "merge", base: "main", ready: 3, moved: 0, blocked: null },
  mergeMoved: { kind: "merge", base: "main", ready: 3, moved: 4, blocked: null },
  catchUp: { kind: "catchUp", base: "main", conflicts: ["src/upload/retry.ts", "src/upload/client.ts"] },
  continue: { kind: "continue", base: "main", left: 2 },
  busy: { kind: "merge", base: "main", ready: 3, moved: 0, blocked: { why: "busy", folder: "/Users/you/upload-app", files: ["src/upload/client.ts"] } },
  landed: { kind: "landed", base: "main", atMs: NOW - 2 * MIN },
  pushPr: { kind: "pushPr", base: "main", pr: 12, ahead: 2, host: HOST },
  fixPr: { kind: "fixPr", base: "main", pr: 12, why: "checks", failed: 1 },
  fixPrChanges: { kind: "fixPr", base: "main", pr: 12, why: "changes", failed: 0 },
  mergePr: { kind: "mergePr", base: "main", pr: 12, checks: { passed: 6, failed: 0, running: 0, approved: true }, mergeable: true },
  folderCommit: { kind: "folderCommit", branch: "main", behind: 1, ahead: 1 },
  sync: { kind: "sync", branch: "main", remote: "origin", behind: 1, ahead: 2 },
  publish: { kind: "publish", branch: "fix/login", remote: "origin" },
} satisfies Record<string, Step>;
