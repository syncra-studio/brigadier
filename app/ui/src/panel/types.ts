import type { FileStatus } from "./status";

/*
 * What the right panel draws, in the shape Rust will send it [D65, D71]: structure only, the UI writes the words.
 * Until the wiring steps (2.15 on) these come from fake.ts.
 */

export type PanelView = "files" | "search" | "source";

/** A changed file and its lines added and removed. */
export type SourceFile = { path: string; status: FileStatus; oldPath: string | null; added: number; removed: number };

/** Whose checkout it is: a session's own worktree, or the user's own folder (a Local checkout session, the project folder). */
export type Checkout = "worktree" | "folder";

/** A checkout as git has it. */
export type SourceState = {
  checkout: Checkout;
  branch: string | null;
  /** The remote the branch publishes to, if there is one. */
  remote: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  staged: SourceFile[];
  changes: SourceFile[];
  merging: { incoming: string; message: string } | null;
  rebasing: { branch: string; onto: string; message: string } | null;
  /** The session's commits since its base, newest first [D1041]; none for a folder. */
  commits: Commit[];
  /** What the session's branch changed since its base, once committed: Source's "Changed since main" [D1111]. */
  sinceBase: SourceFile[];
};

export type Commit = { sha: string; subject: string; atMs: number; added: number; removed: number };

export type Branch = { name: string; remote: boolean; atMs: number; author: string; subject: string };

/** A pull request of the session's branch, as the host module reads it [D1017, D1030]: what its row and dot say. */
export type Pr = {
  number: number;
  title: string;
  state: "open" | "merged" | "closed";
  /** An open PR's worst news: checks failed, conflicts, changes asked, checks still running, or ready to merge. */
  health: "failed" | "conflicts" | "changes" | "running" | "ready";
  /** How many checks failed. */
  failed: number;
};

/** What the PR watch saw last, and when it last looked [D1017, D1116]. */
export type PrWatch = {
  checkedAtMs: number;
  events: { atMs: number; pr: number; kind: "opened" | "checksFailed" | "checksPassed" | "changesAsked" | "commented" | "merged"; detail: string }[];
};

/** A pull request's checks, as the merge confirm shows them. */
export type Checks = { passed: number; failed: number; running: number; approved: boolean };

/**
 * The action button's next step, which Rust works out from git all the time [D1015, D1019, D1045]. Each carries
 * the facts its pre-check line is written from. `base` is what the session lands into.
 */
export type Step =
  | { kind: "commit"; base: string; waiting: number; clean: boolean }
  | { kind: "merge"; base: string; ready: number; moved: number; busy: string[] | null }
  | { kind: "catchUp"; base: string; conflicts: string[] }
  | { kind: "continue"; base: string; left: number }
  | { kind: "landed"; base: string; atMs: number }
  | { kind: "pushPr"; base: string; pr: number; ahead: number; host: string }
  | { kind: "fixPr"; base: string; pr: number; why: "checks" | "changes"; detail: string }
  | { kind: "mergePr"; base: string; pr: number; checks: Checks }
  // A folder's: VS Code's own [D1045].
  | { kind: "folderCommit"; branch: string; behind: number; ahead: number }
  | { kind: "sync"; branch: string; remote: string; behind: number; ahead: number }
  | { kind: "publish"; branch: string; remote: string };

/** How a branch lands: merged locally as a merge commit or squashed [D1028]; a PR's host may also rebase. */
export type MergeStyle = "merge" | "squash" | "rebase";

/** A step that didn't go: Rust's reason, kept on the pre-check line until the next try. */
export type StepError = { kind: Step["kind"]; reason: string };

/** The dot on the toolbar's toggle and its tip [D1022, D1025]: the most urgent state, and the view it points to. */
export type PanelHint =
  | { tone: "changes"; count: number }
  | { tone: "ready"; base: string }
  | { tone: "conflict"; base: string }
  | { tone: "failed"; pr: number; why: "checks" | "changes" };

/**
 * A force push after a rejected one [D1034, D1049]: the local branch pushed, the remote and its ref (`remoteRef` as shown), the remote commit
 * the user reviewed, and where it is now if it moved.
 */
export type ForcePush = { branch: string; remote: string; ref: string; remoteRef: string; reviewed: string; movedTo: string | null };
