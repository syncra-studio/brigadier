import type { SourceState } from "./types";

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
