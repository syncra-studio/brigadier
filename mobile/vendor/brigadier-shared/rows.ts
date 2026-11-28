// A session's row and a project as Rust keeps them, and the facts a row carries, for both apps [D58].
import type { StepKind } from "./thread";

export type Daemon = { pid: number; version: string; build: number };
/** A project as Rust keeps it [D165, D171]: `trusted` is null until the owner answers; `include` (paths to copy into worktrees) and `setup` are Project settings' [D178, D202]; `removing` while Remove project runs [D172]. */
export type Project = { id: string; name: string; folder: string; trusted: boolean | null; setup: string; include: string[]; added: number; removing?: boolean; branch_prefix?: string | null; github_account?: string | null; /** Its repositories on GitHub (`of`) as last read: each account gh keeps for their server, whether it can see them all (null: not known), and that server when a folder has others; null before any read [D631]. */ github?: { github: boolean; of?: string[]; ssh?: boolean; host?: string | null; logins: { login: string; sees: boolean | null }[] } | null; browser_profile?: string | null; kind?: "folder"; pinned?: number | null; icon?: string | null };
/** A session's row; `mark` and the facts behind it (reason, resets, sent, finished) are Rust's [D173]. */
export type Row = {
  id: string;
  title: string;
  state: string;
  reason: unknown;
  mark: Mark;
  resets: number | null;
  reset?: Reset | null; // its carry-on at the limit's reset, or why it won't go by itself [C34, C54]
  sent: number;
  finished: number;
  /** The daemon's own switch of its limit is due or under way: it stays working meanwhile [C6, D51] (proposed). */
  switching?: boolean;
  project: string | null;
  /** When it was pinned (ms), or null [D185]. */
  pinned?: number | null;
  /** When it was archived (ms), or null; and an archive, restore or delete under way, or a delete that left something [D180]. */
  archived?: number | null;
  lifecycle?: { op: "archive" | "restore" | "delete"; left?: string[] } | null;
  /** When its folder last changed (ms): how far Rust's row has caught up with an action. */
  touched?: number;
  backend: string;
  updated: number;
  items: number;
  error: string | null;
  /** It uses the computer now, holding its lock: the menu bar item says so [D907, D957]. */ computer?: boolean;
  /** An agent is working in it now: what keeps the computer awake "while agents work". */
  works?: boolean;
  /** What its ended turns left running (a dev server, a watcher), each with the TCP ports it listens on and the open app in it, by which the card's Background lists it [D105, D145]. */
  background?: Job[];
  /** Something has run in its background: the card keeps its Background history button [D200]. */ background_ran?: boolean;
  /** Its agent's to-do list as its CLI's todo or plan tool last wrote it, after the finished steps it left out [D144]. */ plan?: { text: string; status: string }[] | null;
  /** Other sessions' messages its agent hasn't got yet, oldest first; one in its queue isn't here. */ arriving?: { id: string; from: string; text: string; at: number }[];
  /** Overnight, on or in its night; `overnight_op`: the last act on it Rust took, by the app's op id [D30]. */ overnight?: Overnight | null; overnight_op?: string | null;
  /** It holds its project's own folder, unarchived: Local checkout can't start there again [D306]. */
  local?: boolean;
  /** A note's side chat: shown in its note's tab, never as a row, a notice or in the Dock's count [D281]. */
  noteChat?: boolean;
  /** The session it was forked from, which its row sits under [D48]. */
  forkOf?: string | null;
  /** Where it works: its worktree, else its project's folder; null for a chat with no folder [D348, D2022]. */
  folder?: string | null;
  /** Its PRs as Rust's watch keeps them, null before any read [D1009]. */
  prs?: KeptPrs | null;
  /** A turn the network cut that Brigadier resumes by itself once it's back: which try of how many [D339]. */ reconnect?: { turn: string; attempt: number; max: number } | null;
  /** A worker's facts, Rust's, for 4.2's parts; absent for a session that isn't one [D3012]. */
  worker?: WorkerRow | null;
};

/** A row's one mark, worked out in Rust [D173]: spinner, blue ring, amber ring, blue dot, a calm grey dot for what it left running [D68], or nothing. */
export type Mark = "working" | "needs" | "amber" | "unread" | "background" | null;

/** A chat's carry-on at its usage limit's reset: due then, or held (no reset time given, the limit didn't lift at its reset time, or its receipt wasn't confirmed); `error`, a try refused, tried again each minute [C34, C54]. */
export type Reset = { due?: number; held?: "unknown" | "stuck" | "unconfirmed" | "unbegun"; error?: string };

/** A pull request of the session's branch, as the host module reads it [D1017, D1030]: what its row and dot say. */
export type Pr = {
  number: number;
  title: string;
  state: "open" | "merged" | "closed";
  /**
   * An open PR's worst news: checks failed, conflicts, changes asked, checks still running, ready to merge, checks
   * cancelled, or what the checks say couldn't be read (none reported included) [D74].
   */
  health: "failed" | "conflicts" | "changes" | "running" | "ready" | "cancelled" | "unknown";
  /** How many checks failed; null when the host's read couldn't say. */
  failed: number | null;
  url?: string;
  /** The failed checks' names, as the thread's row says them; null when the host's read couldn't say. */
  failedChecks?: string[] | null;
  /** Its repository, `owner/name`, on one from a repository other than the session's own [D213]. */
  repo?: string | null;
  branch?: string;
  base?: string;
  draft?: boolean;
  /** Checks running and passed; null when the host's read couldn't say. */
  running?: number | null;
  passed?: number | null;
  /** Approved; false while a review is required or changes are asked; null when none is needed. */
  approved?: boolean | null;
  /** When the host last saw it change. */
  updatedAtMs?: number | null;
  /** When its tab's read last kept it (`pr/<n>.json`): the tab brings that read in again [D207]. */
  viewedAtMs?: number;
  /** The list's row as GitHub's [D258]: who opened it and when, its review, checks done well of all, comments. */
  author?: string | null;
  createdAtMs?: number | null;
  review?: "review_required" | "approved" | "changes_requested" | null;
  checks?: { ok: number; all: number; mark: "pass" | "fail" | "pending" } | null;
  comments?: number | null;
};

/**
 * A session's PRs as Rust's watch keeps them (`prs.json`, proposed) [D1009]: when the last whole read answered (ms),
 * why the last read didn't (null when it did), and each PR's last known facts.
 */
export type KeptPrs = { okAt: number | null; error: string | null; branch?: string; prs: Pr[] };

/** A process tree: its topmost process, checked by its start time (μs), its command or app's name, and the TCP ports it listens on. */
type Tree = { pid: number; start_us: number; label: string; ports: number[] };
/** One process tree a turn left running, and the open apps in it. */
export type Job = Tree & { apps: Tree[] };

/**
 * A session's overnight, Rust's, on its row: `asking`, on and its agent asking its last questions; `ready`, all
 * it needs asked, waiting for Start night; `night`, working until it is proven done or the user is back.
 */
export type Overnight = {
  state: "asking" | "ready" | "night";
  /** When the night began (ms). */
  since?: number | null;
  /** Parts of the done list proven done, of how many; and what it has decided for the user. */
  done?: number;
  total?: number;
  decided?: number;
  /** Ready: what it does alone till the user is back, in its words. */
  words?: string | null;
};

/** A worker's state, first match wins in Rust, as the old `workerStateOf`; the ones wave 4 has a cause for [D3029]. */
export type WorkerStateKind = "needsYou" | "limit" | "paused" | "cliEnded" | "freshContext" | "working" | "failed" | "stopped" | "merged" | "doneNotMerged" | "done";

/** A worker's row facts, as Rust's `workers::row` writes them. */
export type WorkerRow = {
  parent: string;
  root: string;
  depth: number;
  brief: string;
  started: number;
  kind: WorkerStateKind;
  word: string;
  ended?: number | null;
  model: string;
  receipt: string;
  review?: string | null;
  asked?: string | null;
  why?: string | null;
  added?: number | null;
  removed?: number | null;
  repos?: string[];
  /** Its newest call at work, while it works [D143]. */
  now?: { step: StepKind; name: string; input: string; description?: string | null } | null;
};
