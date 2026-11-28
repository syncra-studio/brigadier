// The words rows say, written from what Rust sent, for both apps [D58]: formatting only, no drawing.
import type { FileChange, Item, Progress, SetupStep, StepKind, Turn, Work } from "./thread";
import type { Reset, Row } from "./rows";

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

/** A time separator's words, above a message: "Today 3:36 PM", else as the bubble's time says it [D106]. */
export const datedWords = (at: number) => (new Date(at).toDateString() === new Date().toDateString() ? `Today ${sentAt(at)}` : sentAt(at));

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

/** The old app's setupStepWords; Rust has already folded the states and ordered the steps. */
export function setupStepWords(step: SetupStep): string {
  const { state } = step;
  switch (step.kind) {
    case "worktree":
      // Its name only once made: it's Rust's to pick, so the words never change while it's being made [D85].
      return state === "running" ? `Creating the branch from ${step.base ?? "branch"}` : state === "done" ? `Created ${step.branch ?? "the branch"} from ${step.base ?? "branch"}` : "Couldn't create the worktree";
    case "setupScript":
      return state === "running" ? "Running the setup script" : state === "done" ? "Ran the setup script" : "The setup script failed";
    case "cli":
      return state === "running" ? `Starting ${step.cli ?? "the CLI"}` : state === "done" ? `Started ${step.cli ?? "the CLI"}` : `Couldn't start ${step.cli ?? "the CLI"}`;
  }
}

/** Why a setup step ended badly, under it: its error, else how its process ended. */
export const setupStepError = (step: SetupStep) =>
  step.error || (step.interrupted ? "Interrupted" : step.signal != null ? `Signal ${step.signal}` : step.code != null && step.code !== 0 ? `Exit code ${step.code}` : null);

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

/** An event the app can't draw yet, opening to the event as it came. */
export const UNKNOWN_STEP = "This step isn’t shown yet · details inside";

/** Kinds by the icon a group takes: its first one held. */
export const ORDER: StepKind[] = ["edit", "read", "list", "search", "run", "web", "agent", "skill", "other"];

/** An MCP server as the user knows it, as the old app's: "atlassian" is "Atlassian". */
export function connectorName(server: string): string {
  const words = server.replace(/[_-]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "an integration";
}

/** What a step acted on: a command, a path, a query; another tool's own name, an MCP tool's server ("Atlassian"). */
export const toolObject = (kind: StepKind, name: string, input: string, server?: string | null) =>
  kind === "skill" ? skillObject(name, input) : kind === "other" ? (server ? connectorName(server) : name) : input || name;

/** A skill by its name and what it was given: "code-review on" a PR by its number or repo and number, read from short arguments [D211, D227]. */
const skillObject = (name: string, input: string) => `${name || "a skill"}${input ? ` on ${target(input)}` : ""}`;

/** Short arguments naming a PR or issue by link or number read as it alone, a level or flag beside it left out; any others as given. */
function target(input: string) {
  const words = input.trim().split(/\s+/);
  if (words.length > 3) return input;
  const link = words.map((word) => /([\w.-]+)\/(?:pull|issues)\/(\d+)/.exec(word)).find(Boolean);
  const number = words.find((word) => /^#?\d+$/.test(word));
  return link ? `${link[1]}#${link[2]}` : number ? `#${number.replace("#", "")}` : input;
}

/** An MCP tool's name as words, as the old app's: "searchJiraIssues" is "search jira issues". */
export const actionWords = (name: string) =>
  name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .toLowerCase()
    .trim();

/** How a command's Shell box says it ended; null while it runs. */
export const shellEnding = (progress: Progress, exitCode: number | null) =>
  progress === "cancelled" ? "Stopped" : progress === "failed" && exitCode === null ? "Failed" : exitCode ? `Exit code ${exitCode}` : progress === "done" ? "Success" : null;

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

/** Held this long with no word from what holds it, its header says so; no Stop, no limit [D552]. */
const QUIET_MS = 30 * 60_000;

/** "2 workers", "1 subagent". */
const count = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/**
 * A turn's work header: workWords, with what it waits on, a count per kind ("· 2 workers · 1 subagent running",
 * "· 1 worker paused") [D67, D550, D553], "· waiting for you" [D551] or "· waited for 1m 2s", and "· no activity for
 * 30 min" once held that long with no word from any of them (`heard`: the latest word) [D552].
 */
export function workHeaderWords(turn: Turn, work: Work | undefined, now: number, workers: number, paused: number, heard: number): string {
  const live = turn.status === "running" || Boolean(turn.held);
  const subagents = turn.helpers ?? 0;
  const running = [workers && count(workers, "worker"), subagents && count(subagents, "subagent")].filter(Boolean).join(" · ");
  const { waitingSince, waitedMs } = turn;
  return (
    workWords(turn, work, now) +
    (live && running ? ` · ${running} running` : "") +
    (live && paused ? ` · ${count(paused, "worker")} paused` : "") +
    (live && waitingSince != null ? " · waiting for you" : !live && waitedMs !== undefined && waitedMs >= 1000 ? ` · waited for ${duration(waitedMs)}` : "") +
    (turn.held && waitingSince == null && now - heard >= QUIET_MS ? " · no activity for 30 min" : "")
  );
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

// ── Lines across the thread, notices, a switch past a limit, sessions started and forked, images, mockups and workers.

type LineItem = Extract<Item, { kind: "line" }>;

/**
 * A `line` row's words, and the rest its ⓘ says (D487). A stop a session made names it: `lead`, that session's title,
 * null once it's gone (PROPOSED words) [C76].
 */
export function lineWords(item: LineItem, lead?: string | null): { words: string; tip?: string } {
  switch (item.reason) {
    case "limit-reset":
      // Brigadier's own carry-on at the reset says so (proposed) [C34, C54].
      return { words: `Usage limit reset · ${item.carried ? `carried on at ${hhmm(item.carried)}` : hhmm(item.at)}` };
    case "model":
      return item.why === "changed"
        ? { words: item.live ? `Switching model to ${item.to}…` : `Switched model to ${item.to}`, tip: `${item.from ? `From ${item.from}. ` : ""}Answers may read differently from here on.` }
        : { words: `This request went to ${item.to}`, tip: item.from ? `The agent sent this request on from ${item.from}.` : "The agent sent this request on to another model." };
    case "stopped": {
      const who = item.by !== "lead" ? "You stopped" : lead != null ? `${lead || "New session"} stopped it` : "Stopped";
      return { words: item.ms === null ? who : `${who} after ${duration(item.ms)}` };
    }
    // A worker's Pause, in its own thread: Resume carries it on [D90].
    case "paused":
      return { words: item.ms === null ? "You paused" : `You paused after ${duration(item.ms)}` };
    // The run's host or agent was gone before the turn ended; Resume carries it on (D92).
    case "interrupted":
      return { words: "Interrupted · the run stopped before it finished" };
    case "review-ended":
      return { words: "The automatic reviewer ended this turn", tip: "It turned down too many actions in a row. Say more about the task, or change the permission level, to go on." };
    case "stalled":
      return { words: "Stopped: this task keeps filling its context without making progress" };
    case "retried":
      return { words: "Sent again · the previous attempt was replaced" };
  }
}

/** A notice Rust sends as structure, in words: a held-back reply, a turn carried on once the network was back, trust taken back. */
export const NOTICE_WORDS = {
  blocked: "The agent’s safety checks held this reply back",
  resumed: "Connection lost · tried again once it was back",
  untrusted: "This folder is no longer trusted, so this turn runs under Ask.",
};

/** A limit's carry-on in words, where Brigadier carries it on or says why not (proposed) [C34, C54]. */
export function resetWords(reset: Reset | null | undefined): string | null {
  if (reset?.error) return `couldn’t carry on by itself: ${reset.error}`;
  if (reset?.due) return `carries on at ${hhmm(reset.due)}`;
  if (reset?.held === "stuck") return "the limit didn’t lift at its reset time";
  if (reset?.held === "unconfirmed") return "receipt wasn’t confirmed, so it won’t carry on by itself";
  if (reset?.held === "unbegun") return "the limit stopped it before it began, so it won’t carry on by itself";
  if (reset?.held === "unknown") return "no reset time was given";
  return null;
}

type Switch = Extract<Item, { kind: "switch" }>;

/**
 * One state's words of a switch divider [D51, D132]: `status`, the limit's, after its warning; `words`, the rest, with
 * `tip` on its ⓘ. `from` names the side that hit it; `carries`, the session's carry-on at the reset.
 */
export function switchWords(change: Switch, state: Switch["state"], from: string, carries?: Reset | null): { status?: string; words?: string; tip?: string } {
  const to = change.model ? `${change.to} · ${change.model}` : (change.to ?? "");
  const refused = change.reason === "unresumable";
  const hit = refused ? `${from} couldn’t resume this conversation` : change.reason === "credits" ? `Out of credits on ${from}` : `Usage limit on ${from}`;
  // When it comes back, as its CLI said; a reset already past, or none said, is "later" [D74, D379].
  // Where Brigadier carries it on at the reset, or says why not, that's the words [C34, C54].
  const carry = change.reason === "usage-limit" ? resetWords(carries) : null;
  const back = carry ? ` · ${carry}` : change.reason !== "usage-limit" ? "" : change.resets && change.resets > Date.now() ? ` · try again at ${hhmm(change.resets)}` : " · try again later";
  switch (state) {
    case "limit":
      return { status: hit + back };
    case "switching":
      return { words: refused ? `Starting a new conversation on ${to}…` : to ? `Switching to ${to}…` : "Switching…" };
    case "switched":
      // A switch logged before the shape has only Rust's sentence; one picked, not forced, no limit to explain.
      if (!change.to) return { words: change.text };
      if (change.reason === "picked") return { words: `Switched to ${to}` };
      if (change.moved) return { words: change.moved, tip: hit };
      return { words: refused ? `Continued in a new conversation on ${to}` : `Switched ${change.automatic ? "automatically " : ""}to ${to}`, tip: hit };
    case "failed":
      // An automatic one keeps the limit's words: nothing was clicked that the line could name.
      if (change.automatic) return { status: hit + back, words: to ? `· couldn’t switch to ${to}` : "· couldn’t switch automatically", tip: change.error ?? "" };
      return { words: `Couldn’t switch to ${to} · the thread is unchanged`, tip: change.error };
    case "over":
      // History: no "try again", which a carry-on or a later message has settled (proposed) [C54].
      return { status: hit };
  }
}

const STARTED_MARKS: Record<string, StartedStatus> = { working: "working", needs: "needs", amber: "failed" };

/** PROPOSED: a started session's status from its row: any mark but working, needs and amber reads Done, or Stopped once the user stopped it [C99]. */
export const startedStatus = (row: Pick<Row, "mark" | "state">): StartedStatus => STARTED_MARKS[row.mark ?? ""] ?? (row.state === "stopped" ? "stopped" : "done");

/** A started session's line [D204, D206]: on its way, then started, from its base where it has one. */
export const startedWords = (starting: boolean, base?: string | null) => (starting ? "Starting a new session" : base ? `Started a new session from ${base}` : "Started a new session");

/** Why it couldn't start, and what it left behind. */
export const startError = (item: { error?: string | null; left?: string[] | null }) => `${item.error ?? "Refused"}${item.left?.length ? ` · left behind: ${item.left.join(", ")}` : ""}`;

/** "Couldn’t start the session · Add a retry · Refused". */
export const startFailed = (title: string, error: string) => `Couldn’t start the session · ${title ? `${title} · ` : ""}${error}`;

/** Where a fork came from [D48]: "Forked from", the source by its title or, gone, "another session". */
export const FORKED_FROM = "Forked from";
export const forkedSource = (chat: boolean) => `another ${chat ? "chat" : "session"}`;
export const forkedAfter = (where: "worktree" | null, summary: boolean) => `${where === "worktree" ? " · works in a new worktree" : ""}${summary ? " · started from a summary" : ""}`;
/** Big files and nested repositories its snapshot doesn't hold [D1068] (proposed). */
export const tooBigToCopy = (leftOut: readonly string[]) => `Too big to copy: ${leftOut.join(", ")}`;

/** An image the agent makes [D289]. */
export const IMAGE_WORDS = {
  making: "Creating image",
  failed: "Couldn't create the image.",
  limit: "Couldn't create the image: its usage limit was reached.",
  missing: "The image isn't available.",
};

/** One moment of a mockup, as its chat row tells it [D2055, D560]. */
export type MockupMoment =
  | { kind: "drawing"; count: number }
  | { kind: "ready"; round: number | null; open: boolean }
  | { kind: "waiting" }
  | { kind: "notes"; count: number; on: string[]; round: number }
  | { kind: "picked"; letter: string }
  | { kind: "built"; letter: string }
  | { kind: "stopped" };

const notes = (n: number) => (n === 1 ? "1 note" : `${n} notes`);

/** "A", "A and B", "A, B and C". */
const listed = (names: string[]) => (names.length < 2 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);

/** "Plan card mockup", so a chat's several are told apart; "Mockup" till its title is read. */
export const mockupName = (title?: string) => (!title ? "Mockup" : /\bmockup$/i.test(title) ? title : `${title} mockup`);

/** A mockup row's two parts: its name, bright, and what's happening. */
export function mockupWords(moment: MockupMoment, name: string): [string, string] {
  switch (moment.kind) {
    case "drawing":
      return [name, moment.count === 1 ? "drawing 1 variant" : `drawing ${moment.count} variants`];
    case "ready":
      // Still the newest round, nothing picked: the user's move.
      if (!moment.open) return [name, `round ${moment.round ?? 1} ready`];
      return [moment.round ? `${name} · round ${moment.round} ready` : `${name} ready`, "pick one with Use, or leave a note"];
    case "waiting":
      // Its worker's turn ended before the round was all in.
      return [name, "waiting for your notes"];
    case "notes":
      return [`You → ${name === "Mockup" ? "mockup" : name}`, `${notes(moment.count)} on ${listed(moment.on)} · round ${moment.round} drawing`];
    case "picked":
      return [name, `you picked ${moment.letter} · building for real`];
    case "built":
      return [name, `${moment.letter} built into the app`];
    case "stopped":
      return [name, "stopped"];
  }
}
