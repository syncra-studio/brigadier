// A conflicted file as Rust will send it (2.23): its parts already parsed, so no conflict logic lives here [D65, D71].
// PROPOSED contract, unwired; the gallery feeds it fake data [D388].

/** One conflict: the checkout's lines, the common version's (when git marked it), the incoming lines. */
export type Conflict = {
  type: "conflict";
  /** Rust's id for this conflict, which an accept is reconciled by [D30]. */
  id: string;
  current: string[];
  base: string[] | null;
  incoming: string[];
  /** What follows `<<<<<<<`, `|||||||` and `>>>>>>>`. */
  currentLabel: string;
  baseLabel: string;
  incomingLabel: string;
  /** Each marker's length: 7 unless `.gitattributes` sets `conflict-marker-size`. */
  size: number;
};

export type Segment = { type: "common"; lines: string[] } | Conflict;

export type ConflictFile = {
  path: string;
  /** The working file's parts, each line with its own ending; null when one side deleted the file. */
  segments: Segment[] | null;
  /** Each side's whole file, for Compare; null where that side deleted it [D1044]. */
  current: string | null;
  incoming: string | null;
  currentLabel: string;
  incomingLabel: string;
  /** During a rebase, the commit it replays. */
  rebasing: { step: number; total: number; subject: string } | null;
};

/** Which side Accept keeps of one conflict. */
export type Choice = "current" | "incoming" | "both";

/** An accept on its way to Rust, by conflict id: shown at once, then gone when the file comes back, or failed. */
export type Accepting = { choice: Choice; error?: string };
