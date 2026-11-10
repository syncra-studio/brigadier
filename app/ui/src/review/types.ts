/**
 * What the Review tab draws, as Rust will send it (PROPOSED for step 2.18): the file list with counts first, then
 * each file's contents (D1036). Rust parses git's patches; the UI only draws them (D71).
 */

import type { FileStatus } from "../panel/status";

/** What a review compares (D1035). */
export type ReviewScope = "uncommitted" | "staged" | "unstaged" | "branch";

export type ReviewFile = {
  path: string;
  /** A renamed file's old path. */
  from: string | null;
  status: FileStatus;
  insertions: number;
  deletions: number;
  binary: boolean;
  /** All its changes are in the index, so the file's own action is Unstage; known before its contents arrive. */
  staged: boolean;
  /** Over Rust's size threshold: it arrives folded, and its contents are asked for when it's opened (D1036). */
  large: boolean;
};

/** One change as git cuts it, which Stage hunk and Revert hunk take (D1043). */
export type ReviewHunk = {
  /** Stable while the hunk is unchanged, to reconcile a stage or revert by (D30). */
  id: string;
  /** Its `@@ -27,6 +28,8 @@` line. */
  header: string;
  insertions: number;
  deletions: number;
  /** Already in the index (an Uncommitted review shows both kinds). */
  staged: boolean;
  /** Its first line in the new file and the unchanged lines before its first change: its bar sits right above that change. */
  newStart: number;
  leading: number;
  /** The lines it changes, for its confirm's words: numbered in the new file, or in the old one when it only deletes. */
  side: "additions" | "deletions";
  start: number;
  end: number;
};

/** A file's two sides whole, so every unchanged stretch opens in place (D48), and git's hunks over them. */
export type FileContents = { before: string; after: string; hunks: readonly ReviewHunk[] };

export type Review = {
  scope: ReviewScope;
  /** The branch Branch since base compares against. */
  base: string | null;
  files: readonly ReviewFile[];
  insertions: number;
  deletions: number;
};

/** What the diff asks of git, by a hunk or a whole file. */
export type HunkAction = "stage" | "unstage" | "revert";

/** A request from the diff: a hunk's action, or the file's when `hunk` is null. */
export type ReviewRequest = { action: HunkAction; path: string; hunk: string | null };

/** Where a request stands, by hunk id or, for a whole file, by its path (D30). */
export type RequestState = { pending: HunkAction } | { error: string };

/** A comment on a range of lines, waiting as a chip to go with the next message (D1040). */
export type DiffComment = {
  id: string;
  path: string;
  side: "additions" | "deletions";
  start: number;
  end: number;
  /** The range's first line, as the chip quotes it. */
  excerpt: string;
  text: string;
};
