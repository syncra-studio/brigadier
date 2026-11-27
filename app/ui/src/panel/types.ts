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

export type { Job, KeptPrs, Pr } from "../../../shared/rows";
import type { Pr } from "../../../shared/rows";

