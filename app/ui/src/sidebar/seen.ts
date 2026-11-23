import { useEffect } from "react";

import { seen } from "./actions";
import type { SessionRow } from "./words";

/**
 * The open session is read up to the end its row shows: on opening it, and each time a later end comes in
 * while it stays open (as the old app did) [D173]. Its row draws no dot meanwhile.
 */
export function useSeen(open: SessionRow | undefined): void {
  const id = open?.id;
  // Its mockup's news counts as an end: seen once the session is open [D560].
  const finished = Math.max(open?.finished ?? 0, open?.news ?? 0);
  useEffect(() => {
    if (id) seen(id, finished);
  }, [id, finished]);
}
