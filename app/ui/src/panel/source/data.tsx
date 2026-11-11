import { ErrorLine } from "../../components/error-line";
import type { FileFlag, LastRun } from "../../review/types";
import type { Freshness, StepAt, Truth } from "../git";
import type { Branch, ForcePush, MergeStyle, Pr, SourceState, Step } from "../types";
import type { BranchRead } from "./branch-ops";

/** What the summary card's git part shows, from Rust; the gallery's own fake without it. */
export type SourceData = {
  /** Null while the first read is under way. */
  source: SourceState | null;
  step: Step | null;
  /** How the project lands, from Rust [D1028]; the gallery's own pick without it. */
  merge?: MergeStyle | null;
  /** The commits Rust's step was worked out on: a landing is pinned to them [D1049]. */
  at?: StepAt | null;
  /** The read failed: shown over the last read, if any, which stays read-only. */
  error?: string | null;
  /** The daemon is out of reach: what was last read shows, read-only. */
  offline?: boolean;
  host?: string | null;
  branches?: Branch[] | null;
  /** A push was turned away: Force Push is offered, with this lease [D1034, D1049]. */
  rejected?: ForcePush | null;
  /**
   * Others work in this folder too, by name [D1070, D1082]: `with` lands its work, `busy` works there now, `includes`
   * made changes still uncommitted here; `lands` false, no PR or merge from here. Null until Rust's first read.
   */
  share?: { with: string | null; busy: string | null; includes: string | null; lands: boolean } | null;
  /** The session's agent is working: the button waits for its turn [D1208], and the user's own folder can't switch branches [D1021]. */
  agentWorking?: boolean;
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
  /** A sync or publish is under way; the name a rename or switch is moving to, until the watch reads it [D30]. */
  syncing?: boolean;
  naming?: string | null;
};

/** The branch item's moves on Rust's git (2.21) [D1020, D1021]; without them (the gallery) a pick only closes. */
export type BranchOps = {
  read: (done: (read: BranchRead | null) => void) => void;
  sync: () => void;
  publish: () => void;
  rename: (name: string) => void;
  switchTo: (name: string, remote: boolean) => void;
  create: (name: string, from: string | null) => void;
  setBase: (base: string) => void;
  /** Home, to start a session from `base` in this session's project. */
  newSession: (base: string) => void;
  openPage: (url: string) => void;
};

/** Rust's moves on the checkout, once wired: without them (the gallery) nothing moves. */
export type SourceOps = {
  retry: () => void;
  branch?: BranchOps;
  /** Rust's step moves (2.22): landing, the merge style, a squash's first message. Without them the button is the gallery's. */
  land?: (style: MergeStyle, message: string | null, at: StepAt | null, done: (error: string | null) => void) => void;
  setStyle?: (style: MergeStyle) => void;
  squashOf?: (at: StepAt, done: (squash: { message: string; commits: { sha: string; subject: string }[] } | null) => void) => void;
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
