/**
 * What the Review tab draws, as Rust sends it: the file list with counts first, then
 * each file's contents (D1036). Rust parses git's patches; the UI only draws them (D71).
 */

import type { FileStatus } from "../panel/status";

/** What a review compares (D1035); Last turn is the session's last turn, from rewind's captures (D1000); a commit's own
 * diff opens from History (D1041). */
export type ReviewScope = "last" | "uncommitted" | "staged" | "unstaged" | "branch" | "commit";

/** Why a file is worth a look first, as Rust classed it (D1188, D1213): a test file deleted or with lines removed, a
 * lock file, a dependency manifest, CI or build config, a migration. */
export type FileFlag = { kind: "test" | "lock" | "manifest" | "build" | "migration"; removed: number; deleted: boolean };

/** The session's last test or build run (D1188): its exit code only as its CLI reported it, else null (D74); `changed`:
 * an edit to this checkout began after it ended, the run's own fact, the same in every scope (D1243), else unknown, never "no" (D1192). */
export type LastRun = { command: string; exit: number | null; at: number; changed: boolean };

/** Why Last turn has nothing to compare (D30). */
export type NoTurn = "noProject" | "notGit" | "noTurn" | "midTurn" | "noSnapshot";

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
  /** Rust's flag, when the review carries its brief. */
  flag?: FileFlag | null;
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
  /** Where the branch left it: Branch since base starts there. */
  since?: string;
  /** The commit a commit review shows: its full id, subject and time (D1041). */
  commit?: { sha: string; subject: string; atMs: number };
  files: readonly ReviewFile[];
  insertions: number;
  deletions: number;
  /** Last turn's two captures, which its files' contents are read between, and what they leave out (D1192). */
  turn?: { before: string; after: string; live: boolean; missed: boolean; excluded: readonly string[] };
  /** Last turn with nothing to compare, and why. */
  none?: NoTurn;
  /** Another session works in this folder: its changes may be in the diff (D1078). */
  shared?: boolean;
  /** The brief's last run; null with none this session. Absent where Rust sent no brief. */
  run?: LastRun | null;
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
