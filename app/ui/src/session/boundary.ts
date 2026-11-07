// What any backend owning a session must speak. Rust folds; the UI only places what it is sent.

/** A row as the backend sends it: whole and folded, with the client id of the command that made it. */
export type Row<I> = { item: I; clientId: string | null };

/** What the backend says the session's run is doing. The UI never works this out itself. */
export type Run = { state: "idle" | "working" | "stalled" | "interrupted" } | { state: "error"; error: string };

/** What became of a command the UI asked about when it (re)connected. */
export type Outcome =
  | { kind: "applied" }
  | { kind: "rejected"; error: string }
  /** Queued or running: its frames are still to come. */
  | { kind: "pending" }
  /** Never received, and refused from now on: proven never to run. */
  | { kind: "unseen" };

/** After a snapshot, each frame's seq is the one before + 1. */
export type Frame<I> =
  | { type: "snapshot"; seq: number; rows: Row<I>[]; run: Run; outcomes: Record<string, Outcome> }
  | { type: "put"; seq: number; row: Row<I> }
  | { type: "drop"; seq: number; id: string }
  /** `cause`: the command this run change answers, which proves the backend accepted it. */
  | { type: "run"; seq: number; run: Run; cause: string | null }
  | { type: "rejected"; seq: number; clientId: string; error: string };

export type Link = "connecting" | "live" | "reconnecting" | "disconnected";

/** A repeated `clientId` creates nothing: the backend answers with its first outcome. */
export type Command<C> = { clientId: string; command: C };

export type Backend<I, C> = {
  /**
   * Opens the stream, replacing any open one. Every (re)connection starts with a snapshot whose
   * `outcomes` answer the client ids `ask()` returns at that moment.
   */
  connect(ask: () => string[], onFrame: (frame: Frame<I>) => void, onLink: (link: Link) => void): void;
  send(command: Command<C>): void;
};
