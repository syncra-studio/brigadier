// The words rows say, written from what Rust sent, for both apps [D58]: formatting only, no drawing.
import type { FileChange, Item, Progress, StepKind, Turn, Work } from "./thread";

/** A step's verb while it runs, once done and while it waits to start ("Reading", "Read", "read"), by kind. */
export const VERBS: Record<StepKind, [string, string, string]> = {
  read: ["Reading", "Read", "read"],
  edit: ["Editing", "Edited", "edit"],
  list: ["Listing files in", "Listed files in", "list files in"],
  search: ["Searching for", "Searched for", "search for"],
  run: ["Running", "Ran", "run"],
  web: ["Searching the web for", "Searched the web for", "search the web for"],
  agent: ["Running a subagent:", "Ran a subagent:", "run a subagent:"],
  skill: ["Using", "Used", "use"],
  other: ["Using", "Used", "use"],
};

export const FILE_VERBS: Record<FileChange["change"], [string, string, string]> = {
  added: ["Creating", "Created", "create"],
  modified: ["Editing", "Edited", "edit"],
  deleted: ["Deleting", "Deleted", "delete"],
  renamed: ["Renaming", "Renamed", "rename"],
};

const time = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const weekday = new Intl.DateTimeFormat(undefined, { weekday: "short" });
const monthDay = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" });
const fullDate = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });

/** When a message was sent: "3:09 PM", "Yesterday 3:09 PM", "Mon 3:09 PM", "Mon, Mar 3 at 3:09 PM", "Mar 3, 2025 at 3:09 PM". */
export function sentAt(ms: number, now = Date.now()): string {
  const at = new Date(ms);
  const day = new Date(now);
  // Midnight `back` calendar days ago: a day across a clock change isn't 24 hours.
  const midnight = (back: number) => new Date(day.getFullYear(), day.getMonth(), day.getDate() - back).getTime();
  const clock = time.format(at);
  if (ms >= midnight(0)) return clock;
  if (ms >= midnight(1)) return `Yesterday ${clock}`;
  if (ms >= midnight(6)) return `${weekday.format(at)} ${clock}`;
  if (at.getFullYear() === new Date(now).getFullYear()) return `${monthDay.format(at)} at ${clock}`;
  return `${fullDate.format(at)} at ${clock}`;
}

/** A gap before a user's message that a time separator marks (the old app's). */
const SEPARATOR_GAP_MS = 60 * 60 * 1000;

/** The user's messages with their date above: the first, and one sent more than an hour after the message before it. */
export function datedMessages(items: readonly Item[]): ReadonlySet<string> {
  const dated = new Set<string>();
  let previous: Extract<Item, { kind: "message" }> | undefined;
  for (const item of items) {
    if (item.kind !== "message") continue;
    if (item.role === "user" && item.origin !== "system" && datedAfter(previous, item.sentAt)) dated.add(item.id);
    previous = item;
  }
  return dated;
}

/** Whether a user's message sent at `at` after `previous` (the last message, if any) has its date above it: a chat's first has none [D83]. */
export function datedAfter(previous: { sentAt?: number } | undefined, at: number | undefined): boolean {
  return previous !== undefined && at !== undefined && previous.sentAt !== undefined && at - previous.sentAt > SEPARATOR_GAP_MS;
}

/** A failed turn's row, by why it failed [D54]. */
export const TURN_FAILED = {
  "turn-failed": "This turn didn’t finish",
  "start-failed": "The agent couldn’t start",
  "model-unavailable": "This model isn’t available",
  "ended-for-safety": "A safety check ended this conversation, so it can’t go on",
  "context-full": "Context full",
};

/** What a passing failure cut, in one plain line [D339]. */
export const FAILED_CAUSE = {
  capacity: "The model’s servers are busy, so this turn didn’t finish",
  connection: "The connection to the agent’s servers dropped, so this turn didn’t finish",
  timeout: "The agent’s servers took too long to answer, so this turn didn’t finish",
};

/** The agent shortening its context, by how far it got. */
export const COMPACTION: Record<Exclude<Progress, "pending">, string> = {
  running: "Optimizing context…",
  done: "Context optimized",
  failed: "Couldn’t optimize context · Nothing changed",
  cancelled: "Couldn’t optimize context · Nothing changed",
};

/** The new session's live status, from its row's mark [D204]. */
export type StartedStatus = "working" | "needs" | "done" | "stopped" | "failed";
export const STARTED_STATUS: Record<StartedStatus, string> = { working: "Working", needs: "Needs you", done: "Done", stopped: "Stopped", failed: "Failed" };

/** A worktree's setup step, by how it went. */
export const SETUP_TITLES = { running: "Creating a worktree", done: "Created a worktree", failed: "Worktree setup failed" };

/** Rust's reason no file can go back, in one line (D1247's words, the rest proposed); a chat with no project has none to say. */
export const REWIND_CANT: Record<string, string> = {
  unreadable: "Files stay: this turn's snapshot couldn't be read.",
  not_git: "Files can't go back: this folder isn't a git folder.",
  no_folder: "Files can't go back: this session's folder is missing.",
  missing: "Files can't go back: no snapshot was taken of this turn.",
};

// Proposed words, shown to the owner on screen [D1068].
export const FORK_FILES: Record<"snapshot" | "none" | "gone" | "sourceGone", string> = {
  snapshot: "Files as they were at this message",
  none: "Today's files: this message has no snapshot",
  gone: "Files as they were · their commit is gone, so it starts from today's base",
  sourceGone: "Today's files: the session it came from is gone",
};

// Proposed words: each repo of a folder chat by where its copy's files come from [D3105].
export const FORK_REPO_FILES = [
  ["snapshot", "As they were at this message"],
  ["none", "Today's files, no snapshot of this message"],
  ["gone", "As they were, from today's base: their commit is gone"],
  ["later", "Not copied, claimed after this message"],
] as const;

/** Kinds by the icon a group takes: its first one held. */
export const ORDER: StepKind[] = ["edit", "read", "list", "search", "run", "web", "agent", "skill", "other"];

/** An MCP server as the user knows it, as the old app's: "atlassian" is "Atlassian". */
export function connectorName(server: string): string {
  const words = server.replace(/[_-]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "an integration";
}

/**
 * A group's one line, short words for what kinds of steps it holds, in order [D116]: "Read files, ran
 * commands", "Edited a file, searched, listed files". Rust tells each step's kind, shell commands by what they do, so
 * only true commands say "ran". Thoughts say nothing; a group of only thoughts is "Thought".
 */
export function groupWords(steps: readonly Item[]): string {
  const used: string[] = [];
  const files = new Set<string>();
  const n: Partial<Record<StepKind, number>> = {};
  for (const step of steps) {
    const kind = step.kind === "fileChange" ? "edit" : step.kind === "childAgent" ? "agent" : step.kind === "tool" ? (step.step ?? "other") : null;
    if (!kind) continue;
    // An MCP server's or a skill's calls say its name: "Used Linear", "Used code-review".
    const name = step.kind !== "tool" ? null : kind === "skill" ? step.name || "a skill" : kind === "other" && step.server ? connectorName(step.server) : null;
    if (name) {
      if (!used.includes(name)) used.push(name);
      continue;
    }
    n[kind] = (n[kind] ?? 0) + 1;
    if (step.kind === "fileChange") for (const change of step.changes) files.add(change.path);
    else if (kind === "edit" && step.kind === "tool") files.add(step.input);
  }
  const one = (count: number | undefined, a: string, many: string) => (count === 1 ? a : many);
  const parts = [
    used.length && `used ${used.length < 3 ? used.join(" and ") : `${used.slice(0, -1).join(", ")} and ${used.at(-1)}`}`,
    n.edit && `edited ${one(files.size || n.edit, "a file", "files")}`,
    n.read && "read files",
    n.search && "searched",
    n.list && "listed files",
    n.run && `ran ${one(n.run, "a command", "commands")}`,
    n.web && "searched the web",
    n.agent && `ran ${one(n.agent, "a subagent", "subagents")}`,
    n.other && `called ${one(n.other, "a tool", "tools")}`,
  ].filter(Boolean);
  const line = parts.join(", ") || "thought";
  return line.charAt(0).toUpperCase() + line.slice(1);
}

const ENDED: Record<Turn["status"], string> = {
  running: "Working for",
  done: "Worked for",
  // A failure is said once, by its row at the turn's end [D54]; your Stop by its own line under the turn [D2099].
  failed: "Worked for",
  cancelled: "Worked for",
};

/** "Working for 12s" while the turn runs (from `now`), "Worked for 3m 4s" once it's done. */
export function workWords(turn: Turn, work: Work | undefined, now: number): string {
  // Live, one clock from the turn's start that never resets [D128]; ended, like Rust's `Work.ms`, its waits on the user don't count.
  const live = turn.status === "running" || turn.held;
  const ms = work?.ms ?? (live ? now - turn.startedAt : (turn.endedAt ?? now) - turn.startedAt - (turn.waitedMs ?? 0));
  // Answered, it still waits on what it started, counting on [D114]; WorkHeader says on what.
  if (turn.held) return `Working for ${duration(ms)}`;
  if (turn.status === "running" && ms < 1000) return "Working";
  // The actions turned down in it, beside the time (D487).
  const denied = turn.denied ?? work?.denied;
  return `${ENDED[turn.status]} ${duration(ms)}${denied ? ` · ${denied} denied` : ""}${turn.unchecked ? " · safety check unavailable" : ""}`;
}

/** A clock time, "09:39". */
export const hhmm = (ms: number) => {
  const at = new Date(ms);
  return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
};

/** 12s, 3m 4s, 1h 5m. */
export function duration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}
