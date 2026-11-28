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

/** What an approval asks, in words: its kind, the reason (or the plain question) as its title, a line under it, its buttons' words. */
export type AskWords = { kind: string; title: string; detail?: string; allow?: string; deny?: string; noDeny?: boolean };
export function askWords(approval: PendingApproval): AskWords {
  const { action, reason, host } = approval;
  const paths = approval.paths ?? [];
  switch (action) {
    case "command":
      return { kind: "Terminal", title: reason || "Allow this command?" };
    case "edit":
      return { kind: "Edit files", title: reason || (paths.length === 1 ? "Allow editing this file?" : "Allow editing these files?") };
    case "network":
      return { kind: "Internet access", title: reason || (host ? `Allow connecting to https://${host}?` : "Allow connecting to the internet?") };
    // Where it lands always shows; the agent's reason goes under it.
    case "land":
      return { kind: "Land a change", title: `Land this change on ${approval.branch ?? "the branch"}?`, detail: reason ?? undefined, allow: "Land" };
    // The plan the agent proposed in its plan mode: build it, or reply to change it.
    // While its review holds it, or its agent revises it, nothing to answer yet (§6, D401).
    case "plan":
      return {
        kind: "Plan",
        title: approval.revising ? "Revising this plan" : approval.review ? `Reviewing this plan · ${approval.review.name}` : reason || "Build this plan?",
        detail: approval.reviewed,
        allow: "Build it",
        noDeny: true,
      };
    // Who it goes to always shows; the agent's reason goes under it.
    case "message":
      return { kind: "Message", title: `Send a message to ${approval.to ?? "another session"}?`, detail: reason ?? undefined, allow: "Send", deny: "Don't send" };
    case "browser":
      return { kind: "Browser", title: reason || "Go ahead in the browser?", allow: "Go ahead", deny: "Don't" };
    case "computer":
      return { kind: "Computer use", title: reason || "Use this app?", allow: "Allow in this chat" };
    default:
      return { kind: "Ask permission", title: reason || "Allow this?" };
  }
}

/** The lines under what an approval asks: where a command runs, what it asks beyond its sandbox, a site not on the list. */
export const ASKED = {
  cwd: (cwd: string) => `in ${cwd}`,
  paths: (paths: readonly string[]) => `with ${paths.join(", ")}`,
  host: (host: string) => `${host} isn’t on this session’s list of allowed sites.`,
};

/** The "Allow for this session" button's tip, from what the grant covers (D177); its words never change [D167]. */
export function grantTip({ scope, pattern }: NonNullable<PendingApproval["grant"]>): string {
  const kept = "Not saved across sessions.";
  if (scope === "edits") return `Allow file changes inside ${pattern} in this chat. Edits outside it still ask. ${kept}`;
  if (scope === "tool") return `Allow ${pattern} in this chat. ${kept}`;
  if (scope === "site") return `Allow scripts, clicks, typing, deletes and sends on ${pattern} in this chat. Paying, cards, passwords, codes and sign-in still ask. ${kept}`;
  if (scope === "network") return `Allow connections to ${pattern} in this chat. ${kept}`;
  return `Allow commands that start with ${pattern} in this chat. ${kept}`;
}

export const WITHDRAWN = "withdrawn";

/** The session that started a worker, which a request it answers names [D131], until its title is known. */
export const PARENT = "Its parent";

/**
 * An approval's row: "Asking for approval · waiting", then "Asked for approval · allowed" or "· denied"; a plan denied was
 * sent back, by the review or with a reply [D394]; undecided once the turn moved on, withdrawn. `parent`: a worker's,
 * which only its parent answers: "Asking ‹parent›", "‹parent› allowed:" [D121, D131].
 */
export function approvalWords(decision: "approved" | "denied" | "withdrawn" | null, action: ApprovalAction, waiting: boolean, parent?: string, byReview?: boolean): string {
  if (decision === null || decision === "withdrawn") {
    const live = waiting && decision === null;
    const asking = parent !== undefined ? `Asking ${parent}` : "Asking for approval";
    const asked = parent !== undefined ? `Asked ${parent}` : "Asked for approval";
    return live ? `${asking} · waiting` : `${asked} · ${WITHDRAWN}`;
  }
  const said = decision === "approved" ? "allowed" : action !== "plan" ? "denied" : byReview ? "sent back by review" : "sent back";
  return parent !== undefined ? `${parent} ${said}:` : `Asked for approval · ${said}`;
}

/**
 * A question's row: "Asking a question · waiting" or "Asking questions · waiting"; answered, "Asked a question" or "Asked 3
 * questions", the round's title after it; unanswered once the turn moved on, withdrawn. `parent`: a worker's, "‹parent› answered".
 */
export function questionWords(answered: boolean, waiting: boolean, count: number, title?: string | null, parent?: string): string {
  const named = title ? ` · ${title}` : "";
  const asked = parent !== undefined ? `${parent} answered${named}` : `Asked ${count === 1 ? "a question" : `${count} questions`}${named}`;
  if (answered) return asked;
  const asking = parent !== undefined ? `Asking ${parent}` : count === 1 ? "Asking a question" : "Asking questions";
  return waiting ? `${asking} · waiting` : `${parent !== undefined ? `Asked ${parent}${named}` : asked} · ${WITHDRAWN}`;
}

/** An answer as the row shows it: a recommended pick says so, each one of a multi-select too; a skipped one says that. */
export function answerWords(item: QuestionItem | undefined, answer: string | null): string {
  if (!answer?.trim()) return "No answer provided";
  const recommended = item?.recommended == null ? undefined : item.options[item.recommended]?.label;
  const mark = (label: string) => (label === recommended ? `${label} (Recommended)` : label);
  const labels = new Set(item?.options.map((option) => option.label));
  const picks = item?.multiSelect && !labels.has(answer) ? answer.split(", ") : [answer];
  return picks.every((pick) => labels.has(pick)) ? picks.map(mark).join(", ") : answer;
}

const WHY: Record<string, string> = {
  answered: "Already answered",
  uncertain: "Your earlier answer may not have reached the agent",
  not_running: "The session that asked has ended",
  disconnected: "Brigadier isn't running",
};

/** Rust's refusal of an answer (`brigadier answer`), in words. */
export function refusalWords(reply: Record<string, any>): string {
  if (reply.error === "not_pending") return WHY[reply.why] ?? (reply.why === "unknown" ? "Nothing is waiting for this answer" : "The agent stopped waiting for this");
  // The agent's own words.
  if (reply.error === "agent" && reply.why) return String(reply.why);
  return WHY[reply.error] ?? String(reply.message ?? reply.error ?? "Refused");
}

/** Under a decision: how many more wait behind it. */
export const moreWaiting = (more: number) => `${more} more ${more === 1 ? "decision waits" : "decisions wait"} after this one`;
