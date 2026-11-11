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
  url?: string;
  /** The failed checks' names, as the thread's row says them; null when the host's read couldn't say. */
  failedChecks?: string[] | null;
};

/**
 * A session's PRs as Rust's watch keeps them (`prs.json`, proposed) [D1009]: when the last whole read answered (ms),
 * why the last read didn't (null when it did), and each PR's last known facts.
 */
export type KeptPrs = { okAt: number | null; error: string | null; branch?: string; prs: Pr[] };
