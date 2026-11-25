/**
 * What the Review tab draws, as Rust sends it: the file list with counts first, then
 * each file's contents (D1036). Rust parses git's patches; the UI only draws them (D71).
 */

import type { FileStatus } from "../panel/status";

/** What a review compares (D1035); Last turn is the session's last turn, from rewind's captures (D1000), and a night,
 * by when it began and ended (ms), from its own two. */
export type ReviewScope = "last" | `night:${number}-${number}` | "uncommitted" | "staged" | "unstaged" | "branch";

/** Why a file is worth a look first, as Rust classed it (D1188, D1213): a test file deleted or with lines removed, a
 * lock file, a dependency manifest, CI or build config, a migration. */
export type FileFlag = { kind: "test" | "lock" | "manifest" | "build" | "migration"; removed: number; deleted: boolean };

/** The session's last test or build run (D1188): its exit code only as its CLI reported it, else null (D74); `changed`:
 * an edit to this checkout began after it ended, the run's own fact, the same in every scope (D1243), else unknown, never "no" (D1192). */
export type LastRun = { command: string; exit: number | null; at: number; changed: boolean };

/** A scope read between two captures of the folder. */
export const captured = (scope: ReviewScope) => scope === "last" || scope.startsWith("night:");

/** Why Last turn or a night has nothing to compare (D30). */
export type NoTurn = "noNight" | "noProject" | "notGit" | "noTurn" | "midTurn" | "noSnapshot";

export type ReviewFile = {
  path: string;
  /** A renamed file's old path. */
  from: string | null;
  status: FileStatus;
  insertions: number;
  deletions: number;
  binary: boolean;
  /** All its changes are in the index; known before its contents arrive. */
  staged: boolean;
  /** Over Rust's size threshold: it arrives folded, and its contents are asked for when it's opened (D1036). */
  large: boolean;
  /** Rust's flag, when the review carries its brief. */
  flag?: FileFlag | null;
};

/** One change as git cuts it, as Rust sends it (D1043). */
export type ReviewHunk = {
  /** Stable while the hunk is unchanged (D30). */
  id: string;
  /** Its `@@ -27,6 +28,8 @@` line. */
  header: string;
  insertions: number;
  deletions: number;
  /** Already in the index (an Uncommitted review shows both kinds). */
  staged: boolean;
  /** Its first line in the new file and the unchanged lines before its first change. */
  newStart: number;
  leading: number;
  /** The lines it changes: numbered in the new file, or in the old one when it only deletes. */
  side: "additions" | "deletions";
  start: number;
  end: number;
};

/** A file's two sides whole, so every unchanged stretch opens in place (D48), and git's hunks over them. */
export type FileContents = { before: string; after: string; hunks: readonly ReviewHunk[] };

/** A host's patch of a file, as a PR's Files changed reads it [D231]; null where the host sent none (too large). */
export type PatchContents = { patch: string | null };

export type Review = {
  scope: ReviewScope;
  /** The branch Branch since base compares against. */
  base: string | null;
  /** Where the branch left it: Branch since base starts there. */
  since?: string;
  files: readonly ReviewFile[];
  insertions: number;
  deletions: number;
  /** Last turn's or a night's two captures, which its files' contents are read between, and what they leave out (D1192). */
  turn?: { before: string; after: string; live: boolean; missed: boolean; excluded: readonly string[] };
  /** Last turn or a night with nothing to compare, and why. */
  none?: NoTurn;
  /** Another session works in this folder: its changes may be in the diff (D1078). */
  shared?: boolean;
  /** The brief's last run; null with none this session. Absent where Rust sent no brief. */
  run?: LastRun | null;
};

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
