import type { PendingApproval } from "../components/composer/approval";
import type { Draft } from "../components/composer/draft";
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
  /** After find went to an island far up: the `n` of the first newer row not held, or null when they reach the newest. */
  after?: number | null;
  turns: Turn[];
  /** Every item of every turn, oldest first: the rows of the thread. */
  items: Item[];
  /** One per finished turn that did work. */
  work?: Work[];
  /** Rust places the latest setup under this row, its launch's input; null while that row isn't in yet. */
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
  after: string | null;
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
  /** Actions turned down, even when none ran and there is no work fold. */
  denied?: number;
  /** Its agent's own safety check gave no verdict on an action, so the rest of the turn asks you instead (D455). */
  unchecked?: boolean;
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
  /** Drawn stopped by the UI while the user's Stop is on its way to Rust [D693]. */
  stopping?: true;
  /** Its subagents still running after its answer: its block stays open, counting, until the last ends [D114]. */
  helpers?: number;
  /** Answered while its subagents run, or till the agent wakes once they ended: one open block, drawn as running [D118]. */
  held?: boolean;
  /** When those subagents last did anything (ms); past 30 minutes of quiet, the block offers Stop. */
  heardAt?: number;
  /** Its parent's turn handling a worker's ask: hidden whole, it shows nothing running [D119]. */
  quiet?: boolean;
};

/** What a step of work did, provider-neutral. */
export type StepKind = "read" | "edit" | "list" | "search" | "run" | "web" | "agent" | "skill" | "other";

/**
 * A finished turn's work: how long it took and the items folded under "Worked for …", by `n`, first and last.
 * `ms` leaves out the turn's waits on the user (`Turn.waitedMs`): "Worked for 3m 4s · waited for 1m 2s".
 * `kept`: rows in it that stay visible, its questions with the user's answers [D99].
 * It folds exactly one turn. A background job still running after the turn ends is its own status, not part of it.
 */
export type Work = { turnId: string; ms: number; folded: [number, number]; kept?: number[]; /** Its approvals the user or a rule turned down. */ denied?: number };

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
  /** A fork's copy of its source's thread, read only: no rewind, and its answers fork from the source [D1079]. */
  inherited?: boolean;
};

/** A file a user message carried, by its attachment id; `pasted`: a long paste, sent in the text whole. */
export type SentFile = { id: string; name: string; mime: string; bytes: number; pasted?: boolean };

export type Item = Base &
  (
    | {
        kind: "message";
        role: "user" | "assistant";
        text: string;
        streaming: boolean;
        /** True only on an ended turn's last assistant message. */
        final?: boolean;
        /** Who sent an input item: the user, the app on their behalf, or another session (`from`), never the user [D2034]. */
        origin?: "user" | "system" | "peer";
        from?: string;
        /** When it was sent, ms since the epoch. */
        sentAt?: number;
        /** The input's command id, which the app's own copy settles by and a rewind names. */
        cid?: string;
        /** Steered into the running turn: it sits inside that turn's work and starts no turn of its own. */
        steer?: boolean;
        /** A user message's files (its images, pastes and attached files), stored in its session's folder. */
        files?: SentFile[] | null;
        /** A user message's whole draft, which Retry and Rewind send again or put back. */
        draft?: Draft | null;
        /** Sent with Brigade on: its pill above it [D185]. */
        brigade?: boolean;
      }
    /**
     * Steps that came one after another in a turn, as one row: counts per kind, and the steps' items by `n`, first
     * and last, which follow it. Its id is the turn id plus the group's index in the turn, so an update replaces it.
     */
    /** `server`: an MCP server's calls, counted apart [D176]. */
    /** `run`: the running turn's latest run, nothing after it yet; it draws as its live line, never its count [D230]. */
    | { kind: "group"; steps: { kind: StepKind; n: number; server?: string | null }[]; span: [number, number]; run?: boolean }
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
        /** The MCP server it comes from, as configured ("atlassian") [D176]. */
        server?: string | null;
        /** What the user allowed it, when it asked [D173]. */
        approval?: PendingApproval;
        /** A skill's own steps as it runs them, as a subagent's `log` [D211]. */
        log?: Item[];
        /** Its `log`'s ended steps counted as a group's, which Rust makes [D227]. */
        logSteps?: Extract<Item, { kind: "group" }>["steps"];
        /** What the agent said it does, when it said; empty otherwise [D214]. */
        description?: string;
        /** A shell command's line, whatever its step says it does [D116]. */
        command?: string | null;
      }
    | { kind: "fileChange"; changes: FileChange[]; progress: Progress; approval?: PendingApproval }
    | { kind: "approval"; request: PendingApproval; decision: "approved" | "denied" | "withdrawn" | null; to?: "parent" | "brigadier" | "review"; by?: "parent" | "review" }
    | { kind: "question"; question: string; options: string[]; answer: string | null; request?: PendingQuestion; answers?: (string | null)[]; withdrawn?: boolean; to?: "parent"; /** A worker's routing hold: it waits with no turn running [D2028]. */ held?: true }
    | {
        kind: "childAgent";
        sessionId: string;
        title: string;
        progress: Progress;
        /** When it started and ended (ms); null while it runs. */
        startedAt?: number;
        endedAt?: number | null;
        /** Its own steps, as tool rows without output, for the side panel; absent where its CLI doesn't stream them [D115]. */
        log?: Item[];
        /** Its final answer, once done. */
        answer?: string | null;
      }
    | { kind: "compaction"; summary: string | null; progress?: Progress }
    /**
     * An image the agent makes or made, kept in this session's attachments by `attachment` and `name` once done; a
     * worker's (`from`) shows in its parent's thread too [D289].
     */
    | { kind: "image"; progress: Progress; attachment?: string | null; name?: string | null; prompt?: string | null; error?: string | null; from?: string | null }
    | { kind: "notice"; level: "info" | "warning" | "error"; text: string }
    /** A notice Rust sends as structure, its words written here: `untrusted`, trust taken back holds this turn to Ask [D166]. */
    | { kind: "notice"; reason: "untrusted" }
    /** A reply the agent's safety checks withheld, with its CLI's words [D487]. */
    | { kind: "notice"; reason: "blocked"; text: string }
    /**
     * A failed turn, one row at its end with the CLI's own words [D54]: it didn't finish (`cause: "capacity"` when the
     * model's servers were busy), its model isn't available, or a safety check ended the conversation.
     */
    | { kind: "notice"; reason: "failed"; why: "turn-failed" | "start-failed" | "model-unavailable" | "ended-for-safety" | "context-full"; cause: "capacity" | null; text: string | null }
    /** A sign-in error, its line linking to where sign-in lives [D381]: the agent's own, or a library server's (`plugin`, its key) [wave4 D2043]. */
    | { kind: "notice"; reason: "sign-in"; text: string; plugin?: string | null }
    /**
     * A usage limit (or a refused resume) and the switch past it: one row Rust changes in place [D51, D132], in the
     * kit's switch shape (D133). Rust sends `limit`, `switching` from a pick mid-turn or the switch's input till the new
     * model's first output [D241], `switched`, and `over` for a limit no switch took (a Stop, a new message); the click
     * shows `switching` and `failed` as its own pending states until Rust's row moves. `from`/`to` are
     * display names Rust resolved once switched; at the limit, `backend` and `account` say which side it hit.
     */
    | {
        kind: "switch";
        state: "limit" | "switching" | "switched" | "failed" | "over";
        /** `picked`: the user picked another agent's model, and the next message went to it [D129]. */
        reason: "usage-limit" | "credits" | "unresumable" | "picked";
        from?: string | null;
        to?: string | null;
        model?: string | null;
        handoff: boolean;
        automatic: boolean;
        /** A worker's move to its job's next model, as Rust wrote it [D375]. */
        moved?: string | null;
        error?: string;
        /** The whole note as Rust wrote it, for a switch logged before the shape. */
        text: string;
        backend?: string;
        account?: string;
        /** When the limit resets (ms), if its CLI said; null otherwise [D74]. */
        resets?: number | null;
        /** `op`: the app's pick it came from, to take its pending line's place [D76]. */
        op?: string;
      }
    /** Where a fork starts, after its inherited rows [D48, D1063]; `where` null for a chat's. */
    | { kind: "forked"; source: string; where: "worktree" | null; summary: boolean; leftOut: string[] }
    /** A `!` command the user ran [D316]: running, then how it ended with its newest output (the rest: `shell output`). */
    | { kind: "shell"; cmd: string; command: string; progress: Progress; output: string; exitCode: number | null; ms?: number; error?: string | null }
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
     * (`ms` since the turn started; null when not known), or a worker's Pause in its own thread; a turn the agent's
     * automatic reviewer ended; a failed turn's message sent again in its place (D492); a run that stopped before its
     * turn ended (D92).
     */
    | { kind: "line"; reason: "limit-reset"; at: number }
    /** `op`: the app's pick it came from, to take its pending line's place [D76]; `live` till the new model draws a row [D241]. */
    | { kind: "line"; reason: "model"; why: "changed" | "rerouted"; from: string | null; to: string; op?: string; live?: boolean }
    | { kind: "line"; reason: "stopped"; ms: number | null }
    | { kind: "line"; reason: "paused"; ms: number | null }
    | { kind: "line"; reason: "interrupted" }
    | { kind: "line"; reason: "review-ended" }
    | { kind: "line"; reason: "retried" }
    /** The rebirth loop guard stopped the turn: two fresh conversations in a row did nothing new; Continue goes on [D144]. */
    | { kind: "line"; reason: "stalled" }
    /** Workers in the parent's thread, from Rust's notes and results [D3009, D3010]: started (in one turn, merged), ended, Stop left running. */
    | { kind: "team"; word: "started" | "finished" | "failed" | "stopped"; workers: string[]; merge?: Merge | null }
    | { kind: "team_step"; type: "stopped"; byUser: boolean; workers: string[] }
    | { kind: "team_step"; type: "paused" | "resumed"; workers: string[] }
    | { kind: "team_step"; type: "messaged"; byUser: boolean; workers: string[]; text?: string }
    | { kind: "team_still"; workers: string[] }
    /** The lead's one row for its mockup worker's mockup, its moment read live (`mockup <wid>`) [D2055, D560]. */
    | { kind: "mockup"; worker: string; count: number; on?: string[] | null; round?: number | null }
    /** A message this session's agent sent another, from Rust's notes [D2034, D3014]; `waited` once a `--wait` ended. */
    | {
        kind: "peer";
        mid: string;
        to: string;
        text: string;
        wait: boolean;
        state: "sending" | "sent" | "uncertain" | "dropped" | "stopped" | "refused";
        why: string | null;
        waited?: "replied" | "timeout";
      }
    /** An event the UI can't draw yet, kept as it came. */
    | { kind: "unknown"; raw: unknown }
  );

export type Kind = Item["kind"];

/** Whether a finished worker merged its branch back into its parent's, by Rust's result [D97]. */
export type Merge = { into: string; ok: boolean };
