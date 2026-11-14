import { ErrorLine } from "../../components/error-line";
import type { FileFlag, LastRun } from "../../review/types";
import type { Freshness, Truth } from "../git";
import type { KeptPrs, Pr, SourceState } from "../types";

/** What the summary card's git part shows, from Rust; the gallery's own fake without it. */
export type SourceData = {
  /** Null while the first read is under way. */
  source: SourceState | null;
  /** The read failed: shown over the last read, if any, which stays read-only. */
  error?: string | null;
  /** The daemon is out of reach: what was last read shows, read-only. */
  offline?: boolean;
  /** Another session works in this folder too and lands its work, by name [D1070, D1082]. Null until Rust's first read. */
  share?: { with: string | null } | null;
  /** When the watch last read the checkout: "Offline · 14:32" [D1205, D1206]. */
  readAtMs?: number | null;
  /** What the checkout really is (2.37) [D1187]; Restore under way, or why it was refused. */
  truth?: Truth | null;
  restoring?: boolean;
  restoreError?: string | null;
  /** The base against its own upstream and its fetch age [D1187, D1193]. */
  freshness?: Freshness | null;
  /** The session's last test or build run, from the uncommitted review's brief, Review's own (2.38) [D1199]; null with none yet. */
  run?: LastRun | null;
  /** Risky files' flags by path, from Rust's brief (2.38) [D1188, D1213]. */
  flags?: Record<string, FileFlag>;
  /** In your own folder, the paths the fold's edit steps confirm the agent changed (2.38); null in a worktree or until read [D1192, D1213]. */
  agentPaths?: string[] | null;
  /** The branch's pull requests (2.13); none without a host [D1030]. */
  prs?: Pr[];
  /** The watch's last read, kept: a gallery's stand-in for the session row's [D1009]. */
  kept?: KeptPrs;
};

/** Rust's moves on the checkout, once wired: without them (the gallery) nothing moves. */
export type SourceOps = {
  retry: () => void;
  /** Re-creates a session's gone folder from its branch [D180, D1187]. */
  restore?: () => void;
};

/** The checkout couldn't be read: the summary card's line, with Try again. */
export function ReadError({ error, onRetry }: { error: string; onRetry?: () => void }) {
  return (
    <ErrorLine
      error={`Couldn't read this checkout: ${error}`}
      actions={
        <button type="button" onClick={onRetry} className="shrink-0 cursor-pointer rounded-control text-link hover:text-link-hover focus-visible:focus-ring">
          Try again
        </button>
      }
    />
  );
}
