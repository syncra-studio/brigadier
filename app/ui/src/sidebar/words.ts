import { useEffect, useReducer } from "react";

import type { Row } from "../daemon";
import { hhmm } from "../thread/words";

export type { Mark, Reset } from "../../../shared/rows";
import type { Mark, Reset } from "../../../shared/rows";

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
  /** Its carry-on at the reset, or why it won't go by itself [C34, C54]. */
  reset?: Reset | null;
  /** The daemon's own switch of its limit is due or under way (proposed) [C6, D51]. */
  switching?: boolean;
  /** The user's last send, else when the session was made (ms): the list's order. */
  sent: number;
  /** Its last activity, the user's or an agent's (ms): View's other order [D655]. */
  updated?: number;
  /** When a turn last ended (ms); later than the user last saw it, the row is unread. */
  finished: number;
  /** When its mockup last had news, a round drawn or its pick built (ms): unread as a turn's end is [D560]. */
  news?: number;
  /** Its project's id; null for a session from before projects. */
  project: string | null;
  /** Its labels' names, in the order given [D3101, D3103]. */
  labels?: string[];
} & Pick<Row, "pinned" | "touched" | "archived" | "lifecycle" | "forkOf" | "folder" | "worker">;

export type Project = { id: string; name: string; folder: string; icon?: string | null };

// Each state's words in the hover card, so no code name ever shows (O12). Null says nothing.
const STATE_WORDS: Record<string, string | null> = {
  waiting_answer: "Needs you · question",
  asking: "Working",
  sign_in: "Needs you · sign-in",
  logged: "Starting",
  starting: "Starting",
  working: "Working",
  silent: "Working",
  retrying: "Reconnecting",
  reconnecting: "Reconnecting",
  checking: "Running safety checks",
  idle_jobs: "Background job",
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
const MARK_WORDS: Record<NonNullable<Mark>, string> = { working: "Working", needs: "Needs you", amber: "Failed", unread: "New reply", background: "Background job" };

/** A limit's carry-on in words, where Brigadier carries it on or says why not (proposed) [C34, C54]. */
export function resetWords(reset: Reset | null | undefined): string | null {
  if (reset?.error) return `couldn’t carry on by itself: ${reset.error}`;
  if (reset?.due) return `carries on at ${hhmm(reset.due)}`;
  if (reset?.held === "stuck") return "the limit didn’t lift at its reset time";
  if (reset?.held === "unconfirmed") return "receipt wasn’t confirmed, so it won’t carry on by itself";
  if (reset?.held === "unbegun") return "the limit stopped it before it began, so it won’t carry on by itself";
  if (reset?.held === "unknown") return "no reset time was given";
  return null;
}

/** Whether a limit's reset time is still to come; once it has passed the words stop naming it [D379]. */
const resetAhead = (resets: number | null): resets is number => resets !== null && resets > Date.now();

/** What a row's mark means, in plain words ("Needs you · sign-in", "Usage limit · resets 14:10"); null for nothing. */
export function statusWords(row: SessionRow): string | null {
  if (row.mark === "unread") return MARK_WORDS.unread;
  // A worker may move to another model, not only another account [D2037].
  if (row.switching) return "Switching automatically";
  if (row.state === "limited") {
    // Spinning, an automatic switch waits it out [D51]; otherwise it's stuck until you act.
    const words = row.mark === "working" ? "Waiting for usage limit" : "Usage limit";
    const carry = resetWords(row.reset);
    if (carry) return `${words} · ${carry}`;
    return resetAhead(row.resets) ? `${words} · resets ${hhmm(row.resets)}` : words;
  }
  // A pending approval waits as a question does; only its reason says which [D173].
  if (row.state === "waiting_answer" && typeof row.reason === "object" && row.reason !== null && "approval" in row.reason) return "Needs you · approval";
  // Answered, but its block stays open on its subagents [D118], or its mockup card waits on you.
  if ((row.mark === "working" || row.mark === "needs") && (row.state === "idle" || row.state === "idle_jobs")) return MARK_WORDS[row.mark];
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

/** Which of `count` hues a project's tile takes: FNV-1a of its name, mixed (murmur3's finaliser) so names alike spread
 *  over the hues; the same name always gets the same hue. Their constants in decimal, as FNV publishes its own [D283]. */
export function hueOf(name: string, count: number): number {
  let hash = 2166136261;
  for (const char of name) hash = Math.imul(hash ^ char.codePointAt(0)!, 16777619);
  hash = Math.imul(hash ^ (hash >>> 16), 2246822507);
  hash = Math.imul(hash ^ (hash >>> 13), 3266489909);
  return ((hash ^ (hash >>> 16)) >>> 0) % count;
}

/** A project's initials for its badge: the first letters of its first two words, else its first two. */
export function projectInitials(name: string): string {
  const [first = "", second] = name.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const letters = second === undefined ? [...first].slice(0, 2) : [[...first][0], [...second][0]];
  return letters.join("").toUpperCase();
}
