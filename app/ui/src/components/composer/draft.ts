/**
 * A message being written, as the composer's props carry it: one shape for saving and restoring a draft,
 * sending it, recalling a sent prompt with ↑ and editing a queued message. Rust stores it; the field only
 * shows it. PROPOSED to the owning runs (msgs/w08-fields-1.md).
 */

/**
 * A chip in the text. A mention keeps what it names (`label`: the path or title it shows), a command, skill
 * or MCP prompt its id and its `/name`; an image or a long paste keeps its stored attachment's id. Taking a chip out of the text never deletes that attachment:
 * it goes when the draft holding it is sent or cleared, so undo can bring the chip back.
 */
export type Chip =
  | { kind: "mention"; id: string; type: "file" | "folder" | "chat" | "worker"; label: string }
  | { kind: "command"; id: string; type: "command" | "skill" | "mcp"; label: string }
  | { kind: "image"; attachmentId: string }
  /** `preview`: the paste's first words, for its chip. */
  | { kind: "paste"; attachmentId: string; preview?: string };

/** The text with its chips in place, and the files attached beside it (shown as tiles, not in the text). */
export type Draft = { parts: (string | Chip)[]; attachmentIds: string[] };

export const EMPTY_DRAFT: Draft = { parts: [], attachmentIds: [] };

/** Nothing to send: no attachment, no chip, only blank text. */
export function isEmpty(draft: Draft): boolean {
  return draft.attachmentIds.length === 0 && draft.parts.every((part) => typeof part === "string" && part.trim() === "");
}

/** A draft's words as plain text: a chip pasted in (a mention, a command) reads as its label; an image or a paste as nothing. */
export function plainText(parts: Draft["parts"]): string {
  return parts.map((part) => (typeof part === "string" ? part : "label" in part ? part.label : "")).join("");
}

/** How a message goes: at once, or while a turn runs, queued after it or steered into it. */
export type SendMode = "now" | "queue" | "steer";

/** The session's default way for a message sent while a turn runs. */
export type FollowUp = "queue" | "steer";

/**
 * The way a send goes. Enter takes the default follow-up, ⌥Enter (`other`) the other one; steering only
 * where the agent can (`canSteer`).
 */
export function sendMode(running: boolean, followUp: FollowUp, other: boolean, canSteer: boolean): SendMode {
  if (!running) return "now";
  const way = other ? (followUp === "queue" ? "steer" : "queue") : followUp;
  return way === "steer" && !canSteer ? "queue" : way;
}
