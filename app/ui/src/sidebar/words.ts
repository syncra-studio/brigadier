import { useEffect, useReducer } from "react";

import type { Row } from "../daemon";
import type { PrChipState } from "../landing/pr-chip";
import { hhmm } from "../thread/words";

/** A row's one mark, worked out in Rust [D173]: spinner, blue ring, amber ring, blue dot, or nothing. */
export type Mark = "working" | "needs" | "amber" | "unread" | null;

/** What a sidebar row draws: the daemon's row, its mark and the facts behind it [D65, D173]. */
export type SessionRow = {
  id: string;
  title: string;
  /** The fold's state, the fact behind the mark; only ever shown through its words here. */
  state: string;
  /** What the state is about, as Rust says: a question's text, `{approval: id}`, a limit's message… */
  reason?: unknown;
  mark: Mark;
  /** When a usage limit resets (ms), if its CLI said; null otherwise [D74]. */
  resets: number | null;
  /** The user's last send, else when the session was made (ms): the list's order. */
  sent: number;
  /** When a turn last ended (ms); later than the user last saw it, the row is unread. */
  finished: number;
  /** Its project's id; null for a session from before projects. */
  project: string | null;
  /** Its pull requests' chip, as Rust computes it [D1018]; none when no PR needs a word. */
  pr?: PrChipState | null;
} & Pick<Row, "pinned" | "touched" | "archived" | "lifecycle" | "forkOf" | "folder">;

export type Project = { id: string; name: string; folder: string };

// Each state's words in the hover card, so no code name ever shows (O12). Null says nothing.
const STATE_WORDS: Record<string, string | null> = {
  waiting_answer: "Needs you · question",
  sign_in: "Needs you · sign-in",
  logged: "Starting",
  starting: "Starting",
  working: "Working",
  silent: "Working",
  retrying: "Reconnecting",
  checking: "Running safety checks",
  idle_jobs: "Working · background job",
  failed: "Failed",
  out_of_credits: "Out of credits",
  interrupted: "Interrupted",
  undelivered: "Couldn't send your message",
  uncertain: "Couldn't confirm your message arrived",
  unresumable: "Can't resume on this account",
  stalled: "Stalled · no output for a while",
  unresponsive: "Not responding",
  no_turn_started: "Not started yet",
  error: "Couldn't read this session",
  stopped: "Stopped",
  idle: null,
  new: null,
};

// A state this build has no words for yet still says what its mark means.
const MARK_WORDS: Record<NonNullable<Mark>, string> = { working: "Working", needs: "Needs you", amber: "Failed", unread: "New reply" };

/** Whether a limit's reset time is still to come; once it has passed the words stop naming it [D379]. */
const resetAhead = (resets: number | null): resets is number => resets !== null && resets > Date.now();

/** What a row's mark means, in plain words ("Needs you · sign-in", "Usage limit · resets 14:10"); null for nothing. */
export function statusWords(row: SessionRow): string | null {
  if (row.mark === "unread") return MARK_WORDS.unread;
  if (row.state === "limited") {
    // Spinning, an automatic switch waits it out [D51]; otherwise it's stuck until you act.
    const words = row.mark === "working" ? "Waiting for usage limit" : "Usage limit";
    return resetAhead(row.resets) ? `${words} · resets ${hhmm(row.resets)}` : words;
  }
  // A pending approval waits as a question does; only its reason says which [D173].
  if (row.state === "waiting_answer" && typeof row.reason === "object" && row.reason !== null && "approval" in row.reason) return "Needs you · approval";
  if (Object.hasOwn(STATE_WORDS, row.state)) return STATE_WORDS[row.state];
  return row.mark && MARK_WORDS[row.mark];
}

/** statusWords for a row left on screen: it draws again until the limit's reset time has passed [D379]. */
export function useStatusWords(row: SessionRow): string | null {
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const ahead = resetAhead(row.resets);
  useEffect(() => {
    if (!ahead) return;
    // A poll, not one timeout to the reset: timers don't run while the Mac sleeps.
    const timer = setInterval(redraw, 10_000);
    return () => clearInterval(timer);
  }, [ahead]);
  return statusWords(row);
}

/** A project's initials for its badge: the first letters of its first two words, else its first two. */
export function projectInitials(name: string): string {
  const [first = "", second] = name.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const letters = second === undefined ? [...first].slice(0, 2) : [[...first][0], [...second][0]];
  return letters.join("").toUpperCase();
}
