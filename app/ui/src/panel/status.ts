/* How a changed file differs from git's last commit, shared by Source, the Files tree and Search (the old sourceStatus.ts). */

export type FileStatus = "modified" | "added" | "deleted" | "renamed" | "copied" | "typeChanged" | "untracked" | "conflicted";

/** Each status as a letter in its colour. */
export const LETTERS: Record<FileStatus, { letter: string; label: string; className: string }> = {
  modified: { letter: "M", label: "Modified", className: "text-warning" },
  added: { letter: "A", label: "Added", className: "text-success" },
  deleted: { letter: "D", label: "Deleted", className: "text-destructive" },
  renamed: { letter: "R", label: "Renamed", className: "text-link" },
  copied: { letter: "C", label: "Copied", className: "text-link" },
  typeChanged: { letter: "T", label: "Type changed", className: "text-warning" },
  untracked: { letter: "U", label: "Untracked", className: "text-success" },
  conflicted: { letter: "!", label: "Conflicted", className: "text-destructive" },
};
