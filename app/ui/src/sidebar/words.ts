import { useEffect, useReducer } from "react";

import type { Row } from "../daemon";

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

export { resetWords } from "../../../shared/words";
export { hueOf, projectInitials, statusWords } from "../../../shared/rows";
import { resetAhead, statusWords } from "../../../shared/rows";

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
