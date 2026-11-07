// What the thread view draws. Rust folds provider events into these; the UI only draws them.

export type Session = {
  id: string;
  title: string;
  turns: Turn[];
  /** Every item of every turn, oldest first: the rows of the thread. */
  items: Item[];
};

export type Turn = {
  id: string;
  status: "running" | "done" | "failed" | "cancelled";
  startedAt: number;
  endedAt: number | null;
};

/** How far an action has got. */
export type Progress = "pending" | "running" | "done" | "failed" | "cancelled";

export type FileChange = {
  path: string;
  change: "added" | "modified" | "deleted" | "renamed";
  /** The old path of a renamed file. */
  from: string | null;
  /** Unified diff. */
  diff: string;
};

type Base = { id: string; turnId: string };

export type Item = Base &
  (
    | { kind: "message"; role: "user" | "assistant"; text: string; streaming: boolean }
    | { kind: "reasoning"; text: string; streaming: boolean }
    | {
        kind: "tool";
        /** What the agent ran, as it named it: a shell command, a search, an MCP tool. */
        name: string;
        input: string;
        output: string;
        progress: Progress;
        exitCode: number | null;
      }
    | { kind: "fileChange"; changes: FileChange[]; progress: Progress }
    | { kind: "approval"; title: string; detail: string; decision: "approved" | "denied" | null }
    | { kind: "question"; question: string; options: string[]; answer: string | null }
    | { kind: "childAgent"; sessionId: string; title: string; progress: Progress }
    | { kind: "compaction"; summary: string | null }
    | { kind: "notice"; level: "info" | "warning" | "error"; text: string }
    /** An event the UI can't draw yet, kept as it came. */
    | { kind: "unknown"; raw: unknown }
  );

export type Kind = Item["kind"];
