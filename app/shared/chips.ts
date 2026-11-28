// The chips a message takes from the side panel (a diff comment, a Fix or Resolve with agent), for both apps [D58].

/** `on`: the diff it was made on (the Review tab, or a commit's), which alone draws it. */
/**
 * `agent`: a PR card's Fix or Resolve with agent [D1093, D1290]: the chip's face, what the agent reads, and `key`, what
 * made it, so it's added once (`pr`: the PR it came from, or none).
 */
export type Chip =
  | { kind: "comment"; id: string; on: string; comment: DiffComment }
  | { kind: "agent"; id: string; key: string; pr: number | null; chip: AgentChip; text: string };

/** A comment on a range of lines, waiting as a chip to go with the next message (D1040). */
export type DiffComment = {
  id: string;
  path: string;
  side: "additions" | "deletions";
  start: number;
  end: number;
  /** The range's first line, as the chip quotes it. */
  excerpt: string;
  text: string;
};

/**
 * What waits above the composer for the agent: a Resolve with agent or a failed run's Fix. Nothing is
 * sent until the user sends [D1019, D1027, D1044]. The composer carries it as an `agent` chip (panel/chips.ts).
 */
export type AgentChip =
  | { id: string; kind: "resolve"; conflicts: number; files: number; operation: "merging" | "rebasing" | "pulling"; onto: string }
  | { id: string; kind: "run"; run: string; failed: string };

const plural = (n: number, one: string) => (n === 1 ? `1 ${one}` : `${n} ${one}s`);

/** An agent chip's tile words, for both apps. */
export const agentChipWords = (chip: AgentChip): { title: string; detail: string } =>
  chip.kind === "resolve" ? { title: `Resolve ${plural(chip.conflicts, "conflict")}`, detail: `${plural(chip.files, "file")} · ${chip.operation} ${chip.onto}` } : { title: `Fix ${chip.run}`, detail: chip.failed };

/** Where a diff comment is: "auth.ts:12" or "auth.ts:12–14". */
export const commentAt = (comment: DiffComment) => `${comment.path.slice(comment.path.lastIndexOf("/") + 1)}:${comment.start === comment.end ? comment.start : `${comment.start}–${comment.end}`}`;

/** Chips waiting again: those given back, then those a read held back (`held`) that a given-back message names in `ids`. */
export const chipsBack = (given: readonly Chip[], held: readonly Chip[], ids: readonly string[]): Chip[] => [
  ...given,
  ...held.filter((chip) => ids.includes(chip.id) && !given.some((each) => each.id === chip.id)),
];

/**
 * The chips as the agent reads them, after the user's own words: each comment's place (on a removed line, the old
 * file's; on a commit's diff, that commit's), the lines it's on, quoted, then what it says after a blank line, so it
 * isn't read as part of the quote.
 */
export function withChips(message: string, sent: readonly Chip[]): string {
  const blocks = sent.map((chip) => {
    if (chip.kind === "agent") return chip.text;
    const { on, comment } = chip;
    const lines = comment.start === comment.end ? `${comment.start}` : `${comment.start}-${comment.end}`;
    const where = [on !== "review" && `in commit ${on.slice(0, 12)}`, comment.side === "deletions" && "before the change"].filter(Boolean).join(", ");
    return `${comment.path}:${lines}${where ? ` (${where})` : ""}\n${comment.excerpt.split("\n").map((line) => `> ${line}`).join("\n")}\n\n${comment.text}`;
  });
  return [message.trim(), ...blocks].filter(Boolean).join("\n\n");
}

/** The composer's pasted text: the label that opens editable while it's still the draft's. */
export const PASTE_LABEL = "Pasted text";
/** A chip that asks to repair a PR: its sent message is a "PR fix" [D171]. */
export const PR_FIX = /^(Merge conflicts|Review comments) – PR #\d+$|^\d+ failing checks? · /;
