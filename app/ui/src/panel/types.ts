import type { FileStatus } from "./status";

/*
 * What the right panel draws, in the shape Rust will send it [D65, D71]: structure only, the UI writes the words.
 * Until the wiring steps (2.15 on) these come from fake.ts.
 */

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
  /** What the session's branch changed since its base, once committed [D1111]. */
  sinceBase: SourceFile[];
};

export type Branch = { name: string; remote: boolean; atMs: number; author: string; subject: string };

/** A pull request of the session's branch, as the host module reads it [D1017, D1030]: what its row and dot say. */
export type Pr = {
  number: number;
  title: string;
  state: "open" | "merged" | "closed";
  /**
   * An open PR's worst news: checks failed, conflicts, changes asked, checks still running, ready to merge, checks
   * cancelled, or what the checks say couldn't be read (none reported included) [D74].
   */
  health: "failed" | "conflicts" | "changes" | "running" | "ready" | "cancelled" | "unknown";
  /** How many checks failed; null when the host's read couldn't say. */
  failed: number | null;
};

/** Why the base can't take a landing now [D1047, D1082, D1161]: edits there in the way, a merge stopped there, not a local branch, or another session lands. */
export type Blocked =
  | { why: "busy"; folder: string; files: string[] }
  | { why: "midway"; folder: string }
  | { why: "remote" }
  | { why: "commit" }
  | { why: "shared"; with: string };

/**
 * The card's next git step, which Rust works out from git all the time [D1015, D1045]. Each carries the facts its
 * words are written from. `base` is what the session lands into.
 */
export type Step =
  | { kind: "commit"; base: string; waiting: number; clean: boolean }
  // `commit`: files the button commits first, then lands [D1203, D1207].
  | { kind: "merge"; base: string; ready: number; moved: number; blocked: Blocked | null; commit?: number }
  | { kind: "catchUp"; base: string; conflicts: string[]; commit?: number }
  // No time when it landed outside Brigadier.
  | { kind: "landed"; base: string; atMs: number | null }
  // A folder's: VS Code's own [D1045].
  | { kind: "folderCommit"; branch: string; behind: number; ahead: number }
  | { kind: "sync"; branch: string; remote: string; behind: number; ahead: number; commit?: number }
  | { kind: "publish"; branch: string; remote: string; commit?: number };

/** A step that didn't go: Rust's reason, kept until the next try. */
export type StepError = { kind: Step["kind"]; reason: string };
