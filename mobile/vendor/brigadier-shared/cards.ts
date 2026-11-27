// The cards that wait on the user, as Rust sends them [D58].
import type { Draft } from "./draft";
import type { ApprovalAction } from "./thread";

/** An approval as Rust sends it (msgs/w18-fields-4.md, boss D177). Agent text (`reason`, `body`) passes as is. */
export type PendingApproval = {
  id: string;
  action: ApprovalAction;
  /** The asker's one-line reason; null: the plain question. */
  reason: string | null;
  command?: string;
  /** Only when the command runs outside the session's own folders. */
  cwd?: string | null;
  /** Files to edit; for a command, what it asks beyond its sandbox. */
  paths?: string[];
  /** A landing's diff stat. */
  files?: { path: string; insertions: number; deletions: number; binary: boolean }[];
  branch?: string;
  /** A network request's host, when that's all it asks. */
  host?: string;
  /** A tool's raw input, when there's no command or paths. */
  input?: string;
  /** Prose: a plan, a message to another session, a browser step's details, an action's details. */
  body?: string;
  /** A message's target session. */
  to?: string;
  /** What "Allow for this session" covers: a command prefix, a folder, a host. */
  grant?: { scope: "command" | "edits" | "network" | "tool" | "site"; pattern: string } | null;
  /** The subagent that asks, by its title. */
  agent?: string;
  /** A plan its adversarial review holds: the reviewer, a worker, and its model's name (§6). */
  review?: { by: string; name: string; /** Its reviewer waits on the user (proposed, C71). */ waits?: boolean };
  /** A plan's review line: "Plan reviewed by ‹model›: 5 findings, 4 fixed, 1 rejected", or "Review didn't run: ‹why›". */
  reviewed?: string;
  /** A plan sent back, kept while its agent revises it: its next plan takes this card (D401). */
  revising?: boolean;
};

export type ApprovalDecision = "allow" | "allowSession" | "deny";

/** One question of a round, as Rust sends it (msgs/w18-fields-4.md, boss D177). Its text passes as is. */
export type QuestionItem = {
  text: string;
  /** None: the field alone. */
  options: { label: string; description?: string | null; letter?: string; name?: string; shot?: string | null }[];
  recommended: number | null;
  /** Several marked and sent together, their labels joined with ", ". */
  multiSelect: boolean;
};

export type PendingQuestion = {
  id: string;
  /** A few words over the question (a round's title). */
  title?: string | null;
  items: QuestionItem[];
  /** A worker's routing hold: only its own answers, no words of the user's and no Skip [D2028, D342]. */
  held?: boolean;
  /** A mockup's round: each answer's `letter` is its variant, `shot` its picture then. */
  mockup?: { worker: string; round: number; title: string };
};

/** One answer: an option's label or the user's words, those with images or files as their draft; null for a skipped one. */
export type Given = string | Draft | null;
