import type { Branch, Commit, PanelHint, SourceFile, SourceState, Step } from "./types";

/*
 * Fake data for the right panel while it's unwired [D388]: the app and the gallery draw from it. It goes when the
 * wiring steps (2.15 on) bring Rust's.
 */

const NOW = Date.now();
const MIN = 60_000;

export const file = (path: string, status: SourceFile["status"], oldPath: string | null = null): SourceFile => ({ path, status, oldPath });

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
};

export const CHANGES: SourceState = {
  ...CLEAN,
  ahead: 2,
  changes: [file("src/upload/retry.ts", "modified"), file("src/upload/client.ts", "modified"), file("src/tray/Progress.tsx", "added")],
  commits: COMMITS,
};

export const STAGED: SourceState = {
  ...CHANGES,
  staged: [file("src/upload/retry.ts", "added"), file("src/upload/client.ts", "modified")],
  changes: [file("src/tray/Progress.tsx", "modified"), file("README.md", "modified")],
};

/** Every letter Source draws. */
export const LETTERED: SourceState = {
  ...CLEAN,
  changes: [
    file("src/upload/retry.ts", "modified"),
    file("src/upload/backoff.ts", "added"),
    file("src/upload/legacy.ts", "deleted"),
    file("src/tray/Progress.tsx", "renamed", "src/tray/Bar.tsx"),
    file("src/tray/Icon.tsx", "copied", "src/tray/Badge.tsx"),
    file("scripts/run", "typeChanged"),
    file("notes/todo.md", "untracked"),
  ],
};

export const MERGING: SourceState = {
  ...CLEAN,
  merging: { incoming: "main", message: "Merge branch 'main' into brigadier/912a9469/session" },
  staged: [file("src/tray/Progress.tsx", "modified")],
  changes: [file("src/upload/retry.ts", "conflicted"), file("src/upload/client.ts", "conflicted")],
};

export const REBASING: SourceState = {
  ...CLEAN,
  branch: null,
  rebasing: { branch: BRANCH, onto: "main", message: "Show upload progress in the tray" },
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
  changes: [file("README.md", "modified")],
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

/** The host the fake branch publishes to; the UI names none of its own [D1030]. */
export const HOST = "GitHub";

export const STEPS = {
  commit: { kind: "commit", base: "main", waiting: 0, clean: true },
  commitWaiting: { kind: "commit", base: "main", waiting: 3, clean: true },
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
const FAKES: { source: SourceState; step: Step; hint: PanelHint | null }[] = [
  { source: CHANGES, step: STEPS.commitWaiting, hint: { tone: "changes", count: 3 } },
  { source: { ...CLEAN, ahead: 3, commits: COMMITS.slice(0, 3) }, step: STEPS.merge, hint: { tone: "ready", base: "main" } },
  { source: { ...CLEAN, ahead: 3, commits: COMMITS.slice(0, 3) }, step: STEPS.catchUp, hint: { tone: "conflict", base: "main" } },
  { source: { ...CLEAN, ahead: 2, commits: COMMITS.slice(0, 2) }, step: STEPS.fixPr, hint: { tone: "failed", pr: 12, why: "checks" } },
  { source: { ...CLEAN, commits: COMMITS }, step: STEPS.landed, hint: null },
];

const FOLDER_FAKE = { source: FOLDER, step: STEPS.sync as Step, hint: { tone: "changes", count: 1 } as PanelHint | null };

/** `folder`: a project chat, on the project's folder [D1039]. */
export function fakeFor(owner: string, folder: boolean) {
  if (folder) return FOLDER_FAKE;
  let hash = 0;
  for (const char of owner) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return FAKES[hash % FAKES.length]!;
}
