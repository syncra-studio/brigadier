import type { PendingApproval } from "../components/composer/approval";
import type { PendingQuestion } from "../components/composer/question";

// What the thread view draws. Rust folds provider events into these; the UI only draws them.

// Draft contract Rust must meet, not final: `n`, `origin`, `backend`, the `group` row, `StepKind` and `Work`, and
// `sentAt`, a tool's `step`/`startedAt`/`endedAt`, `added`/`removed`, `action`, `heading`, a compaction's `progress`
// a turn's `waitingSince`/`waitedMs`, and a subagent's `startedAt`/`endedAt`/`current`/`steps`/`answer`.
// A null number or text means "not reported": rows show nothing for it, never 0 or an empty label.

export type Session = {
  id: string;
  title: string;
  /** The `n` of the first row sent, or null when the whole history came. */
  before?: number | null;
  turns: Turn[];
  /** Every item of every turn, oldest first: the rows of the thread. */
  items: Item[];
  /** One per finished turn that did work. */
  work?: Work[];
  /** Rust places the latest setup before this row; null means after the rows so far. */
  setup?: Setup | null;
  /** Requests still waiting on the user, replayed on reconnect and reconciled by CLI id. */
  approvals?: PendingApproval[];
  questions?: PendingQuestion[];
  /** The user messages a rewind can go back to, by command id; Rust decides [D384]. */
  rewind?: string[];
};

/** Rust owns the reached steps, their order, state and placement; the UI writes their words. */
export type Setup = {
  state: "running" | "done" | "failed";
  before: string | null;
  steps: SetupStep[];
};
export type SetupStep = {
  state: "running" | "done" | "failed";
  error: string | null;
  code?: number | null;
  signal?: number | null;
  interrupted?: boolean;
} & ({ kind: "worktree"; branch: string | null; base: string | null } | { kind: "setupScript" } | { kind: "cli"; cli: string | null });

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
  /** Rust hides work that is still awaiting approval, including groups with no visible steps. */
  hidden?: boolean;
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
        /** True only on an ended turn's last assistant message. */
        final?: boolean;
        /** True on the last assistant message before a user input joined its running turn. */
        joined?: boolean;
        /** Who sent an input item: the user, or the app on their behalf. */
        origin?: "user" | "system";
        /** When it was sent, ms since the epoch. */
        sentAt?: number;
        /** The input's command id, which the app's own copy settles by and a rewind names. */
        cid?: string;
        /** Steered into the running turn: it sits inside that turn's work and starts no turn of its own. */
        steer?: boolean;
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
    | { kind: "approval"; request: PendingApproval; decision: "approved" | "denied" | "withdrawn" | null }
    | { kind: "question"; question: string; options: string[]; answer: string | null; request?: PendingQuestion; answers?: (string | null)[]; withdrawn?: boolean }
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
    /** A notice Rust sends as structure, its words written here: `untrusted`, trust taken back holds this turn to Ask [D166]. */
    | { kind: "notice"; reason: "untrusted" }
    /** The agent's own sign-in error, its line linking to where sign-in lives [D381]. */
    | { kind: "notice"; reason: "sign-in"; text: string }
    /**
     * A usage limit (or a refused resume) and the switch past it: one row Rust changes in place [D51, D132], in the
     * kit's switch shape (D133). Rust sends `limit`, `switched`, and `over` for a limit no switch took (a Stop, a new
     * message); `switching` and `failed` are the click's own pending states until Rust's row moves. `from`/`to` are
     * display names Rust resolved once switched; at the limit, `backend` and `account` say which side it hit.
     */
    | {
        kind: "switch";
        state: "limit" | "switching" | "switched" | "failed" | "over";
        /** `picked`: the user picked another agent's model, and the next message went to it [D129]; only ever switched. */
        reason: "usage-limit" | "credits" | "unresumable" | "picked";
        from?: string | null;
        to?: string | null;
        model?: string | null;
        handoff: boolean;
        automatic: boolean;
        error?: string;
        /** The whole note as Rust wrote it, for a switch logged before the shape. */
        text: string;
        backend?: string;
        account?: string;
        /** When the limit resets (ms), if its CLI said; null otherwise [D74]. */
        resets?: number | null;
      }
    /**
     * A session this one's message started [D204, D206]: Rust's row from the source's log, its intent (`starting`,
     * with the text) then its result in place. The new session's title and status come from its own row; `title`
     * here is for when that row is gone. `failed`: Rust's `error`, and what its cleanup couldn't remove (`left`).
     */
    | {
        kind: "started";
        session: string;
        state: "starting" | "started" | "failed";
        text: string | null;
        base?: string | null;
        title?: string | null;
        error?: string | null;
        left?: string[] | null;
      }
    /**
     * A line across the thread where something changed, its words written here (D487): a usage limit that reset
     * (`at`, ms); a model the same agent moved to, picked between turns or the CLI's own reroute; the user's Stop
     * (`ms` since the turn started; null when not known); a turn the agent's automatic reviewer ended; a conversation
     * continued from another session (forks, D463).
     */
    | { kind: "line"; reason: "limit-reset"; at: number }
    | { kind: "line"; reason: "model"; why: "changed" | "rerouted"; from: string | null; to: string }
    | { kind: "line"; reason: "stopped"; ms: number | null }
    | { kind: "line"; reason: "review-ended" }
    | { kind: "line"; reason: "continued"; session: string; title: string | null }
    /** An event the UI can't draw yet, kept as it came. */
    | { kind: "unknown"; raw: unknown }
  );

export type Kind = Item["kind"];
