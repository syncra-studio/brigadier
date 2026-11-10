// A session's pull requests as Rust's watch will send them (2.27): structure only, the UI writes the words
// [D65, D71, D1017]. PROPOSED contract, unwired; the gallery feeds it fake data [D388].

export type PrState = "open" | "draft" | "merged" | "closed";
export type PrStatus = "merged" | "closed" | "checks_failed" | "draft" | "checks_running" | "changes_requested" | "conflicts" | "ready" | "review_needed";
export type MergeStyle = "merge" | "squash" | "rebase";

export type PullRequest = {
  id: string;
  number: number;
  title: string;
  /** The host's name as Rust's host module gives it, for "Open on …"; nothing here names a host [D1030]. */
  host: string;
  state: PrState;
  /** Its one status, as Rust ranks it: failing checks before a draft [D1017]. */
  status: PrStatus;
  /** What stands in the way of merging; null when nothing does. */
  blockers: { failedChecks: number; changesBy: string[]; conflicts: boolean } | null;
  /** Whether Merge is on, the styles the repo allows and the one the button uses [D1019, D1028]. */
  merge: { allowed: boolean; styles: MergeStyle[]; default: MergeStyle };
  branch: string;
  base: string;
  openedBy: string;
  openedAtMs: number;
  /** When the watch last read it; null before the first read. */
  checkedAtMs: number | null;
  /** Why the watch can't read it now, and what fixes that; the rest is its last known state [D1009, D1017]. */
  problem: string | null;
  checks: PrCheck[];
  comments: PrComment[];
  /** Newest first. */
  events: PrEvent[];
};

export type PrCheck = { id: string; name: string; state: "failed" | "running" | "passed"; durationMs: number | null; logTail: string | null };

export type PrComment = { id: string; author: string; path: string | null; line: number | null; body: string; atMs: number };

export type PrEvent = {
  id: string;
  atMs: number;
  kind: "opened" | "pushed" | "checks_running" | "checks_failed" | "checks_passed" | "changes_requested" | "approved" | "commented" | "merged" | "closed";
  actor: string;
  /** Names the event carries: a failing check, a commit count. */
  detail: string | null;
};

/** What a Send or Fix with agent leaves above the composer; nothing is sent until the user sends [D1019, D1027]. */
export type PrSend =
  | { kind: "fix" }
  | { kind: "check"; id: string }
  | { kind: "comment"; id: string }
  | { kind: "event"; id: string };

/** A send's key, for the "Added" state of the button that made it. */
export const sendKey = (send: PrSend): string => (send.kind === "fix" ? "fix" : `${send.kind}:${send.id}`);
