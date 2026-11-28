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
