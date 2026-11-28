// A session's row and a project as Rust keeps them, and the facts a row carries, for both apps [D58].
import type { StepKind } from "./thread";
import { hhmm, resetWords } from "./words";

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

/** What Rust read of a project's repository: `projects branches`. */
export type RepoInfo = { current: string | null; branches: string[]; worktrees: { path: string; branch: string | null }[] };
/** A new worktree's bases as both apps list them: the checked-out branch first, then by name. */
export const baseBranches = (info: RepoInfo) => [...info.branches].sort((a, b) => Number(b === info.current) - Number(a === info.current) || a.localeCompare(b));
/** A session whose messages hold every word (`search`): the best message's snippet, and where the words are in it (UTF-16). */
export type Hit = { id: string; snippet: string; at: [number, number][] };

/** A list push put into the rows and projects held, by id. */
export function applyListFrame(frame: Record<string, any>, rows: Map<string, Row>, projects: Map<string, Project>): void {
  for (const row of frame.rows as Row[]) rows.set(row.id, row);
  for (const id of frame.gone as string[]) rows.delete(id);
  for (const project of (frame.projects ?? []) as Project[]) projects.set(project.id, project);
  for (const id of (frame.projects_gone ?? []) as string[]) projects.delete(id);
}

// Each state's words in the hover card, so no code name ever shows (O12). Null says nothing.
const STATE_WORDS: Record<string, string | null> = {
  waiting_answer: "Needs you · question",
  asking: "Working",
  sign_in: "Needs you · sign-in",
  logged: "Starting",
  starting: "Starting",
  working: "Working",
  silent: "Working",
  retrying: "Reconnecting",
  reconnecting: "Reconnecting",
  checking: "Running safety checks",
  idle_jobs: "Background job",
  failed: "Failed",
  out_of_credits: "Out of credits",
  interrupted: "Interrupted",
  undelivered: "Couldn't send your message",
  uncertain: "Couldn't confirm your message arrived",
  unresumable: "Can't resume on this account",
  stalled: "Stalled · no output for a while",
  unresponsive: "Not responding",
  no_turn_started: "Not started yet",
  error: "Couldn't read this session",
  stopped: "Stopped",
  idle: null,
  new: null,
};

// A state this build has no words for yet still says what its mark means.
const MARK_WORDS: Record<NonNullable<Mark>, string> = { working: "Working", needs: "Needs you", amber: "Failed", unread: "New reply", background: "Background job" };

/** Whether a limit's reset time is still to come; once it has passed the words stop naming it [D379]. */
export const resetAhead = (resets: number | null): resets is number => resets !== null && resets > Date.now();

/** What a row's mark means, in plain words ("Needs you · sign-in", "Usage limit · resets 14:10"); null for nothing. */
export function statusWords(row: Pick<Row, "mark" | "state" | "resets" | "reset" | "switching"> & { reason?: unknown }): string | null {
  if (row.mark === "unread") return MARK_WORDS.unread;
  // A worker may move to another model, not only another account [D2037].
  if (row.switching) return "Switching automatically";
  if (row.state === "limited") {
    // Spinning, an automatic switch waits it out [D51]; otherwise it's stuck until you act.
    const words = row.mark === "working" ? "Waiting for usage limit" : "Usage limit";
    const carry = resetWords(row.reset);
    if (carry) return `${words} · ${carry}`;
    return resetAhead(row.resets) ? `${words} · resets ${hhmm(row.resets)}` : words;
  }
  // A pending approval waits as a question does; only its reason says which [D173].
  if (row.state === "waiting_answer" && typeof row.reason === "object" && row.reason !== null && "approval" in row.reason) return "Needs you · approval";
  // Answered, but its block stays open on its subagents [D118], or its mockup card waits on you.
  if ((row.mark === "working" || row.mark === "needs") && (row.state === "idle" || row.state === "idle_jobs")) return MARK_WORDS[row.mark];
  if (Object.hasOwn(STATE_WORDS, row.state)) return STATE_WORDS[row.state];
  return row.mark && MARK_WORDS[row.mark];
}

/**
 * Whether a project row or strip square shows its one blue mark: a session under it needs you, failed, warned or
 * finished unseen, every kind the same mark [D844]; the open session left out.
 */
export const attentionOf = (rows: readonly Pick<Row, "id" | "mark">[], active: string | null) => rows.some((row) => row.id !== active && (row.mark === "needs" || row.mark === "amber" || row.mark === "unread"));

/** Which of `count` hues a project's tile takes: FNV-1a of its name, mixed (murmur3's finaliser) so names alike spread
 *  over the hues; the same name always gets the same hue. Their constants in decimal, as FNV publishes its own [D283]. */
export function hueOf(name: string, count: number): number {
  let hash = 2166136261;
  for (const char of name) hash = Math.imul(hash ^ char.codePointAt(0)!, 16777619);
  hash = Math.imul(hash ^ (hash >>> 16), 2246822507);
  hash = Math.imul(hash ^ (hash >>> 13), 3266489909);
  return ((hash ^ (hash >>> 16)) >>> 0) % count;
}

/** A project's initials for its badge: the first letters of its first two words, else its first two. */
export function projectInitials(name: string): string {
  const [first = "", second] = name.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const letters = second === undefined ? [...first].slice(0, 2) : [[...first][0], [...second][0]];
  return letters.join("").toUpperCase();
}
