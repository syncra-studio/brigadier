import type { Branch, SourceState } from "./types";

/* Fake data for the gallery's branch pick; the app reads Rust's [D388]. */

const NOW = Date.now();
const MIN = 60_000;

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

export const BRANCHES: Branch[] = [
  { name: "main", remote: false, atMs: NOW - 60 * MIN, author: "You", subject: "Bump the tray icon" },
  { name: "fix/login", remote: false, atMs: NOW - 24 * 60 * MIN, author: "You", subject: "Keep the email on a failed sign-in" },
  { name: "origin/main", remote: true, atMs: NOW - 30 * MIN, author: "sam-k", subject: "Merge #11: faster cold start" },
  { name: "origin/release/2.4", remote: true, atMs: NOW - 5 * 24 * 60 * MIN, author: "sam-k", subject: "Release 2.4.0" },
];
