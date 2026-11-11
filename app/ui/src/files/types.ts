// What Files and the file viewer show: the shapes Rust sends [D1002]. Data only.
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
