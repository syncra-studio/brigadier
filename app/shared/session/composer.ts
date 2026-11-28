import type { Draft } from "../draft";
import type { Overnight } from "../rows";
import { store } from "../store";
import type { ModelRow } from "./model";

// The composer's words, and the small formatting that picks them, for both apps [D58, D103]; each app draws them.

/** How the agent's actions are approved. The words are the apps'; the level is Rust's. */
export type PermissionLevel = "ask" | "auto" | "full";
export const LEVEL_WORDS: { level: PermissionLevel; label: string; detail: string }[] = [
  { level: "ask", label: "Ask", detail: "Asks before edits and commands" },
  { level: "auto", label: "Auto", detail: "Works on its own, asks before risky actions" },
  { level: "full", label: "Full access", detail: "Unrestricted access to the internet and all your files" },
];
/** The levels menu's question, and its line where the folder isn't trusted. */
export const LEVEL_MENU = { question: "How should the agent’s actions be approved?", untrusted: "This folder isn't trusted, so sessions here ask first. Change it in the project's settings." } as const;
/** Full Access's confirm and what it reaches. */
export const FULL_ACCESS_WORDS = { title: "Turn on Full Access?", body: "Agents can use all of these without asking.", confirm: "Turn on Full Access", reaches: ["Files", "Commands", "Internet"] } as const;

/** A session's row with what its next turn runs at, by the rule send uses [D129, D166, D225]. */
export type LevelRow = ModelRow & {
  levels?: PermissionLevel[];
  /** Null when the agent has no levels, or can't run at the one picked (`level_refused` says why). */
  level?: PermissionLevel | null;
  level_refused?: string | null;
  held?: boolean;
  /** The last level pick Rust took, by the app's op id [D30]. */
  level_op?: string | null;
};

/** "xhigh" → "Extra high", "medium" → "Medium". */
export function effortLabel(effort: string): string {
  return effort === "xhigh" ? "Extra high" : effort.charAt(0).toUpperCase() + effort.slice(1);
}

/** Brigadier's own tools, in the `/` and + menus' order, each with its line. */
export const TOOL_LINES: [id: string, line: string][] = [
  ["computer", "Use the apps on your Mac"],
  ["browser", "Open pages, click and type in Brigadier's browser"],
  ["mockup", "Draw 3 looks to pick from before building"],
  ["image", "Make or edit a picture"],
  ["research", "Search and read the web, with sources"],
  ["workers", "Split the job across workers in parallel"],
];

/** The `/` menu's headings by kind, and what the menus say while empty. */
export const KIND_HEADINGS = { command: "Commands", tool: "Tools", skill: "Skills", mcp: "MCP servers", prompt: "MCP prompts" } as const;
export const MENU_NOTES = { searching: "Searching…", noResults: "No results", loading: "Loading…", noCommands: "No commands" } as const;

/** The /new and /overnight commands' words. */
export const NEW_SESSION_WORDS = { label: "/new", description: "Send the message as a new session, and stay here" } as const;
export const OVERNIGHT_WORDS = { label: "/overnight", description: "Finish the job while you’re away" } as const;

/** The field, its footer and Send. */
export const COMPOSER_WORDS = {
  placeholder: "Do anything",
  shell: "Shell command",
  shellPlaceholder: "Run a command",
  add: "Add files and more",
  send: "Send message",
  queue: "Queue",
  steer: "Steer",
  stop: "Stop",
  resume: "Resume",
  run: "Run",
  runNow: "Run command",
  runAfter: "Run when the turn ends",
  reconnecting: "Reconnecting…",
  uploading: "Files uploading…",
  noImages: "This model does not support image inputs. Try a different model",
  attaching: "Attaching…",
  couldntAttach: "Couldn't attach this file",
} as const;
export const sendTo = (name: string) => `Send to ${name}`;
export const messageTo = (name: string) => `Message ${name}`;

/** The queue card's lines. */
export const QUEUE_WORDS = {
  paused: "Queue paused because you interrupted",
  notAdded: "Not added",
  maybeNotAdded: "May not have been added",
  deciding: "Deciding",
  addAgain: "Add again",
} as const;

/** The model picker's notes; its agent not set up, by why. */
export const MODEL_WORDS = {
  title: "Model",
  noneListed: "No models listed yet",
  noEfforts: "No effort levels",
  switchNow: "Switch now",
  search: "Search all models",
  favorites: "Favorites",
  noFavorites: "Star a model and it shows here.",
  star: "Add to favorites",
  unstar: "Remove from favorites",
  inUse: "In use",
  older: "Older",
  effort: "Effort",
  defaultEffort: "Default",
  fast: "Fast",
} as const;
export const notSetUp = (label: string, unavailable?: string | null) =>
  unavailable === "install" ? `${label} isn't installed. Install it and its models show here.` : `${label} isn't signed in. Sign in and its models show here.`;
export const noMatch = (needle: string) => `No models match “${needle}”`;
export const noFast = (name: string) => `${name} has no fast tier`;
export const showOlder = (older: boolean, hidden: number) => (older ? "Show less" : `Show ${hidden} more`);
/** Another agent picked while a turn runs: it takes over as the turn ends, or now. */
export const afterTurn = (name: string, going: boolean) => (going ? `Switching to ${name}…` : `${name} after this turn`);
export const couldntSwitch = (why: string) => `Couldn't switch now: ${why}`;

/** A message on its way that failed: `maybe`, a host was asked, so it may have gone. */
export const failedWords = (maybe: boolean, why: string) => `${maybe ? "May have been sent" : "Not sent"} · ${why}`;
/** A queued message Rust couldn't send; one to a worker can go to the session instead. */
export const stuckWords = (error: string, toWorker: boolean) => `Not sent: ${error}. ${toWorker ? "Edit it, delete it or send it to the session instead." : "Edit or delete it to go on."}`;

/** Send while the queue is paused. */
export const pausedWords = (count: number) => ({
  title: "Send message?",
  body: `The queue is paused. ${count === 1 ? "One message waits" : `${count} messages wait`} until you resume it. Send this one now, or keep it in the queue with them.`,
  cancel: "Keep paused",
  confirm: "Send now",
});

const plural = (count: number, one: string, many: string) => (count === 1 ? one : `${count} ${many}`);

/** What rides with a queued message's text: "Image attachment", "Pasted text", "3 images", "2 files"… or nothing. */
export function attached(draft: Draft): string | null {
  const chips = draft.parts.filter((part) => typeof part !== "string" && (part.kind === "image" || part.kind === "paste"));
  const images = chips.filter((chip) => typeof chip !== "string" && chip.kind === "image").length;
  const total = chips.length + draft.attachmentIds.length;
  if (total === 0) return null;
  if (images === total) return plural(total, "Image attachment", "images");
  if (total === 1 && chips.length === 1) return "Pasted text";
  return plural(total, "1 file", "files");
}

/** "PDF", "PNG image", "Text": what a file's tile says under its name. */
export function kindOf(name: string, mime: string): string {
  if (mime === "application/pdf") return "PDF";
  const extension = name.includes(".") ? name.split(".").pop()?.toUpperCase() : undefined;
  if (mime.startsWith("image/")) return extension ? `${extension} image` : "Image";
  if (mime.startsWith("text/")) return extension ? `${extension} text` : "Text";
  return extension ? `${extension} file` : "File";
}

export const baseName = (name: string) => name.slice(name.lastIndexOf("/") + 1);

/** Overnight's pill, rail and Start night. */
export const NIGHT_WORDS = {
  pill: "Overnight",
  on: "Overnight: it asks what it needs, then finishes the job while you’re away",
  off: "Turn Overnight off",
  back: "I’m back: end the night",
  imBack: "I’m back",
  start: "Start night",
  startNow: "Or start now: it picks what you skip and tells you in the morning",
  // The phone doesn't know its computer's system: the Mac's words there.
  awake: (mac = true) => (mac ? "This Mac stays awake" : "This computer stays awake"),
  beforeYouGo: "Before you go",
  ready: "That’s all I need",
} as const;

export type NightAct = "on" | "start" | "off";
type Taken = { op: string; act: NightAct; at: number };
/** Each session's last Overnight act, by its op id, till the row's `overnight_op` reaches it [D30]. */
export const nightActs = store<ReadonlyMap<string, Taken>>(new Map());
export function putNightAct(id: string, entry: Taken | null): void {
  const next = new Map(nightActs.get());
  if (entry) next.set(id, entry);
  else next.delete(id);
  nightActs.set(next);
}
/** What the session's overnight is, null off: its last act (`mine`) until the row has it (`landed`). */
export function nightShown(now: Overnight | null, mine: Taken | undefined, landed: boolean): Overnight | null {
  if (!mine || landed) return now;
  if (mine.act === "off") return null;
  if (mine.act === "start") return { ...now, state: "night", since: mine.at };
  return { ...now, state: "asking" };
}

/** The field's words while Overnight is on; `asked`: its turn's questions are there already, waiting or answered. */
export const nightPlaceholder = (now: Overnight | null, busy: boolean, asked: boolean) =>
  now === null ? undefined : now.state === "night" ? "Working until you’re back" : now.state === "asking" && busy && !asked ? "It asks its last questions next" : "Anything else before you go?";

/** The night strip's progress after its time: " · 2 of 5 parts done", " · 3 decided for you". */
export const nightProgress = (night: Pick<Overnight, "total" | "done" | "decided">) => `${night.total ? ` · ${night.done ?? 0} of ${night.total} parts done` : ""}${night.decided ? ` · ${night.decided} decided for you` : ""}`;
