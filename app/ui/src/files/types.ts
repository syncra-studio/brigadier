// What Files, the file viewer and Search show: the shapes Rust sends [D1002, D1003]. Data only.
import type { FileStatus } from "../panel/status";

/** A checkout's files as git lists them, capped; what it ignores ("dist/" a folder) is listed apart. */
export type FileList = { files: string[]; truncated: boolean; ignored: string[] };

/** The tree's listing: still coming, failed, or listed [D30]. */
export type Listing = { state: "loading" } | { state: "failed"; error: string } | { state: "listed"; list: FileList };

/** Change marks, worked out in Rust: each changed file's status, and each folder's most severe one. */
export type ChangeMarks = { files: Record<string, FileStatus>; folders: Record<string, FileStatus> };

/** One entry of an ignored folder, read from disk when it's opened. */
export type FolderEntry = { name: string; folder: boolean };

/** A file read from the checkout: `text` null for a binary one, cut short past the size cap. */
export type CheckoutFile = { size: number; text: string | null; truncated: boolean; /** git ignores it. */ ignored?: boolean };

/** A file tab's read: loading, read, gone ("deleted or moved", or never in this session's copy), or failed. */
export type FileRead =
  | { state: "loading" }
  | { state: "read"; file: CheckoutFile }
  | { state: "gone"; carried: boolean }
  | { state: "failed"; error: string };

/** What Search asks for. */
export type SearchQuery = { text: string; matchCase: boolean; wholeWord: boolean; regex: boolean; include: string; exclude: string };

export type SearchRange = { start: number; end: number };
/** A matching line: its number, its text and where the matches are in it. */
export type SearchLine = { line: number; preview: string; ranges: SearchRange[] };
/** A file's matches: `hash` is its content when searched, so Replace all can tell it changed since. */
export type SearchFile = { path: string; matches: number; hash: string; lines: SearchLine[] };

/** A search's results so far: `done` once it ended, `capped` when it stopped at its limit. */
export type SearchResults = {
  query: SearchQuery;
  files: SearchFile[];
  done: { capped: boolean } | null;
  error: string | null;
  /** How many files were found but dismissed, so an empty list reads right. */
  filteredFiles: number;
};

export type ReplaceSkip = { path: string; reason: string };
/** What Replace all did: nothing at all when a file changed since the search (`skipped`). */
export type ReplaceOutcome = { files: number; matches: number; skipped: ReplaceSkip[]; unrestored: ReplaceSkip[] };
