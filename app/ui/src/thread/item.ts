// What the thread view draws. Rust folds provider events into these; the UI only draws them.

// Draft contract Rust must meet, not final: `n`, `origin`, `backend`, the `group` row, `StepKind` and `Work`, and
// `sentAt`, a tool's `step`/`startedAt`/`endedAt`, `added`/`removed`, `action`, `heading`, a compaction's `progress`
// a turn's `waitingSince`/`waitedMs`, and a subagent's `startedAt`/`endedAt`/`current`/`steps`/`answer`.
// A null number or text means "not reported": rows show nothing for it, never 0 or an empty label.

export type Session = {
  id: string;
  title: string;
  turns: Turn[];
  /** Every item of every turn, oldest first: the rows of the thread. */
  items: Item[];
  /** One per finished turn that did work. */
  work?: Work[];
};

export type Turn = {
  id: string;
  status: "running" | "done" | "failed" | "cancelled";
  startedAt: number;
  endedAt: number | null;
  /** Which backend ran the turn. */
  backend?: string;
  /** When the running turn began waiting on the user (a question or an approval); null when it isn't waiting. */
  waitingSince?: number | null;
  /** How long the turn has waited on the user in all (ms). */
  waitedMs?: number;
};

/** What a step of work did, provider-neutral. */
export type StepKind = "read" | "edit" | "search" | "run" | "web" | "agent" | "other";

/**
 * A finished turn's work: how long it took and the items folded under "Worked for …", by `n`, first and last.
 * `ms` leaves out the turn's waits on the user (`Turn.waitedMs`): "Worked for 3m 4s · waited for 1m 2s".
 * `kept`: rows in it that stay visible, its questions with the user's answers [D99].
 * It folds exactly one turn. A background job still running after the turn ends is its own status, not part of it.
 */
export type Work = { turnId: string; ms: number; folded: [number, number]; kept?: number[] };

/** How far an action has got. */
export type Progress = "pending" | "running" | "done" | "failed" | "cancelled";

export type FileChange = {
  path: string;
  change: "added" | "modified" | "deleted" | "renamed";
  /** The old path of a renamed file. */
  from: string | null;
  /** Unified diff; null when the CLI reported none (some report only the path and kind): its row then shows no diff, never an empty one. */
  diff: string | null;
  /** Lines added and removed; null when not reported. */
  added: number | null;
  removed: number | null;
};

/** What an approval asks to do, provider-neutral (the old app's approval kinds). */
export type ApprovalAction = "command" | "edit" | "network" | "permission" | "plan" | "land" | "message" | "browser" | "other";

type Base = {
  id: string;
  turnId: string;
  /** Monotonic across the session: a snapshot is at N, events after it count on from N. */
  n?: number;
};

export type Item = Base &
  (
    | {
        kind: "message";
        role: "user" | "assistant";
        text: string;
        streaming: boolean;
        /** True only on an ended turn's last assistant message; absent or false means no answer actions. */
        final?: boolean;
        /** Who sent an input item: the user, or the app on their behalf. */
        origin?: "user" | "system";
        /** When it was sent, ms since the epoch. */
        sentAt?: number;
      }
    /**
     * Steps that came one after another in a turn, as one row: counts per kind, and the steps' items by `n`, first
     * and last, which follow it. Its id is the turn id plus the group's index in the turn, so an update replaces it.
     */
    | { kind: "group"; steps: { kind: StepKind; n: number }[]; span: [number, number] }
    | {
        kind: "reasoning";
        text: string;
        streaming: boolean;
        /** The newest bold heading in the text, which Rust extracts; null when there is none. */
        heading?: string | null;
      }
    | {
        kind: "tool";
        /** What the agent ran, as it named it: a shell command, a search, an MCP tool. */
        name: string;
        input: string;
        output: string;
        progress: Progress;
        exitCode: number | null;
        /** Which kind of step it is, the same kinds as groups. */
        step?: StepKind;
        startedAt?: number;
        /** Null while it runs or when not reported. */
        endedAt?: number | null;
      }
    | { kind: "fileChange"; changes: FileChange[]; progress: Progress }
    | { kind: "approval"; title: string; detail: string; decision: "approved" | "denied" | null; action?: ApprovalAction }
    | { kind: "question"; question: string; options: string[]; answer: string | null }
    | {
        kind: "childAgent";
        sessionId: string;
        title: string;
        progress: Progress;
        /** When it started and ended (ms); null while it runs. */
        startedAt?: number;
        endedAt?: number | null;
        /** Its running step: the kind and what it acts on (a path, a command, a query, another tool's name); null between steps. */
        current?: { step: StepKind; input: string } | null;
        /** How many steps it took so far. */
        steps?: number | null;
        /** Its final answer, once done. */
        answer?: string | null;
      }
    | { kind: "compaction"; summary: string | null; progress?: Progress }
    | { kind: "notice"; level: "info" | "warning" | "error"; text: string }
    /** An event the UI can't draw yet, kept as it came. */
    | { kind: "unknown"; raw: unknown }
  );

export type Kind = Item["kind"];
