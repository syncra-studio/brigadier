import type { PatchContents, Review, ReviewFile } from "../review/types";

// A session's pull request as Rust's host module reads it (`host <id> view <n>`, one GraphQL read [D207]): structure
// only, the UI writes the words [D65, D71, D1017].

export type PrState = "open" | "draft" | "merged" | "closed";
export type PrStatus = "merged" | "closed" | "checks_failed" | "draft" | "checks_running" | "changes_requested" | "conflicts" | "ready" | "review_needed";

export type PullRequest = {
  id: string;
  number: number;
  title: string;
  url: string;
  /** Its repository, `owner/name`; absent in a read kept before it [D609]. */
  repo?: string;
  /** Its labels' names; absent in a read kept before them [D614]. */
  labels?: string[];
  /** The head commit it was read at. */
  head: string;
  /** The host's name as Rust's host module gives it, for "Open on …"; nothing here names a host [D1030]. */
  host: string;
  state: PrState;
  /** Its one status, as Rust ranks it: failing checks before a draft [D1017]. */
  status: PrStatus;
  /** What stands in the way of merging; null when nothing does. */
  blockers: { failedChecks: number; changesBy: string[]; conflicts: boolean } | null;
  branch: string;
  /** Its branch is in another repository (a fork's, or deleted): Send to agent takes it by number [D674]. */
  fork?: boolean;
  base: string;
  openedBy: string;
  /** The author's, the repository's and the head branch's pages on the host; absent in a read kept before them [D656]. */
  links?: { author: string | null; repo: string | null; branch: string | null };
  openedAtMs: number;
  /** When the watch last read it; null before the first read. */
  checkedAtMs: number | null;
  /** Why the watch can't read it now, and what fixes that; the rest is its last known state [D1009, D1017]. */
  problem: string | null;
  checks: PrCheck[];
  comments: PrComment[];
  /** Newest first. */
  events: PrEvent[];
  /** Its description, as the author wrote it (markdown). */
  body: string | null;
  additions: number;
  deletions: number;
  files: number;
  commitCount: number;
  /** Its last commits, oldest first. */
  commits: PrCommit[];
  /** Who's asked to review, then who has, as GitHub's Reviewers. */
  reviewers: PrReviewer[];
  /** The Conversation under the description, oldest first, as Rust groups it from GitHub's [D260]; absent in a read
   * kept before it, until the next. */
  timeline?: PrItem[];
  /** GitHub's merge state, lower case: clean, blocked, behind, dirty, unstable, has_hooks, unknown. */
  mergeState: string | null;
  /** It's the session's own branch's: Files changed shows the Review tab's branch diff [D204]. */
  onBranch: boolean;
};

export type PrCommit = { sha: string; message: string; author: string | null; atMs: number | null };
export type PrReviewer = { login: string; state: "approved" | "changes" | "commented" | "requested" };

export type PrCheck = { id: string; name: string; state: "failed" | "running" | "passed" | "skipped"; durationMs: number | null; logTail: string | null; url: string | null };

/** `bot`: written by an app's account, as the host marks it. `minimized`: hidden as GitHub hides it, and why ("outdated"). */
export type PrComment = {
  id: string;
  author: string;
  path: string | null;
  line: number | null;
  body: string;
  atMs: number;
  url: string | null;
  bot?: boolean;
  minimized?: string | null;
};

/** A review's line thread: its comments by id, folded as GitHub folds a resolved or outdated one. */
export type PrThread = { id: string; path: string | null; resolved: boolean; outdated: boolean; comments: string[] };

type Item<K extends string, T = object> = { kind: K; id: string; atMs: number | null; actor: string | null; bot?: boolean } & T;

/** One entry of a PR's Conversation, as Rust reads GitHub's timeline [D260]. A comment's and a review's words are in
 * `comments`, by their id. */
export type PrItem =
  | Item<"commits", { commits: PrCommit[] }>
  | Item<"comment">
  | Item<"review", { state: "approved" | "changes" | "commented" | "dismissed"; was: "approved" | "changes" | null; said: boolean; threads: PrThread[]; minimized?: string | null }>
  | Item<"requested", { who: (string | null)[] }>
  | Item<"dismissed", { who: string | null; sha: string | null }>
  | Item<"deployed", { env: string | null; url: string | null }>
  | Item<"mentioned", { number: number | null; title: string | null; url: string | null; state: PrState }>
  | Item<"merged", { sha: string | null; base: string | null }>
  | Item<"deleted", { branch: string | null }>
  | Item<"closed" | "reopened" | "ready" | "draft" | "force_pushed">;

export type PrEvent = {
  id: string;
  atMs: number;
  kind:
    | "opened"
    | "pushed"
    | "force_pushed"
    | "review_requested"
    | "checks_running"
    | "checks_failed"
    | "checks_passed"
    | "changes_requested"
    | "approved"
    | "commented"
    | "merged"
    | "closed"
    | "reopened"
    | "ready"
    | "draft";
  actor: string;
  /** Names the event carries: a failing check, a commit count. */
  detail: string | null;
  /** On checks_failed, when one check failed: its id, so the event's Send is that check's log, one chip for both. */
  check?: string;
};

/** A PR's Files changed as Rust reads it from the host (`host <id> files <n>`) and keeps it [D231]: each file with
 * the host's patch, read at `head`; `total` is how many files changed, more than the list when the host cut it. */
export type PrFiles = Omit<Review, "files"> & { head: string; total: number; checkedAtMs: number; files: (ReviewFile & PatchContents)[] };
